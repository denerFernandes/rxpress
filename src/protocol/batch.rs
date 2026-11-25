//! JS -> Rust response batch decoding (`dispatch_response_batch`).
//!
//! Frame layout (little-endian): req_id u32, status u16, ct_code u8, flags u8,
//! [header_count u16, (klen u16, key, vlen u16, value)*] if `RESP_FLAG_HAS_HEADERS`,
//! body_len u32, body.

use super::raw_response::{build_simple_raw_response, status_reason};
use super::validate::{
    content_length_matches, is_reason_header, is_valid_response_header, is_valid_status,
};
use crate::date::get_date_header_bytes;
use crate::slots::{SlotResponse, SlotTable};
use bytes::Bytes;

pub const CT_TEXT_PLAIN: u8 = 1;
pub const CT_JSON: u8 = 2;
pub const CT_HTML: u8 = 3;
pub const CT_OCTET_STREAM: u8 = 4;

pub const RESP_FLAG_HAS_HEADERS: u8 = 0x01;
pub const RESP_FLAG_IS_FILE: u8 = 0x02;
pub const RESP_FLAG_SUPPRESS_POWERED_BY: u8 = 0x04;
pub const RESP_FLAG_SUPPRESS_ETAG: u8 = 0x08;
pub const RESP_FLAG_FILE_META: u8 = 0x10;
/// Body sent by `res.send`/`res.json`/`res.jsonp`/`res.sendStatus`: apply Express's `res.send`
/// rules (ETag for any status, 304 when fresh, 204/205/304 body stripping). Without it the
/// response is a plain `res.end`, which Express never tags.
pub const RESP_FLAG_SEND: u8 = 0x20;

#[inline]
fn read_u16(buf: &[u8], pos: &mut usize) -> Option<u16> {
    if buf.len().saturating_sub(*pos) < 2 {
        return None;
    }
    let v = u16::from_le_bytes([buf[*pos], buf[*pos + 1]]);
    *pos += 2;
    Some(v)
}

#[inline]
fn read_u32(buf: &[u8], pos: &mut usize) -> Option<u32> {
    if buf.len().saturating_sub(*pos) < 4 {
        return None;
    }
    let v = u32::from_le_bytes([buf[*pos], buf[*pos + 1], buf[*pos + 2], buf[*pos + 3]]);
    *pos += 4;
    Some(v)
}

/// A frame's header pairs, already bounds-checked by `scan_headers`.
#[derive(Clone, Copy)]
struct HeaderBlock<'a> {
    bytes: &'a [u8],
    count: u16,
}

impl<'a> HeaderBlock<'a> {
    #[inline]
    fn iter(self) -> HeaderIter<'a> {
        HeaderIter {
            buf: self.bytes,
            pos: 0,
            remaining: self.count,
        }
    }
}

/// Yields `(key, value)` slices from a pre-validated `HeaderBlock` (no allocation).
struct HeaderIter<'a> {
    buf: &'a [u8],
    pos: usize,
    remaining: u16,
}

impl<'a> Iterator for HeaderIter<'a> {
    type Item = (&'a [u8], &'a [u8]);

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining == 0 {
            return None;
        }
        self.remaining -= 1;
        let buf = self.buf;
        let mut hp = self.pos;
        let klen = u16::from_le_bytes([buf[hp], buf[hp + 1]]) as usize;
        hp += 2;
        let kb = &buf[hp..hp + klen];
        hp += klen;
        let vlen = u16::from_le_bytes([buf[hp], buf[hp + 1]]) as usize;
        hp += 2;
        let vb = &buf[hp..hp + vlen];
        hp += vlen;
        self.pos = hp;
        Some((kb, vb))
    }
}

/// Result of the single bounds-checking/validating pass over a frame's headers.
struct HeaderScan<'a> {
    block: HeaderBlock<'a>,
    valid: bool,
    /// `:reason` pseudo-header value (custom status message).
    reason: Option<&'a [u8]>,
    /// Last JS `Content-Length` value and how many were sent.
    js_cl: Option<&'a [u8]>,
    js_cl_count: u32,
}

