//! Streamed responses (`res.write` / piping): framing, chunk relay with backpressure, and the
//! full-duplex case where the request body is still arriving.

use super::respond_buffered::write_error_close;
use crate::date::write_date_header;
use crate::protocol::{
    is_reason_header, is_valid_response_header, is_valid_status, push_connection_header, reason_for,
};
use crate::reqbody::BodyPump;
use crate::stream::StreamHandle;
use bytes::{Bytes, BytesMut};
use std::io::Write as _;
use std::pin::Pin;
use std::sync::atomic::{AtomicU8, Ordering};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::futures::Notified;
use tokio::sync::Notify;
use tokio::time::Instant;

pub(super) enum StreamOutcome {
    Continue,
    CloseClean,
    Abort,
}

/// How the streamed body is framed on the wire (decided from the response head).
struct Framing {
    use_chunked: bool,
    raw_unframed: bool,
    effective_close: bool,
    expected_cl: Option<usize>,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn handle_stream_response<'a, S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    read_buf: &mut BytesMut,
    pump: Option<&mut BodyPump>,
    body_deadline: Option<Instant>,
    max_read_buf: usize,
    write_buf: &mut Vec<u8>,
    status: u16,
    headers: &[(String, String)],
    suppress_xpb: bool,
    x_powered_by: bool,
    is_head: bool,
    http_version: u8,
    handle: StreamHandle,
    close_conn: bool,
    shutdown_state: &AtomicU8,
    shutdown_shard: &'a Notify,
    shutdown_fut: &mut Pin<&mut Notified<'a>>,
) -> StreamOutcome {
    if !is_valid_status(status)
        || headers
            .iter()
            .any(|(k, v)| !is_valid_response_header(k.as_bytes(), v.as_bytes()))
    {
        let _ = write_error_close(stream, write_buf, 500, x_powered_by && !suppress_xpb).await;
        return StreamOutcome::Abort;
    }

    let framing = append_stream_head(
        write_buf,
        status,
        headers,
        x_powered_by && !suppress_xpb,
        is_head,
        http_version,
        close_conn,
    );

    if stream.write_all(write_buf).await.is_err() || stream.flush().await.is_err() {
        return StreamOutcome::Abort;
    }

    relay_stream(
        stream,
        read_buf,
        pump,
        body_deadline,
        max_read_buf,
        write_buf,
        &framing,
        handle,
        shutdown_state,
        shutdown_shard,
        shutdown_fut,
    )
    .await
}

/// Status line and headers of a streamed response (into `write_buf`).
fn append_stream_head(
    write_buf: &mut Vec<u8>,
    status: u16,
    headers: &[(String, String)],
    xpb: bool,
    is_head: bool,
    http_version: u8,
    close_conn: bool,
) -> Framing {
    write_buf.clear();
    let mut nb = itoa::Buffer::new();
    write_buf.extend_from_slice(b"HTTP/1.1 ");
    write_buf.extend_from_slice(nb.format(status).as_bytes());
    write_buf.push(b' ');
    write_buf.extend_from_slice(reason_for(status, headers).as_bytes());
    write_buf.extend_from_slice(b"\r\n");

    let no_body_status = status == 204 || status == 304 || (100..200).contains(&status);
    let mut has_cl = false;
    let mut expected_cl: Option<usize> = None;
    let mut has_xpb = false;
    let mut has_conn = false;
    // User-supplied Transfer-Encoding is never forwarded verbatim: framing is owned by the
    // engine. `...chunked` means "stream chunked" (and wins over Content-Length, RFC 9112 6.3);
    // any other coding is dropped since no transfer coding is actually applied.
    let te_chunked = headers.iter().any(|(k, v)| {
        k.eq_ignore_ascii_case("transfer-encoding")
            && v.rsplit(',')
                .next()
                .is_some_and(|last| last.trim().eq_ignore_ascii_case("chunked"))
    });
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("transfer-encoding") || is_reason_header(k.as_bytes()) {
            continue;
        } else if k.eq_ignore_ascii_case("content-length") {
            // Only one well-formed length frames the body; a second or unparsable value is
            // dropped (the engine then frames the stream itself).
            if te_chunked || has_cl {
                continue;
            }
            let v = v.trim();
            if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }
            let Ok(n) = v.parse::<usize>() else {
                continue;
            };
            has_cl = true;
            expected_cl = Some(n);
        } else if k.eq_ignore_ascii_case("x-powered-by") {
            has_xpb = true;
        } else if k.eq_ignore_ascii_case("connection") {
            has_conn = true;
        }
        write_buf.extend_from_slice(k.as_bytes());
        write_buf.extend_from_slice(b": ");
        write_buf.extend_from_slice(v.as_bytes());
        write_buf.extend_from_slice(b"\r\n");
    }

    let use_chunked = !is_head && !no_body_status && !has_cl && http_version == 1;
    let raw_unframed = !is_head && !no_body_status && !use_chunked;
    let effective_close =
        close_conn || (http_version == 0 && !has_cl && !no_body_status && !is_head);

    if xpb && !has_xpb {
        write_buf.extend_from_slice(b"X-Powered-By: Express\r\n");
    }
    if use_chunked {
        write_buf.extend_from_slice(b"Transfer-Encoding: chunked\r\n");
    }
    if !has_conn {
        push_connection_header(write_buf, effective_close);
    }
    write_date_header(write_buf);
    write_buf.extend_from_slice(b"\r\n");

    Framing {
        use_chunked,
        raw_unframed,
        effective_close,
        expected_cl,
    }
}

