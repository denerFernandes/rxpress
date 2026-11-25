//! Buffered responses: `res.send`/`res.json` bodies (with native ETag / 304), file responses
//! (`res.sendFile`) and engine-generated error responses.

use super::etag::{compute_etag, CondHeaders};
use crate::config::{EngineConfig, EtagMode};
use crate::date::write_date_header;
use crate::protocol::{
    build_simple_raw_response, content_length_matches, is_reason_header, is_valid_response_header,
    is_valid_status, push_connection_header, reason_for, CT_HTML, CT_JSON, CT_OCTET_STREAM,
    CT_TEXT_PLAIN, RESP_FLAG_FILE_META, RESP_FLAG_IS_FILE, RESP_FLAG_SEND, RESP_FLAG_SUPPRESS_ETAG,
    RESP_FLAG_SUPPRESS_POWERED_BY,
};
use crate::router::MethodCode;
use crate::static_files::{
    decode_sendfile_payload, etag_matches, http_date_not_modified, serve_sendfile,
    write_simple_status, FileServeError,
};
use bytes::Bytes;
use std::time::Duration;
use tokio::io::{AsyncWrite, AsyncWriteExt};

/// Write a minimal `Connection: close` error response (bounded to 2 s).
pub(super) async fn write_error_close<W: AsyncWrite + Unpin>(
    writer: &mut W,
    write_buf: &mut Vec<u8>,
    status: u16,
    x_powered_by: bool,
) -> std::io::Result<()> {
    let bytes = build_simple_raw_response(status, x_powered_by, true);
    write_buf.clear();
    write_buf.extend_from_slice(&bytes);
    match tokio::time::timeout(Duration::from_secs(2), async {
        writer.write_all(write_buf).await?;
        writer.flush().await
    })
    .await
    {
        Ok(res) => res,
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "Write timeout",
        )),
    }
}

#[inline]
pub(super) fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn write_buffered_response<W: AsyncWrite + Unpin>(
    writer: &mut W,
    write_buf: &mut Vec<u8>,
    status: u16,
    ct_code: u8,
    flags: u8,
    headers: &[(String, String)],
    body: &Bytes,
    method: MethodCode,
    config: &EngineConfig,
    cond: CondHeaders<'_>,
    no_cache: bool,
    close_conn: bool,
) -> std::io::Result<bool> {
    let suppress_xpb = (flags & RESP_FLAG_SUPPRESS_POWERED_BY) != 0;
    let suppress_etag = (flags & RESP_FLAG_SUPPRESS_ETAG) != 0;
    let is_head = method == MethodCode::Head;
    let xpb = config.x_powered_by && !suppress_xpb;

    // File response (`res.sendFile` / `res.download`)
    if (flags & RESP_FLAG_IS_FILE) != 0 {
        // Boxed: large future (file I/O), kept out of the buffered-response hot path.
        return Box::pin(write_file_response(
            writer, write_buf, status, flags, headers, body, is_head, config, cond, close_conn,
        ))
        .await
        .map(|()| false);
    }

    if !is_valid_status(status)
        || headers
            .iter()
            .any(|(k, v)| !is_valid_response_header(k.as_bytes(), v.as_bytes()))
    {
        return write_error_close(writer, write_buf, 500, xpb)
            .await
            .map(|()| true);
    }

    // Express `res.send`: ETag for any status and method, then `req.fresh` -> 304.
    let send_mode = (flags & RESP_FLAG_SEND) != 0;
    let mut computed_etag: Option<String> = None;
    let mut status = status;
    if send_mode {
        let custom_etag = header_value(headers, "etag");
        if !suppress_etag && custom_etag.is_none() && config.etag_mode != EtagMode::Off {
            computed_etag = Some(compute_etag(body, config.etag_mode == EtagMode::Weak));
        }
        let cacheable = (200..300).contains(&status) || status == 304;
        if cacheable
            && !no_cache
            && (method == MethodCode::Get || method == MethodCode::Head)
            && is_fresh(
                cond,
                custom_etag.or(computed_etag.as_deref()),
                header_value(headers, "last-modified"),
            )
        {
            status = 304;
        }
    }

    let framing = append_buffered_head(
        write_buf,
        status,
        ct_code,
        headers,
        body,
        is_head,
        xpb,
        computed_etag.as_deref(),
        close_conn,
        send_mode,
    );

    let has_body = !is_head && framing != Framing::NoBody && !(send_mode && status == 205);
    match framing {
        Framing::Chunked if has_body => {
            if !body.is_empty() {
                let mut hex = [0u8; 16];
                write_buf.extend_from_slice(hex_len(body.len(), &mut hex));
                write_buf.extend_from_slice(b"\r\n");
                write_buf.extend_from_slice(body);
                write_buf.extend_from_slice(b"\r\n");
            }
            write_buf.extend_from_slice(b"0\r\n\r\n");
        }
        _ if has_body && !body.is_empty() => write_buf.extend_from_slice(body),
        _ => {}
    }

    writer.write_all(write_buf).await?;
    Ok(framing == Framing::CloseDelimited)
}

