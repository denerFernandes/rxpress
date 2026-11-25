use super::cache::CACHE_MAX_FILE_SIZE;
use super::sendfile::open_nonblocking;
use super::DotfilesPolicy;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

pub(super) enum MissResolve {
    SmallFile {
        resolved_path: PathBuf,
        data: Vec<u8>,
        file_size: u64,
        mtime: Option<SystemTime>,
    },
    LargeFile {
        resolved_path: PathBuf,
        file: std::fs::File,
        file_size: u64,
        mtime: Option<SystemTime>,
    },
    DirRedirect,
    NotFound,
    Forbidden,
}

#[inline]
pub(super) fn path_has_dot_component(p: &Path) -> bool {
    p.components().any(
        |c| matches!(c, Component::Normal(seg) if seg.to_str().is_some_and(|s| s.starts_with('.'))),
    )
}

fn try_open_contained(
    candidate: &Path,
    canon_root: &Path,
    dot_policy: DotfilesPolicy,
) -> Result<(PathBuf, std::fs::File, std::fs::Metadata), MissResolve> {
    let canon_file = match std::fs::canonicalize(candidate) {
        Ok(p) => p,
        Err(e) => {
            return Err(if e.kind() == ErrorKind::PermissionDenied {
                MissResolve::Forbidden
            } else {
                MissResolve::NotFound
            });
        }
    };
    if !canon_file.starts_with(canon_root) {
        return Err(MissResolve::Forbidden);
    }
    if dot_policy != DotfilesPolicy::Allow {
        if let Ok(rel) = canon_file.strip_prefix(canon_root) {
            if path_has_dot_component(rel) {
                return Err(match dot_policy {
                    DotfilesPolicy::Deny => MissResolve::Forbidden,
                    DotfilesPolicy::Ignore => MissResolve::NotFound,
                    DotfilesPolicy::Allow => unreachable!(),
                });
            }
        }
    }
    let file = match open_nonblocking(&canon_file) {
        Ok(f) => f,
        Err(e) => {
            return Err(if e.kind() == ErrorKind::PermissionDenied {
                MissResolve::Forbidden
            } else {
                MissResolve::NotFound
            });
        }
    };
    let meta = match file.metadata() {
        Ok(m) => m,
        Err(_) => return Err(MissResolve::NotFound),
    };
    if !meta.is_file() {
        return Err(MissResolve::NotFound);
    }
    Ok((canon_file, file, meta))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn resolve_mount_miss_blocking(
    root: &Path,
    canon_root_opt: Option<PathBuf>,
    clean_rel: &Path,
    index_files: &[String],
    extensions: &[String],
    has_trailing_slash: bool,
    redirect: bool,
    dot_policy: DotfilesPolicy,
) -> MissResolve {
    // Fail closed if root cannot be canonicalized
    let canon_root = match canon_root_opt {
        Some(cr) => cr,
        None => match std::fs::canonicalize(root) {
            Ok(cr) => cr,
            Err(_) => return MissResolve::NotFound,
        },
    };

    let candidate = root.join(clean_rel);

    let opened = match std::fs::metadata(&candidate) {
        Ok(meta) => {
            if meta.is_file() {
                if has_trailing_slash {
                    return MissResolve::NotFound;
                }
                match try_open_contained(&candidate, &canon_root, dot_policy) {
                    Ok(v) => Some(v),
                    Err(e) => return e,
                }
            } else if meta.is_dir() {
                let canon_dir = match std::fs::canonicalize(&candidate) {
                    Ok(d) => d,
                    Err(e) => {
                        return if e.kind() == ErrorKind::PermissionDenied {
                            MissResolve::Forbidden
                        } else {
                            MissResolve::NotFound
                        };
                    }
                };
                if !canon_dir.starts_with(&canon_root) {
                    return MissResolve::Forbidden;
                }
                if !has_trailing_slash {
                    return if redirect {
                        MissResolve::DirRedirect
                    } else {
                        MissResolve::NotFound
                    };
                }
                let mut found = None;
                for idx in index_files {
                    let idx_path = candidate.join(idx);
                    match try_open_contained(&idx_path, &canon_root, dot_policy) {
                        Ok(v) => {
                            found = Some(v);
                            break;
                        }
                        Err(MissResolve::Forbidden) => return MissResolve::Forbidden,
                        Err(_) => continue,
                    }
                }
                found
            } else {
                None
            }
        }
        Err(_) => {
            let mut found = None;
            if !has_trailing_slash && !extensions.is_empty() {
                let base_str = candidate.to_string_lossy();
                for ext in extensions {
                    let ext_clean = ext.trim_start_matches('.');
                    let with_ext = PathBuf::from(format!("{base_str}.{ext_clean}"));
                    match try_open_contained(&with_ext, &canon_root, dot_policy) {
                        Ok(v) => {
                            found = Some(v);
                            break;
                        }
                        Err(MissResolve::Forbidden) => return MissResolve::Forbidden,
                        Err(_) => continue,
                    }
                }
            }
            found
        }
    };

    let Some((resolved_path, mut file, meta)) = opened else {
        return MissResolve::NotFound;
    };

    let file_size = meta.len();
    let mtime = meta.modified().ok();
    if file_size <= CACHE_MAX_FILE_SIZE {
        let mut data = Vec::with_capacity(file_size as usize);
        if std::io::Read::read_to_end(&mut file, &mut data).is_err() {
            return MissResolve::NotFound;
        }
        let actual_size = data.len() as u64;
        MissResolve::SmallFile {
            resolved_path,
            data,
            file_size: actual_size,
            mtime,
        }
    } else {
        MissResolve::LargeFile {
            resolved_path,
            file,
            file_size,
            mtime,
        }
    }
}