/// Relay JS chunks to the socket until the stream ends, while watching the socket (EOF,
/// pipelined bytes, a request body still being pumped) and shutdown.
#[allow(clippy::too_many_arguments)]
async fn relay_stream<'a, S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    read_buf: &mut BytesMut,
    mut pump: Option<&mut BodyPump>,
    body_deadline: Option<Instant>,
    max_read_buf: usize,
    write_buf: &mut Vec<u8>,
    framing: &Framing,
    mut handle: StreamHandle,
    shutdown_state: &AtomicU8,
    shutdown_shard: &'a Notify,
    shutdown_fut: &mut Pin<&mut Notified<'a>>,
) -> StreamOutcome {
    let low_water = handle.capacity / 2;
    let mut eof_probe = [0u8; 64];
    let mut discarded_overflow = false;
    let mut bytes_written: usize = 0;

    loop {
        if shutdown_state.load(Ordering::Acquire) >= 2 {
            return StreamOutcome::Abort;
        }
        // Full-duplex: a response streaming while its request body is still arriving (e.g.
        // `req.pipe(res)`) keeps pumping the body.
        let pump_open = pump.as_ref().is_some_and(|p| !p.done);
        let pump_blocked = pump_open && pump.as_ref().is_some_and(|p| p.blocked);
        let space = if pump_blocked {
            pump.as_ref().map(|p| p.space.clone())
        } else {
            None
        };
        let body_dl = if pump_open { body_deadline } else { None };
        tokio::select! {
            biased;
            _ = shutdown_fut.as_mut() => {
                shutdown_fut.set(shutdown_shard.notified());
                let _ = shutdown_fut.as_mut().enable();
                if shutdown_state.load(Ordering::Acquire) >= 2 {
                    return StreamOutcome::Abort;
                }
            }
            _ = async {
                match &space {
                    Some(n) => n.notified().await,
                    None => std::future::pending::<()>().await,
                }
            }, if space.is_some() => {
                if let Some(p) = pump.as_mut() {
                    if p.feed(read_buf).is_err() {
                        p.abort();
                        handle.close_notifier.notify_closed(handle.req_id);
                        return StreamOutcome::Abort;
                    }
                }
            }
            // requestTimeout: the body must arrive in time even while the response streams.
            _ = async {
                match body_dl {
                    Some(dl) => tokio::time::sleep_until(dl).await,
                    None => std::future::pending::<()>().await,
                }
            }, if body_dl.is_some() => {
                if let Some(p) = pump.as_mut() {
                    p.abort();
                }
                handle.close_notifier.notify_closed(handle.req_id);
                return StreamOutcome::Abort;
            }
            chunk = handle.rx.recv() => {
                match chunk {
                    Some(data) => {
                        // Chunks queued before an abort were already "written" from JS's point
                        // of view (Node flushes them to the socket), so deliver them; the abort
                        // only suppresses the terminator, checked once the channel drains.
                        if !write_chunk(stream, write_buf, framing, &data, &mut bytes_written).await {
                            return StreamOutcome::Abort;
                        }
                        if handle.rx.len() <= low_water
                            && handle.drain_armed.swap(false, Ordering::SeqCst)
                        {
                            handle.close_notifier.notify_drained(handle.req_id);
                        }
                    }
                    None => {
                        return finish_stream(stream, framing, &handle, discarded_overflow, bytes_written)
                            .await;
                    }
                }
            }
            read_res = async {
                if pump_open || (!discarded_overflow && read_buf.len() < max_read_buf) {
                    if read_buf.capacity() - read_buf.len() < 1024 {
                        read_buf.reserve(16384);
                    }
                    stream.read_buf(read_buf).await
                } else {
                    stream.read(&mut eof_probe).await
                }
            }, if !pump_blocked => {
                match read_res {
                    Ok(0) | Err(_) => {
                        if let Some(p) = pump.as_mut() {
                            p.abort();
                        }
                        return StreamOutcome::Abort;
                    }
                    Ok(_) => {
                        if pump_open {
                            if let Some(p) = pump.as_mut() {
                                if p.feed(read_buf).is_err() {
                                    p.abort();
                                    handle.close_notifier.notify_closed(handle.req_id);
                                    return StreamOutcome::Abort;
                                }
                            }
                        } else if read_buf.len() >= max_read_buf {
                            discarded_overflow = true;
                        }
                    }
                }
            }
        }
    }
}

