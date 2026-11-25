use super::file_response::write_file_response_from_open;
use super::resolve::path_has_dot_component;
use super::{DotfilesPolicy, FileServeError};
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use tokio::fs::File;
use tokio::io::AsyncWrite;

#[derive(Debug, Clone)]
pub struct SendFileRequest<'a> {
    pub file_path: &'a str,
    pub root: Option<&'a str>,
    pub accept_ranges: bool,
    pub last_modified: bool,
    pub cache_control: bool,
    pub immutable: bool,
    pub max_age_secs: u64,
    pub dotfiles: DotfilesPolicy,
    pub enable_etag: bool,
}

/// Open for reading without blocking on special files: a FIFO (named pipe) planted under a static
/// root would otherwise park a blocking-pool thread until a writer shows up. Callers still reject
/// anything that is not a regular file; for regular files `O_NONBLOCK` has no effect on reads.
pub(super) fn open_nonblocking(path: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NONBLOCK);
    }
    opts.open(path)
}

pub fn decode_sendfile_payload<'a>(
    body: &'a [u8],
    has_meta: bool,
    config_etag_enabled: bool,
    suppress_etag: bool,
) -> Option<SendFileRequest<'a>> {
    if !has_meta {
        let file_path = std::str::from_utf8(body).ok()?;
        return Some(SendFileRequest {
            file_path,
            root: None,
            accept_ranges: true,
            last_modified: true,
            cache_control: false,
            immutable: false,
            max_age_secs: 0,
            dotfiles: DotfilesPolicy::Ignore,
            enable_etag: config_etag_enabled && !suppress_etag,
        });
    }

    // Binary layout:
    // [0]: optsBits (u8)
    // [1..5]: maxAgeSecs (u32 LE)
    // [5..9]: filePathLen (u32 LE)
    // [9..9+N]: filePath (UTF-8)
    // if hasRoot: u32 LE rootLen + rootBytes (UTF-8)
    if body.len() < 9 {
        return None;
    }
    let opts = body[0];
    let max_age_secs = u32::from_le_bytes([body[1], body[2], body[3], body[4]]) as u64;
    let file_len = u32::from_le_bytes([body[5], body[6], body[7], body[8]]) as usize;
    let mut pos = 9usize;
    if body.len().saturating_sub(pos) < file_len {
        return None;
    }
    let file_path = std::str::from_utf8(&body[pos..pos + file_len]).ok()?;
    pos += file_len;

    let has_root = (opts & 0x10) != 0;
    let root = if has_root {
        if body.len().saturating_sub(pos) < 4 {
            return None;
        }
        let rlen =
            u32::from_le_bytes([body[pos], body[pos + 1], body[pos + 2], body[pos + 3]]) as usize;
        pos += 4;
        if body.len().saturating_sub(pos) < rlen {
            return None;
        }
        let r = std::str::from_utf8(&body[pos..pos + rlen]).ok()?;
        Some(r)
    } else {
        None
    };

    let dotfiles = match (opts >> 5) & 0x03 {
        1 => DotfilesPolicy::Allow,
        2 => DotfilesPolicy::Deny,
        _ => DotfilesPolicy::Ignore,
    };
    let meta_etag = (opts & 0x80) != 0;

    Some(SendFileRequest {
        file_path,
        root,
        accept_ranges: (opts & 0x01) != 0,
        last_modified: (opts & 0x02) != 0,
        cache_control: (opts & 0x04) != 0,
        immutable: (opts & 0x08) != 0,
        max_age_secs,
        dotfiles,
        enable_etag: config_etag_enabled && !suppress_etag && meta_etag,
    })
}

/// Lexically normalises the requested path (rejecting traversal) and applies the dotfiles policy
/// before any filesystem access. Returns the cleaned root-relative path (empty without a root).
fn clean_sendfile_path(req: &SendFileRequest<'_>) -> Result<PathBuf, FileServeError> {
    let mut clean_rel = PathBuf::new();
    let mut has_dotfile = false;

    if req.root.is_some() {
        let stripped = req.file_path.trim_start_matches(['/', '\\']);
        for comp in Path::new(stripped).components() {
            match comp {
                Component::Normal(seg) => {
                    if let Some(s) = seg.to_str() {
                        if s.starts_with('.') {
                            has_dotfile = true;
                        }
                    }
                    clean_rel.push(seg);
                }
                Component::CurDir | Component::RootDir => {}
                Component::ParentDir | Component::Prefix(_) => {
                    return Err(FileServeError::PreHeader(403));
                }
            }
        }
    } else {
        let p = Path::new(req.file_path);
        if !p.is_absolute() {
            return Err(FileServeError::PreHeader(403));
        }
        for comp in p.components() {
            match comp {
                Component::Normal(seg) => {
                    if let Some(s) = seg.to_str() {
                        if s.starts_with('.') {
                            has_dotfile = true;
                        }
                    }
                }
                Component::ParentDir => return Err(FileServeError::PreHeader(403)),
                _ => {}
            }
        }
    }

    if has_dotfile {
        match req.dotfiles {
            DotfilesPolicy::Deny => return Err(FileServeError::PreHeader(403)),
            DotfilesPolicy::Ignore => return Err(FileServeError::PreHeader(404)),
            DotfilesPolicy::Allow => {}
        }
    }

    Ok(clean_rel)
}

