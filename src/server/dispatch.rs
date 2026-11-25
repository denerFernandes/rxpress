//! Parse/dispatch phase of a batch: parse pipelined requests from `read_buf`, answer static
//! files (cache hits coalesced synchronously, misses served async), read or stream request
//! bodies, and queue the rest for JS (or hand an `'upgrade'` off).

#[cfg(test)]
use super::conn::MAX_STATIC_COALESCED;
use super::conn::{
    pump_error_status, Batch, Conn, Flow, InFlightReq, Step, MAX_PIPELINE_BATCH,
    STATIC_COALESCE_FLUSH,
};
use super::etag::{str_at, CondHeaders};
use super::handoff::{hand_off_upgrade, ConnStream};
use super::read_body::BodyPlan;
use crate::date::write_date_header;
use crate::http_parse::{
    try_parse_request, ParseOutcome, ParsedMeta, DEFAULT_MAX_CHUNK_LINE, DEFAULT_MAX_TRAILER_BYTES,
    DEFAULT_MAX_TRAILER_COUNT,
};
use crate::protocol::{push_connection_header, set_http10_keep_alive, PendingRequest};
use crate::reqbody::BodyPump;
use crate::router::MethodCode;
use crate::slots::SlotFuture;
use bytes::Bytes;
use std::ops::ControlFlow::{Break, Continue};
#[cfg(test)]
use std::sync::atomic::Ordering;
use tokio::io::AsyncWriteExt;
use tokio::time::Instant;

impl<S: ConnStream> Conn<'_, '_, S> {
    /// Parse and batch up to MAX_PIPELINE_BATCH complete requests from read_buf.
    pub(super) async fn parse_batch(&mut self, batch: &mut Batch) -> Flow {
        while self.in_flight.len() < MAX_PIPELINE_BATCH
            && !self.read_buf.is_empty()
            && !batch.close_connection
        {
            // Admission control: beyond its first in-flight request a connection may only
            // pipeline while the slot pool keeps a reserve for every other connection.
            if !self.in_flight.is_empty() && !self.shared.slots.can_pipeline(self.slot_reserve) {
                break;
            }
            let cur_req_start = self.req_start;

            let meta = match try_parse_request(
                &self.read_buf,
                self.shared.config.max_headers_count,
                self.shared.config.max_header_size_bytes,
            ) {
                ParseOutcome::Complete(m) => m,
                ParseOutcome::Partial => {
                    batch.need_more_bytes = true;
                    break;
                }
                ParseOutcome::Error(status) => {
                    if self.in_flight.is_empty() && !self.write_buf.is_empty() {
                        let _ = self.stream.write_all(&self.write_buf).await;
                        self.write_buf.clear();
                    }
                    self.reject(batch, status, ()).await?;
                    break;
                }
            };

            set_http10_keep_alive(meta.version == 0 && meta.keep_alive);
            let method = MethodCode::from_bytes(&self.read_buf[meta.method_start..meta.method_end]);
            let has_body_framing = meta.is_chunked || meta.content_length.is_some_and(|cl| cl > 0);

            if !self.in_flight.is_empty() && !self.can_join_batch(&meta, method, has_body_framing) {
                break;
            }

            // Fast synchronous static-file coalescing when no JS requests are pending ahead of it
            if self.in_flight.is_empty()
                && !has_body_framing
                && !meta.expect_100
                && !meta.precondition
                && !self.shared.static_mounts.is_empty()
                && (method == MethodCode::Get || method == MethodCode::Head)
            {
                match self.try_static_cached(batch, &meta, method) {
                    Some(Step::Next) => {
                        if self.write_buf.len() >= STATIC_COALESCE_FLUSH {
                            self.flush_static_coalesced().await?;
                        }
                        continue;
                    }
                    Some(Step::Stop) => break,
                    None => {}
                }
            }

            // Flush any coalesced static responses before switching to async static miss or JS
            self.flush_write_buf().await?;

            // (Not a helper future of its own: this loop runs once per pipelined request.)
            if let Step::Stop = self
                .dispatch(batch, &meta, has_body_framing, cur_req_start)
                .await?
            {
                break;
            }
        }
        Continue(())
    }