impl<'a> HeaderScan<'a> {
    #[inline]
    fn empty() -> Self {
        HeaderScan {
            block: HeaderBlock {
                bytes: &[],
                count: 0,
            },
            valid: true,
            reason: None,
            js_cl: None,
            js_cl_count: 0,
        }
    }
}

/// Reads `header_count` and walks the pairs, bounds-checking and validating them.
/// `None` means the batch is truncated/malformed and decoding must stop.
#[inline]
fn scan_headers<'a>(buf: &'a [u8], pos: &mut usize) -> Option<HeaderScan<'a>> {
    let len = buf.len();
    let count = read_u16(buf, pos)?;
    let start = *pos;
    let mut scan = HeaderScan::empty();
    for _ in 0..count {
        let klen = read_u16(buf, pos)?;
        if (klen as usize) > len.saturating_sub(*pos) {
            return None;
        }
        let kb = &buf[*pos..*pos + klen as usize];
        *pos += klen as usize;
        let vlen = read_u16(buf, pos)?;
        if (vlen as usize) > len.saturating_sub(*pos) {
            return None;
        }
        let vb = &buf[*pos..*pos + vlen as usize];
        *pos += vlen as usize;

        if scan.valid && !is_valid_response_header(kb, vb) {
            scan.valid = false;
        }
        if is_reason_header(kb) {
            scan.reason = Some(vb);
        } else if kb.eq_ignore_ascii_case(b"content-length") {
            scan.js_cl = Some(vb);
            scan.js_cl_count += 1;
        }
    }
    scan.block = HeaderBlock {
        bytes: &buf[start..*pos],
        count,
    };
    Some(scan)
}

/// One decoded response frame, borrowing from the batch buffer.
struct Frame<'a> {
    req_id: u32,
    status: u16,
    ct_code: u8,
    flags: u8,
    headers: HeaderScan<'a>,
    body: &'a [u8],
}

/// Decodes the frame at `*pos`. The caller guarantees at least 8 bytes remain.
/// `None` means the batch is truncated/malformed and decoding must stop.
#[inline]
fn parse_frame<'a>(buf: &'a [u8], pos: &mut usize) -> Option<Frame<'a>> {
    let req_id = read_u32(buf, pos)?;
    let status = read_u16(buf, pos)?;
    let ct_code = buf[*pos];
    let flags = buf[*pos + 1];
    *pos += 2;

    let headers = if (flags & RESP_FLAG_HAS_HEADERS) != 0 {
        scan_headers(buf, pos)?
    } else {
        HeaderScan::empty()
    };

    let blen = read_u32(buf, pos)? as usize;
    if blen > buf.len().saturating_sub(*pos) {
        return None;
    }
    let body = &buf[*pos..*pos + blen];
    *pos += blen;

    Some(Frame {
        req_id,
        status,
        ct_code,
        flags,
        headers,
        body,
    })
}

#[inline]
fn push_status_line(
    raw: &mut Vec<u8>,
    num_buf: &mut itoa::Buffer,
    status: u16,
    reason: Option<&[u8]>,
) {
    if status == 200 && reason.is_none() {
        raw.extend_from_slice(b"HTTP/1.1 200 OK\r\n");
    } else {
        raw.extend_from_slice(b"HTTP/1.1 ");
        raw.extend_from_slice(num_buf.format(status).as_bytes());
        raw.push(b' ');
        raw.extend_from_slice(reason.unwrap_or_else(|| status_reason(status).as_bytes()));
        raw.extend_from_slice(b"\r\n");
    }
}

#[inline]
fn content_type_line(ct_code: u8) -> Option<&'static [u8]> {
    match ct_code {
        CT_TEXT_PLAIN => Some(b"Content-Type: text/plain; charset=utf-8\r\n"),
        CT_JSON => Some(b"Content-Type: application/json; charset=utf-8\r\n"),
        CT_HTML => Some(b"Content-Type: text/html; charset=utf-8\r\n"),
        CT_OCTET_STREAM => Some(b"Content-Type: application/octet-stream\r\n"),
        _ => None,
    }
}

