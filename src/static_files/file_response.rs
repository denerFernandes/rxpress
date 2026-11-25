use super::cache::CACHE_MAX_FILE_SIZE;
use super::conditional::{
    append_416, append_cache_control, etag_matches, format_304, format_weak_etag,
    http_date_not_modified, if_range_matches, parse_single_range, RangeParseResult,
};
use super::content_type::detect_content_type;
use super::FileServeError;
use crate::date::write_date_header;
use crate::protocol::status_reason;
use std::io::ErrorKind;
use std::path::Path;
use std::time::SystemTime;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt, SeekFrom};

/// Outcome of evaluating `Range` / `If-Range` against a file.
enum RangeOutcome {
    Full,
    Partial(u64, u64),
    Unsatisfiable,
}

/// Everything `write_file_headers` needs to render the status line and header block.
struct FileHeaderParams<'a> {
    file_path: &'a Path,
    status: u16,
    content_len: u64,
    file_size: u64,
    /// `Some((start, end))` when answering with a partial body.
    partial: Option<(u64, u64)>,
    etag: Option<&'a str>,
    last_modified: Option<&'a str>,
    extra_headers: &'a [(String, String)],
    accept_ranges: bool,
    cache_control: bool,
    max_age_secs: u64,
    immutable: bool,
    x_powered_by: bool,
    emit_close: bool,
}

/// Answers a satisfied conditional request with `304 Not Modified`. Returns whether it did.
#[allow(clippy::too_many_arguments)]
async fn try_write_not_modified<W: AsyncWrite + Unpin>(
    writer: &mut W,
    write_buf: &mut Vec<u8>,
    etag_val: Option<&str>,
    last_mod_str: Option<&str>,
    if_none_match: Option<&str>,
    if_modified_since: Option<&str>,
    x_powered_by: bool,
    emit_close: bool,
) -> std::io::Result<bool> {
    if let (Some(etag), Some(inm)) = (etag_val, if_none_match) {
        if etag_matches(inm, etag) {
            format_304(
                write_buf,
                Some(etag),
                last_mod_str,
                x_powered_by,
                emit_close,
            );
            writer.write_all(write_buf).await?;
            return Ok(true);
        }
    } else if let (Some(lm), Some(ims)) = (last_mod_str, if_modified_since) {
        if http_date_not_modified(ims, lm) {
            format_304(write_buf, etag_val, Some(lm), x_powered_by, emit_close);
            writer.write_all(write_buf).await?;
            return Ok(true);
        }
    }
    Ok(false)
}

fn resolve_range(
    accept_ranges: bool,
    range_header: Option<&str>,
    if_range: Option<&str>,
    file_size: u64,
    etag_val: Option<&str>,
    last_mod_str: Option<&str>,
) -> RangeOutcome {
    if accept_ranges {
        if let Some(rh) = range_header {
            let allow_range = match if_range {
                Some(ir) => if_range_matches(ir, etag_val, last_mod_str),
                None => true,
            };
            if allow_range {
                match parse_single_range(rh, file_size) {
                    RangeParseResult::Satisfiable(start, end) => {
                        return RangeOutcome::Partial(start, end);
                    }
                    RangeParseResult::Unsatisfiable => return RangeOutcome::Unsatisfiable,
                    RangeParseResult::Ignore => {}
                }
            }
        }
    }
    RangeOutcome::Full
}