#[allow(clippy::too_many_arguments)]
pub async fn serve_sendfile<W: AsyncWrite + Unpin>(
    writer: &mut W,
    write_buf: &mut Vec<u8>,
    req: &SendFileRequest<'_>,
    is_head: bool,
    if_none_match: Option<&str>,
    if_modified_since: Option<&str>,
    range_header: Option<&str>,
    if_range: Option<&str>,
    status: u16,
    extra_headers: &[(String, String)],
    x_powered_by: bool,
    close_conn: bool,
) -> Result<(), FileServeError> {
    if req.file_path.is_empty()
        || req.file_path.contains('\0')
        || req.root.is_some_and(|r| r.is_empty() || r.contains('\0'))
    {
        return Err(FileServeError::PreHeader(400));
    }

    let clean_rel = clean_sendfile_path(req)?;

    let file_path_owned = req.file_path.to_string();
    let root_owned = req.root.map(|s| s.to_string());
    let dot_policy = req.dotfiles;

    let open_res = tokio::task::spawn_blocking(move || {
        open_sendfile_blocking(
            &file_path_owned,
            root_owned.as_deref(),
            &clean_rel,
            dot_policy,
        )
    })
    .await
    .map_err(|e| FileServeError::StreamAborted(std::io::Error::other(e)))?;

    let (resolved_path, std_file, meta) = open_res?;
    let file_size = meta.len();
    let mtime = meta.modified().ok();
    let tokio_file = File::from_std(std_file);

    write_file_response_from_open(
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
        status,
        extra_headers,
        req.enable_etag,
        req.last_modified,
        req.accept_ranges,
        req.cache_control,
        req.max_age_secs,
        req.immutable,
        x_powered_by,
        close_conn,
    )
    .await
}

