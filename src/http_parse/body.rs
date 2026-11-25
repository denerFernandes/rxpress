//! Message-body readers for the buffered path: Content-Length and chunked framing.
use super::deadline::read_buf_timed;
use crate::protocol::{is_valid_header_name, is_valid_header_value};
use bytes::{Bytes, BytesMut};
use std::pin::Pin;
use std::sync::atomic::{AtomicU8, Ordering};
use tokio::io::AsyncRead;
use tokio::sync::futures::Notified;
use tokio::sync::Notify;
use tokio::time::{Instant, Sleep};

pub const DEFAULT_MAX_CHUNK_LINE: usize = 4096;
pub const DEFAULT_MAX_TRAILER_BYTES: usize = 16 * 1024;
pub const DEFAULT_MAX_TRAILER_COUNT: usize = 64;

#[derive(Debug)]
pub enum ExactBodyError {
    Timeout,
    Eof,
    Io,
    Shutdown,
}

#[derive(Debug)]
pub enum ChunkedError {
    TooLarge,
    BadRequest,
    HeaderTooLarge,
    Timeout,
    Eof,
    Io,
    Shutdown,
}

/// RFC 9110 5.6.2 `tchar`.
#[inline]
fn is_tchar(b: u8) -> bool {
    matches!(b,
        b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`'
        | b'|' | b'~' | b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z')
}

/// `qdtext` (HTAB / SP / %x21 / %x23-5B / %x5D-7E / obs-text).
#[inline]
fn is_qdtext(b: u8) -> bool {
    matches!(b, b'\t' | b' ' | 0x21 | 0x23..=0x5B | 0x5D..=0x7E | 0x80..=0xFF)
}

/// Second byte of a `quoted-pair` (HTAB / SP / VCHAR / obs-text).
#[inline]
fn is_quoted_pair_char(b: u8) -> bool {
    matches!(b, b'\t' | 0x20..=0x7E | 0x80..=0xFF)
}

/// Validates the chunk extensions after the first `;` exactly like llhttp (strict mode):
/// `*( ";" ext-name [ "=" ext-value ] )` with no whitespace anywhere, where ext-name may be
/// empty when followed by `=` or `;`, ext-value is `*( tchar / quoted-string )` and a quoted
/// string must end the value. A `;` cannot end the line.
fn is_valid_chunk_ext(ext: &[u8]) -> bool {
    #[derive(Clone, Copy)]
    enum St {
        /// Just after `;`: the line must not end here.
        Start,
        Name,
        Value,
        Quoted,
        QuotedPair,
        QuotedDone,
    }
    let mut st = St::Start;
    for &b in ext {
        st = match st {
            St::Start | St::Name => match b {
                b'=' => St::Value,
                b';' => St::Start,
                _ if is_tchar(b) => St::Name,
                _ => return false,
            },
            St::Value => match b {
                b'"' => St::Quoted,
                b';' => St::Start,
                _ if is_tchar(b) => St::Value,
                _ => return false,
            },
            St::Quoted => match b {
                b'"' => St::QuotedDone,
                b'\\' => St::QuotedPair,
                _ if is_qdtext(b) => St::Quoted,
                _ => return false,
            },
            St::QuotedPair if is_quoted_pair_char(b) => St::Quoted,
            St::QuotedDone if b == b';' => St::Start,
            St::QuotedPair | St::QuotedDone => return false,
        };
    }
    matches!(st, St::Name | St::Value | St::QuotedDone)
}

/// Parses a chunk-size line (without its CRLF) like llhttp in strict mode:
/// `1*HEXDIG [ ";" chunk-ext ]`. No whitespace is allowed around the size or inside the
/// extensions (RFC 9112 7.1 has no BWS there; llhttp rejects it with HPE_INVALID_CHUNK_SIZE /
/// HPE_STRICT). `None` on any syntax error or a size that overflows `usize`.
#[inline]
pub(crate) fn parse_chunk_size_line(line: &[u8]) -> Option<usize> {
    let mut acc: usize = 0;
    let mut i = 0;
    while i < line.len() {
        let d = match line[i] {
            b @ b'0'..=b'9' => b - b'0',
            b @ b'a'..=b'f' => b - b'a' + 10,
            b @ b'A'..=b'F' => b - b'A' + 10,
            _ => break,
        };
        acc = acc.checked_mul(16)?.checked_add(d as usize)?;
        i += 1;
    }
    if i == 0 {
        return None;
    }
    if i == line.len() {
        return Some(acc);
    }
    (line[i] == b';' && is_valid_chunk_ext(&line[i + 1..])).then_some(acc)
}

#[allow(clippy::too_many_arguments)]
pub async fn read_exact_body<'a, S: AsyncRead + Unpin>(
    stream: &mut S,
    read_buf: &mut BytesMut,
    len: usize,
    deadline: Option<Instant>,
    sleep: &mut Pin<&mut Sleep>,
    armed_until: &mut Option<Instant>,
    shutdown_state: &AtomicU8,
    shutdown_shard: &'a Notify,
    shutdown_fut: &mut Pin<&mut Notified<'a>>,
) -> Result<Bytes, ExactBodyError> {
    if shutdown_state.load(Ordering::Acquire) >= 2 {
        return Err(ExactBodyError::Shutdown);
    }
    while read_buf.len() < len {
        let remaining = len - read_buf.len();
        let spare = read_buf.capacity() - read_buf.len();
        if spare < remaining.min(4096) {
            read_buf.reserve(remaining.min(64 * 1024));
        }
        read_buf_timed(
            stream,
            read_buf,
            deadline,
            sleep,
            armed_until,
            shutdown_state,
            shutdown_shard,
            shutdown_fut,
        )
        .await?;
    }
    Ok(read_buf.split_to(len).freeze())
}

#[inline]
pub(crate) fn find_crlf_bounded(buf: &[u8], max_len: usize) -> Result<Option<usize>, ()> {
    let scan_len = buf.len().min(max_len + 2);
    let slice = &buf[..scan_len];
    let mut i = 0;
    while i < slice.len() {
        let b = slice[i];
        if b == b'\r' {
            if i + 1 < slice.len() {
                if slice[i + 1] == b'\n' {
                    return if i <= max_len { Ok(Some(i)) } else { Err(()) };
                }
                return Err(());
            }
            // Trailing '\r' at exact end of currently buffered slice — wait for next byte
            return if i > max_len { Err(()) } else { Ok(None) };
        }
        if b == b'\n' {
            return Err(());
        }
        i += 1;
    }
    if buf.len() > max_len + 1 {
        Err(())
    } else {
        Ok(None)
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn read_chunked_body<'a, S: AsyncRead + Unpin>(
    stream: &mut S,
    read_buf: &mut BytesMut,
    limit: usize,
    max_chunk_line: usize,
    max_trailer_bytes: usize,
    max_trailer_count: usize,
    deadline: Option<Instant>,
    sleep: &mut Pin<&mut Sleep>,
    armed_until: &mut Option<Instant>,
    shutdown_state: &AtomicU8,
    shutdown_shard: &'a Notify,
    shutdown_fut: &mut Pin<&mut Notified<'a>>,
) -> Result<Bytes, ChunkedError> {
    if shutdown_state.load(Ordering::Acquire) >= 2 {
        return Err(ChunkedError::Shutdown);
    }
    let mut out = BytesMut::new();

    loop {
        // 1. Read bounded chunk-size line ending in \r\n
        let line_end = loop {
            match find_crlf_bounded(read_buf, max_chunk_line) {
                Ok(Some(pos)) => break pos,
                Ok(None) => {}
                Err(()) => return Err(ChunkedError::BadRequest),
            }
            read_buf_timed(
                stream,
                read_buf,
                deadline,
                sleep,
                armed_until,
                shutdown_state,
                shutdown_shard,
                shutdown_fut,
            )
            .await
            .map_err(|e| match e {
                ExactBodyError::Timeout => ChunkedError::Timeout,
                ExactBodyError::Eof => ChunkedError::Eof,
                ExactBodyError::Io => ChunkedError::Io,
                ExactBodyError::Shutdown => ChunkedError::Shutdown,
            })?;
        };

        let line = read_buf.split_to(line_end + 2);
        let Some(chunk_size) = parse_chunk_size_line(&line[..line_end]) else {
            return Err(ChunkedError::BadRequest);
        };

        // 2. Last chunk (0-size): drain and validate trailers before returning
        if chunk_size == 0 {
            let mut trailer_bytes: usize = 0;
            let mut trailer_count: usize = 0;
            loop {
                let rem_budget = max_trailer_bytes.saturating_sub(trailer_bytes);
                let t_end = loop {
                    match find_crlf_bounded(read_buf, rem_budget) {
                        Ok(Some(pos)) => break pos,
                        Ok(None) => {
                            if read_buf.len() > rem_budget + 1 {
                                return Err(ChunkedError::HeaderTooLarge);
                            }
                        }
                        Err(()) => {
                            if read_buf.len() > rem_budget {
                                return Err(ChunkedError::HeaderTooLarge);
                            }
                            return Err(ChunkedError::BadRequest);
                        }
                    }
                    read_buf_timed(
                        stream,
                        read_buf,
                        deadline,
                        sleep,
                        armed_until,
                        shutdown_state,
                        shutdown_shard,
                        shutdown_fut,
                    )
                    .await
                    .map_err(|e| match e {
                        ExactBodyError::Timeout => ChunkedError::Timeout,
                        ExactBodyError::Eof => ChunkedError::Eof,
                        ExactBodyError::Io => ChunkedError::Io,
                        ExactBodyError::Shutdown => ChunkedError::Shutdown,
                    })?;
                };

                let tline = read_buf.split_to(t_end + 2);
                if t_end == 0 {
                    return Ok(out.freeze());
                }

                trailer_bytes = trailer_bytes.saturating_add(t_end + 2);
                trailer_count += 1;
                if trailer_bytes > max_trailer_bytes || trailer_count > max_trailer_count {
                    return Err(ChunkedError::HeaderTooLarge);
                }

                let raw_t = &tline[..t_end];
                let Some(colon) = raw_t.iter().position(|&b| b == b':') else {
                    return Err(ChunkedError::BadRequest);
                };
                if !is_valid_header_name(&raw_t[..colon])
                    || !is_valid_header_value(&raw_t[colon + 1..])
                {
                    return Err(ChunkedError::BadRequest);
                }
            }
        }

        // 3. Overflow-safe limit check
        let new_total = out
            .len()
            .checked_add(chunk_size)
            .ok_or(ChunkedError::TooLarge)?;
        if new_total > limit {
            return Err(ChunkedError::TooLarge);
        }

        let need = chunk_size.checked_add(2).ok_or(ChunkedError::TooLarge)?;
        while read_buf.len() < need {
            let remaining = need - read_buf.len();
            let spare = read_buf.capacity() - read_buf.len();
            if spare < remaining.min(4096) {
                read_buf.reserve(remaining.min(64 * 1024));
            }
            read_buf_timed(
                stream,
                read_buf,
                deadline,
                sleep,
                armed_until,
                shutdown_state,
                shutdown_shard,
                shutdown_fut,
            )
            .await
            .map_err(|e| match e {
                ExactBodyError::Timeout => ChunkedError::Timeout,
                ExactBodyError::Eof => ChunkedError::Eof,
                ExactBodyError::Io => ChunkedError::Io,
                ExactBodyError::Shutdown => ChunkedError::Shutdown,
            })?;
        }

        let chunk = read_buf.split_to(need);
        if &chunk[chunk_size..need] != b"\r\n" {
            return Err(ChunkedError::BadRequest);
        }
        out.extend_from_slice(&chunk[..chunk_size]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    #[test]
    fn chunk_size_line_matches_llhttp_strict() {
        // Verdicts recorded from Node 24 (llhttp 9.4.3) for `<line>\r\nhello\r\n0\r\n\r\n`.
        let accept: &[&[u8]] = &[
            b"5",
            b"05",
            b"00005",
            b"5;a",
            b"5;a=b",
            b"5;a;b",
            b"5;a=b;c=d",
            b"5;=b",
            b"5;a=",
            b"5;=",
            b"5;;a",
            b"5;a=;b",
            b"5;=;b",
            b"5;a=b;;c",
            b"5;a=\"x y\"",
            b"5;a=\"x\\\"y\"",
            b"5;a=\"\t\"",
            b"5;a=\"\xff\"",
            b"5;a=\"\"",
            b"5;a=\"x\";b",
            b"5;a=b\"c\"",
            b"5;a=\"\\~\"",
            b"5;a=\"\\ \"",
        ];
        let reject: &[&[u8]] = &[
            b"",
            b"5 ",
            b"5\t",
            b"5  ",
            b"5 \t",
            b" 5",
            b"5 ;a",
            b"5\t;a",
            b"5 ; a",
            b"5; a",
            b"5;a ",
            b"5;a=b ",
            b"5;a = b",
            b"5;a= b",
            b"5;a =b",
            b"5;",
            b"5;;",
            b"5;a;",
            b"5;a=b;",
            b"5;a=\"x\";",
            b"5;a=b c",
            b"5;a@b",
            b"5;a=b@c",
            b"5;a/b",
            b"5;a=b/c",
            b"5;a=\xff",
            b"5;\ta",
            b"5;a\t",
            b"5;a=b\t",
            b"5;a=\"\x01\"",
            b"5;a=\"\x7f\"",
            b"5;a=\"\\\x01\"",
            b"5;a=\"x\"y",
            b"5;a=\"x\" ",
            b"5;a=\"x\"\t",
            b"5;a==b",
            b"5;a=\"x\"\"y\"",
            b"5;a=\"x\"=",
            b"5;a=\"\"b",
            b"5;a=\"x",
            b"0x5",
            b"-5",
            b"+5",
            b"10000000000000000",
            b";a",
        ];
        for l in accept {
            let shown = String::from_utf8_lossy(l);
            assert_eq!(parse_chunk_size_line(l), Some(5), "{shown:?}");
        }
        for l in reject {
            let shown = String::from_utf8_lossy(l);
            assert_eq!(parse_chunk_size_line(l), None, "{shown:?}");
        }
        assert_eq!(parse_chunk_size_line(b"ffffffffffffffff"), Some(usize::MAX));
        assert_eq!(parse_chunk_size_line(b"aB;x=1"), Some(0xab));
    }

    #[tokio::test]
    async fn read_chunked_body_trailers_pipeline_and_security_cases() {
        let sleep = tokio::time::sleep(Duration::from_secs(60));
        tokio::pin!(sleep);
        let mut armed = None;
        let shutdown_state = AtomicU8::new(0);
        let shutdown_shard = Notify::new();
        let shutdown_fut = shutdown_shard.notified();
        tokio::pin!(shutdown_fut);
        let _ = shutdown_fut.as_mut().enable();

        // Multi-chunk + extension + trailers + pipelined follow-up request
        let (mut client, mut server) = tokio::io::duplex(4096);
        client
            .write_all(b"5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nX-Checksum: ok\r\n\r\nGET /next HTTP/1.1\r\nHost: a\r\n\r\n")
            .await
            .unwrap();
        client.shutdown().await.unwrap();

        let mut buf = BytesMut::new();
        let body = read_chunked_body(
            &mut server,
            &mut buf,
            1024,
            DEFAULT_MAX_CHUNK_LINE,
            DEFAULT_MAX_TRAILER_BYTES,
            DEFAULT_MAX_TRAILER_COUNT,
            None,
            &mut sleep,
            &mut armed,
            &shutdown_state,
            &shutdown_shard,
            &mut shutdown_fut,
        )
        .await
        .unwrap();
        assert_eq!(&body[..], b"hello world");
        let mut tail = buf.to_vec();
        tokio::io::AsyncReadExt::read_to_end(&mut server, &mut tail)
            .await
            .unwrap();
        assert_eq!(&tail[..], b"GET /next HTTP/1.1\r\nHost: a\r\n\r\n");

        // Overflow protection: ffffffffffffffff chunk size
        let (mut c2, mut s2) = tokio::io::duplex(1024);
        c2.write_all(b"ffffffffffffffff\r\n").await.unwrap();
        c2.shutdown().await.unwrap();
        let mut b2 = BytesMut::new();
        let err = read_chunked_body(
            &mut s2,
            &mut b2,
            1024,
            DEFAULT_MAX_CHUNK_LINE,
            DEFAULT_MAX_TRAILER_BYTES,
            DEFAULT_MAX_TRAILER_COUNT,
            None,
            &mut sleep,
            &mut armed,
            &shutdown_state,
            &shutdown_shard,
            &mut shutdown_fut,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ChunkedError::TooLarge));

        // Missing CRLF after chunk data -> BadRequest
        let (mut c3, mut s3) = tokio::io::duplex(1024);
        c3.write_all(b"3\r\nabcXX0\r\n\r\n").await.unwrap();
        c3.shutdown().await.unwrap();
        let mut b3 = BytesMut::new();
        let err3 = read_chunked_body(
            &mut s3,
            &mut b3,
            1024,
            DEFAULT_MAX_CHUNK_LINE,
            DEFAULT_MAX_TRAILER_BYTES,
            DEFAULT_MAX_TRAILER_COUNT,
            None,
            &mut sleep,
            &mut armed,
            &shutdown_state,
            &shutdown_shard,
            &mut shutdown_fut,
        )
        .await
        .unwrap_err();
        assert!(matches!(err3, ChunkedError::BadRequest));

        // Invalid chunk size (+5) -> BadRequest
        let (mut c4, mut s4) = tokio::io::duplex(1024);
        c4.write_all(b"+5\r\nhello\r\n0\r\n\r\n").await.unwrap();
        c4.shutdown().await.unwrap();
        let mut b4 = BytesMut::new();
        let err4 = read_chunked_body(
            &mut s4,
            &mut b4,
            1024,
            DEFAULT_MAX_CHUNK_LINE,
            DEFAULT_MAX_TRAILER_BYTES,
            DEFAULT_MAX_TRAILER_COUNT,
            None,
            &mut sleep,
            &mut armed,
            &shutdown_state,
            &shutdown_shard,
            &mut shutdown_fut,
        )
        .await
        .unwrap_err();
        assert!(matches!(err4, ChunkedError::BadRequest));

        // Trailing whitespace on the chunk-size line -> BadRequest (llhttp HPE_INVALID_CHUNK_SIZE)
        let (mut c5, mut s5) = tokio::io::duplex(1024);
        c5.write_all(b"5 \r\nhello\r\n0\r\n\r\n").await.unwrap();
        c5.shutdown().await.unwrap();
        let mut b5 = BytesMut::new();
        let err5 = read_chunked_body(
            &mut s5,
            &mut b5,
            1024,
            DEFAULT_MAX_CHUNK_LINE,
            DEFAULT_MAX_TRAILER_BYTES,
            DEFAULT_MAX_TRAILER_COUNT,
            None,
            &mut sleep,
            &mut armed,
            &shutdown_state,
            &shutdown_shard,
            &mut shutdown_fut,
        )
        .await
        .unwrap_err();
        assert!(matches!(err5, ChunkedError::BadRequest));
    }
}