    /// A request may follow others in the same batch only if its body is already buffered
    /// and it cannot be a static-file request (those are answered in order by the engine).
    #[inline]
    fn can_join_batch(
        &self,
        meta: &ParsedMeta,
        method: MethodCode,
        has_body_framing: bool,
    ) -> bool {
        let is_body_ready_inline = if meta.is_chunked {
            false
        } else if let Some(cl) = meta.content_length {
            cl == 0 || self.read_buf.len() >= meta.header_len + cl
        } else {
            true
        };
        let static_mounts = &self.shared.static_mounts;
        let maybe_static = !meta.expect_100
            && !static_mounts.is_empty()
            && std::str::from_utf8(&self.read_buf[meta.url_start..meta.url_end])
                .ok()
                .map(|u| {
                    let plen = u.find('?').unwrap_or(u.len());
                    let p = &u[..plen];
                    let is_get_head = method == MethodCode::Get || method == MethodCode::Head;
                    static_mounts.iter().any(|m| {
                        ((!has_body_framing && is_get_head) || !m.fallthrough)
                            && m.matches_prefix(p).is_some()
                    })
                })
                .unwrap_or(false);
        is_body_ready_inline && !maybe_static && !meta.expect_100
    }

    /// Static-cache hit: append the response to `write_buf` (the caller flushes it in bounded
    /// chunks) and consume the request. `None` = not a cache hit.
    #[inline]
    fn try_static_cached(
        &mut self,
        batch: &mut Batch,
        meta: &ParsedMeta,
        method: MethodCode,
    ) -> Option<Step> {
        let shared = self.shared;
        let Ok(url_preview) = std::str::from_utf8(&self.read_buf[meta.url_start..meta.url_end])
        else {
            return None;
        };
        let plen = url_preview.find('?').unwrap_or(url_preview.len());
        let pstr = &url_preview[..plen];
        let (cond, _) = CondHeaders::scan(
            &self.read_buf,
            meta.if_none_match,
            meta.if_modified_since,
            meta.range,
            (meta.headers_start, meta.headers_end),
        );
        let close_conn_static = !meta.keep_alive || self.draining();

        let mut hit_cached = false;
        for mount in &shared.static_mounts {
            if mount.try_append_cached(
                &mut self.write_buf,
                method == MethodCode::Head,
                pstr,
                cond.if_none_match,
                cond.if_modified_since,
                cond.range,
                cond.if_range,
                shared.config.x_powered_by,
                close_conn_static,
            ) {
                hit_cached = true;
                break;
            }
        }
        if !hit_cached {
            return None;
        }

        if self.read_buf.len() == meta.header_len {
            self.read_buf.clear();
        } else {
            let _ = self.read_buf.split_to(meta.header_len);
        }
        self.mark_served();
        if close_conn_static {
            batch.close_connection = true;
            return Some(Step::Stop);
        }
        #[cfg(test)]
        MAX_STATIC_COALESCED.fetch_max(self.write_buf.len(), Ordering::Relaxed);
        Some(Step::Next)
    }

    /// Coalesced static hits reached `STATIC_COALESCE_FLUSH`: write them out (TCP backpressure,
    /// bounded by the write idle timeout) and give back an oversized buffer.
    async fn flush_static_coalesced(&mut self) -> Flow {
        if self.stream.write_all(&self.write_buf).await.is_err() {
            return Break(false);
        }
        self.write_buf.clear();
        if self.write_buf.capacity() > 4 * STATIC_COALESCE_FLUSH {
            self.write_buf.shrink_to(STATIC_COALESCE_FLUSH);
        }
        Continue(())
    }

