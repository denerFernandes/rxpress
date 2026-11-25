mod body;
mod config;
mod date;
mod http_parse;
mod mime_table;
mod protocol;
mod reqbody;
mod router;
mod server;
mod slots;
mod static_files;
mod stream;
mod tls;
mod upgrade;
mod write_idle;

use body::{BodyMode, BodyRule};
use bytes::Bytes;
use config::{EngineConfig, EtagMode};
use crossbeam_queue::SegQueue;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::JsFunction;
use napi_derive::napi;
use parking_lot::Mutex;
use protocol::{build_simple_raw_response, is_valid_response_header, is_valid_status};
use reqbody::RequestBodies;
use router::CompiledRouter;
use server::{
    drain_server, get_io_runtime, start_http_server_sync, RunningServer, ServerMetrics,
    ServerShared,
};
use slots::{SlotResponse, SlotTable};
use static_files::StaticMount;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use stream::{CloseNotifier, StreamRegistry};
use tls::TlsInput;
use tokio::sync::Notify;
use upgrade::Upgrades;

#[napi(object)]
pub struct NativeServerConfig {
    pub x_powered_by: Option<bool>,
    pub etag_mode: Option<String>,
    pub case_sensitive: Option<bool>,
    pub strict_routing: Option<bool>,
    pub headers_timeout_ms: Option<u32>,
    pub request_timeout_ms: Option<u32>,
    pub keep_alive_timeout_ms: Option<u32>,
    pub tls_handshake_timeout_ms: Option<u32>,
    pub handler_timeout_ms: Option<u32>,
    pub write_timeout_ms: Option<u32>,
    pub shutdown_timeout_ms: Option<u32>,
    pub max_connections: Option<u32>,
    pub max_headers_count: Option<u32>,
    pub max_header_size_bytes: Option<u32>,
    pub default_body_limit_bytes: Option<u32>,
    pub stream_queue_capacity: Option<u32>,
    pub io_threads: Option<u32>,
}

#[napi(object)]
pub struct NativeStaticMount {
    pub prefix: String,
    pub root: String,
    pub index: Option<Vec<String>>,
    pub max_age_secs: Option<u32>,
    pub etag: Option<bool>,
    pub last_modified: Option<bool>,
    pub dotfiles: Option<String>,
    pub fallthrough: Option<bool>,
    pub extensions: Option<Vec<String>>,
    pub immutable: Option<bool>,
    pub redirect: Option<bool>,
}

#[napi(object)]
pub struct NativeBodyRule {
    pub prefix: String,
    pub mode: u32,
    pub limit: u32,
    pub content_types: Vec<String>,
}

#[napi(object)]
pub struct NativeTlsConfig {
    pub cert: Buffer,
    pub key: Buffer,
}

#[napi(object)]
pub struct NativeAddressInfo {
    pub address: String,
    pub port: u32,
    pub family: String,
}

#[napi(object)]
pub struct NativeServerMetrics {
    pub tls_handshake_errors: u32,
    pub tls_handshake_timeouts: u32,
    pub rejected_connections: u32,
    pub request_timeouts: u32,
    pub handler_timeouts: u32,
    pub active_connections: u32,
}

#[inline]
pub fn validate_port(port: u32) -> std::result::Result<u16, String> {
    u16::try_from(port).map_err(|_| format!("Port {port} out of range (must be 0..=65535)"))
}

struct ServerLifecycle {
    shared: Option<Arc<ServerShared>>,
    running: Option<RunningServer>,
}

impl ServerLifecycle {
    fn close(&mut self) {
        if let Some(mut running) = self.running.take() {
            running.force_close();
        }
        self.shared = None;
    }
}

impl Drop for ServerLifecycle {
    fn drop(&mut self) {
        self.close();
    }
}

