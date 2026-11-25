//! Allocation-free validators for JS-supplied response metadata (header names/values, status,
//! reason phrase, Content-Length).

#[inline]
pub fn is_valid_header_name(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    bytes.iter().all(|&b| {
        matches!(
            b,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
                | b'0'..=b'9'
                | b'A'..=b'Z'
                | b'a'..=b'z'
        )
    })
}

#[inline]
pub fn is_valid_header_value(bytes: &[u8]) -> bool {
    !bytes.iter().any(|&b| (b < 0x20 && b != b'\t') || b == 0x7F)
}

#[inline]
pub fn is_valid_status(status: u16) -> bool {
    (100..=999).contains(&status)
}

/// Pseudo-header the JS layer uses to carry a custom `res.statusMessage` (Node sends it verbatim).
/// A leading `:` can never be a real header name, so it cannot collide with user headers.
pub const REASON_HEADER: &str = ":reason";

#[inline]
pub fn is_reason_header(k: &[u8]) -> bool {
    k == REASON_HEADER.as_bytes()
}

/// Whether a JS-supplied `Content-Length` value states exactly `len` (1*DIGIT, optional OWS).
/// Allocation-free; anything unparsable counts as a mismatch.
#[inline]
pub fn content_length_matches(v: &[u8], len: usize) -> bool {
    let mut s = 0;
    let mut e = v.len();
    while s < e && (v[s] == b' ' || v[s] == b'\t') {
        s += 1;
    }
    while e > s && (v[e - 1] == b' ' || v[e - 1] == b'\t') {
        e -= 1;
    }
    if s == e || e - s > 20 {
        return false;
    }
    let mut n: u64 = 0;
    for &b in &v[s..e] {
        if !b.is_ascii_digit() {
            return false;
        }
        n = match n
            .checked_mul(10)
            .and_then(|n| n.checked_add(u64::from(b - b'0')))
        {
            Some(n) => n,
            None => return false,
        };
    }
    n == len as u64
}

/// reason-phrase = *( HTAB / SP / VCHAR / obs-text ) (RFC 9112 4); no CR/LF/NUL.
#[inline]
pub fn is_valid_reason(v: &[u8]) -> bool {
    v.iter()
        .all(|&b| b == b'\t' || (0x20..=0x7e).contains(&b) || b >= 0x80)
}

/// Header validation that also accepts the `:reason` pseudo-header.
#[inline]
pub fn is_valid_response_header(k: &[u8], v: &[u8]) -> bool {
    if is_reason_header(k) {
        is_valid_reason(v)
    } else {
        is_valid_header_name(k) && is_valid_header_value(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_and_status_validators_reject_crlf_and_invalid_tokens() {
        assert!(is_valid_header_name(b"X-Custom_1.0"));
        assert!(!is_valid_header_name(b""));
        assert!(!is_valid_header_name(b"Bad Name"));
        assert!(!is_valid_header_name(b"Bad:Name"));
        assert!(!is_valid_header_name(b"Bad\rName"));

        assert!(is_valid_header_value(b"hello\tworld"));
        assert!(!is_valid_header_value(b"val\r\nInjected: 1"));
        assert!(!is_valid_header_value(b"val\n"));
        assert!(!is_valid_header_value(b"val\0"));
        assert!(!is_valid_header_value(b"val\x7f"));

        assert!(is_valid_status(100));
        assert!(is_valid_status(200));
        assert!(is_valid_status(999));
        assert!(!is_valid_status(99));
        assert!(!is_valid_status(1000));
    }

    #[test]
    fn content_length_matches_is_strict() {
        assert!(content_length_matches(b"4", 4));
        assert!(content_length_matches(b" 4\t", 4));
        assert!(content_length_matches(b"0", 0));
        assert!(!content_length_matches(b"", 0));
        assert!(!content_length_matches(b"4", 5));
        assert!(!content_length_matches(b"+4", 4));
        assert!(!content_length_matches(b"4, 4", 4));
        assert!(!content_length_matches(b"99999999999999999999999", 4));
    }
}