    /// Consume the request head, then serve it statically, answer it, or queue it for JS.
    async fn dispatch(
        &mut self,
        batch: &mut Batch,
        meta: &ParsedMeta,
        has_body_framing: bool,
        cur_req_start: Option<Instant>,
    ) -> Flow<Step> {
        let shared = self.shared;
        // Split off the header bytes
        let header_block = self.read_buf.split_to(meta.header_len).freeze();
        let method_slice = &header_block[meta.method_start..meta.method_end];
        let method_code = MethodCode::from_bytes(method_slice);
        let is_head = method_code == MethodCode::Head;

        let raw_url = header_block.slice(meta.url_start..meta.url_end);
        let Ok(url_str) = std::str::from_utf8(&raw_url) else {
            return self.reject(batch, 400, Step::Stop).await;
        };
        let path_len = url_str.find('?').unwrap_or(url_str.len());
        let path_str = &url_str[..path_len];
        let query_str = &url_str[path_len..];

        let raw_headers = if meta.headers_start < meta.headers_end {
            header_block.slice(meta.headers_start..meta.headers_end)
        } else {
            Bytes::new()
        };
        let content_type = str_at(&header_block, meta.content_type);
        let (cond, if_range_offsets) = CondHeaders::scan(
            &header_block,
            meta.if_none_match,
            meta.if_modified_since,
            meta.range,
            (meta.headers_start, meta.headers_end),
        );
        let req_close = !meta.keep_alive || self.draining();

        // Async static fallback (cache miss, Range, large file, or directory)
        // (`try_serve` answers `Ok(false)` without I/O when its prefix does not match, so
        // only paths under some mount take this path.)
        if !has_body_framing
            && !meta.expect_100
            && !meta.precondition
            && !shared.static_mounts.is_empty()
            && (method_code == MethodCode::Get || method_code == MethodCode::Head)
            && shared
                .static_mounts
                .iter()
                .any(|m| m.matches_prefix(path_str).is_some())
        {
            // Boxed: the file-serving future is large and this path does file I/O anyway;
            // inline it would bloat every request's dispatch future.
            if let Some(step) =
                Box::pin(self.try_static_async(is_head, path_str, query_str, cond, req_close))
                    .await?
            {
                return Continue(step);
            }
        }

        // No body on the wire (the common GET): no I/O, so no body future on the hot path.
        let (body, plan) = if !has_body_framing {
            (Bytes::new(), self.plan_without_body(path_str, content_type))
        } else {
            // Boxed: keeps the body-reading future out of every request's dispatch future.
            match Box::pin(self.read_body(batch, meta, path_str, content_type, cur_req_start))
                .await?
            {
                Ok(read) => read,
                Err(step) => return Continue(step),
            }
        };

        if self.in_flight.is_empty()
            && !shared.static_mounts.is_empty()
            && method_code != MethodCode::Get
            && method_code != MethodCode::Head
            && shared
                .static_mounts
                .iter()
                .any(|m| !m.fallthrough && m.matches_prefix(path_str).is_some())
        {
            return self.reply_405(req_close).await;
        }

        let mut params = Vec::new();
        let route_id = shared
            .router
            .match_route(method_code, path_str, &mut params);

        let method_str = if method_code == MethodCode::Other {
            Some(String::from_utf8_lossy(method_slice).into_owned())
        } else {
            None
        };

        let pending = PendingRequest {
            req_id: 0,
            route_id,
            method: method_code,
            method_str,
            is_tls: self.is_tls,
            body_mode: plan.mode,
            raw_url,
            path_len: path_len as u32,
            remote_addr: self.peer_ip.clone(),
            params,
            raw_headers,
            body,
            upgrade: false,
            conditional: meta.if_none_match.is_some() || meta.if_modified_since.is_some(),
        };
        let slot_future = match self.admit(batch, meta, pending, plan) {
            Admit::Queued(f) => f,
            Admit::Reject(status) => return self.reject(batch, status, Step::Stop).await,
            Admit::Fail(status) => return self.error_close(status).await,
            Admit::Upgrade(req) => return Break(self.upgrade(req).await),
        };

        let req_close = !meta.keep_alive || plan.too_large || self.draining();
        self.in_flight.push(InFlightReq {
            slot_future,
            method_code,
            is_head,
            http_version: meta.version,
            close_after: req_close,
            header_block,
            if_none_match: meta.if_none_match,
            if_modified_since: meta.if_modified_since,
            range: meta.range,
            if_range: if_range_offsets,
        });

        if batch.batch_start.is_none() {
            batch.batch_start = self.req_start;
        }
        self.mark_served();

        if req_close {
            batch.close_connection = true;
            return Continue(Step::Stop);
        }
        if batch.pump.is_some() {
            return Continue(Step::Stop);
        }
        Continue(Step::Next)
    }

    /// Static mounts that need I/O (cache miss, Range, large file, directory). `None` = no
    /// mount served the request.
    async fn try_static_async(
        &mut self,
        is_head: bool,
        path_str: &str,
        query_str: &str,
        cond: CondHeaders<'_>,
        req_close: bool,
    ) -> Flow<Option<Step>> {
        let shared = self.shared;
        let mut served_static = false;
        for mount in &shared.static_mounts {
            match mount
                .try_serve(
                    &mut *self.stream,
                    &mut self.write_buf,
                    is_head,
                    path_str,
                    query_str,
                    cond.if_none_match,
                    cond.if_modified_since,
                    cond.range,
                    cond.if_range,
                    shared.config.x_powered_by,
                    req_close,
                )
                .await
            {
                Ok(true) => {
                    served_static = true;
                    break;
                }
                Ok(false) => continue,
                Err(_) => return Break(false),
            }
        }
        self.write_buf.clear();
        if !served_static {
            return Continue(None);
        }
        self.mark_served();
        if req_close {
            return Break(true);
        }
        Continue(Some(Step::Next))
    }