/// Content-Type for a file extension (`"js"`, `"PNG"`), from the same table as `mime-types`;
/// `null` when unknown. Backs `res.type()` so it agrees with static files and `res.sendFile()`.
#[napi]
pub fn mime_content_type(ext: String) -> Option<String> {
    mime_table::content_type_for_extension(&ext).map(str::to_owned)
}

#[napi]
pub struct NativeServer {
    config: EngineConfig,
    routes: Vec<(String, String, i32)>,
    static_mounts: Vec<StaticMount>,
    body_rules: Vec<BodyRule>,
    lifecycle: ServerLifecycle,
    tsfn: Option<ThreadsafeFunction<(), ErrorStrategy::Fatal>>,
}

impl Drop for NativeServer {
    fn drop(&mut self) {
        self.close();
    }
}

#[napi]
impl NativeServer {
    #[napi(constructor)]
    pub fn new(cfg: Option<NativeServerConfig>) -> Self {
        let mut config = EngineConfig::default();
        if let Some(c) = cfg {
            apply_config(&mut config, c);
        }
        Self {
            config,
            routes: Vec::new(),
            static_mounts: Vec::new(),
            body_rules: Vec::new(),
            lifecycle: ServerLifecycle {
                shared: None,
                running: None,
            },
            tsfn: None,
        }
    }

    #[napi]
    pub fn set_config(&mut self, cfg: NativeServerConfig) {
        apply_config(&mut self.config, cfg);
    }

    #[napi]
    pub fn add_route(&mut self, method: String, path: String, route_id: i32) -> bool {
        if router::express_to_matchit(&path, self.config.case_sensitive).is_none() {
            return false;
        }
        self.routes.push((method, path, route_id));
        true
    }

    #[napi]
    pub fn add_static(&mut self, mount: NativeStaticMount) {
        self.static_mounts.push(StaticMount::new(
            mount.prefix,
            PathBuf::from(mount.root),
            mount
                .index
                .unwrap_or_else(|| vec!["index.html".to_string()]),
            mount.max_age_secs.unwrap_or(0) as u64,
            mount.etag.unwrap_or(true),
            mount.last_modified.unwrap_or(true),
            mount.dotfiles.unwrap_or_else(|| "ignore".to_string()),
            mount.fallthrough.unwrap_or(true),
            mount.extensions.unwrap_or_default(),
            mount.immutable.unwrap_or(false),
            mount.redirect.unwrap_or(true),
        ));
    }

    #[napi]
    pub fn add_body_rule(&mut self, rule: NativeBodyRule) {
        let mode = match rule.mode {
            1 => BodyMode::Json,
            2 => BodyMode::UrlEncoded,
            3 => BodyMode::Text,
            4 => BodyMode::Raw,
            _ => BodyMode::None,
        };
        self.body_rules.push(BodyRule {
            prefix: rule.prefix,
            mode,
            limit: rule.limit as usize,
            content_types: rule.content_types,
            case_sensitive: self.config.case_sensitive,
        });
    }