fn open_sendfile_blocking(
    file_path: &str,
    root: Option<&str>,
    clean_rel: &Path,
    dot_policy: DotfilesPolicy,
) -> Result<(PathBuf, std::fs::File, std::fs::Metadata), FileServeError> {
    let canon_file = if let Some(r) = root {
        let canon_root = std::fs::canonicalize(r).map_err(|e| {
            FileServeError::PreHeader(if e.kind() == ErrorKind::PermissionDenied {
                403
            } else {
                404
            })
        })?;
        let candidate = Path::new(r).join(clean_rel);
        let cf = std::fs::canonicalize(&candidate).map_err(|e| {
            FileServeError::PreHeader(if e.kind() == ErrorKind::PermissionDenied {
                403
            } else {
                404
            })
        })?;
        if !cf.starts_with(&canon_root) {
            return Err(FileServeError::PreHeader(403));
        }
        if dot_policy != DotfilesPolicy::Allow {
            if let Ok(rel) = cf.strip_prefix(&canon_root) {
                if path_has_dot_component(rel) {
                    return Err(FileServeError::PreHeader(match dot_policy {
                        DotfilesPolicy::Deny => 403,
                        DotfilesPolicy::Ignore => 404,
                        DotfilesPolicy::Allow => unreachable!(),
                    }));
                }
            }
        }
        cf
    } else {
        std::fs::canonicalize(file_path).map_err(|e| {
            FileServeError::PreHeader(if e.kind() == ErrorKind::PermissionDenied {
                403
            } else {
                404
            })
        })?
    };

    let file = open_nonblocking(&canon_file).map_err(|e| {
        FileServeError::PreHeader(if e.kind() == ErrorKind::PermissionDenied {
            403
        } else {
            404
        })
    })?;
    let meta = file
        .metadata()
        .map_err(|_| FileServeError::PreHeader(404))?;
    if !meta.is_file() {
        return Err(FileServeError::PreHeader(404));
    }
    Ok((canon_file, file, meta))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::static_files::test_util::make_temp_dir;

    #[test]
    fn sendfile_payload_decodes_meta_and_legacy() {
        let mut payload = Vec::new();
        // opts: accept_ranges(1) | last_modified(2) | cache_control(4) | immutable(8) | has_root(16) | dotfiles=deny(2<<5) | etag(128)
        let opts: u8 = 0x01 | 0x02 | 0x04 | 0x08 | 0x10 | (2 << 5) | 0x80;
        payload.push(opts);
        payload.extend_from_slice(&3600u32.to_le_bytes());
        let fp = b"hello.txt";
        payload.extend_from_slice(&(fp.len() as u32).to_le_bytes());
        payload.extend_from_slice(fp);
        let root = b"/tmp/root";
        payload.extend_from_slice(&(root.len() as u32).to_le_bytes());
        payload.extend_from_slice(root);

        let req = decode_sendfile_payload(&payload, true, true, false).unwrap();
        assert_eq!(req.file_path, "hello.txt");
        assert_eq!(req.root, Some("/tmp/root"));
        assert!(req.accept_ranges);
        assert!(req.last_modified);
        assert!(req.cache_control);
        assert!(req.immutable);
        assert_eq!(req.max_age_secs, 3600);
        assert_eq!(req.dotfiles, DotfilesPolicy::Deny);
        assert!(req.enable_etag);

        let legacy = decode_sendfile_payload(b"/tmp/foo.txt", false, true, false).unwrap();
        assert_eq!(legacy.file_path, "/tmp/foo.txt");
        assert_eq!(legacy.root, None);
        assert!(!legacy.cache_control);
        assert!(legacy.accept_ranges);
    }

    #[tokio::test]
    async fn sendfile_options_and_containment_enforced_in_rust() {
        let base = make_temp_dir("sendfile");
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("ok.txt"), b"okdata").unwrap();
        std::fs::write(root.join(".hidden"), b"secret").unwrap();
        std::fs::write(outside.join("leak.txt"), b"leak").unwrap();

        let root_str = root.to_str().unwrap();

        // Traversal -> PreHeader(403)
        let mut out = Vec::new();
        let mut wbuf = Vec::new();
        let err_trav = serve_sendfile(
            &mut out,
            &mut wbuf,
            &SendFileRequest {
                file_path: "../outside/leak.txt",
                root: Some(root_str),
                accept_ranges: true,
                last_modified: true,
                cache_control: false,
                immutable: false,
                max_age_secs: 0,
                dotfiles: DotfilesPolicy::Ignore,
                enable_etag: true,
            },
            false,
            None,
            None,
            None,
            None,
            200,
            &[],
            false,
            true,
        )
        .await
        .unwrap_err();
        assert!(matches!(err_trav, FileServeError::PreHeader(403)));

        // Dotfile deny -> PreHeader(403), ignore -> PreHeader(404)
        let err_dot = serve_sendfile(
            &mut out,
            &mut wbuf,
            &SendFileRequest {
                file_path: ".hidden",
                root: Some(root_str),
                accept_ranges: true,
                last_modified: true,
                cache_control: false,
                immutable: false,
                max_age_secs: 0,
                dotfiles: DotfilesPolicy::Deny,
                enable_etag: true,
            },
            false,
            None,
            None,
            None,
            None,
            200,
            &[],
            false,
            true,
        )
        .await
        .unwrap_err();
        assert!(matches!(err_dot, FileServeError::PreHeader(403)));

        // accept_ranges: false + cache_control: false + last_modified: false + close_conn: true
        out.clear();
        serve_sendfile(
            &mut out,
            &mut wbuf,
            &SendFileRequest {
                file_path: "ok.txt",
                root: Some(root_str),
                accept_ranges: false,
                last_modified: false,
                cache_control: false,
                immutable: false,
                max_age_secs: 0,
                dotfiles: DotfilesPolicy::Ignore,
                enable_etag: false,
            },
            false,
            None,
            None,
            Some("bytes=0-1"),
            None,
            200,
            &[],
            false,
            true,
        )
        .await
        .unwrap();
        let resp = String::from_utf8_lossy(&out);
        assert!(resp.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(!resp.contains("Accept-Ranges:"));
        assert!(!resp.contains("Last-Modified:"));
        assert!(!resp.contains("Cache-Control:"));
        assert!(!resp.contains("ETag:"));
        assert!(resp.contains("Connection: close\r\n"));
        assert!(resp.ends_with("\r\n\r\nokdata"));

        let _ = std::fs::remove_dir_all(&base);
    }
}