    /// Non-GET/HEAD request under a static mount with `fallthrough: false`.
    async fn reply_405(&mut self, req_close: bool) -> Flow<Step> {
        self.write_buf.clear();
        self.write_buf.extend_from_slice(
            b"HTTP/1.1 405 Method Not Allowed\r\nAllow: GET, HEAD\r\nContent-Length: 0\r\n",
        );
        if self.shared.config.x_powered_by {
            self.write_buf
                .extend_from_slice(b"X-Powered-By: Express\r\n");
        }
        push_connection_header(&mut self.write_buf, req_close);
        write_date_header(&mut self.write_buf);
        self.write_buf.extend_from_slice(b"\r\n");
        if self.stream.write_all(&self.write_buf).await.is_err() {
            return Break(false);
        }
        self.write_buf.clear();
        self.mark_served();
        if req_close {
            return Break(true);
        }
        Continue(Step::Next)
    }

    /// Take a slot and queue the request for JS (opening its body stream first). Synchronous:
    /// the rare outcomes that need I/O are returned for `dispatch` to carry out.
    fn admit(
        &mut self,
        batch: &mut Batch,
        meta: &ParsedMeta,
        mut pending: PendingRequest,
        plan: BodyPlan,
    ) -> Admit {
        if !pending.can_encode() {
            let err_status = if pending.raw_url.len() > u16::MAX as usize {
                414
            } else {
                413
            };
            return Admit::Reject(err_status);
        }

        let shared = self.shared;
        let Some(req_id) = shared.slots.acquire() else {
            return Admit::Reject(503);
        };

        let slot_future = shared.slots.wait(req_id);
        pending.req_id = req_id;
        // `'upgrade'`: the connection leaves the engine (Node: the socket is the listener's).
        if meta.upgrade
            && self.in_flight.is_empty()
            && !meta.is_chunked
            && meta.content_length.unwrap_or(0) == 0
            && shared.upgrades.enabled()
        {
            pending.upgrade = true;
            let head = self.read_buf.split().freeze();
            return Admit::Upgrade(Box::new((pending, slot_future, head)));
        }
        if plan.stream_body {
            // Open the body before JS can see the request, then hand over what is buffered.
            let mut p = BodyPump::new(
                req_id,
                if meta.is_chunked {
                    None
                } else {
                    meta.content_length
                },
                if plan.unparsed_unbounded {
                    None
                } else {
                    Some(plan.limit)
                },
                &shared.bodies,
                DEFAULT_MAX_CHUNK_LINE,
                DEFAULT_MAX_TRAILER_BYTES,
                DEFAULT_MAX_TRAILER_COUNT,
            );
            if let Err(e) = p.feed(&mut self.read_buf) {
                // Malformed from the first bytes: answer like the buffered path did,
                // without dispatching (dropping the pump and slot frees both).
                drop(p);
                shared.bodies.remove(req_id);
                drop(slot_future);
                return Admit::Fail(pump_error_status(e));
            }
            batch.pump = Some(p);
        }
        shared.queue.push(pending);
        Admit::Queued(slot_future)
    }

    /// `'upgrade'` hand-off (boxed: the relay future is large and upgrades are rare).
    async fn upgrade(&mut self, req: Box<(PendingRequest, SlotFuture, Bytes)>) -> bool {
        let (pending, slot_future, head) = *req;
        Box::pin(hand_off_upgrade(
            &mut *self.stream,
            self.shared,
            pending,
            slot_future,
            head,
            self.bus,
            self.shard,
            &mut self.sfut,
        ))
        .await
    }
}

/// Outcome of [`Conn::admit`].
enum Admit {
    Queued(SlotFuture),
    /// Refuse (after the responses in flight, if any).
    Reject(u16),
    /// Answer with `Connection: close` right away.
    Fail(u16),
    Upgrade(Box<(PendingRequest, SlotFuture, Bytes)>),
}