    #[napi]
    pub fn start(
        &mut self,
        host: String,
        port: u32,
        on_wakeup: JsFunction,
        tls: Option<NativeTlsConfig>,
    ) -> Result<NativeAddressInfo> {
        if self.lifecycle.running.is_some() {
            return Err(Error::from_reason("Server is already running"));
        }
        let validated_port = validate_port(port).map_err(Error::from_reason)?;

        let mut compiled =
            CompiledRouter::new(self.config.case_sensitive, self.config.strict_routing);
        for (method, path, route_id) in &self.routes {
            compiled.insert(method, path, *route_id);
        }

        let tsfn: ThreadsafeFunction<(), ErrorStrategy::Fatal> =
            on_wakeup.create_threadsafe_function(0, |_ctx| Ok(Vec::<Unknown>::new()))?;

        let tsfn_for_close = tsfn.clone();
        let tsfn_arc = Arc::new(tsfn);
        let wakeup: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let _ = tsfn_arc.call((), ThreadsafeFunctionCallMode::NonBlocking);
        });

        let closed_streams = Arc::new(SegQueue::new());
        let drained_streams = Arc::new(SegQueue::new());
        let scheduled = Arc::new(AtomicBool::new(false));
        let close_notifier = Arc::new(CloseNotifier {
            closed_queue: closed_streams.clone(),
            drained_queue: drained_streams.clone(),
            wakeup: wakeup.clone(),
            scheduled: scheduled.clone(),
        });

        let shared = Arc::new(ServerShared {
            config: self.config.clone(),
            router: compiled,
            static_mounts: self.static_mounts.clone(),
            body_rules: self.body_rules.clone(),
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
        });

        let tls_input = tls.map(|t| TlsInput {
            cert_pem: t.cert.to_vec(),
            key_pem: t.key.to_vec(),
        });

        let running = start_http_server_sync(host, validated_port, shared.clone(), tls_input)
            .map_err(Error::from_reason)?;

        let local_addr = running.local_addr;
        self.lifecycle.shared = Some(shared);
        self.lifecycle.running = Some(running);
        self.tsfn = Some(tsfn_for_close);

        Ok(NativeAddressInfo {
            address: local_addr.ip().to_string(),
            port: local_addr.port() as u32,
            family: if local_addr.is_ipv6() {
                "IPv6".to_string()
            } else {
                "IPv4".to_string()
            },
        })
    }

    /// Zero-allocation batch drain directly into a reusable JS Buffer!
    #[napi]
    pub fn drain_batch_into(&self, mut buf: Buffer, max_batch: Option<u32>) -> u32 {
        let Some(shared) = self.lifecycle.shared.as_ref() else {
            return 0;
        };
        let max = max_batch.unwrap_or(256) as usize;
        shared.drain_requests_into(buf.as_mut(), max)
    }

    #[napi]
    pub fn drain_closed_streams(&self) -> Option<Uint32Array> {
        let shared = self.lifecycle.shared.as_ref()?;
        let closed = shared.drain_closed_streams();
        if closed.is_empty() {
            return None;
        }
        Some(Uint32Array::new(closed))
    }

    #[napi]
    pub fn drain_stream_events(&self) -> Option<Uint32Array> {
        let shared = self.lifecycle.shared.as_ref()?;
        let events = shared.drain_stream_events();
        if events.is_empty() {
            return None;
        }
        Some(Uint32Array::new(events))
    }

    /// Streamed request body: `[state, ...chunks]` (state 0 open, 1 ended, 2 aborted), or
    /// `null` when the engine no longer holds a body for `reqId` (ended / abandoned).
    #[napi]
    pub fn take_request_body(&self, req_id: u32) -> Option<Vec<Either<u32, Buffer>>> {
        let shared = self.lifecycle.shared.as_ref()?;
        let (chunks, state) = shared.bodies.take(req_id)?;
        let mut out: Vec<Either<u32, Buffer>> = Vec::with_capacity(chunks.len() + 1);
        out.push(Either::A(state));
        for c in chunks {
            out.push(Either::B(Buffer::from(c.to_vec())));
        }
        Some(out)
    }

    /// Whether `'upgrade'` listeners exist: upgrade requests then leave the engine (see upgrade.rs).
    /// Applies to a started server (JS re-applies it after `start`).
    #[napi]
    pub fn set_upgrade_enabled(&self, enabled: bool) {
        if let Some(shared) = self.lifecycle.shared.as_ref() {
            shared.upgrades.set_enabled(enabled);
        }
    }

    /// Socket of an upgraded request: `[fd, head]`, or null when already taken.
    #[napi]
    pub fn take_upgrade(&self, req_id: u32) -> Option<Vec<Either<i32, Buffer>>> {
        let shared = self.lifecycle.shared.as_ref()?;
        let (fd, head) = shared.upgrades.take(req_id)?;
        #[cfg(unix)]
        {
            use std::os::fd::IntoRawFd;
            Some(vec![
                Either::A(fd.into_raw_fd()),
                Either::B(Buffer::from(head.to_vec())),
            ])
        }
        #[cfg(not(unix))]
        {
            let _ = (fd, head);
            None
        }
    }

    /// JS no longer reads this request's body (response finished, stream destroyed).
    #[napi]
    pub fn release_request_body(&self, req_id: u32) {
        if let Some(shared) = self.lifecycle.shared.as_ref() {
            shared.bodies.remove(req_id);
        }
    }

    #[napi]
    pub fn flush_responses(&self, buf: Buffer, byte_length: u32) {
        let Some(shared) = self.lifecycle.shared.as_ref() else {
            return;
        };
        let slice = buf.as_ref();
        let len = (byte_length as usize).min(slice.len());
        if len == 0 {
            return;
        }
        shared.flush_response_buf(&slice[..len]);
    }

    #[napi]
    pub fn stream_start(
        &self,
        req_id: u32,
        status: u32,
        headers_flat: Vec<String>,
        suppress_x_powered_by: bool,
    ) -> Result<bool> {
        let Some(shared) = self.lifecycle.shared.as_ref() else {
            return Ok(false);
        };
        let valid_status = u16::try_from(status).ok().filter(|&s| is_valid_status(s));
        let valid_pairs = headers_flat.len().is_multiple_of(2);

        if valid_status.is_none() || !valid_pairs {
            shared.slots.complete(
                req_id,
                SlotResponse::RawHttp(build_simple_raw_response(
                    500,
                    shared.config.x_powered_by && !suppress_x_powered_by,
                    false,
                )),
            );
            return Err(Error::from_reason("Invalid stream status or headers"));
        }

        let mut headers = Vec::with_capacity(headers_flat.len() / 2);
        let mut iter = headers_flat.into_iter();
        while let (Some(k), Some(v)) = (iter.next(), iter.next()) {
            if !is_valid_response_header(k.as_bytes(), v.as_bytes()) {
                shared.slots.complete(
                    req_id,
                    SlotResponse::RawHttp(build_simple_raw_response(
                        500,
                        shared.config.x_powered_by && !suppress_x_powered_by,
                        false,
                    )),
                );
                return Err(Error::from_reason("Invalid character in response header"));
            }
            headers.push((k, v));
        }

        Ok(shared.start_stream(
            req_id,
            valid_status.unwrap(),
            headers,
            suppress_x_powered_by,
        ))
    }

    #[napi]
    pub fn stream_write(&self, req_id: u32, chunk: Buffer) -> u8 {
        let Some(shared) = self.lifecycle.shared.as_ref() else {
            return 0;
        };
        shared
            .streams
            .write(req_id, Bytes::copy_from_slice(chunk.as_ref()))
    }

    #[napi]
    pub fn stream_end(&self, req_id: u32, final_chunk: Option<Buffer>) {
        let Some(shared) = self.lifecycle.shared.as_ref() else {
            return;
        };
        let bytes = final_chunk.map(|b| Bytes::copy_from_slice(b.as_ref()));
        shared.streams.end(req_id, bytes);
    }

    /// Abort an in-flight stream: close the connection without the terminating chunk.
    #[napi]
    pub fn stream_abort(&self, req_id: u32) {
        let Some(shared) = self.lifecycle.shared.as_ref() else {
            return;
        };
        shared.streams.abort(req_id);
    }

    #[napi]
    pub fn begin_close(&mut self, timeout_ms: Option<u32>, on_drained: JsFunction) -> Result<()> {
        let tsfn: ThreadsafeFunction<(), ErrorStrategy::Fatal> =
            on_drained.create_threadsafe_function(0, |_ctx| Ok(Vec::<Unknown>::new()))?;

        let Some(ref running) = self.lifecycle.running else {
            let _ = tsfn.call((), ThreadsafeFunctionCallMode::NonBlocking);
            return Ok(());
        };

        running.shared.draining.store(true, Ordering::Release);
        running.shutdown_bus.send_state(1);

        let shared = running.shared.clone();
        let accept_done_rx = running.accept_done_rx.clone();
        let shutdown_bus = running.shutdown_bus.clone();
        let dur = timeout_ms
            .map(|ms| Duration::from_millis(ms as u64))
            .unwrap_or_else(|| shared.config.shutdown_timeout());

        get_io_runtime().spawn(async move {
            drain_server(shared, accept_done_rx, shutdown_bus, dur).await;
            let _ = tsfn.call((), ThreadsafeFunctionCallMode::NonBlocking);
        });

        Ok(())
    }

    #[napi]
    pub fn get_metrics(&self) -> Option<NativeServerMetrics> {
        let shared = self.lifecycle.shared.as_ref()?;
        Some(NativeServerMetrics {
            tls_handshake_errors: shared.metrics.tls_handshake_errors.load(Ordering::Relaxed)
                as u32,
            tls_handshake_timeouts: shared
                .metrics
                .tls_handshake_timeouts
                .load(Ordering::Relaxed) as u32,
            rejected_connections: shared.metrics.rejected_connections.load(Ordering::Relaxed)
                as u32,
            request_timeouts: shared.metrics.request_timeouts.load(Ordering::Relaxed) as u32,
            handler_timeouts: shared.metrics.handler_timeouts.load(Ordering::Relaxed) as u32,
            active_connections: shared.active_connections.load(Ordering::Relaxed) as u32,
        })
    }

    #[napi]
    pub fn close(&mut self) {
        self.lifecycle.close();
        if let Some(tsfn) = self.tsfn.take() {
            let _ = tsfn.abort();
        }
    }

    #[napi]
    pub fn force_close(&mut self) {
        self.lifecycle.close();
    }

    #[napi]
    pub fn refer(&mut self, env: Env) {
        if let Some(ref mut tsfn) = self.tsfn {
            let _ = tsfn.refer(&env);
        }
    }

    #[napi]
    pub fn unref(&mut self, env: Env) {
        if let Some(ref mut tsfn) = self.tsfn {
            let _ = tsfn.unref(&env);
        }
    }
}