/// How the body of a buffered response is delimited on the wire.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Framing {
    /// The status forbids a body (1xx, 204, 304).
    NoBody,
    ContentLength,
    /// The app set `Transfer-Encoding: ...chunked` (as Node, the engine frames the body).
    Chunked,
    /// The app set a `Transfer-Encoding` without `chunked`: the body ends when the connection
    /// closes (RFC 9112 6.3), so the engine closes it after the response.
    CloseDelimited,
}

fn hex_len(n: usize, buf: &mut [u8; 16]) -> &[u8] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut i = buf.len();
    let mut v = n;
    loop {
        i -= 1;
        buf[i] = HEX[v & 0xf];
        v >>= 4;
        if v == 0 {
            break;
        }
    }
    &buf[i..]
}

/// `Transfer-Encoding` the app set (last value), unless it is empty.
fn js_transfer_encoding(headers: &[(String, String)]) -> Option<&str> {
    header_value(headers, "transfer-encoding")
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

/// `res.sendFile` / `res.download`: the body carries the encoded file request.
#[allow(clippy::too_many_arguments)]
async fn write_file_response<W: AsyncWrite + Unpin>(
    writer: &mut W,
    write_buf: &mut Vec<u8>,
    status: u16,
    flags: u8,
    headers: &[(String, String)],
    body: &Bytes,
    is_head: bool,
    config: &EngineConfig,
    cond: CondHeaders<'_>,
    close_conn: bool,
) -> std::io::Result<()> {
    let suppress_xpb = (flags & RESP_FLAG_SUPPRESS_POWERED_BY) != 0;
    let suppress_etag = (flags & RESP_FLAG_SUPPRESS_ETAG) != 0;
    let has_meta = (flags & RESP_FLAG_FILE_META) != 0;
    let Some(sf_req) = decode_sendfile_payload(
        body,
        has_meta,
        config.etag_mode != EtagMode::Off,
        suppress_etag,
    ) else {
        return write_simple_status(
            writer,
            write_buf,
            400,
            is_head,
            config.x_powered_by && !suppress_xpb,
            close_conn,
        )
        .await;
    };
    match serve_sendfile(
        writer,
        write_buf,
        &sf_req,
        is_head,
        cond.if_none_match,
        cond.if_modified_since,
        cond.range,
        cond.if_range,
        status,
        headers,
        config.x_powered_by && !suppress_xpb,
        close_conn,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(FileServeError::PreHeader(err_status)) => {
            write_simple_status(
                writer,
                write_buf,
                err_status,
                is_head,
                config.x_powered_by && !suppress_xpb,
                close_conn,
            )
            .await
        }
        Err(FileServeError::StreamAborted(e)) => Err(e),
    }
}

/// Last value of a response header set from JS.
fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .rev()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// The `fresh` package (what Express's `req.fresh` uses), minus the method/status checks.
fn is_fresh(cond: CondHeaders<'_>, etag: Option<&str>, last_modified: Option<&str>) -> bool {
    let inm = cond.if_none_match.map(str::trim).filter(|v| !v.is_empty());
    let ims = cond
        .if_modified_since
        .map(str::trim)
        .filter(|v| !v.is_empty());
    if inm.is_none() && ims.is_none() {
        return false;
    }
    if let Some(inm) = inm {
        if inm != "*" {
            match etag {
                Some(tag) if etag_matches(inm, tag) => {}
                _ => return false,
            }
        }
    }
    if let Some(ims) = ims {
        match last_modified {
            Some(lm) if http_date_not_modified(ims, lm) => {}
            _ => return false,
        }
    }
    true
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

/// Status line and headers of a buffered response (into a cleared `write_buf`). Returns how
/// the body is framed.
#[allow(clippy::too_many_arguments)]
fn append_buffered_head(
    write_buf: &mut Vec<u8>,
    status: u16,
    ct_code: u8,
    headers: &[(String, String)],
    body: &Bytes,
    is_head: bool,
    xpb: bool,
    computed_etag: Option<&str>,
    close_conn: bool,
    send_mode: bool,
) -> Framing {
    write_buf.clear();
    let mut nb = itoa::Buffer::new();
    let reason = reason_for(status, headers);
    if status == 200 && reason == "OK" {
        write_buf.extend_from_slice(b"HTTP/1.1 200 OK\r\n");
    } else {
        write_buf.extend_from_slice(b"HTTP/1.1 ");
        write_buf.extend_from_slice(nb.format(status).as_bytes());
        write_buf.push(b' ');
        write_buf.extend_from_slice(reason.as_bytes());
        write_buf.extend_from_slice(b"\r\n");
    }

    let mut has_cl = false;
    let mut has_xpb = false;
    let mut has_conn = false;
    let no_body_status = status == 204 || status == 304 || (100..200).contains(&status);
    // A JS Content-Length is kept only when it frames the body we send: a HEAD answer (no body
    // follows, the value advertises the GET size) or the exact body length. Anything else would
    // desync the connection, so the engine writes the real length instead.
    let keep_js_cl = no_body_status || is_head || {
        let mut cls = headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"));
        cls.next()
            .is_some_and(|(_, v)| content_length_matches(v.as_bytes(), body.len()))
            && cls.next().is_none()
    };

    // `res.send` drops Content-Type / Content-Length on 204 and 304, and answers 205 with an
    // empty body and `Content-Length: 0`.
    let strip_entity = send_mode && (status == 204 || status == 304);
    let reset_content = send_mode && status == 205;

    // A Transfer-Encoding set by the app is honoured like Node does (never together with a
    // Content-Length): `chunked` last means chunked framing, anything else a close-delimited body.
    let te = if no_body_status || reset_content {
        None
    } else {
        js_transfer_encoding(headers)
    };
    let framing = match te {
        _ if no_body_status => Framing::NoBody,
        Some(v)
            if v.rsplit(',')
                .next()
                .is_some_and(|last| last.trim().eq_ignore_ascii_case("chunked")) =>
        {
            Framing::Chunked
        }
        Some(_) => Framing::CloseDelimited,
        None => Framing::ContentLength,
    };
    let keep_js_cl = keep_js_cl && te.is_none();

    let mut has_ct = false;
    if !strip_entity {
        if let Some(line) = content_type_line(ct_code) {
            write_buf.extend_from_slice(line);
            has_ct = true;
        }
    }

    for (k, v) in headers {
        if is_reason_header(k.as_bytes()) {
            continue;
        }
        if strip_entity
            && (k.eq_ignore_ascii_case("content-type") || k.eq_ignore_ascii_case("content-length"))
        {
            continue;
        }
        if reset_content && k.eq_ignore_ascii_case("content-length") {
            continue;
        }
        if k.eq_ignore_ascii_case("content-type") {
            if has_ct {
                continue;
            }
            has_ct = true;
        } else if k.eq_ignore_ascii_case("content-length") {
            if !keep_js_cl {
                continue;
            }
            has_cl = true;
        } else if k.eq_ignore_ascii_case("transfer-encoding") {
            // Only the last value, and only when it frames this body (see `framing`).
            if te.is_none() || !std::ptr::eq(v.as_str(), header_value(headers, k).unwrap_or("")) {
                continue;
            }
        } else if k.eq_ignore_ascii_case("x-powered-by") {
            has_xpb = true;
        } else if k.eq_ignore_ascii_case("connection") {
            if framing == Framing::CloseDelimited {
                continue;
            }
            has_conn = true;
        }
        write_buf.extend_from_slice(k.as_bytes());
        write_buf.extend_from_slice(b": ");
        write_buf.extend_from_slice(v.as_bytes());
        write_buf.extend_from_slice(b"\r\n");
    }

    if xpb && !has_xpb {
        write_buf.extend_from_slice(b"X-Powered-By: Express\r\n");
    }

    if let Some(tag) = computed_etag {
        write_buf.extend_from_slice(b"ETag: ");
        write_buf.extend_from_slice(tag.as_bytes());
        write_buf.extend_from_slice(b"\r\n");
    }

    if framing == Framing::CloseDelimited {
        write_buf.extend_from_slice(b"Connection: close\r\n");
    } else if !has_conn {
        push_connection_header(write_buf, close_conn);
    }

    if reset_content {
        write_buf.extend_from_slice(b"Content-Length: 0\r\n");
    } else if !has_cl && framing == Framing::ContentLength {
        write_buf.extend_from_slice(b"Content-Length: ");
        write_buf.extend_from_slice(nb.format(body.len()).as_bytes());
        write_buf.extend_from_slice(b"\r\n");
    }

    write_date_header(write_buf);
    write_buf.extend_from_slice(b"\r\n");
    framing
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn buffered_to_string(
        status: u16,
        headers: &[(&str, &str)],
        body: &'static [u8],
        method: MethodCode,
        inm: Option<&str>,
    ) -> String {
        let headers: Vec<(String, String)> = headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let mut out: Vec<u8> = Vec::new();
        let mut wb = Vec::new();
        let cond = CondHeaders {
            if_none_match: inm,
            ..CondHeaders::default()
        };
        write_buffered_response(
            &mut out,
            &mut wb,
            status,
            CT_TEXT_PLAIN,
            RESP_FLAG_SEND,
            &headers,
            &Bytes::from_static(body),
            method,
            &EngineConfig::default(),
            cond,
            false,
            false,
        )
        .await
        .unwrap();
        String::from_utf8(out).unwrap().to_ascii_lowercase()
    }

    #[tokio::test]
    async fn buffered_frames_js_transfer_encoding_and_fixes_content_length() {
        // A JS `Transfer-Encoding: chunked` is honoured like Node: the engine frames the body
        // (a body that looks like a chunk terminator cannot end the message early), and no
        // Content-Length goes with it, even one set from JS.
        let te = [("Transfer-Encoding", "chunked"), ("Content-Length", "5")];
        let s = buffered_to_string(404, &te, b"0\r\n\r\n", MethodCode::Get, None).await;
        assert!(s.contains("transfer-encoding: chunked\r\n"), "{s}");
        assert!(!s.contains("content-length"), "{s}");
        assert!(s.ends_with("\r\n\r\n5\r\n0\r\n\r\n\r\n0\r\n\r\n"), "{s}");

        // Any other coding: no length at all, so the body is close-delimited.
        let gz = [("Transfer-Encoding", "gzip")];
        let s = buffered_to_string(200, &gz, b"hello", MethodCode::Get, None).await;
        assert!(s.contains("transfer-encoding: gzip\r\n"), "{s}");
        assert!(s.contains("connection: close\r\n"), "{s}");
        assert!(
            !s.contains("content-length") && s.ends_with("\r\n\r\nhello"),
            "{s}"
        );

        // ETag 304 branch: same rule.
        let etag = compute_etag(b"hello", true);
        let s = buffered_to_string(200, &te, b"hello", MethodCode::Get, Some(&etag)).await;
        assert!(s.starts_with("http/1.1 304"), "{s}");
        assert!(!s.contains("transfer-encoding"), "{s}");

        // Wrong JS Content-Length is replaced by the real one; a matching one is kept once.
        for cl in ["2", "999", "abc", "5, 5"] {
            let s = buffered_to_string(
                200,
                &[("Content-Length", cl)],
                b"hello",
                MethodCode::Get,
                None,
            )
            .await;
            assert_eq!(s.matches("content-length:").count(), 1, "{cl}: {s}");
            assert!(
                s.contains("content-length: 5\r\n") && s.ends_with("\r\n\r\nhello"),
                "{cl}: {s}"
            );
        }
        let dup = [("Content-Length", "5"), ("Content-Length", "7")];
        let s = buffered_to_string(200, &dup, b"hello", MethodCode::Get, None).await;
        assert_eq!(s.matches("content-length:").count(), 1, "{s}");
        assert!(s.contains("content-length: 5\r\n"), "{s}");

        // HEAD: no body follows, the JS value advertises the representation size.
        let cl = [("Content-Length", "1234")];
        let s = buffered_to_string(200, &cl, b"", MethodCode::Head, None).await;
        assert!(
            s.contains("content-length: 1234\r\n") && s.ends_with("\r\n\r\n"),
            "{s}"
        );
        // Same response for GET: the real (empty) length.
        let s = buffered_to_string(200, &cl, b"", MethodCode::Get, None).await;
        assert!(
            s.contains("content-length: 0\r\n") && !s.contains("1234"),
            "{s}"
        );
    }
}
