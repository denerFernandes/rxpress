//! Per-connection driver: a monomorphized HTTP/1.1 loop with pipelined request batching and
//! write coalescing. Each turn of the loop is one batch:
//!
//! 1. `read_head`: wait (keep-alive / headers timeout) until request bytes are buffered;
//! 2. `parse_batch` (in `dispatch`): parse up to `MAX_PIPELINE_BATCH` requests, answering
//!    static-cache hits inline and queueing the rest for JS (or handing an upgrade off);
//! 3. `collect` (in `collect`): wake JS once, await every response in order and write them,
//!    coalesced, while watching the socket;
//! 4. flush, then keep-alive or close (`read_more` when a request head is still partial).
//!
//! Phases return [`Flow`]: `Break(clean)` ends the connection (`clean` = eligible for TLS
//! close_notify and lingering close), `Continue` carries on.

use super::handoff::ConnStream;
use super::respond_buffered::write_error_close;
use super::{ServerShared, ShutdownBus};
use crate::http_parse::{arm_deadline, arm_deadline_with_slack, read_buf_timed, ExactBodyError};
use crate::protocol::HTTP10_KEEP_ALIVE;
use crate::reqbody::{BodyPump, PumpError};
use crate::router::MethodCode;
use crate::slots::SlotFuture;
use crate::write_idle::IdleWrite;
use bytes::{Bytes, BytesMut};
use std::ops::ControlFlow::{self, Break, Continue};
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::futures::Notified;
use tokio::sync::Notify;
use tokio::time::{Instant, Sleep};

pub(super) const MAX_PIPELINE_BATCH: usize = 16;
/// How long in-flight handlers may still answer after the client half-closes (FIN).
pub(super) const PEER_EOF_GRACE: Duration = Duration::from_millis(100);
/// Bodies no parser claims are buffered up to this size; larger (or chunked) ones stream to JS.
pub(super) const STREAM_BODY_THRESHOLD: usize = 64 * 1024;
/// Pipelined static-cache hits are coalesced into one write, but never more than this many
/// bytes at a time: past it the batch is flushed (and the write applies TCP backpressure, bounded
/// by the write idle timeout), so a client that pipelines thousands of requests and never reads
/// cannot grow a connection's memory without limit.
pub(super) const STATIC_COALESCE_FLUSH: usize = 256 * 1024;
/// Largest coalesced static batch seen (regression probe for the bound above).
#[cfg(test)]
pub(super) static MAX_STATIC_COALESCED: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// `Break(clean)` ends the connection; `Continue(v)` carries on.
pub(super) type Flow<T = ()> = ControlFlow<bool, T>;

/// What the batch loop does after one request.
pub(super) enum Step {
    /// Parse the next pipelined request.
    Next,
    /// Stop batching; collect what is in flight.
    Stop,
}

/// A request queued for JS whose response is awaited in pipeline order.
pub(super) struct InFlightReq {
    pub(super) slot_future: SlotFuture,
    pub(super) method_code: MethodCode,
    pub(super) is_head: bool,
    pub(super) http_version: u8,
    pub(super) close_after: bool,
    pub(super) header_block: Bytes,
    pub(super) if_none_match: Option<(usize, usize)>,
    pub(super) if_modified_since: Option<(usize, usize)>,
    pub(super) range: Option<(usize, usize)>,
    pub(super) if_range: Option<(usize, usize)>,
}

#[inline]
pub(super) fn pump_error_status(e: PumpError) -> u16 {
    match e {
        PumpError::Bad => 400,
        PumpError::TooLarge => 413,
        PumpError::TrailerTooLarge => 431,
    }
}

pub(super) fn earliest_deadline(a: Option<Instant>, b: Option<Instant>) -> Option<Instant> {
    match (a, b) {
        (Some(ia), Some(ib)) => Some(ia.min(ib)),
        (Some(ia), None) => Some(ia),
        (None, Some(ib)) => Some(ib),
        (None, None) => None,
    }
}

/// State of one pipelined batch (reset every turn of the connection loop).
#[derive(Default)]
pub(super) struct Batch {
    pub(super) close_connection: bool,
    pub(super) need_more_bytes: bool,
    /// Error answered after the responses already in flight (then the connection closes).
    pub(super) pending_error_status: Option<u16>,
    pub(super) batch_start: Option<Instant>,
    /// Streamed request body of this batch (always its only request).
    pub(super) pump: Option<BodyPump>,
    pub(super) pump_err: Option<PumpError>,
}

