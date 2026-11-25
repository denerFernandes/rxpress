//! Native ETag (Express-compatible `"<len hex>-<sha1 base64>"`) and the request-header scans
//! conditional responses need (`If-Range`, `Cache-Control: no-cache`).

/// The request's conditional / range headers, borrowed from its header block.
#[derive(Clone, Copy, Default)]
pub(super) struct CondHeaders<'h> {
    pub if_none_match: Option<&'h str>,
    pub if_modified_since: Option<&'h str>,
    pub range: Option<&'h str>,
    pub if_range: Option<&'h str>,
}

/// `buf[s..e]` as UTF-8, if present and valid.
#[inline]
pub(super) fn str_at(buf: &[u8], off: Option<(usize, usize)>) -> Option<&str> {
    off.and_then(|(s, e)| std::str::from_utf8(&buf[s..e]).ok())
}

impl<'h> CondHeaders<'h> {
    /// From header offsets (as produced by the parser) into `buf`. `If-Range` is only looked up
    /// when a valid `Range` is present.
    #[inline]
    pub(super) fn scan(
        buf: &'h [u8],
        if_none_match: Option<(usize, usize)>,
        if_modified_since: Option<(usize, usize)>,
        range: Option<(usize, usize)>,
        headers: (usize, usize),
    ) -> (Self, Option<(usize, usize)>) {
        let range = str_at(buf, range);
        let if_range_offsets = if range.is_some() {
            find_if_range_offsets(buf, headers.0, headers.1)
        } else {
            None
        };
        let cond = CondHeaders {
            if_none_match: str_at(buf, if_none_match),
            if_modified_since: str_at(buf, if_modified_since),
            range,
            if_range: str_at(buf, if_range_offsets),
        };
        (cond, if_range_offsets)
    }
}

/// Offsets of the trimmed `If-Range` value inside `buf[start..end]` (a raw header block).
#[inline]
pub(super) fn find_if_range_offsets(
    buf: &[u8],
    start: usize,
    end: usize,
) -> Option<(usize, usize)> {
    if start >= end || end > buf.len() {
        return None;
    }
    let mut pos = start;
    while pos < end {
        let line_end = buf[pos..end]
            .windows(2)
            .position(|w| w == b"\r\n")
            .map(|p| pos + p)
            .unwrap_or(end);
        let line = &buf[pos..line_end];
        if line.len() >= 9 && line[..9].eq_ignore_ascii_case(b"if-range:") {
            let mut vs = pos + 9;
            while vs < line_end && (buf[vs] == b' ' || buf[vs] == b'\t') {
                vs += 1;
            }
            let mut ve = line_end;
            while ve > vs && (buf[ve - 1] == b' ' || buf[ve - 1] == b'\t') {
                ve -= 1;
            }
            return Some((vs, ve));
        }
        pos = if line_end + 2 <= end {
            line_end + 2
        } else {
            end
        };
    }
    None
}

/// Whether the request head carries `Cache-Control: no-cache` (which disables 304 answers).
#[inline]
pub(super) fn header_block_has_no_cache(buf: &[u8]) -> bool {
    let mut pos = match buf.windows(2).position(|w| w == b"\r\n") {
        Some(p) => p + 2,
        None => return false,
    };
    while pos < buf.len() {
        let line_end = buf[pos..]
            .windows(2)
            .position(|w| w == b"\r\n")
            .map(|p| pos + p)
            .unwrap_or(buf.len());
        let line = &buf[pos..line_end];
        if line.is_empty() {
            break;
        }
        if line.len() >= 14 && line[..14].eq_ignore_ascii_case(b"cache-control:") {
            let val = &line[14..];
            for token in val.split(|&b| b == b',') {
                let mut s = 0;
                let mut e = token.len();
                while s < e && (token[s] == b' ' || token[s] == b'\t') {
                    s += 1;
                }
                while e > s && (token[e - 1] == b' ' || token[e - 1] == b'\t') {
                    e -= 1;
                }
                let trimmed = &token[s..e];
                if trimmed.eq_ignore_ascii_case(b"no-cache")
                    || (trimmed.len() > 9 && trimmed[..9].eq_ignore_ascii_case(b"no-cache="))
                {
                    return true;
                }
            }
        }
        pos = if line_end + 2 <= buf.len() {
            line_end + 2
        } else {
            buf.len()
        };
    }
    false
}

pub(super) fn compute_etag(body: &[u8], weak: bool) -> String {
    let mut hasher = sha1_smol::Sha1::new();
    hasher.update(body);
    let digest = hasher.digest().bytes();
    let b64 = base64_encode_20(&digest);
    if weak {
        format!("W/\"{:x}-{b64}\"", body.len())
    } else {
        format!("\"{:x}-{b64}\"", body.len())
    }
}

const B64_CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode_20(input: &[u8; 20]) -> String {
    let mut out = String::with_capacity(27);
    let mut i = 0;
    while i + 3 <= 20 {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | (input[i + 2] as u32);
        out.push(B64_CHARS[((n >> 18) & 63) as usize] as char);
        out.push(B64_CHARS[((n >> 12) & 63) as usize] as char);
        out.push(B64_CHARS[((n >> 6) & 63) as usize] as char);
        out.push(B64_CHARS[(n & 63) as usize] as char);
        i += 3;
    }
    let n = ((input[18] as u32) << 16) | ((input[19] as u32) << 8);
    out.push(B64_CHARS[((n >> 18) & 63) as usize] as char);
    out.push(B64_CHARS[((n >> 12) & 63) as usize] as char);
    out.push(B64_CHARS[((n >> 6) & 63) as usize] as char);
    out
}