/// Write one JS chunk with the response's framing. `false` = the socket failed.
#[inline]
async fn write_chunk<S: AsyncWrite + Unpin>(
    stream: &mut S,
    write_buf: &mut Vec<u8>,
    framing: &Framing,
    data: &Bytes,
    bytes_written: &mut usize,
) -> bool {
    if data.is_empty() {
        return true;
    }
    if framing.use_chunked {
        write_buf.clear();
        let _ = write!(write_buf, "{:x}\r\n", data.len());
        write_buf.extend_from_slice(data);
        write_buf.extend_from_slice(b"\r\n");
        if stream.write_all(write_buf).await.is_err() || stream.flush().await.is_err() {
            return false;
        }
    } else if framing.raw_unframed {
        // Never write past the declared Content-Length: surplus bytes would be read as the
        // next response. The mismatch closes the connection once the stream ends.
        let room = framing
            .expected_cl
            .map_or(data.len(), |cl| cl.saturating_sub(*bytes_written));
        *bytes_written = bytes_written.saturating_add(data.len());
        let data = &data[..data.len().min(room)];
        if !data.is_empty()
            && (stream.write_all(data).await.is_err() || stream.flush().await.is_err())
        {
            return false;
        }
    }
    true
}

/// The JS side ended the stream: terminate the framing and decide whether the connection
/// can carry another request.
async fn finish_stream<S: AsyncWrite + Unpin>(
    stream: &mut S,
    framing: &Framing,
    handle: &StreamHandle,
    discarded_overflow: bool,
    bytes_written: usize,
) -> StreamOutcome {
    if handle.aborted.load(Ordering::SeqCst) {
        return StreamOutcome::Abort;
    }
    if framing.use_chunked
        && (stream.write_all(b"0\r\n\r\n").await.is_err() || stream.flush().await.is_err())
    {
        return StreamOutcome::Abort;
    }
    if framing.effective_close
        || discarded_overflow
        || framing.expected_cl.is_some_and(|cl| bytes_written != cl)
    {
        return StreamOutcome::CloseClean;
    }
    StreamOutcome::Continue
}

#[cfg(test)]
mod tests {
    use super::super::test_util::make_test_shared;
    use super::super::ShutdownBus;
    use super::*;
    use crate::config::EngineConfig;
    use crate::slots::SlotResponse;
    use std::time::Duration;

    #[tokio::test]
    async fn handle_stream_response_preserves_pipelined_bytes_and_frames_head_204_http10() {
        let (mut server_side, mut client_side) = tokio::io::duplex(4096);
        let shared = make_test_shared(EngineConfig::default());
        let bus = ShutdownBus::new(4);
        let shard = bus.shard(0);
        let sfut = shard.notified();
        tokio::pin!(sfut);

        // Client sends pipelined request while stream is active
        client_side
            .write_all(b"GET /after HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();

        let id1 = shared.slots.acquire().unwrap();
        let _fut1 = shared.slots.wait(id1);
        assert!(shared.start_stream(id1, 200, vec![], true));
        let SlotResponse::Stream {
            status,
            headers,
            suppress_x_powered_by,
            handle,
        } = _fut1.await
        else {
            panic!("expected stream");
        };

        assert_eq!(shared.streams.write(id1, Bytes::from_static(b"hello")), 1);
        let shared_clone = shared.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            shared_clone.streams.end(id1, None);
        });

        let mut read_buf = BytesMut::new();
        let mut write_buf = Vec::new();
        let outcome = handle_stream_response(
            &mut server_side,
            &mut read_buf,
            None,
            None,
            65_536,
            &mut write_buf,
            status,
            &headers,
            suppress_x_powered_by,
            false,
            false,
            1,
            handle,
            false,
            bus.state_atomic(),
            shard,
            &mut sfut,
        )
        .await;
        assert!(matches!(outcome, StreamOutcome::Continue));
        assert_eq!(
            &read_buf[..],
            b"GET /after HTTP/1.1\r\nHost: localhost\r\n\r\n"
        );

