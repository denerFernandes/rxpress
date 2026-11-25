//! Pre-built HTTP/1.1 response bytes: reason phrases, simple status responses, and the
//! `Connection` / HTTP/1.0 keep-alive header helpers.

use super::validate::is_reason_header;
use crate::date::get_date_header_bytes;
use bytes::Bytes;

/// The reason phrase to send: the `:reason` pseudo-header if present, else the standard one.
pub fn reason_for(status: u16, headers: &[(String, String)]) -> &str {
    headers
        .iter()
        .find(|(k, _)| is_reason_header(k.as_bytes()))
        .map(|(_, v)| v.as_str())
        .unwrap_or_else(|| status_reason(status))
}

#[inline]
pub fn status_reason(code: u16) -> &'static str {
    match code {
        100 => "Continue",
        101 => "Switching Protocols",
        102 => "Processing",
        103 => "Early Hints",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        203 => "Non-Authoritative Information",
        204 => "No Content",
        205 => "Reset Content",
        206 => "Partial Content",
        207 => "Multi-Status",
        208 => "Already Reported",
        226 => "IM Used",
        300 => "Multiple Choices",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        305 => "Use Proxy",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        407 => "Proxy Authentication Required",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        411 => "Length Required",
        412 => "Precondition Failed",
        413 => "Payload Too Large",
        414 => "URI Too Long",
        415 => "Unsupported Media Type",
        416 => "Range Not Satisfiable",
        417 => "Expectation Failed",
        418 => "I'm a Teapot",
        421 => "Misdirected Request",
        422 => "Unprocessable Entity",
        423 => "Locked",
        424 => "Failed Dependency",
        425 => "Too Early",
        426 => "Upgrade Required",
        428 => "Precondition Required",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        451 => "Unavailable For Legal Reasons",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        505 => "HTTP Version Not Supported",
        506 => "Variant Also Negotiates",
        507 => "Insufficient Storage",
        508 => "Loop Detected",
        510 => "Not Extended",
        511 => "Network Authentication Required",
        _ => "Unknown",
    }
}

pub fn build_simple_raw_response(status: u16, x_powered_by: bool, close: bool) -> Bytes {
    let reason = status_reason(status);
    let mut num_buf = itoa::Buffer::new();
    let status_str = num_buf.format(status);
    let len_str_buf = reason.as_bytes();
    let mut out = Vec::with_capacity(160 + len_str_buf.len() * 2);
    out.extend_from_slice(b"HTTP/1.1 ");
    out.extend_from_slice(status_str.as_bytes());
    out.push(b' ');
    out.extend_from_slice(len_str_buf);
    out.extend_from_slice(b"\r\nContent-Type: text/plain; charset=utf-8\r\n");
    if x_powered_by {
        out.extend_from_slice(b"X-Powered-By: Express\r\n");
    }
    if close {
        out.extend_from_slice(b"Connection: close\r\n");
    }
    let mut cl_buf = itoa::Buffer::new();
    out.extend_from_slice(b"Content-Length: ");
    out.extend_from_slice(cl_buf.format(len_str_buf.len()).as_bytes());
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(&get_date_header_bytes());
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(len_str_buf);
    Bytes::from(out)
}

#[inline]
fn headers_contain_connection(hdr_block: &[u8]) -> bool {
    let mut pos = 0;
    // Skip status line
    if let Some(first_nl) = hdr_block.windows(2).position(|w| w == b"\r\n") {
        pos = first_nl + 2;
    }
    while pos < hdr_block.len() {
        let rest = &hdr_block[pos..];
        let line_len = rest
            .windows(2)
            .position(|w| w == b"\r\n")
            .unwrap_or(rest.len());
        let line = &rest[..line_len];
        if line.len() >= 11 && line[..11].eq_ignore_ascii_case(b"connection:") {
            return true;
        }
        pos += line_len + 2;
    }
    false
}

tokio::task_local! {
    /// Per-connection: the response being written answers an HTTP/1.0 keep-alive request, so the
    /// persistence must be announced (`Connection: keep-alive`), as Node does.
    pub static HTTP10_KEEP_ALIVE: std::cell::Cell<bool>;
}

#[inline]
pub fn http10_keep_alive() -> bool {
    HTTP10_KEEP_ALIVE.try_with(|c| c.get()).unwrap_or(false)
}

#[inline]
pub fn set_http10_keep_alive(v: bool) {
    let _ = HTTP10_KEEP_ALIVE.try_with(|c| c.set(v));
}

/// `Connection: close` when closing, `Connection: keep-alive` for HTTP/1.0 keep-alive, else nothing
/// (persistence is the HTTP/1.1 default).
#[inline]
pub fn push_connection_header(out: &mut Vec<u8>, close: bool) {
    if close {
        out.extend_from_slice(b"Connection: close\r\n");
    } else if http10_keep_alive() {
        out.extend_from_slice(b"Connection: keep-alive\r\n");
    }
}

/// Copy a pre-built response, adding `connection` (unless it already has one) and dropping
/// the body for HEAD.
pub fn append_raw_http_with_connection(
    raw: &[u8],
    out: &mut Vec<u8>,
    is_head: bool,
    connection: &[u8],
) {
    let Some(hdr_end) = raw.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4) else {
        out.extend_from_slice(raw);
        return;
    };
    let hdr_block = &raw[..hdr_end - 2];
    out.extend_from_slice(hdr_block);
    if !headers_contain_connection(hdr_block) {
        out.extend_from_slice(connection);
    }
    out.extend_from_slice(b"\r\n");
    if !is_head && hdr_end < raw.len() {
        out.extend_from_slice(&raw[hdr_end..]);
    }
}

pub fn append_raw_http_with_close(raw: &[u8], out: &mut Vec<u8>, is_head: bool) {
    append_raw_http_with_connection(raw, out, is_head, b"Connection: close\r\n");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_reason_covers_standard_and_unknown_codes() {
        assert_eq!(status_reason(408), "Request Timeout");
        assert_eq!(status_reason(413), "Payload Too Large");
        assert_eq!(status_reason(417), "Expectation Failed");
        assert_eq!(status_reason(418), "I'm a Teapot");
        assert_eq!(status_reason(431), "Request Header Fields Too Large");
        assert_eq!(status_reason(501), "Not Implemented");
        assert_eq!(status_reason(504), "Gateway Timeout");
        assert_eq!(status_reason(505), "HTTP Version Not Supported");
        assert_eq!(status_reason(499), "Unknown");
    }

    #[test]
    fn append_raw_http_with_close_adds_header_once_and_strips_head_body() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello";
        let mut out = Vec::new();
        append_raw_http_with_close(raw, &mut out, false);
        assert_eq!(
            &out,
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello"
        );

        let mut head_out = Vec::new();
        append_raw_http_with_close(raw, &mut head_out, true);
        assert_eq!(
            &head_out,
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n"
        );

        let raw_with_conn = b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nhi";
        let mut out2 = Vec::new();
        append_raw_http_with_close(raw_with_conn, &mut out2, false);
        assert_eq!(&out2, raw_with_conn);
    }
}
