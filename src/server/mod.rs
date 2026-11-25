//! HTTP/1.1 engine: shared server state and lifecycle.
//!
//! - `listener`: Tokio runtime, bind, accept loop, connection limits, graceful drain.
//! - `conn`: per-connection driver (read head → dispatch a pipelined batch → collect the JS
//!   responses → flush → keep-alive), split in `dispatch` and `collect`.
//! - `respond_buffered` / `respond_stream`: response framing for buffered and streamed bodies.
//! - `handoff`: the `ConnStream` abstraction and `'upgrade'` hand-off to Node.
//! - `etag`: native ETag computation and conditional-request header scans.

mod collect;
mod conn;
mod dispatch;
mod etag;
mod handoff;
mod listener;
mod read_body;
mod respond_buffered;
mod respond_stream;

pub use listener::{drain_server, get_io_runtime, set_io_threads, start_http_server_sync};

use crate::body::BodyRule;
use crate::config::{EngineConfig, EtagMode};
use crate::protocol::{build_simple_raw_response, dispatch_response_batch, PendingRequest};
use crate::reqbody::RequestBodies;
use crate::router::CompiledRouter;
use crate::slots::{SlotResponse, SlotTable};
use crate::static_files::StaticMount;
use crate::stream::{CloseNotifier, StreamHandle, StreamRegistry};
use crate::upgrade::Upgrades;
use crossbeam_queue::SegQueue;
use parking_lot::Mutex;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, watch, Notify};

#[derive(Default)]
pub struct ServerMetrics {
    pub tls_handshake_errors: AtomicU64,
    pub tls_handshake_timeouts: AtomicU64,
    pub rejected_connections: AtomicU64,
    pub request_timeouts: AtomicU64,
    pub handler_timeouts: AtomicU64,
}

pub struct ServerShared {
    pub config: EngineConfig,
    pub router: CompiledRouter,
    pub static_mounts: Vec<StaticMount>,
    pub body_rules: Vec<BodyRule>,
    pub queue: SegQueue<PendingRequest>,
    pub overflow: Mutex<Option<PendingRequest>>,
    pub has_overflow: AtomicBool,
    pub closed_streams: Arc<SegQueue<u32>>,
    pub drained_streams: Arc<SegQueue<u32>>,
    pub scheduled: Arc<AtomicBool>,
    pub draining: AtomicBool,
    pub is_closed: AtomicBool,
    pub active_connections: AtomicUsize,
    pub drain_notify: Notify,
    pub metrics: ServerMetrics,
    pub slots: Arc<SlotTable>,
    pub streams: Arc<StreamRegistry>,
    /// Streamed request bodies (see `reqbody`).
    pub bodies: Arc<RequestBodies>,
    /// Upgraded connections waiting for JS (see `upgrade`).
    pub upgrades: Upgrades,
    pub wakeup: Arc<dyn Fn() + Send + Sync>,
    pub close_notifier: Arc<CloseNotifier>,
}

impl ServerShared {
    #[inline]
    pub fn wake_js(&self) {
        if !self.scheduled.swap(true, Ordering::SeqCst) {
            (self.wakeup)();
        }
    }