#[cfg(test)]
mod tests {
    use super::super::respond_buffered::find_header_end;
    use super::super::test_util::make_test_shared;
    use super::super::{drain_server, start_http_server_sync};
    use super::*;
    use crate::config::EngineConfig;
    use crate::static_files::StaticMount;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn pipelined_static_hits_are_bounded_and_non_reader_is_dropped_by_write_timeout() {
        let dir = std::env::temp_dir().join(format!("rxpress-srv-s3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = vec![b'z'; 60 * 1024];
        std::fs::write(dir.join("big.bin"), &file).unwrap();

        let mut cfg = EngineConfig::default();
        cfg.set_write_timeout_ms(400);
        let mut shared = make_test_shared(cfg);
        Arc::get_mut(&mut shared)
            .unwrap()
            .static_mounts
            .push(StaticMount::new(
                "/s".into(),
                dir.clone(),
                vec!["index.html".into()],
                0,
                false,
                false,
                "ignore".into(),
                true,
                vec![],
                false,
                true,
            ));
        let running = start_http_server_sync("127.0.0.1".into(), 0, shared.clone(), None).unwrap();
        let addr = running.local_addr;

        let sock = tokio::net::TcpSocket::new_v4().unwrap();
        sock.set_recv_buffer_size(4096).unwrap();
        let client = sock.connect(addr).await.unwrap();
        let (mut rd, mut wr) = client.into_split();
        let req: &[u8] = b"GET /s/big.bin HTTP/1.1\r\nHost: a\r\n\r\n";

        // Warm the per-thread cache with one answered request.
        wr.write_all(req).await.unwrap();
        let mut got = Vec::new();
        let mut buf = vec![0u8; 65_536];
        while got.len() < file.len()
            || find_header_end(&got).is_none_or(|h| got.len() < h + file.len())
        {
            let n = rd.read(&mut buf).await.unwrap();
            assert!(n > 0, "closed early");
            got.extend_from_slice(&buf[..n]);
        }
        MAX_STATIC_COALESCED.store(0, Ordering::Relaxed);

        // ~2000 x 60 KiB of cache hits in one burst, and the client never reads them.
        let burst = req.repeat(2000);
        let writer = tokio::spawn(async move {
            let _ = wr.write_all(&burst).await;
            wr
        });
        let t0 = Instant::now();
        while shared.active_connections.load(Ordering::Relaxed) > 0 {
            assert!(
                t0.elapsed() < Duration::from_secs(10),
                "non-reading client never dropped"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let max = MAX_STATIC_COALESCED.load(Ordering::Relaxed);
        assert!(max > 0, "burst was served from the static cache");
        assert!(
            max < STATIC_COALESCE_FLUSH + 2 * file.len(),
            "coalesced {max} bytes before flushing"
        );
        drop(writer.await);
        drop(rd);

        shared.draining.store(true, Ordering::Release);
        running.shutdown_bus.send_state(1);
        drain_server(
            shared,
            running.accept_done_rx,
            running.shutdown_bus,
            Duration::from_secs(1),
        )
        .await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn static_mount_fallthrough_false_non_get_returns_405_with_allow_and_close() {
        let dir = std::env::temp_dir().join(format!("rxpress-srv-405-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), b"hi").unwrap();

        let mut shared = make_test_shared(EngineConfig::default());
        Arc::get_mut(&mut shared)
            .unwrap()
            .static_mounts
            .push(StaticMount::new(
                "/assets".into(),
                dir.clone(),
                vec!["index.html".into()],
                0,
                true,
                true,
                "ignore".into(),
                false,
                vec![],
                false,
                true,
            ));

        let running = start_http_server_sync("127.0.0.1".into(), 0, shared.clone(), None).unwrap();
        let addr = running.local_addr;

        let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
        client
            .write_all(
                b"POST /assets/item HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbody",
            )
            .await
            .unwrap();
        let mut resp = Vec::new();
        client.read_to_end(&mut resp).await.unwrap();
        let s = String::from_utf8(resp).unwrap();
        assert!(
            s.starts_with("HTTP/1.1 405 Method Not Allowed\r\n"),
            "got: {s}"
        );
        assert!(s.contains("Allow: GET, HEAD\r\n"));
        assert!(s.contains("Content-Length: 0\r\n"));
        assert!(s.contains("Connection: close\r\n"));

        shared.draining.store(true, Ordering::Release);
        running.shutdown_bus.send_state(1);
        drain_server(
            shared,
            running.accept_done_rx,
            running.shutdown_bus,
            Duration::from_secs(1),
        )
        .await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