/// Per-connection state.
pub(super) struct Conn<'c, 'a, S> {
    pub(super) stream: &'c mut S,
    pub(super) shared: &'c Arc<ServerShared>,
    pub(super) peer_ip: Arc<str>,
    pub(super) is_tls: bool,
    pub(super) bus: &'c ShutdownBus,
    pub(super) shard: &'a Notify,
    pub(super) sfut: Pin<&'c mut Notified<'a>>,

    pub(super) read_buf: BytesMut,
    pub(super) write_buf: Vec<u8>,
    pub(super) in_flight: Vec<InFlightReq>,

    /// Keep-alive / request-head timer.
    ka_sleep: Pin<&'c mut Sleep>,
    ka_armed_until: Option<Instant>,
    /// Body / handler timer.
    pub(super) req_sleep: Pin<&'c mut Sleep>,
    pub(super) req_armed_until: Option<Instant>,

    pub(super) slot_reserve: usize,
    pub(super) max_wait_read_buf: usize,
    pub(super) wait_eof_probe: [u8; 1],
    pub(super) peer_eof_deadline: Option<Instant>,

    h_dur: Option<Duration>,
    pub(super) r_dur: Option<Duration>,
    ka_dur: Option<Duration>,
    pub(super) handler_dur: Option<Duration>,
    needs_req_start: bool,

    served_count: u64,
    pub(super) req_start: Option<Instant>,
}

pub(super) async fn handle_connection<'a, S: ConnStream>(
    stream: S,
    shared: Arc<ServerShared>,
    peer_ip: Arc<str>,
    is_tls: bool,
    shutdown_bus: &ShutdownBus,
    shutdown_shard: &'a Notify,
    shutdown_fut: &mut Pin<&mut Notified<'a>>,
) {
    // Every response write (buffered, static/sendFile, streamed) goes through the idle
    // deadline: a peer that stops reading is dropped instead of pinning the connection.
    let mut stream = IdleWrite::new(stream, shared.config.write_timeout());
    let clean_exit = HTTP10_KEEP_ALIVE
        .scope(
            std::cell::Cell::new(false),
            handle_connection_inner(
                &mut stream,
                &shared,
                peer_ip,
                is_tls,
                shutdown_bus,
                shutdown_shard,
                shutdown_fut,
            ),
        )
        .await;
    if clean_exit {
        if is_tls {
            let _ = tokio::time::timeout(Duration::from_millis(500), stream.shutdown()).await;
        }
        if shutdown_bus.state() == 0 {
            lingering_close(&mut stream).await;
        }
    }
}

/// Lingering close (RFC 9112 9.6): after a final `Connection: close` response the client may
/// still be sending a request body we never read. Closing a socket with unread input makes the
/// kernel answer RST, which can destroy the response before the client reads it (e.g. an early
/// 413). Half-close our side, then discard input until EOF, briefly and with a byte cap.
async fn lingering_close<S: ConnStream>(stream: &mut S) {
    // Like Node/Express (which read the rest of an unwanted body before closing), keep draining
    // while the peer is still sending, so a client that is mid-upload when we answer (413...)
    // reads our response instead of hitting EPIPE/RST. Bounded per connection by an idle gap,
    // a total deadline and a byte budget.
    const IDLE: Duration = Duration::from_millis(500);
    const DEADLINE: Duration = Duration::from_secs(10);
    const MAX_DISCARD: usize = 64 << 20;
    let _ = tokio::time::timeout(Duration::from_millis(100), stream.shutdown()).await;
    let mut sink = [0u8; 16384];
    let mut discarded = 0usize;
    let _ = tokio::time::timeout(DEADLINE, async {
        while discarded < MAX_DISCARD {
            match tokio::time::timeout(IDLE, stream.read(&mut sink)).await {
                Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
                Ok(Ok(n)) => discarded += n,
            }
        }
    })
    .await;
}