/// Copies the JS headers onto the wire, dropping `:reason`, a duplicate Content-Type, a
/// mismatched Content-Length and any Transfer-Encoding. Returns `(has_cl, has_xpb)`.
#[inline]
fn push_js_headers(
    raw: &mut Vec<u8>,
    block: HeaderBlock<'_>,
    mut has_ct: bool,
    js_cl_mismatch: bool,
) -> (bool, bool) {
    let mut has_cl = false;
    let mut has_xpb = false;
    for (kb, vb) in block.iter() {
        if is_reason_header(kb) {
            continue;
        }
        if kb.eq_ignore_ascii_case(b"content-type") {
            if has_ct {
                continue;
            }
            has_ct = true;
        } else if kb.eq_ignore_ascii_case(b"content-length") {
            if js_cl_mismatch {
                continue;
            }
            has_cl = true;
        } else if kb.eq_ignore_ascii_case(b"transfer-encoding") {
            // The body is sent as-is with Content-Length; never emit both (RFC 9112 6.1).
            continue;
        } else if kb.eq_ignore_ascii_case(b"x-powered-by") {
            has_xpb = true;
        }

        raw.extend_from_slice(kb);
        raw.extend_from_slice(b": ");
        raw.extend_from_slice(vb);
        raw.extend_from_slice(b"\r\n");
    }
    (has_cl, has_xpb)
}

/// Ultra-fast wire-ready path: the complete HTTP/1.1 response in one allocation.
#[inline]
fn build_wire_response(
    f: &Frame<'_>,
    num_buf: &mut itoa::Buffer,
    date_hdr: &[u8],
    add_xpb: bool,
    no_body_status: bool,
    js_cl_mismatch: bool,
) -> Bytes {
    let blen = f.body.len();
    let mut raw = Vec::with_capacity(140 + f.headers.block.bytes.len() + blen);
    push_status_line(&mut raw, num_buf, f.status, f.headers.reason);

    let ct_line = content_type_line(f.ct_code);
    if let Some(line) = ct_line {
        raw.extend_from_slice(line);
    }
    let (has_cl, has_xpb) =
        push_js_headers(&mut raw, f.headers.block, ct_line.is_some(), js_cl_mismatch);

    if add_xpb && !has_xpb {
        raw.extend_from_slice(b"X-Powered-By: Express\r\n");
    }

    if !has_cl && !no_body_status {
        raw.extend_from_slice(b"Content-Length: ");
        raw.extend_from_slice(num_buf.format(blen).as_bytes());
        raw.extend_from_slice(b"\r\n");
    }

    raw.extend_from_slice(date_hdr);
    raw.extend_from_slice(b"\r\n");

    if !no_body_status && blen > 0 {
        raw.extend_from_slice(f.body);
    }
    Bytes::from(raw)
}

/// General path (ETag enabled or sendFile response): owned headers + body for the
/// method-aware writer.
#[inline]
fn buffered_response(f: &Frame<'_>) -> SlotResponse {
    let block = f.headers.block;
    let mut headers = Vec::with_capacity(block.count as usize);
    for (kb, vb) in block.iter() {
        headers.push((
            String::from_utf8_lossy(kb).into_owned(),
            String::from_utf8_lossy(vb).into_owned(),
        ));
    }
    SlotResponse::Buffered {
        status: f.status,
        content_type_code: f.ct_code,
        flags: f.flags,
        headers,
        body: if f.body.is_empty() {
            Bytes::new()
        } else {
            Bytes::copy_from_slice(f.body)
        },
    }
}

