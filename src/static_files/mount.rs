use super::cache::TL_STATIC_CACHE;
use super::resolve::{path_has_dot_component, resolve_mount_miss_blocking};
use super::DotfilesPolicy;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncWrite, AsyncWriteExt};

static NEXT_MOUNT_ID: AtomicU64 = AtomicU64::new(1);

/// Every `%` starts a two-hex-digit escape (`decodeURIComponent` would not throw).
fn percent_escapes_valid(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if i + 2 >= b.len() {
                return false;
            }
            if !(b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit()) {
                return false;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    true
}

#[derive(Clone)]
pub struct StaticMount {
    pub id: u64,
    pub prefix: String,
    pub root: PathBuf,
    pub canon_root: Option<PathBuf>,
    pub index: Vec<String>,
    pub max_age_secs: u64,
    pub etag: bool,
    pub last_modified: bool,
    pub dotfiles: String,
    pub fallthrough: bool,
    pub extensions: Vec<String>,
    pub immutable: bool,
    pub redirect: bool,
}

impl StaticMount {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        prefix: String,
        root: PathBuf,
        index: Vec<String>,
        max_age_secs: u64,
        etag: bool,
        last_modified: bool,
        dotfiles: String,
        fallthrough: bool,
        extensions: Vec<String>,
        immutable: bool,
        redirect: bool,
    ) -> Self {
        let canon_root = std::fs::canonicalize(&root).ok();
        Self {
            id: NEXT_MOUNT_ID.fetch_add(1, Ordering::Relaxed),
            prefix,
            root,
            canon_root,
            index,
            max_age_secs,
            etag,
            last_modified,
            dotfiles,
            fallthrough,
            extensions,
            immutable,
            redirect,
        }
    }

    #[inline]
    pub fn matches_prefix<'a>(&self, req_path: &'a str) -> Option<&'a str> {
        if self.prefix.is_empty() || self.prefix == "/" {
            return Some(req_path);
        }
        if req_path == self.prefix {
            return Some("/");
        }
        if let Some(rest) = req_path.strip_prefix(&self.prefix) {
            if rest.starts_with('/') || self.prefix.ends_with('/') {
                return Some(rest);
            }
        }
        None
    }

    /// Ultra-fast synchronous thread-local cache lookup that APPENDS the full HTTP response
    /// directly onto `out_buf` (allowing pipelined responses to coalesce into a single write syscall!).
    #[allow(clippy::too_many_arguments)]
    #[inline]
    pub fn try_append_cached(
        &self,
        out_buf: &mut Vec<u8>,
        is_head: bool,
        req_path: &str,
        if_none_match: Option<&str>,
        if_modified_since: Option<&str>,
        range_header: Option<&str>,
        if_range: Option<&str>,
        x_powered_by: bool,
        close_conn: bool,
    ) -> bool {
        let Some(rel_raw) = self.matches_prefix(req_path) else {
            return false;
        };
        if (rel_raw == "/" && !req_path.ends_with('/'))
            || rel_raw.contains("..")
            || rel_raw.contains('\0')
            || rel_raw.contains('\\')
        {
            return false;
        }
        TL_STATIC_CACHE.with(|cell| {
            let cache = cell.borrow();
            let Some(slot) = cache.get(self.id, rel_raw) else {
                return false;
            };
            self.append_cached_slot(
                slot,
                out_buf,
                is_head,
                if_none_match,
                if_modified_since,
                range_header,
                if_range,
                x_powered_by,
                close_conn,
            );
            true
        })
    }

    /// Lexically normalises a percent-decoded mount-relative path the way `send` does
    /// (`normalize('./' + path)`) and applies the dotfiles policy, before any filesystem
    /// access. `None` = not for the engine to answer: a path that climbs above the root or a
    /// hidden file the policy refuses is handed to the JS handler, which raises the same
    /// error (or falls through) as Express.
    fn sanitize_rel_path(&self, decoded: &str) -> Option<PathBuf> {
        let mut clean_rel = PathBuf::new();
        for comp in Path::new(decoded).components() {
            match comp {
                Component::Normal(seg) => clean_rel.push(seg),
                Component::RootDir | Component::CurDir => {}
                Component::ParentDir => {
                    if !clean_rel.pop() {
                        return None;
                    }
                }
                Component::Prefix(_) => return None,
            }
        }
        if self.dotfiles != "allow" && path_has_dot_component(&clean_rel) {
            return None;
        }
        Some(clean_rel)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn try_serve<W: AsyncWrite + Unpin>(
        &self,
        writer: &mut W,
        write_buf: &mut Vec<u8>,
        is_head: bool,
        req_path: &str,
        query_str: &str,
        if_none_match: Option<&str>,
        if_modified_since: Option<&str>,
        range_header: Option<&str>,
        if_range: Option<&str>,
        x_powered_by: bool,
        close_conn: bool,
    ) -> std::io::Result<bool> {
        let Some(rel_raw) = self.matches_prefix(req_path) else {
            return Ok(false);
        };

        let is_mount_root = rel_raw == "/";
        let has_trailing_slash = req_path.ends_with('/');

        // ZERO-LOCK, ZERO-ATOMIC, ZERO-SYSCALL THREAD-LOCAL CACHE HIT!
        if !(is_mount_root && !has_trailing_slash)
            && !rel_raw.contains("..")
            && !rel_raw.contains('\0')
            && !rel_raw.contains('\\')
        {
            let hit = TL_STATIC_CACHE.with(|cell| {
                let cache = cell.borrow();
                let Some(slot) = cache.get(self.id, rel_raw) else {
                    return false;
                };
                write_buf.clear();
                self.append_cached_slot(
                    slot,
                    write_buf,
                    is_head,
                    if_none_match,
                    if_modified_since,
                    range_header,
                    if_range,
                    x_powered_by,
                    close_conn,
                );
                true
            });

            if hit {
                writer.write_all(write_buf).await?;
                return Ok(true);
            }
        }

        // Malformed escapes, invalid UTF-8 and NUL bytes are 400s (or fall-throughs) that the
        // JS handler raises as Express errors.
        if !percent_escapes_valid(rel_raw) {
            return Ok(false);
        }
        let Ok(decoded) = percent_encoding::percent_decode_str(rel_raw).decode_utf8() else {
            return Ok(false);
        };
        if decoded.contains('\0') {
            return Ok(false);
        }
        let Some(clean_rel) = self.sanitize_rel_path(decoded.as_ref()) else {
            return Ok(false);
        };

        let root = self.root.clone();
        let canon_root = self.canon_root.clone();
        let index_files = self.index.clone();
        let extensions = self.extensions.clone();
        let redirect = self.redirect;
        let dot_policy = DotfilesPolicy::from_str(&self.dotfiles);

        let miss = tokio::task::spawn_blocking(move || {
            resolve_mount_miss_blocking(
                &root,
                canon_root,
                &clean_rel,
                &index_files,
                &extensions,
                has_trailing_slash,
                redirect,
                dot_policy,
            )
        })
        .await
        .map_err(std::io::Error::other)?;

        self.write_miss_response(
            writer,
            write_buf,
            miss,
            rel_raw,
            req_path,
            query_str,
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::static_files::cache::{CACHE_MAX_ENTRIES, TL_STATIC_CACHE};
    use crate::static_files::test_util::make_temp_dir;

    #[tokio::test]
    async fn canon_containment_defers_symlink_escape_and_missing_root_to_js() {
        let base = make_temp_dir("canon");
        let root = base.join("pub");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, b"TOP_SECRET").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, root.join("escape.txt")).unwrap();

        let mount = StaticMount::new(
            "/pub".into(),
            root.clone(),
            vec!["index.html".into()],
            0,
            true,
            true,
            "ignore".into(),
            false,
            vec![],
            false,
            true,
        );

        #[cfg(unix)]
        {
            let mut out = Vec::new();
            let mut wbuf = Vec::new();
            let served = mount
                .try_serve(
                    &mut out,
                    &mut wbuf,
                    false,
                    "/pub/escape.txt",
                    "",
                    None,
                    None,
                    None,
                    None,
                    false,
                    true,
                )
                .await
                .unwrap();
            // Refused, not served: the JS handler raises the 403 (`ForbiddenError`).
            assert!(!served);
            assert!(out.is_empty());
        }

        // Nonexistent root -> canon_root is None -> MUST fail closed (handed to JS, never served)
        let missing_mount = StaticMount::new(
            "/miss".into(),
            base.join("does-not-exist"),
            vec![],
            0,
            true,
            true,
            "ignore".into(),
            false,
            vec![],
            false,
            true,
        );
        assert!(missing_mount.canon_root.is_none());
        let mut out2 = Vec::new();
        let mut wbuf2 = Vec::new();
        let served2 = missing_mount
            .try_serve(
                &mut out2,
                &mut wbuf2,
                true,
                "/miss/any.txt",
                "",
                None,
                None,
                None,
                None,
                false,
                true,
            )
            .await
            .unwrap();
        assert!(!served2);
        assert!(out2.is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn tl_static_cache_clock_eviction_and_cached_range_serving() {
        let base = make_temp_dir("clock-cache");
        for i in 0..300 {
            std::fs::write(base.join(format!("f{i}.txt")), b"0123456789").unwrap();
        }
        let mount = StaticMount::new(
            "/s".into(),
            base.clone(),
            vec![],
            60,
            true,
            true,
            "ignore".into(),
            false,
            vec![],
            true,
            true,
        );

        let mut sink = Vec::new();
        let mut wbuf = Vec::new();
        for i in 0..300 {
            sink.clear();
            let path = format!("/s/f{i}.txt");
            assert!(mount
                .try_serve(
                    &mut sink, &mut wbuf, false, &path, "", None, None, None, None, false, false,
                )
                .await
                .unwrap());
        }

        TL_STATIC_CACHE.with(|cell| {
            assert!(cell.borrow().slots.len() <= CACHE_MAX_ENTRIES);
        });

        // f299 is definitely in cache; delete from disk and verify cached Range / 416 / If-Range / 304 / Connection: close
        std::fs::remove_file(base.join("f299.txt")).unwrap();
        let mut out_206 = Vec::new();
        assert!(mount.try_append_cached(
            &mut out_206,
            false,
            "/s/f299.txt",
            None,
            None,
            Some("BYTES=2-5"),
            None,
            false,
            true,
        ));
        let s206 = String::from_utf8_lossy(&out_206);
        assert!(s206.starts_with("HTTP/1.1 206 Partial Content\r\n"));
        assert!(s206.contains("Content-Range: bytes 2-5/10\r\n"));
        assert!(s206.contains("Cache-Control: public, max-age=60, immutable\r\n"));
        assert!(s206.contains("Connection: close\r\n"));
        assert!(s206.ends_with("\r\n\r\n2345"));

        let mut out_416 = Vec::new();
        assert!(mount.try_append_cached(
            &mut out_416,
            false,
            "/s/f299.txt",
            None,
            None,
            Some("bytes=50-60"),
            None,
            false,
            true,
        ));
        let s416 = String::from_utf8_lossy(&out_416);
        assert!(s416.starts_with("HTTP/1.1 416 Range Not Satisfiable\r\n"));
        assert!(s416.contains("Content-Range: bytes */10\r\n"));
        assert!(s416.contains("Connection: close\r\n"));

        let mut out_ir_miss = Vec::new();
        assert!(mount.try_append_cached(
            &mut out_ir_miss,
            false,
            "/s/f299.txt",
            None,
            None,
            Some("bytes=0-2"),
            Some("\"stale-etag\""),
            false,
            false,
        ));
        let sir = String::from_utf8_lossy(&out_ir_miss);
        assert!(sir.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(sir.ends_with("\r\n\r\n0123456789"));

        let _ = std::fs::remove_dir_all(&base);
    }
}
