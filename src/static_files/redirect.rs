use crate::date::write_date_header;
use tokio::io::{AsyncWrite, AsyncWriteExt};

fn collapse_leading_slashes(s: &str) -> String {
    let trimmed = s.trim_start_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        format!("/{trimmed}")
    }
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

pub(super) async fn write_dir_redirect<W: AsyncWrite + Unpin>(
    writer: &mut W,
    write_buf: &mut Vec<u8>,
    req_path: &str,
    query_str: &str,
    is_head: bool,
    x_powered_by: bool,
    close_conn: bool,
) -> std::io::Result<()> {
    let with_slash = format!("{}/", collapse_leading_slashes(req_path));
    // Strip CR/LF/NUL defensively from Location
    let clean_loc_raw: String = format!("{with_slash}{query_str}")
        .chars()
        .filter(|&c| c != '\r' && c != '\n' && c != '\0')
        .collect();
    let escaped_body = format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Redirecting</title>\n</head>\n<body>\n<pre>Redirecting to {}</pre>\n</body>\n</html>\n",
        escape_html(&clean_loc_raw)
    );

    write_buf.clear();
    let mut nb = itoa::Buffer::new();
    write_buf.extend_from_slice(
        b"HTTP/1.1 301 Moved Permanently\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ",
    );
    write_buf.extend_from_slice(nb.format(escaped_body.len()).as_bytes());
    write_buf.extend_from_slice(
        b"\r\nContent-Security-Policy: default-src 'none'\r\nX-Content-Type-Options: nosniff\r\nLocation: ",
    );
    write_buf.extend_from_slice(clean_loc_raw.as_bytes());
    write_buf.extend_from_slice(b"\r\n");
    if x_powered_by {
        write_buf.extend_from_slice(b"X-Powered-By: Express\r\n");
    }
    crate::protocol::push_connection_header(write_buf, close_conn);
    write_date_header(write_buf);
    write_buf.extend_from_slice(b"\r\n");
    if !is_head {
        write_buf.extend_from_slice(escaped_body.as_bytes());
    }
    writer.write_all(write_buf).await
}