fn apply_config(config: &mut EngineConfig, c: NativeServerConfig) {
    if let Some(v) = c.x_powered_by {
        config.x_powered_by = v;
    }
    if let Some(mode) = c.etag_mode {
        config.etag_mode = match mode.as_str() {
            "off" | "false" => EtagMode::Off,
            "strong" => EtagMode::Strong,
            _ => EtagMode::Weak,
        };
    }
    if let Some(v) = c.case_sensitive {
        config.case_sensitive = v;
    }
    if let Some(v) = c.strict_routing {
        config.strict_routing = v;
    }
    if let Some(v) = c.headers_timeout_ms {
        config.set_headers_timeout_ms(v);
    }
    if let Some(v) = c.request_timeout_ms {
        config.set_request_timeout_ms(v);
    }
    if let Some(v) = c.keep_alive_timeout_ms {
        config.set_keep_alive_timeout_ms(v);
    }
    if let Some(v) = c.tls_handshake_timeout_ms {
        config.set_tls_handshake_timeout_ms(v);
    }
    if let Some(v) = c.handler_timeout_ms {
        config.set_handler_timeout_ms(v);
    }
    if let Some(v) = c.io_threads {
        server::set_io_threads(v as usize);
    }
    if let Some(v) = c.write_timeout_ms {
        config.set_write_timeout_ms(v);
    }
    if let Some(v) = c.shutdown_timeout_ms {
        config.set_shutdown_timeout_ms(v);
    }
    if let Some(v) = c.max_connections {
        config.set_max_connections(v);
    }
    if let Some(v) = c.max_headers_count {
        config.set_max_headers_count(v);
    }
    if let Some(v) = c.max_header_size_bytes {
        config.set_max_header_size_bytes(v);
    }
    if let Some(v) = c.default_body_limit_bytes {
        config.set_default_body_limit_bytes(v);
    }
    if let Some(v) = c.stream_queue_capacity {
        config.set_stream_queue_capacity(v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_validation_rejects_gt_65535() {
        assert_eq!(validate_port(0), Ok(0));
        assert_eq!(validate_port(8080), Ok(8080));
        assert_eq!(validate_port(65535), Ok(65535));
        assert!(validate_port(65536).is_err());
        assert!(validate_port(70000).is_err());
    }

    #[test]
    fn partial_native_config_preserves_defaults() {
        let mut cfg = EngineConfig::default();
        apply_config(
            &mut cfg,
            NativeServerConfig {
                x_powered_by: Some(false),
                etag_mode: None,
                case_sensitive: None,
                strict_routing: None,
                headers_timeout_ms: None,
                request_timeout_ms: None,
                keep_alive_timeout_ms: None,
                tls_handshake_timeout_ms: None,
                handler_timeout_ms: None,
                write_timeout_ms: None,
                shutdown_timeout_ms: None,
                max_connections: None,
                max_headers_count: None,
                max_header_size_bytes: None,
                default_body_limit_bytes: None,
                stream_queue_capacity: None,
                io_threads: None,
            },
        );
        assert!(!cfg.x_powered_by);
        assert_eq!(cfg.headers_timeout_ms, 60_000);
        assert_eq!(cfg.max_connections, 10_000);
        assert_eq!(cfg.max_headers_count, 128);
    }

    #[tokio::test]
    async fn native_server_drop_signals_shutdown_and_closes_listener() {
        // Unstarted ServerLifecycle drop must be a safe no-op
        {
            let _unstarted = ServerLifecycle {
                shared: None,
                running: None,
            };
        }

        let cfg = EngineConfig {
            keep_alive_timeout_ms: 60_000,
            ..EngineConfig::default()
        };
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
        let shared = Arc::new(ServerShared {
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
        });

        let running = start_http_server_sync("127.0.0.1".into(), 0, shared.clone(), None).unwrap();
        let addr = running.local_addr;
        let bus = running.shutdown_bus.clone();
        let mut accept_done_rx = running.accept_done_rx.clone();

        let lifecycle = ServerLifecycle {
            shared: Some(shared.clone()),
            running: Some(running),
        };

        let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(shared.active_connections.load(Ordering::Acquire), 1);

        drop(lifecycle);

        assert!(shared.draining.load(Ordering::Acquire));
        assert!(shared.is_closed.load(Ordering::Acquire));
        assert_eq!(bus.state(), 2);

        let accept_closed = tokio::time::timeout(Duration::from_secs(2), async {
            while !*accept_done_rx.borrow() {
                if accept_done_rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
        assert!(
            accept_closed.is_ok(),
            "accept loop did not exit on ServerLifecycle::drop"
        );

        let mut buf = [0u8; 16];
        let client_closed = tokio::time::timeout(
            Duration::from_secs(2),
            tokio::io::AsyncReadExt::read(&mut client, &mut buf),
        )
        .await;
        assert!(
            client_closed.is_ok(),
            "idle client not closed on ServerLifecycle::drop"
        );

        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(shared.active_connections.load(Ordering::Acquire), 0);
        assert!(std::net::TcpListener::bind(addr).is_ok());
    }
}

#[cfg(feature = "fuzzing")]
pub mod fuzz_api {
    pub use crate::http_parse::{read_chunked_body, try_parse_request, ParseOutcome, ParsedMeta};
    pub use crate::protocol::{
        dispatch_response_batch, is_valid_header_name, is_valid_header_value,
    };
    pub use crate::slots::SlotTable;
    pub use crate::static_files::{
        decode_sendfile_payload, etag_matches, if_range_matches, parse_single_range,
        RangeParseResult,
    };
}
