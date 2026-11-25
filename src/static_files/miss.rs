use super::cache::{CacheSlot, TL_STATIC_CACHE};
use super::conditional::{append_cache_control, format_weak_etag};
use super::content_type::detect_content_type;
use super::file_response::write_file_response_from_open;
use super::mount::StaticMount;
use super::redirect::write_dir_redirect;
use super::resolve::MissResolve;
use super::FileServeError;
use bytes::Bytes;
use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Instant, SystemTime};
use tokio::fs::File;
use tokio::io::{AsyncWrite, AsyncWriteExt};

impl StaticMount {
    /// Turns the blocking resolver's verdict into a response (or a fallthrough: `Ok(false)`).
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn write_miss_response<W: AsyncWrite + Unpin>(
        &self,
        writer: &mut W,
        write_buf: &mut Vec<u8>,
        miss: MissResolve,
        rel_raw: &str,
        req_path: &str,
        query_str: &str,
        is_head: bool,
        is_mount_root: bool,
        has_trailing_slash: bool,
        if_none_match: Option<&str>,
        if_modified_since: Option<&str>,
        range_header: Option<&str>,
        if_range: Option<&str>,
        x_powered_by: bool,
        close_conn: bool,
    ) -> std::io::Result<bool> {
        match miss {
            MissResolve::DirRedirect => {
                write_dir_redirect(
                    writer,
                    write_buf,
                    req_path,
                    query_str,
                    is_head,
                    x_powered_by,
                    close_conn,
                )
                .await?;
                Ok(true)
            }
            // Misses and refusals go to the JS handler: it falls through or raises the
            // Express error (`NotFoundError`, `ForbiddenError`, ...) for the app's handlers.
            MissResolve::Forbidden | MissResolve::NotFound => Ok(false),
            MissResolve::SmallFile {
                resolved_path,
                data,
                file_size,
                mtime,
            } => {
                self.serve_small_file(
                    writer,
                    write_buf,
                    rel_raw,
                    resolved_path,
                    data,
                    file_size,
                    mtime,
                    is_head,
                    is_mount_root,
                    has_trailing_slash,
                    if_none_match,
                    if_modified_since,
                    range_header,
                    if_range,
                    x_powered_by,
                    close_conn,
                )
                .await
            }
            MissResolve::LargeFile {
                resolved_path,
                file,
                file_size,
                mtime,
            } => {
                self.serve_large_file(
                    writer,
                    write_buf,
                    resolved_path,
                    file,
                    file_size,
                    mtime,
                    is_head,
                    if_none_match,
                    if_modified_since,
                    range_header,
                    if_range,
                    x_powered_by,
                    close_conn,
                )
                .await
            }
        }
    }

    /// Pre-renders the cacheable part of a small file's 200 response (everything before the
    /// per-request `Connection` and `Date` headers).
    fn build_small_file_header_prefix(
        &self,
        content_type: &str,
        body_len: usize,
        etag: Option<&str>,
        last_modified: Option<&str>,
        x_powered_by: bool,
    ) -> Vec<u8> {
        let mut hp = Vec::with_capacity(256);
        hp.extend_from_slice(b"HTTP/1.1 200 OK\r\nContent-Type: ");
        hp.extend_from_slice(content_type.as_bytes());
        hp.extend_from_slice(b"\r\nAccept-Ranges: bytes\r\nContent-Length: ");
        let mut nb = itoa::Buffer::new();
        hp.extend_from_slice(nb.format(body_len).as_bytes());
        hp.extend_from_slice(b"\r\n");
        if let Some(et) = etag {
            hp.extend_from_slice(b"ETag: ");
            hp.extend_from_slice(et.as_bytes());
            hp.extend_from_slice(b"\r\n");
        }
        if let Some(lm) = last_modified {
            hp.extend_from_slice(b"Last-Modified: ");
            hp.extend_from_slice(lm.as_bytes());
            hp.extend_from_slice(b"\r\n");
        }
        append_cache_control(&mut hp, self.max_age_secs, self.immutable);
        if x_powered_by {
            hp.extend_from_slice(b"X-Powered-By: Express\r\n");
        }
        hp
    }

    /// Serves a small file from memory and inserts it into the thread-local cache.
    #[allow(clippy::too_many_arguments)]
    async fn serve_small_file<W: AsyncWrite + Unpin>(
        &self,
        writer: &mut W,
        write_buf: &mut Vec<u8>,
        rel_raw: &str,
        resolved_path: PathBuf,
        data: Vec<u8>,
        file_size: u64,
        mtime: Option<SystemTime>,
        is_head: bool,
        is_mount_root: bool,
        has_trailing_slash: bool,
        if_none_match: Option<&str>,
        if_modified_since: Option<&str>,
        range_header: Option<&str>,
        if_range: Option<&str>,
        x_powered_by: bool,
        close_conn: bool,
    ) -> std::io::Result<bool> {
        let etag = if self.etag {
            Some(format_weak_etag(file_size, mtime))
        } else {
            None
        };
        let last_modified = if self.last_modified {
            mtime.map(httpdate::fmt_http_date)
        } else {
            None
        };
        let content_type = detect_content_type(&resolved_path);

        let hp = self.build_small_file_header_prefix(
            &content_type,
            data.len(),
            etag.as_deref(),
            last_modified.as_deref(),
            x_powered_by,
        );

        {
            let slot = CacheSlot {
                mount_id: self.id,
                key: Rc::from(rel_raw),
                referenced: Cell::new(true),
                cached_at: Instant::now(),
                body: Bytes::from(data),
                etag,
                last_modified,
                content_type,
                header_prefix: Bytes::from(hp),
            };

            write_buf.clear();
            self.append_cached_slot(
                &slot,
                write_buf,
                is_head,
                if_none_match,
                if_modified_since,
                range_header,
                if_range,
                x_powered_by,
                close_conn,
            );

            if !(is_mount_root && !has_trailing_slash) {
                TL_STATIC_CACHE.with(|cell| {
                    cell.borrow_mut().insert(slot);
                });
            }
        }

        writer.write_all(write_buf).await?;
        Ok(true)
    }

    /// Streams a file too large for the cache.
    #[allow(clippy::too_many_arguments)]
    async fn serve_large_file<W: AsyncWrite + Unpin>(
        &self,
        writer: &mut W,
        write_buf: &mut Vec<u8>,
        resolved_path: PathBuf,
        file: std::fs::File,
        file_size: u64,
        mtime: Option<SystemTime>,
        is_head: bool,
        if_none_match: Option<&str>,
        if_modified_since: Option<&str>,
        range_header: Option<&str>,
        if_range: Option<&str>,
        x_powered_by: bool,
        close_conn: bool,
    ) -> std::io::Result<bool> {
        let tokio_file = File::from_std(file);
        match write_file_response_from_open(
            writer,
            write_buf,
            &resolved_path,
            tokio_file,
            file_size,
            mtime,
            is_head,
            if_none_match,
            if_modified_since,
            range_header,
            if_range,
            200,
            &[],
            self.etag,
            self.last_modified,
            true,
            true,
            self.max_age_secs,
            self.immutable,
            None,
            x_powered_by,
            close_conn,
        )
        .await
        {
            Ok(()) => Ok(true),
            // Nothing written yet: the JS handler answers (or falls through) as Express would.
            Err(FileServeError::PreHeader(_)) => Ok(false),
            Err(FileServeError::StreamAborted(e)) => Err(e),
        }
    }
}
