use std::path::Path;

pub(super) fn detect_content_type(path: &Path) -> String {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    if mime.type_() == "text" || mime == "application/javascript" {
        format!("{mime}; charset=utf-8")
    } else {
        mime.to_string()
    }
}