    /// Zero-allocation batch drain directly into the JS-owned pre-allocated Buffer.
    /// Returns:
    /// - `0` if no requests are queued
    /// - `byte_len` (top bit 0) if 1+ requests were encoded into `dst[..byte_len]`
    /// - `0x8000_0000 | needed_size` if the next single request exceeds `dst.len()`
    ///
    /// In `dst[0..4]`, bit 31 indicates `has_more` so JS never starves on `hit_limit`.
    pub fn drain_requests_into(&self, dst: &mut [u8], max_batch: usize) -> u32 {
        if dst.len() < 4 {
            self.scheduled.store(false, Ordering::SeqCst);
            if !self.queue.is_empty()
                || !self.closed_streams.is_empty()
                || !self.drained_streams.is_empty()
                || self.bodies.has_ready()
                || self.has_overflow.load(Ordering::Acquire)
            {
                self.wake_js();
            }
            return 0;
        }
        let mut count: u32 = 0;
        let mut pos: usize = 4;
        let cap = dst.len();
        let mut hit_limit = false;

        let mut overflow_guard = if self.has_overflow.load(Ordering::Acquire) {
            Some(self.overflow.lock())
        } else {
            None
        };

        for _ in 0..max_batch {
            let next_req = match overflow_guard.as_mut().and_then(|g| g.take()) {
                Some(r) => {
                    self.has_overflow.store(false, Ordering::Release);
                    Some(r)
                }
                None => self.queue.pop(),
            };
            let Some(req) = next_req else {
                break;
            };

            let Some(needed) = req.validated_encoded_size() else {
                self.slots.complete(
                    req.req_id,
                    SlotResponse::RawHttp(build_simple_raw_response(
                        413,
                        self.config.x_powered_by,
                        true,
                    )),
                );
                continue;
            };
            let req_size_total = needed.saturating_add(64);
            if req_size_total > 0x7FFF_FFFF {
                self.slots.complete(
                    req.req_id,
                    SlotResponse::RawHttp(build_simple_raw_response(
                        413,
                        self.config.x_powered_by,
                        true,
                    )),
                );
                continue;
            }

            if pos + needed > cap {
                let guard = overflow_guard.get_or_insert_with(|| self.overflow.lock());
                **guard = Some(req);
                self.has_overflow.store(true, Ordering::Release);
                if count == 0 {
                    drop(overflow_guard);
                    self.scheduled.store(false, Ordering::SeqCst);
                    let req_size = req_size_total as u32;
                    return 0x8000_0000 | (req_size & 0x7FFF_FFFF);
                }
                hit_limit = true;
                break;
            }

            if req.encode_with_size_into(needed, dst, &mut pos).is_err() {
                self.slots.complete(
                    req.req_id,
                    SlotResponse::RawHttp(build_simple_raw_response(
                        500,
                        self.config.x_powered_by,
                        true,
                    )),
                );
                continue;
            }
            count += 1;
        }

        let has_more_in_overflow = self.has_overflow.load(Ordering::Acquire);
        drop(overflow_guard);

        let has_more = hit_limit || (count as usize) == max_batch || has_more_in_overflow;
        if count > 0 {
            let header_val = count | if has_more { 0x8000_0000 } else { 0 };
            dst[0..4].copy_from_slice(&header_val.to_le_bytes());
        }

        if !has_more {
            self.scheduled.store(false, Ordering::SeqCst);
            if !self.queue.is_empty()
                || !self.closed_streams.is_empty()
                || !self.drained_streams.is_empty()
                || self.bodies.has_ready()
            {
                self.wake_js();
            }
        }

        if count == 0 {
            0
        } else {
            pos as u32
        }
    }

    pub fn drain_closed_streams(&self) -> Vec<u32> {
        let mut closed = Vec::new();
        while let Some(id) = self.closed_streams.pop() {
            closed.push(id);
        }
        closed
    }

    /// `[closedCount, drainedCount, ...closed, ...drained, ...bodyReady]`, or empty.
    pub fn drain_stream_events(&self) -> Vec<u32> {
        if self.closed_streams.is_empty()
            && self.drained_streams.is_empty()
            && !self.bodies.has_ready()
        {
            return Vec::new();
        }
        let mut out = vec![0, 0];
        while let Some(id) = self.closed_streams.pop() {
            out.push(id);
        }
        let closed_count = (out.len() - 2) as u32;
        while let Some(id) = self.drained_streams.pop() {
            out.push(id);
        }
        let drained_count = (out.len() - 2) as u32 - closed_count;
        self.bodies.drain_ready(&mut out);
        if out.len() == 2 {
            return Vec::new();
        }
        out[0] = closed_count;
        out[1] = drained_count;
        out
    }

    #[inline]
    pub fn flush_response_buf(&self, buf: &[u8]) {
        dispatch_response_batch(
            buf,
            &self.slots,
            self.config.x_powered_by,
            self.config.etag_mode != EtagMode::Off,
        );
    }

    pub fn start_stream(
        &self,
        req_id: u32,
        status: u16,
        headers: Vec<(String, String)>,
        suppress_x_powered_by: bool,
    ) -> bool {
        let cap = self.config.stream_queue_capacity.max(1);
        let (tx, rx) = mpsc::channel(cap);
        let drain_armed = Arc::new(AtomicBool::new(false));
        let aborted = self.streams.insert(req_id, tx, drain_armed.clone(), cap);
        let handle = StreamHandle {
            req_id,
            rx,
            drain_armed,
            capacity: cap,
            aborted,
            streams: self.streams.clone(),
            close_notifier: self.close_notifier.clone(),
        };
        let ok = self.slots.complete(
            req_id,
            SlotResponse::Stream {
                status,
                headers,
                suppress_x_powered_by,
                handle,
            },
        );
        if !ok {
            self.streams.remove(req_id);
        }
        ok
    }
}

struct ShutdownBusInner {
    state: AtomicU8,
    shards: Vec<Notify>,
}

#[derive(Clone)]
pub struct ShutdownBus {
    inner: Arc<ShutdownBusInner>,
}

impl ShutdownBus {
    pub fn new(shard_count: usize) -> Self {
        let count = shard_count.max(1);
        let mut shards = Vec::with_capacity(count);
        for _ in 0..count {
            shards.push(Notify::new());
        }
        Self {
            inner: Arc::new(ShutdownBusInner {
                state: AtomicU8::new(0),
                shards,
            }),
        }
    }