/// Renders the status line and headers (through the blank line) into `write_buf`.
fn write_file_headers(write_buf: &mut Vec<u8>, p: &FileHeaderParams<'_>) {
    let extra_headers = p.extra_headers;
    let has_custom_ct = extra_headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("content-type"));
    let has_custom_cc = extra_headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("cache-control"));
    let has_custom_xpb = extra_headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("x-powered-by"));
    let has_custom_etag = extra_headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("etag"));
    let has_custom_lm = extra_headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("last-modified"));
    let has_custom_ar = extra_headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("accept-ranges"));

    write_buf.clear();
    let mut nb = itoa::Buffer::new();
    write_buf.extend_from_slice(b"HTTP/1.1 ");
    write_buf.extend_from_slice(nb.format(p.status).as_bytes());
    write_buf.push(b' ');
    write_buf.extend_from_slice(status_reason(p.status).as_bytes());
    write_buf.extend_from_slice(b"\r\n");

    if !has_custom_ct {
        let ct = detect_content_type(p.file_path);
        write_buf.extend_from_slice(b"Content-Type: ");
        write_buf.extend_from_slice(ct.as_bytes());
        write_buf.extend_from_slice(b"\r\n");
    }

    if p.accept_ranges && !has_custom_ar {
        write_buf.extend_from_slice(b"Accept-Ranges: bytes\r\n");
    }
    write_buf.extend_from_slice(b"Content-Length: ");
    write_buf.extend_from_slice(nb.format(p.content_len).as_bytes());
    write_buf.extend_from_slice(b"\r\n");

    if let Some((range_start, range_end)) = p.partial {
        write_buf.extend_from_slice(b"Content-Range: bytes ");
        write_buf.extend_from_slice(nb.format(range_start).as_bytes());
        write_buf.push(b'-');
        write_buf.extend_from_slice(nb.format(range_end).as_bytes());
        write_buf.push(b'/');
        write_buf.extend_from_slice(nb.format(p.file_size).as_bytes());
        write_buf.extend_from_slice(b"\r\n");
    }

    if let Some(et) = p.etag {
        if !has_custom_etag {
            write_buf.extend_from_slice(b"ETag: ");
            write_buf.extend_from_slice(et.as_bytes());
            write_buf.extend_from_slice(b"\r\n");
        }
    }
    if let Some(lm) = p.last_modified {
        if !has_custom_lm {
            write_buf.extend_from_slice(b"Last-Modified: ");
            write_buf.extend_from_slice(lm.as_bytes());
            write_buf.extend_from_slice(b"\r\n");
        }
    }
    if p.cache_control && !has_custom_cc {
        append_cache_control(write_buf, p.max_age_secs, p.immutable);
    }
    if p.x_powered_by && !has_custom_xpb {
        write_buf.extend_from_slice(b"X-Powered-By: Express\r\n");
    }

    for (k, v) in extra_headers {
        // Framing is the engine's: Content-Length was written above from the file size, and a
        // JS Transfer-Encoding/Content-Length would contradict it (RFC 9112 6.1).
        if crate::protocol::is_reason_header(k.as_bytes())
            || k.eq_ignore_ascii_case("content-length")
            || k.eq_ignore_ascii_case("transfer-encoding")
        {
            continue;
        }
        write_buf.extend_from_slice(k.as_bytes());
        write_buf.extend_from_slice(b": ");
        write_buf.extend_from_slice(v.as_bytes());
        write_buf.extend_from_slice(b"\r\n");
    }

    crate::protocol::push_connection_header(write_buf, p.emit_close);

    write_date_header(write_buf);
    write_buf.extend_from_slice(b"\r\n");
}