        // HEAD stream must suppress Transfer-Encoding: chunked, chunks, and 0\r\n\r\n
        let id2 = shared.slots.acquire().unwrap();
        let _fut2 = shared.slots.wait(id2);
        assert!(shared.start_stream(id2, 200, vec![], true));
        let SlotResponse::Stream { handle: h2, .. } = _fut2.await else {
            panic!("expected stream");
        };
        assert_eq!(shared.streams.write(id2, Bytes::from_static(b"secret")), 1);
        shared.streams.end(id2, None);

        let mut rb2 = BytesMut::new();
        let mut wb2 = Vec::new();
        let out2 = handle_stream_response(
            &mut server_side,
            &mut rb2,
            None,
            None,
            65_536,
            &mut wb2,
            200,
            &[],
            true,
            false,
            true,
            1,
            h2,
            false,
            bus.state_atomic(),
            shard,
            &mut sfut,
        )
        .await;
        assert!(matches!(out2, StreamOutcome::Continue));

        // HTTP/1.0 stream without Content-Length emits Connection: close, raw body, CloseClean
        let id3 = shared.slots.acquire().unwrap();
        let _fut3 = shared.slots.wait(id3);
        assert!(shared.start_stream(id3, 200, vec![], true));
        let SlotResponse::Stream { handle: h3, .. } = _fut3.await else {
            panic!("expected stream");
        };
        assert_eq!(shared.streams.write(id3, Bytes::from_static(b"raw10")), 1);
        shared.streams.end(id3, None);

        let mut rb3 = BytesMut::new();
        let mut wb3 = Vec::new();
        let out3 = handle_stream_response(
            &mut server_side,
            &mut rb3,
            None,
            None,
            65_536,
            &mut wb3,
            200,
            &[],
            true,
            false,
            false,
            0,
            h3,
            false,
            bus.state_atomic(),
            shard,
            &mut sfut,
        )
        .await;
        assert!(matches!(out3, StreamOutcome::CloseClean));
        drop(server_side);

        let mut received = Vec::new();
        client_side.read_to_end(&mut received).await.unwrap();
        let s = String::from_utf8(received).unwrap();
        assert!(s.contains("Transfer-Encoding: chunked\r\n"));
        assert!(s.contains("5\r\nhello\r\n0\r\n\r\n"));
        assert!(!s.contains("secret"));
        assert!(s.contains("Connection: close\r\n"));
        assert!(s.ends_with("\r\n\r\nraw10"));
    }

    #[tokio::test]
    async fn stream_response_never_writes_past_js_content_length() {
        let (mut server_side, mut client_side) = tokio::io::duplex(65_536);
        let shared = make_test_shared(EngineConfig::default());
        let bus = ShutdownBus::new(4);
        let shard = bus.shard(0);
        let sfut = shard.notified();
        tokio::pin!(sfut);

        let id = shared.slots.acquire().unwrap();
        let fut = shared.slots.wait(id);
        let hdrs = vec![("Content-Length".to_string(), "4".to_string())];
        assert!(shared.start_stream(id, 200, hdrs, true));
        let SlotResponse::Stream {
            headers, handle, ..
        } = fut.await
        else {
            panic!("expected stream");
        };
        assert_eq!(shared.streams.write(id, Bytes::from_static(b"ab")), 1);
        assert_eq!(
            shared
                .streams
                .write(id, Bytes::from_static(b"cdHTTP/1.1 200 OK\r\n\r\n")),
            1
        );
        shared.streams.end(id, None);
        let mut rb = BytesMut::new();
        let mut wb = Vec::new();
        let out = handle_stream_response(
            &mut server_side,
            &mut rb,
            None,
            None,
            65_536,
            &mut wb,
            200,
            &headers,
            true,
            false,
            false,
            1,
            handle,
            false,
            bus.state_atomic(),
            shard,
            &mut sfut,
        )
        .await;
        assert!(matches!(out, StreamOutcome::CloseClean), "mismatch closes");
        drop(server_side);
        let mut received = Vec::new();
        client_side.read_to_end(&mut received).await.unwrap();
        let s = String::from_utf8(received).unwrap();
        assert!(s.ends_with("\r\n\r\nabcd"), "{s}");
        assert_eq!(s.matches("HTTP/1.1").count(), 1, "{s}");
    }
}