    #[inline]
    pub fn state(&self) -> u8 {
        self.inner.state.load(Ordering::Acquire)
    }

    #[inline]
    pub fn state_atomic(&self) -> &AtomicU8 {
        &self.inner.state
    }

    #[inline]
    pub fn shard(&self, idx: usize) -> &Notify {
        &self.inner.shards[idx % self.inner.shards.len()]
    }

    pub fn send_state(&self, state: u8) {
        self.inner.state.fetch_max(state, Ordering::AcqRel);
        for shard in &self.inner.shards {
            shard.notify_waiters();
        }
    }
}

pub struct RunningServer {
    pub local_addr: SocketAddr,
    pub shutdown_bus: ShutdownBus,
    pub accept_done_rx: watch::Receiver<bool>,
    pub shared: Arc<ServerShared>,
}

impl RunningServer {
    pub fn force_close(&mut self) {
        self.shared.draining.store(true, Ordering::Release);
        self.shared.is_closed.store(true, Ordering::Release);
        self.shutdown_bus.send_state(2);
        // Upgraded sockets JS has not taken yet are closed with the server.
        self.shared.upgrades.clear();
    }
}

#[cfg(test)]
pub(crate) mod test_util {
    use super::*;

    pub(crate) fn make_test_shared(cfg: EngineConfig) -> Arc<ServerShared> {
        let closed_streams = Arc::new(SegQueue::new());
        let drained_streams = Arc::new(SegQueue::new());
        let scheduled = Arc::new(AtomicBool::new(false));
        let wakeup: Arc<dyn Fn() + Send + Sync> = Arc::new(|| {});
        let close_notifier = Arc::new(CloseNotifier {
            closed_queue: closed_streams.clone(),
            drained_queue: drained_streams.clone(),
            wakeup: wakeup.clone(),
            scheduled: scheduled.clone(),
        });
        Arc::new(ServerShared {
            config: cfg,
            router: CompiledRouter::new(false, false),
            static_mounts: Vec::new(),
            body_rules: Vec::new(),
            queue: SegQueue::new(),
            overflow: Mutex::new(None),
            has_overflow: AtomicBool::new(false),
            bodies: Arc::new(RequestBodies::new(wakeup.clone(), scheduled.clone())),
            upgrades: Upgrades::new(),
            closed_streams,
            drained_streams,
            scheduled,
            draining: AtomicBool::new(false),
            is_closed: AtomicBool::new(false),
            active_connections: AtomicUsize::new(0),
            drain_notify: Notify::new(),
            metrics: ServerMetrics::default(),
            slots: Arc::new(SlotTable::new()),
            streams: Arc::new(StreamRegistry::new()),
            wakeup,
            close_notifier,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::test_util::make_test_shared;
    use super::*;
    use crate::body::BodyMode;
    use crate::router::MethodCode;
    use bytes::Bytes;

    #[tokio::test]
    async fn drain_requests_into_sets_has_more_and_clears_scheduled_on_sentinel() {
        let shared = make_test_shared(EngineConfig::default());
        let id = shared.slots.acquire().unwrap();
        let _fut = shared.slots.wait(id);
        shared.queue.push(PendingRequest {
            req_id: id,
            route_id: 0,
            method: MethodCode::Get,
            method_str: None,
            is_tls: false,
            body_mode: BodyMode::None,
            raw_url: Bytes::from_static(b"/hello"),
            path_len: 6,
            remote_addr: Arc::from("127.0.0.1"),
            params: Vec::new(),
            raw_headers: Bytes::new(),
            body: Bytes::from(vec![b'a'; 1024]),
            upgrade: false,
            conditional: false,
        });
        shared.scheduled.store(true, Ordering::SeqCst);

        // Buffer too small -> returns resize sentinel and clears scheduled
        let mut tiny = vec![0u8; 64];
        let res = shared.drain_requests_into(&mut tiny, 512);
        assert_ne!(res & 0x8000_0000, 0);
        assert!(!shared.scheduled.load(Ordering::SeqCst));

        // Large buffer -> drains cleanly and clears scheduled
        let mut big = vec![0u8; 4096];
        let res2 = shared.drain_requests_into(&mut big, 512);
        assert_eq!(res2 & 0x8000_0000, 0);
        assert!(res2 > 0);
        let hdr = u32::from_le_bytes([big[0], big[1], big[2], big[3]]);
        assert_eq!(hdr & 0x7FFF_FFFF, 1);
        assert_eq!(hdr & 0x8000_0000, 0);
        assert!(!shared.scheduled.load(Ordering::SeqCst));
    }
}