/// Sends the body for `[range_start, range_start + content_len)`. `write_buf` already holds the
/// rendered headers: small bodies are appended to it for a single write, large ones are streamed.
async fn write_file_body<W: AsyncWrite + Unpin>(
    writer: &mut W,
    write_buf: &mut Vec<u8>,
    file: &mut File,
    range_start: u64,
    content_len: u64,
) -> Result<(), FileServeError> {
    if range_start > 0 {
        file.seek(SeekFrom::Start(range_start))
            .await
            .map_err(|_| FileServeError::PreHeader(500))?;
    }

    if content_len <= CACHE_MAX_FILE_SIZE {
        let start_len = write_buf.len();
        write_buf.resize(start_len + content_len as usize, 0);
        if let Err(e) = file.read_exact(&mut write_buf[start_len..]).await {
            write_buf.truncate(start_len);
            return Err(FileServeError::PreHeader(
                if e.kind() == ErrorKind::UnexpectedEof {
                    500
                } else {
                    404
                },
            ));
        }
        writer.write_all(write_buf).await?;
        Ok(())
    } else {
        writer.write_all(write_buf).await?;
        let mut chunk = vec![0u8; 64 * 1024];
        let mut remaining = content_len;
        while remaining > 0 {
            let to_read = (remaining as usize).min(chunk.len());
            let n = file.read(&mut chunk[..to_read]).await?;
            if n == 0 {
                return Err(FileServeError::StreamAborted(std::io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "File truncated during streaming",
                )));
            }
            writer.write_all(&chunk[..n]).await?;
            remaining -= n as u64;
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn write_file_response_from_open<W: AsyncWrite + Unpin>(
    writer: &mut W,
    write_buf: &mut Vec<u8>,
    file_path: &Path,
    mut file: File,
    file_size: u64,
    mtime: Option<SystemTime>,
    is_head: bool,
    if_none_match: Option<&str>,
    if_modified_since: Option<&str>,
    range_header: Option<&str>,
    if_range: Option<&str>,
    status: u16,
    extra_headers: &[(String, String)],
    enable_etag: bool,
    enable_last_modified: bool,
    accept_ranges: bool,
    cache_control: bool,
    max_age_secs: u64,
    immutable: bool,
    window: Option<(u64, u64)>,
    x_powered_by: bool,
    close_conn: bool,
) -> Result<(), FileServeError> {
    // `send`'s `start`/`end`: serve `len` bytes from `offset` (validators stay the whole file's).
    let (base, view_size) = match window {
        Some((off, len)) => (off.min(file_size), len.min(file_size.saturating_sub(off))),
        None => (0, file_size),
    };
    let etag_val = if enable_etag {
        Some(format_weak_etag(file_size, mtime))
    } else {
        None
    };

    let last_mod_str = if enable_last_modified {
        mtime.map(httpdate::fmt_http_date)
    } else {
        None
    };

    let has_custom_conn = extra_headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("connection"));
    let emit_close = close_conn && !has_custom_conn;

    if try_write_not_modified(
        writer,
        write_buf,
        etag_val.as_deref(),
        last_mod_str.as_deref(),
        if_none_match,
        if_modified_since,
        x_powered_by,
        emit_close,
    )
    .await?
    {
        return Ok(());
    }

    let mut range_start: u64 = 0;
    let mut range_end: u64 = view_size.saturating_sub(1);
    let mut is_partial = false;

    match resolve_range(
        accept_ranges,
        range_header,
        if_range,
        view_size,
        etag_val.as_deref(),
        last_mod_str.as_deref(),
    ) {
        RangeOutcome::Partial(start, end) => {
            range_start = start;
            range_end = end;
            is_partial = true;
        }
        RangeOutcome::Unsatisfiable => {
            write_buf.clear();
            append_416(write_buf, view_size, x_powered_by, emit_close);
            writer.write_all(write_buf).await?;
            return Ok(());
        }
        RangeOutcome::Full => {}
    }

    let content_len = if view_size == 0 {
        0
    } else {
        range_end - range_start + 1
    };
    let final_status = if is_partial && status == 200 {
        206
    } else {
        status
    };

    write_file_headers(
        write_buf,
        &FileHeaderParams {
            file_path,
            status: final_status,
            content_len,
            file_size: view_size,
            partial: is_partial.then_some((range_start, range_end)),
            etag: etag_val.as_deref(),
            last_modified: last_mod_str.as_deref(),
            extra_headers,
            accept_ranges,
            cache_control,
            max_age_secs,
            immutable,
            x_powered_by,
            emit_close,
        },
    );

    if is_head || content_len == 0 {
        writer.write_all(write_buf).await?;
        return Ok(());
    }

    write_file_body(
        writer,
        write_buf,
        &mut file,
        base + range_start,
        content_len,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::static_files::test_util::make_temp_dir;

    #[tokio::test]
    async fn streaming_truncation_returns_stream_aborted_without_404_desync() {
        let base = make_temp_dir("trunc");
        let p = base.join("large.bin");
        let data = vec![b'x'; 80 * 1024];
        std::fs::write(&p, &data).unwrap();

        let std_file = std::fs::File::open(&p).unwrap();
        let meta = std_file.metadata().unwrap();
        let tokio_file = File::from_std(std_file);
        // Pretend file_size is larger than actual readable bytes to deterministically trigger EOF mid-stream
        let claimed_size = meta.len() + 4096;

        let mut out = Vec::new();
        let mut wbuf = Vec::new();
        let res = write_file_response_from_open(
            &mut out,
            &mut wbuf,
            &p,
            tokio_file,
            claimed_size,
            meta.modified().ok(),
            false,
            None,
            None,
            None,
            None,
            200,
            &[],
            false,
            false,
            true,
            false,
            0,
            false,
            None,
            false,
            true,
        )
        .await;

        match res {
            Err(FileServeError::StreamAborted(e)) => {
                assert_eq!(e.kind(), ErrorKind::UnexpectedEof);
            }
            other => panic!("expected StreamAborted, got {other:?}"),
        }
        let s = String::from_utf8_lossy(&out);
        assert!(s.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(s.contains("Connection: close\r\n"));
        assert!(!s.contains("404 Not Found"));

        let _ = std::fs::remove_dir_all(&base);
    }
}