/// Returns `true` when the connection exited cleanly (eligible for TLS close_notify).
async fn handle_connection_inner<'a, S: ConnStream>(
    stream: &mut S,
    shared: &Arc<ServerShared>,
    peer_ip: Arc<str>,
    is_tls: bool,
    shutdown_bus: &ShutdownBus,
    shutdown_shard: &'a Notify,
    shutdown_fut: &mut Pin<&mut Notified<'a>>,
) -> bool {
    let ka_sleep = tokio::time::sleep(Duration::from_secs(60));
    tokio::pin!(ka_sleep);
    let req_sleep = tokio::time::sleep(Duration::from_secs(300));
    tokio::pin!(req_sleep);

    let h_dur = shared.config.headers_timeout();
    let r_dur = shared.config.request_timeout();
    let handler_dur = shared.config.handler_timeout();
    let mut conn = Conn {
        stream,
        shared,
        peer_ip,
        is_tls,
        bus: shutdown_bus,
        shard: shutdown_shard,
        sfut: shutdown_fut.as_mut(),
        read_buf: BytesMut::with_capacity(8192),
        write_buf: Vec::with_capacity(8192),
        in_flight: Vec::with_capacity(MAX_PIPELINE_BATCH),
        ka_sleep,
        ka_armed_until: None,
        req_sleep,
        req_armed_until: None,
        slot_reserve: shared
            .config
            .max_connections_limit()
            .unwrap_or(usize::MAX)
            .min(crate::slots::SLOT_COUNT / 2),
        max_wait_read_buf: shared.config.max_header_size_bytes.max(65_536),
        wait_eof_probe: [0u8; 1],
        peer_eof_deadline: None,
        h_dur,
        r_dur,
        ka_dur: shared.config.keep_alive_timeout(),
        handler_dur,
        needs_req_start: h_dur.is_some() || r_dur.is_some() || handler_dur.is_some(),
        served_count: 0,
        req_start: None,
    };
    conn.run().await
}

impl<S: ConnStream> Conn<'_, '_, S> {
    async fn run(&mut self) -> bool {
        loop {
            if let Break(clean) = self.serve_batch().await {
                return clean;
            }
        }
    }

    /// One turn of the connection loop: read, parse/dispatch a batch, collect, flush.
    async fn serve_batch(&mut self) -> Flow {
        let bus_state = self.bus.state();
        if self.shared.is_closed.load(Ordering::Relaxed) || bus_state >= 2 {
            return Break(false);
        }
        if (self.draining() || bus_state >= 1) && self.read_buf.is_empty() {
            return Break(true);
        }

        // Ensure at least one complete HTTP/1.1 request is in read_buf
        if self.read_buf.is_empty() {
            self.read_head().await?;
        }

        if self.needs_req_start && self.req_start.is_none() {
            self.req_start = Some(Instant::now());
        }

        self.write_buf.clear();
        self.in_flight.clear();
        let mut batch = Batch::default();

        self.parse_batch(&mut batch).await?;

        // Flush coalesced pure-Rust static responses in ONE syscall!
        self.flush_write_buf().await?;

        if !self.in_flight.is_empty() {
            self.collect(&mut batch).await?;
        } else if let Some(err_status) = batch.pending_error_status {
            return self.error_close(err_status).await;
        }

        if batch.close_connection || self.draining() {
            return Break(true);
        }

        if batch.need_more_bytes {
            self.read_more().await?;
        }
        Continue(())
    }

    /// Wait for the first bytes of the next request (empty `read_buf`).
    async fn read_head(&mut self) -> Flow {
        if self.read_buf.capacity() < 4096 {
            self.read_buf.reserve(8192);
        }
        if self.served_count == 0 {
            return self.wait_first_request().await;
        }
        // O2: Fast non-blocking probe before arming Keep-Alive timers or select!
        match self.stream.try_read_buf_fast(&mut self.read_buf) {
            Ok(0) => Break(true),
            Ok(_) => {
                if self.needs_req_start {
                    self.req_start = Some(Instant::now());
                }
                Continue(())
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                self.wait_keep_alive().await
            }
            Err(_) => Break(false),
        }
    }

