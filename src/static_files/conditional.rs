use crate::date::write_date_header;
use std::time::{SystemTime, UNIX_EPOCH};

#[inline]
pub(super) fn format_weak_etag(file_size: u64, mtime: Option<SystemTime>) -> String {
    let ms = mtime
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("W/\"{file_size:x}-{ms:x}\"")
}

#[inline]
pub(super) fn append_cache_control(out: &mut Vec<u8>, max_age_secs: u64, immutable: bool) {
    let mut nb = itoa::Buffer::new();
    out.extend_from_slice(b"Cache-Control: public, max-age=");
    out.extend_from_slice(nb.format(max_age_secs).as_bytes());
    if immutable {
        out.extend_from_slice(b", immutable");
    }
    out.extend_from_slice(b"\r\n");
}

#[inline]
pub(super) fn append_416(out: &mut Vec<u8>, file_size: u64, x_powered_by: bool, close_conn: bool) {
    let mut nb = itoa::Buffer::new();
    out.extend_from_slice(b"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */");
    out.extend_from_slice(nb.format(file_size).as_bytes());
    out.extend_from_slice(b"\r\nContent-Length: 0\r\n");
    if x_powered_by {
        out.extend_from_slice(b"X-Powered-By: Express\r\n");
    }
    crate::protocol::push_connection_header(out, close_conn);
    write_date_header(out);
    out.extend_from_slice(b"\r\n");
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeParseResult {
    Satisfiable(u64, u64),
    Unsatisfiable,
    Ignore,
}

pub fn parse_single_range(header: &str, file_size: u64) -> RangeParseResult {
    let trimmed = header.trim();
    // Byte comparison: the header is client data and may hold multi-byte UTF-8 right where a
    // `&str` slice at offset 6 would split a character (and panic).
    let Some(spec) = trimmed
        .as_bytes()
        .get(..6)
        .filter(|p| p.eq_ignore_ascii_case(b"bytes="))
        .and_then(|_| trimmed.get(6..))
    else {
        return RangeParseResult::Ignore;
    };
    let spec = spec.trim();
    if spec.is_empty() || spec.contains(',') {
        return RangeParseResult::Ignore;
    }
    let Some((start_raw, end_raw)) = spec.split_once('-') else {
        return RangeParseResult::Ignore;
    };
    let start_s = start_raw.trim();
    let end_s = end_raw.trim();
    if !start_s.bytes().all(|b| b.is_ascii_digit()) || !end_s.bytes().all(|b| b.is_ascii_digit()) {
        return RangeParseResult::Ignore;
    }
    if start_s.is_empty() {
        if end_s.is_empty() {
            return RangeParseResult::Ignore;
        }
        let Ok(suffix) = end_s.parse::<u64>() else {
            return RangeParseResult::Ignore;
        };
        if suffix == 0 || file_size == 0 {
            return RangeParseResult::Unsatisfiable;
        }
        return RangeParseResult::Satisfiable(file_size.saturating_sub(suffix), file_size - 1);
    }

    let Ok(start) = start_s.parse::<u64>() else {
        return RangeParseResult::Ignore;
    };
    if !end_s.is_empty() {
        let Ok(end_req) = end_s.parse::<u64>() else {
            return RangeParseResult::Ignore;
        };
        if start > end_req {
            return RangeParseResult::Ignore;
        }
        if file_size == 0 || start >= file_size {
            return RangeParseResult::Unsatisfiable;
        }
        RangeParseResult::Satisfiable(start, end_req.min(file_size - 1))
    } else {
        if file_size == 0 || start >= file_size {
            return RangeParseResult::Unsatisfiable;
        }
        RangeParseResult::Satisfiable(start, file_size - 1)
    }
}

pub fn if_range_matches(if_range: &str, etag: Option<&str>, last_modified: Option<&str>) -> bool {
    let ir = if_range.trim();
    if ir.is_empty() {
        return false;
    }
    if ir.starts_with('"') || ir.starts_with("W/\"") {
        return etag.is_some_and(|et| ir == et);
    }
    if let Some(lm) = last_modified {
        if ir == lm {
            return true;
        }
        if let (Ok(t_ir), Ok(t_lm)) = (httpdate::parse_http_date(ir), httpdate::parse_http_date(lm))
        {
            return t_ir == t_lm;
        }
    }
    false
}

#[inline]
pub fn http_date_not_modified(if_modified_since: &str, last_modified: &str) -> bool {
    let ims = if_modified_since.trim();
    if ims == last_modified {
        return true;
    }
    if let (Ok(t_ims), Ok(t_lm)) = (
        httpdate::parse_http_date(ims),
        httpdate::parse_http_date(last_modified),
    ) {
        return t_ims >= t_lm;
    }
    false
}

pub fn etag_matches(if_none_match: &str, current_etag: &str) -> bool {
    let trimmed = if_none_match.trim();
    if trimmed == "*" {
        return true;
    }
    let cur_clean = current_etag.strip_prefix("W/").unwrap_or(current_etag);
    for candidate in trimmed.split(',') {
        let c = candidate.trim();
        let c_clean = c.strip_prefix("W/").unwrap_or(c);
        if c_clean == cur_clean {
            return true;
        }
    }
    false
}

#[inline]
pub(super) fn append_304(
    write_buf: &mut Vec<u8>,
    etag: Option<&str>,
    last_modified: Option<&str>,
    x_powered_by: bool,
    close_conn: bool,
) {
    write_buf.extend_from_slice(b"HTTP/1.1 304 Not Modified\r\n");
    if let Some(et) = etag {
        write_buf.extend_from_slice(b"ETag: ");
        write_buf.extend_from_slice(et.as_bytes());
        write_buf.extend_from_slice(b"\r\n");
    }
    if let Some(lm) = last_modified {
        write_buf.extend_from_slice(b"Last-Modified: ");
        write_buf.extend_from_slice(lm.as_bytes());
        write_buf.extend_from_slice(b"\r\n");
    }
    if x_powered_by {
        write_buf.extend_from_slice(b"X-Powered-By: Express\r\n");
    }
    crate::protocol::push_connection_header(write_buf, close_conn);
    write_date_header(write_buf);
    write_buf.extend_from_slice(b"\r\n");
}

#[inline]
pub(super) fn format_304(
    write_buf: &mut Vec<u8>,
    etag: Option<&str>,
    last_modified: Option<&str>,
    x_powered_by: bool,
    close_conn: bool,
) {
    write_buf.clear();
    append_304(write_buf, etag, last_modified, x_powered_by, close_conn);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parser_never_panics_on_non_ascii() {
        // `bytesé=0-1`: byte 6 is inside the two-byte `é` (regression: used to panic).
        assert_eq!(
            parse_single_range("bytes\u{e9}=0-1", 10),
            RangeParseResult::Ignore
        );
        assert_eq!(
            parse_single_range("bytes=\u{e9}0-1", 10),
            RangeParseResult::Ignore
        );
        assert_eq!(
            parse_single_range("\u{e9}\u{e9}\u{e9}", 10),
            RangeParseResult::Ignore
        );
        assert_eq!(
            parse_single_range("bytes=0-1\u{e9}", 10),
            RangeParseResult::Ignore
        );
        for s in [
            "\u{1F600}",
            "byt\u{1F600}",
            "bytes\u{1F600}0-1",
            "b\u{e9}tes=0-1",
        ] {
            assert_eq!(parse_single_range(s, 10), RangeParseResult::Ignore, "{s}");
        }
    }

    #[test]
    fn range_parser_handles_rfc9110_edge_cases() {
        assert_eq!(
            parse_single_range("BYTES=0-3", 10),
            RangeParseResult::Satisfiable(0, 3)
        );
        assert_eq!(
            parse_single_range("bytes=7-999", 10),
            RangeParseResult::Satisfiable(7, 9)
        );
        assert_eq!(
            parse_single_range("bytes=-4", 10),
            RangeParseResult::Satisfiable(6, 9)
        );
        assert_eq!(
            parse_single_range("bytes=0-0", 0),
            RangeParseResult::Unsatisfiable
        );
        assert_eq!(
            parse_single_range("bytes=-0", 10),
            RangeParseResult::Unsatisfiable
        );
        assert_eq!(
            parse_single_range("bytes=10-20", 10),
            RangeParseResult::Unsatisfiable
        );
        assert_eq!(
            parse_single_range("bytes=abc", 10),
            RangeParseResult::Ignore
        );
        assert_eq!(
            parse_single_range("bytes=10-5", 10),
            RangeParseResult::Ignore
        );
        assert_eq!(
            parse_single_range("bytes=+0-2", 10),
            RangeParseResult::Ignore
        );
        assert_eq!(
            parse_single_range("bytes=0-1, 2-3", 10),
            RangeParseResult::Ignore
        );
        assert_eq!(
            parse_single_range("items=0-1", 10),
            RangeParseResult::Ignore
        );
    }

    #[test]
    fn if_range_matches_etag_and_http_date() {
        let et = Some("W/\"a-123\"");
        let lm = Some("Wed, 21 Oct 2015 07:28:00 GMT");
        assert!(if_range_matches("W/\"a-123\"", et, lm));
        assert!(!if_range_matches("W/\"a-999\"", et, lm));
        assert!(if_range_matches("Wed, 21 Oct 2015 07:28:00 GMT", et, lm));
        assert!(!if_range_matches("Thu, 22 Oct 2015 07:28:00 GMT", et, lm));
        assert!(!if_range_matches("", et, lm));
    }
}
