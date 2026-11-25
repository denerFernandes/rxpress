use std::path::Path;

/// `send`: `mime-types.contentType(extname(path))`, else `application/octet-stream`.
pub(super) fn detect_content_type(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .and_then(crate::mime_table::content_type_for_extension)
        .unwrap_or("application/octet-stream")
        .to_owned()
}