/// Dispatch all packed responses directly into the SlotTable with zero intermediate Vec allocations.
/// When fast-path eligible (no ETag computation needed, not a file response), builds the wire
/// HTTP/1.1 response bytes in one shot!
pub fn dispatch_response_batch(
    buf: &[u8],
    slots: &SlotTable,
    x_powered_by: bool,
    etag_enabled: bool,
) {
    let mut pos = 0usize;
    let mut num_buf = itoa::Buffer::new();
    // Compute RFC 7231 Date header ONCE for the entire batch (0 syscalls per response!)
    let date_hdr = get_date_header_bytes();

    while buf.len().saturating_sub(pos) >= 8 {
        let Some(f) = parse_frame(buf, &mut pos) else {
            break;
        };
        let add_xpb = x_powered_by && (f.flags & RESP_FLAG_SUPPRESS_POWERED_BY) == 0;

        if !is_valid_status(f.status) || !f.headers.valid {
            let raw = build_simple_raw_response(500, add_xpb, false);
            slots.complete(f.req_id, SlotResponse::RawHttp(raw));
            continue;
        }

        let status = f.status;
        let blen = f.body.len();
        let no_body_status = status == 204 || status == 304 || (100..200).contains(&status);
        // A JS Content-Length that disagrees with the body would desync the connection (the
        // surplus bytes parse as the next response). The real length wins, except for an empty
        // body, which may be a HEAD answer advertising the representation size: the general
        // path knows the request method and decides there.
        let js_cl_mismatch = !no_body_status
            && (f.headers.js_cl_count > 1
                || f.headers
                    .js_cl
                    .is_some_and(|v| !content_length_matches(v, blen)));

        let is_file = (f.flags & RESP_FLAG_IS_FILE) != 0;
        let suppress_etag = (f.flags & RESP_FLAG_SUPPRESS_ETAG) != 0;
        // `res.send` responses need the general path for the ETag, the freshness check (which
        // may use an ETag / Last-Modified set from JS) and 204/205/304 stripping.
        let send_rules = (f.flags & RESP_FLAG_SEND) != 0
            && ((etag_enabled && !suppress_etag)
                || (f.flags & RESP_FLAG_HAS_HEADERS) != 0
                || matches!(status, 204 | 205 | 304));
        if !is_file && !send_rules && !(js_cl_mismatch && blen == 0) {
            let raw = build_wire_response(
                &f,
                &mut num_buf,
                &date_hdr,
                add_xpb,
                no_body_status,
                js_cl_mismatch,
            );
            slots.complete(f.req_id, SlotResponse::RawHttp(raw));
            continue;
        }

        slots.complete(f.req_id, buffered_response(&f));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push_resp_frame(
        out: &mut Vec<u8>,
        req_id: u32,
        status: u16,
        ct_code: u8,
        flags: u8,
        headers: &[(&[u8], &[u8])],
        body: &[u8],
    ) {
        out.extend_from_slice(&req_id.to_le_bytes());
        out.extend_from_slice(&status.to_le_bytes());
        out.push(ct_code);
        let f = if headers.is_empty() {
            flags
        } else {
            flags | RESP_FLAG_HAS_HEADERS
        };
        out.push(f);
        if !headers.is_empty() {
            out.extend_from_slice(&(headers.len() as u16).to_le_bytes());
            for (k, v) in headers {
                out.extend_from_slice(&(k.len() as u16).to_le_bytes());
                out.extend_from_slice(k);
                out.extend_from_slice(&(v.len() as u16).to_le_bytes());
                out.extend_from_slice(v);
            }
        }
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(body);
    }

    fn header_lines(raw: &[u8]) -> (String, Vec<u8>) {
        let end = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        (
            String::from_utf8(raw[..end].to_vec())
                .unwrap()
                .to_ascii_lowercase(),
            raw[end..].to_vec(),
        )
    }

    #[tokio::test]
    async fn fast_path_drops_js_transfer_encoding_and_fixes_content_length() {
        let slots = std::sync::Arc::new(SlotTable::new());
        let id_te = slots.acquire().unwrap();
        let fut_te = slots.wait(id_te);
        let id_short = slots.acquire().unwrap();
        let fut_short = slots.wait(id_short);
        let id_long = slots.acquire().unwrap();
        let fut_long = slots.wait(id_long);
        let id_ok = slots.acquire().unwrap();
        let fut_ok = slots.wait(id_ok);
        let id_empty = slots.acquire().unwrap();
        let fut_empty = slots.wait(id_empty);

        let smuggle: &[u8] = b"0\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
        let mut batch = Vec::new();
        push_resp_frame(
            &mut batch,
            id_te,
            404,
            CT_OCTET_STREAM,
            0,
            &[(b"Transfer-Encoding", b"chunked")],
            smuggle,
        );
        push_resp_frame(
            &mut batch,
            id_short,
            200,
            CT_TEXT_PLAIN,
            0,
            &[(b"Content-Length", b"2")],
            b"hello world",
        );
        push_resp_frame(
            &mut batch,
            id_long,
            200,
            CT_TEXT_PLAIN,
            0,
            &[(b"content-length", b"99")],
            b"hi",
        );
        push_resp_frame(
            &mut batch,
            id_ok,
            200,
            CT_TEXT_PLAIN,
            0,
            &[(b"Content-Length", b"2")],
            b"hi",
        );
        push_resp_frame(
            &mut batch,
            id_empty,
            200,
            CT_TEXT_PLAIN,
            0,
            &[(b"Content-Length", b"10")],
            b"",
        );
        dispatch_response_batch(&batch, &slots, false, false);

        let SlotResponse::RawHttp(r) = fut_te.await else {
            panic!("expected RawHttp");
        };
        let (h, body) = header_lines(&r);
        assert!(!h.contains("transfer-encoding"), "{h}");
        assert!(
            h.contains(&format!("content-length: {}\r\n", smuggle.len())),
            "{h}"
        );
        assert_eq!(body, smuggle);

        for (fut, body) in [
            (fut_short, &b"hello world"[..]),
            (fut_long, b"hi"),
            (fut_ok, b"hi"),
        ] {
            let SlotResponse::RawHttp(r) = fut.await else {
                panic!("expected RawHttp");
            };
            let (h, got) = header_lines(&r);
            assert_eq!(h.matches("content-length:").count(), 1, "{h}");
            assert!(
                h.contains(&format!("content-length: {}\r\n", body.len())),
                "{h}"
            );
            assert_eq!(got, body);
        }

        // Empty body + JS length: maybe a HEAD answer; the method-aware general path decides.
        assert!(matches!(fut_empty.await, SlotResponse::Buffered { .. }));
    }

    #[tokio::test]
    async fn dispatch_response_batch_isolates_crlf_and_invalid_status() {
        let slots = std::sync::Arc::new(SlotTable::new());
        let id_bad_hdr = slots.acquire().unwrap();
        let fut_bad_hdr = slots.wait(id_bad_hdr);
        let id_bad_status = slots.acquire().unwrap();
        let fut_bad_status = slots.wait(id_bad_status);
        let id_good = slots.acquire().unwrap();
        let fut_good = slots.wait(id_good);

        let mut batch = Vec::new();
        push_resp_frame(
            &mut batch,
            id_bad_hdr,
            200,
            CT_TEXT_PLAIN,
            0,
            &[(b"X-Test", b"ok\r\nX-Evil: 1")],
            b"hi",
        );
        push_resp_frame(
            &mut batch,
            id_bad_status,
            1000,
            CT_TEXT_PLAIN,
            0,
            &[],
            b"hi",
        );
        push_resp_frame(&mut batch, id_good, 200, CT_TEXT_PLAIN, 0, &[], b"good");

        dispatch_response_batch(&batch, &slots, false, false);

        let SlotResponse::RawHttp(r1) = fut_bad_hdr.await else {
            panic!("expected RawHttp");
        };
        let s1 = std::str::from_utf8(&r1).unwrap();
        assert!(s1.starts_with("HTTP/1.1 500 Internal Server Error\r\n"));
        assert!(!s1.contains("X-Evil"));

        let SlotResponse::RawHttp(r2) = fut_bad_status.await else {
            panic!("expected RawHttp");
        };
        assert!(std::str::from_utf8(&r2)
            .unwrap()
            .starts_with("HTTP/1.1 500 Internal Server Error\r\n"));

        let SlotResponse::RawHttp(r3) = fut_good.await else {
            panic!("expected RawHttp");
        };
        let s3 = std::str::from_utf8(&r3).unwrap();
        assert!(s3.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(s3.ends_with("\r\n\r\ngood"));
    }
}