    /// Idle Keep-Alive wait.
    async fn wait_keep_alive(&mut self) -> Flow {
        let mut ka_dl: Option<Instant> = None;
        loop {
            let st = self.bus.state();
            if st >= 2 {
                return Break(false);
            }
            if st >= 1 || self.draining() {
                return Break(true);
            }
            if let Some(dur) = self.ka_dur {
                let dl = match ka_dl {
                    Some(d) => {
                        if Instant::now() >= d {
                            return Break(true);
                        }
                        d
                    }
                    None => {
                        let d = Instant::now() + dur;
                        ka_dl = Some(d);
                        d
                    }
                };
                arm_deadline(&mut self.ka_sleep, &mut self.ka_armed_until, Some(dl), dur);
            }
            tokio::select! {
                biased;
                read_res = self.stream.read_buf(&mut self.read_buf) => {
                    return match read_res {
                        Ok(0) => Break(true),
                        Ok(_) => {
                            if self.needs_req_start {
                                self.req_start = Some(Instant::now());
                            }
                            Continue(())
                        }
                        Err(_) => Break(false),
                    };
                }
                _ = self.sfut.as_mut() => {
                    self.sfut.set(self.shard.notified());
                    let _ = self.sfut.as_mut().enable();
                    let st = self.bus.state();
                    if st >= 1 {
                        return Break(st < 2);
                    }
                }
                _ = self.ka_sleep.as_mut(), if ka_dl.is_some() => {
                    self.ka_armed_until = None;
                    if let Some(dl) = ka_dl {
                        if Instant::now() >= dl {
                            return Break(true);
                        }
                    }
                }
            }
        }
    }

    /// First request on a newly accepted socket: enforce headersTimeout / requestTimeout.
    async fn wait_first_request(&mut self) -> Flow {
        let phase_dur = match (self.h_dur, self.r_dur) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => Duration::from_secs(60),
        };
        let dl = match (self.h_dur, self.r_dur) {
            (None, None) => None,
            _ => {
                let start = *self.req_start.get_or_insert_with(Instant::now);
                Some(start + phase_dur)
            }
        };

        loop {
            let st = self.bus.state();
            if st >= 2 {
                return Break(false);
            }
            if st >= 1 || self.draining() {
                return Break(true);
            }
            if let Some(d) = dl {
                arm_deadline_with_slack(
                    &mut self.ka_sleep,
                    &mut self.ka_armed_until,
                    Some(d),
                    Duration::ZERO,
                );
            }
            tokio::select! {
                biased;
                read_res = self.stream.read_buf(&mut self.read_buf) => {
                    match read_res {
                        Ok(0) => return Break(true),
                        Ok(_) => {
                            if let Some(d) = dl {
                                if Instant::now() >= d {
                                    return self.timeout_close().await;
                                }
                            }
                            if self.needs_req_start && self.req_start.is_none() {
                                self.req_start = Some(Instant::now());
                            }
                            return Continue(());
                        }
                        Err(_) => return Break(false),
                    }
                }
                _ = self.sfut.as_mut() => {
                    self.sfut.set(self.shard.notified());
                    let _ = self.sfut.as_mut().enable();
                    let st = self.bus.state();
                    if st >= 1 {
                        return Break(st < 2);
                    }
                }
                _ = self.ka_sleep.as_mut(), if dl.is_some() => {
                    self.ka_armed_until = None;
                    if let Some(d) = dl {
                        if Instant::now() >= d {
                            return self.timeout_close().await;
                        }
                    }
                }
            }
        }
    }

    /// The buffered bytes end mid request head: read more under headersTimeout/requestTimeout.
    async fn read_more(&mut self) -> Flow {
        if self.read_buf.capacity() - self.read_buf.len() < 4096 {
            self.read_buf.reserve(8192);
        }
        let h_dl = self
            .h_dur
            .map(|d| self.req_start.unwrap_or_else(Instant::now) + d);
        let r_dl = self
            .r_dur
            .map(|d| self.req_start.unwrap_or_else(Instant::now) + d);
        let dl = earliest_deadline(h_dl, r_dl);

        match read_buf_timed(
            &mut *self.stream,
            &mut self.read_buf,
            dl,
            &mut self.ka_sleep,
            &mut self.ka_armed_until,
            self.bus.state_atomic(),
            self.shard,
            &mut self.sfut,
        )
        .await
        {
            Ok(_) => Continue(()),
            Err(ExactBodyError::Timeout) => self.timeout_close().await,
            Err(ExactBodyError::Eof) => Break(true),
            Err(ExactBodyError::Io | ExactBodyError::Shutdown) => Break(false),
        }
    }

    #[inline]
    pub(super) fn draining(&self) -> bool {
        self.shared.draining.load(Ordering::Relaxed)
    }

    /// A request was answered (or queued): count it and restart the request clock if more
    /// bytes are already buffered.
    #[inline]
    pub(super) fn mark_served(&mut self) {
        self.served_count += 1;
        self.req_start = if !self.needs_req_start || self.read_buf.is_empty() {
            None
        } else {
            Some(Instant::now())
        };
    }

    /// Write out coalesced responses; a failed write ends the connection.
    #[inline]
    pub(super) async fn flush_write_buf(&mut self) -> Flow {
        if !self.write_buf.is_empty() {
            if self.stream.write_all(&self.write_buf).await.is_err() {
                return Break(false);
            }
            self.write_buf.clear();
        }
        Continue(())
    }

    /// Answer `status` with `Connection: close` and end the connection.
    pub(super) async fn error_close<T>(&mut self, status: u16) -> Flow<T> {
        let _ = write_error_close(
            &mut *self.stream,
            &mut self.write_buf,
            status,
            self.shared.config.x_powered_by,
        )
        .await;
        Break(true)
    }

    /// requestTimeout / headersTimeout expired: count it and answer 408.
    async fn timeout_close<T>(&mut self) -> Flow<T> {
        self.shared
            .metrics
            .request_timeouts
            .fetch_add(1, Ordering::Relaxed);
        self.error_close(408).await
    }

    /// Refuse the request being parsed: after the responses already in flight when there are
    /// some (`stop` is returned and the batch closes the connection), otherwise right away.
    pub(super) async fn reject<T>(&mut self, batch: &mut Batch, status: u16, stop: T) -> Flow<T> {
        if !self.in_flight.is_empty() {
            batch.pending_error_status = Some(status);
            batch.close_connection = true;
            return Continue(stop);
        }
        self.error_close(status).await
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_util::make_test_shared;
    use super::super::{drain_server, start_http_server_sync};
    use super::*;
    use crate::config::EngineConfig;

    #[tokio::test]
    async fn forced_shutdown_aborts_slowloris_mid_header_and_mid_body() {
        let cfg = EngineConfig {
            headers_timeout_ms: 30_000,
            request_timeout_ms: 30_000,
            shutdown_timeout_ms: 50,
            ..EngineConfig::default()
        };
        let shared = make_test_shared(cfg);
        let running = start_http_server_sync("127.0.0.1".into(), 0, shared.clone(), None).unwrap();
        let addr = running.local_addr;

        let mut h_sock = tokio::net::TcpStream::connect(addr).await.unwrap();
        h_sock.write_all(b"GET /ok HTTP/1.1\r\n").await.unwrap();

        let mut b_sock = tokio::net::TcpStream::connect(addr).await.unwrap();
        b_sock
            .write_all(b"POST /up HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\nhello")
            .await
            .unwrap();

        let mut c_sock = tokio::net::TcpStream::connect(addr).await.unwrap();
        c_sock
            .write_all(b"POST /up HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhe")
            .await
            .unwrap();

        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(shared.active_connections.load(Ordering::Acquire), 3);

        shared.draining.store(true, Ordering::Release);
        running.shutdown_bus.send_state(1);
        drain_server(
            shared.clone(),
            running.accept_done_rx,
            running.shutdown_bus,
            Duration::from_millis(50),
        )
        .await;

        assert_eq!(shared.active_connections.load(Ordering::Acquire), 0);
        let mut buf = [0u8; 16];
        let r1 = tokio::time::timeout(Duration::from_secs(1), h_sock.read(&mut buf)).await;
        let r2 = tokio::time::timeout(Duration::from_secs(1), b_sock.read(&mut buf)).await;
        let r3 = tokio::time::timeout(Duration::from_secs(1), c_sock.read(&mut buf)).await;
        assert!(r1.is_ok(), "mid-header socket did not close promptly");
        assert!(r2.is_ok(), "mid-CL-body socket did not close promptly");
        assert!(r3.is_ok(), "mid-chunked-body socket did not close promptly");
    }
}
