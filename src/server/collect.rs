//! Collect phase of a batch: wake JS once, await each in-flight response in pipeline order
//! (watching the socket, the streamed request body and the deadlines meanwhile) and write the
//! responses, coalesced into as few writes as possible.

use super::conn::{
    earliest_deadline, pump_error_status, Batch, Conn, Flow, InFlightReq, MAX_PIPELINE_BATCH,
    PEER_EOF_GRACE,
};
use super::etag::{header_block_has_no_cache, str_at, CondHeaders};
use super::handoff::ConnStream;
use super::respond_buffered::{find_header_end, write_buffered_response};
use super::respond_stream::{handle_stream_response, StreamOutcome};
use super::ServerShared;
use crate::http_parse::arm_deadline;
use crate::protocol::{
    append_raw_http_with_close, append_raw_http_with_connection, set_http10_keep_alive,
};
use crate::slots::SlotResponse;
use bytes::Bytes;
use futures_util::FutureExt;
use std::ops::ControlFlow::{Break, Continue};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::Instant;

/// Per-batch context while collecting.
struct Collect {
    batch_len: usize,
    should_close: bool,
    handler_dl: Option<Instant>,
    /// requestTimeout also bounds receiving a streamed body (Node's semantics).
    body_dl: Option<Instant>,
    pending_ids: [u32; MAX_PIPELINE_BATCH],
}

impl Collect {
    /// Client gone while handlers are pending: tell JS (req 'aborted'/'close') for every
    /// request of this batch that has not been answered yet.
    #[inline]
    fn notify_aborted(&self, shared: &ServerShared, from: usize) {
        for &id in &self.pending_ids[from..self.batch_len] {
            shared.close_notifier.notify_closed(id);
        }
    }
}

impl<S: ConnStream> Conn<'_, '_, S> {
    /// Wake Node.js ONCE for all pipelined JS requests and coalesce all responses into ONE write!
    pub(super) async fn collect(&mut self, batch: &mut Batch) -> Flow {
        self.shared.wake_js();

        let batch_len = self.in_flight.len();
        let mut ctx = Collect {
            batch_len,
            should_close: batch.close_connection || self.draining(),
            handler_dl: self
                .handler_dur
                .map(|d| batch.batch_start.unwrap_or_else(Instant::now) + d),
            body_dl: None,
            pending_ids: [0u32; MAX_PIPELINE_BATCH],
        };
        for (slot, it) in ctx.pending_ids.iter_mut().zip(self.in_flight.iter()) {
            *slot = it.slot_future.req_id();
        }
        if batch.pump.is_some() {
            ctx.body_dl = self
                .r_dur
                .map(|d| batch.batch_start.unwrap_or_else(Instant::now) + d);
        }

        // Taken for the loop (the vector, and its capacity, is put back afterwards).
        let mut in_flight = std::mem::take(&mut self.in_flight);
        let mut idx = 0usize;
        for mut item in in_flight.drain(..) {
            idx += 1;
            let is_last = idx == batch_len;

            let resp = self.await_response(batch, &ctx, &mut item, idx).await?;

            if item.close_after {
                ctx.should_close = true;
            }
            let draining_last = is_last && batch.pending_error_status.is_none() && self.draining();
            let item_close = item.close_after || draining_last;

            match resp {
                // Coalesced pre-formatted response (the pipelined hot path): no helper future.
                SlotResponse::RawHttp(raw_bytes)
                    if !self.raw_goes_direct(&ctx, &item, item_close) =>
                {
                    let ka10 = item.http_version == 0 && !item_close;
                    set_http10_keep_alive(ka10);
                    self.append_raw(&item, &raw_bytes, item_close, ka10);
                }
                resp => {
                    self.write_response(batch, &ctx, &item, resp, idx, item_close)
                        .await?
                }
            }

            // Answered before its streamed body ended: the rest of the body is still on the
            // wire, so this connection cannot carry another request (lingering close drains).
            if let Some(p) = batch.pump.take() {
                if !p.done {
                    ctx.should_close = true;
                }
            }
        }
        self.in_flight = in_flight;

        self.flush_write_buf().await?;

        if let Some(err_status) = batch.pending_error_status {
            return self.error_close(err_status).await;
        }
        if ctx.should_close {
            return Break(true);
        }
        Continue(())
    }

    /// Wait for the JS response of `item` (`idx` is 1-based) while pumping a streamed request
    /// body, watching the socket for EOF/RST and enforcing the handler/body deadlines.
    async fn await_response(
        &mut self,
        batch: &mut Batch,
        ctx: &Collect,
        item: &mut InFlightReq,
        idx: usize,
    ) -> Flow<SlotResponse> {
        loop {
            if self.bus.state() >= 2 {
                return Break(false);
            }
            if let Some(e) = batch.pump_err.take() {
                if let Some(p) = batch.pump.as_mut() {
                    p.abort();
                }
                ctx.notify_aborted(self.shared, idx - 1);
                return self.error_close(pump_error_status(e)).await;
            }
            // Already answered (typical for every pipelined request after the first): take it
            // without setting up the select (whose biased first branch it would be).
            if let Some(r) = (&mut item.slot_future).now_or_never() {
                return Continue(r);
            }
            let pump_open = batch.pump.as_ref().is_some_and(|p| !p.done);
            let pump_blocked = pump_open && batch.pump.as_ref().is_some_and(|p| p.blocked);
            let space = if pump_blocked {
                batch.pump.as_ref().map(|p| p.space.clone())
            } else {
                None
            };
            let wait_dl =
                earliest_deadline(ctx.handler_dl, if pump_open { ctx.body_dl } else { None });
            if let Some(dl) = wait_dl {
                // Slack scales with the phase whose deadline is the nearest one.
                let phase = if pump_open && ctx.body_dl == Some(dl) {
                    self.r_dur
                } else {
                    self.handler_dur.or(self.r_dur)
                };
                arm_deadline(
                    &mut self.req_sleep,
                    &mut self.req_armed_until,
                    Some(dl),
                    phase.unwrap_or(Duration::from_secs(1)),
                );
            }
            let peer_eof_deadline = self.peer_eof_deadline;
            let max_wait_read_buf = self.max_wait_read_buf;
            let stream = &mut *self.stream;
            let read_buf = &mut self.read_buf;
            let probe = &mut self.wait_eof_probe;
            tokio::select! {
                biased;
                r = &mut item.slot_future => return Continue(r),
                // Streamed body: JS took queued chunks, keep pumping.
                _ = async {
                    match &space {
                        Some(n) => n.notified().await,
                        None => std::future::pending::<()>().await,
                    }
                }, if space.is_some() => {
                    if let Some(p) = batch.pump.as_mut() {
                        if let Err(e) = p.feed(read_buf) {
                            batch.pump_err = Some(e);
                        }
                    }
                }
                // Watch the socket while JS works: a client that disconnects must free
                // its slots now, not after the handler (or handlerTimeoutMs) finishes.
                read_res = async {
                    if read_buf.len() < max_wait_read_buf {
                        if read_buf.capacity() - read_buf.len() < 1024 {
                            read_buf.reserve(4096);
                        }
                        stream.read_buf(read_buf).await
                    } else {
                        // Buffer full of pipelined bytes: only peek-wait for EOF/RST.
                        stream.read(&mut probe[..]).await.inspect(|&n| {
                            if n > 0 {
                                read_buf.extend_from_slice(&probe[..n]);
                            }
                        })
                    }
                }, if peer_eof_deadline.is_none() && !pump_blocked => {
                    self.on_wait_read(batch, ctx, idx, pump_open, read_res)?;
                }
                _ = async {
                    match peer_eof_deadline {
                        Some(dl) => tokio::time::sleep_until(dl).await,
                        None => std::future::pending::<()>().await,
                    }
                }, if peer_eof_deadline.is_some() => {
                    ctx.notify_aborted(self.shared, idx - 1);
                    return Break(false);
                }
                _ = self.req_sleep.as_mut(), if wait_dl.is_some() => {
                    self.req_armed_until = None;
                    self.on_wait_deadline(batch, ctx, idx, pump_open).await?;
                }
                _ = self.sfut.as_mut() => {
                    self.sfut.set(self.shard.notified());
                    let _ = self.sfut.as_mut().enable();
                    if self.bus.state() >= 2 {
                        return Break(false);
                    }
                }
            }
        }
    }

    /// Socket activity while a handler runs.
    fn on_wait_read(
        &mut self,
        batch: &mut Batch,
        ctx: &Collect,
        idx: usize,
        pump_open: bool,
        read_res: std::io::Result<usize>,
    ) -> Flow {
        match read_res {
            // RST / socket error: the client is gone, free the slots now.
            Err(_) => {
                if let Some(p) = batch.pump.as_mut() {
                    p.abort();
                }
                ctx.notify_aborted(self.shared, idx - 1);
                Break(false)
            }
            // EOF in the middle of a streamed body: the upload was cut short.
            Ok(0) if pump_open => {
                if let Some(p) = batch.pump.as_mut() {
                    p.abort();
                }
                ctx.notify_aborted(self.shared, idx - 1);
                Break(false)
            }
            // FIN: like Node's default (httpAllowHalfOpen=false) the request is
            // aborted, but give fast handlers a short grace to answer first.
            Ok(0) => {
                self.peer_eof_deadline = Some(Instant::now() + PEER_EOF_GRACE);
                Continue(())
            }
            Ok(_) => {
                if pump_open {
                    if let Some(p) = batch.pump.as_mut() {
                        if let Err(e) = p.feed(&mut self.read_buf) {
                            batch.pump_err = Some(e);
                        }
                    }
                }
                Continue(())
            }
        }
    }

    /// The handler/body timer fired: answer 408 (streamed body too slow) or 504 (handler).
    async fn on_wait_deadline(
        &mut self,
        batch: &mut Batch,
        ctx: &Collect,
        idx: usize,
        pump_open: bool,
    ) -> Flow {
        if pump_open && ctx.body_dl.is_some_and(|dl| Instant::now() >= dl) {
            self.shared
                .metrics
                .request_timeouts
                .fetch_add(1, Ordering::Relaxed);
            if let Some(p) = batch.pump.as_mut() {
                p.abort();
            }
            ctx.notify_aborted(self.shared, idx - 1);
            return self.error_close(408).await;
        }
        if let Some(dl) = ctx.handler_dl {
            if Instant::now() >= dl {
                self.shared
                    .metrics
                    .handler_timeouts
                    .fetch_add(1, Ordering::Relaxed);
                if !self.write_buf.is_empty() {
                    let _ = self.stream.write_all(&self.write_buf).await;
                    self.write_buf.clear();
                }
                return self.error_close(504).await;
            }
        }
        Continue(())
    }

    /// Write (or coalesce) the response of `item`.
    async fn write_response(
        &mut self,
        batch: &mut Batch,
        ctx: &Collect,
        item: &InFlightReq,
        resp: SlotResponse,
        idx: usize,
        item_close: bool,
    ) -> Flow {
        let ka10 = item.http_version == 0 && !item_close;
        set_http10_keep_alive(ka10);

        match resp {
            SlotResponse::RawHttp(raw_bytes) => {
                if self.raw_goes_direct(ctx, item, item_close) {
                    self.write_raw_direct(ctx, item, &raw_bytes, idx).await
                } else {
                    self.append_raw(item, &raw_bytes, item_close, ka10);
                    Continue(())
                }
            }
            SlotResponse::Buffered {
                status,
                content_type_code,
                flags,
                headers,
                body,
            } => {
                self.flush_before(ctx, idx).await?;
                let hb = &item.header_block;
                let cond = CondHeaders {
                    if_none_match: str_at(hb, item.if_none_match),
                    if_modified_since: str_at(hb, item.if_modified_since),
                    range: str_at(hb, item.range),
                    if_range: str_at(hb, item.if_range),
                };
                let no_cache = item.if_none_match.is_some() && header_block_has_no_cache(hb);

                if write_buffered_response(
                    &mut *self.stream,
                    &mut self.write_buf,
                    status,
                    content_type_code,
                    flags,
                    &headers,
                    &body,
                    item.method_code,
                    &self.shared.config,
                    cond,
                    no_cache,
                    item_close,
                )
                .await
                .is_err()
                {
                    ctx.notify_aborted(self.shared, idx);
                    return Break(false);
                }
                self.write_buf.clear();
                Continue(())
            }
            SlotResponse::Stream {
                status,
                headers,
                suppress_x_powered_by,
                handle,
            } => {
                self.flush_before(ctx, idx).await?;
                let max_read_buf = self.shared.config.max_header_size_bytes.max(65_536);
                // Boxed: large future, kept out of the per-request collect path.
                let outcome = Box::pin(handle_stream_response(
                    &mut *self.stream,
                    &mut self.read_buf,
                    batch.pump.as_mut(),
                    ctx.body_dl,
                    max_read_buf,
                    &mut self.write_buf,
                    status,
                    &headers,
                    suppress_x_powered_by,
                    self.shared.config.x_powered_by,
                    item.is_head,
                    item.http_version,
                    handle,
                    item_close,
                    self.bus.state_atomic(),
                    self.shard,
                    &mut self.sfut,
                ))
                .await;
                self.write_buf.clear();
                match outcome {
                    StreamOutcome::Continue => Continue(()),
                    StreamOutcome::CloseClean => {
                        ctx.notify_aborted(self.shared, idx);
                        Break(true)
                    }
                    StreamOutcome::Abort => {
                        ctx.notify_aborted(self.shared, idx);
                        Break(false)
                    }
                }
            }
        }
    }

    /// A pre-formatted response is written directly (not coalesced) when it is the only one
    /// of its batch, keeps the connection open and needs no HTTP/1.0 keep-alive header.
    #[inline]
    fn raw_goes_direct(&self, ctx: &Collect, item: &InFlightReq, item_close: bool) -> bool {
        let ka10 = item.http_version == 0 && !item_close;
        !ka10 && ctx.batch_len == 1 && self.write_buf.is_empty() && !item_close
    }

    /// Zero-copy direct write for a single non-pipelined pre-formatted response.
    #[inline]
    async fn write_raw_direct(
        &mut self,
        ctx: &Collect,
        item: &InFlightReq,
        raw_bytes: &Bytes,
        idx: usize,
    ) -> Flow {
        let ok = if item.is_head {
            let hdr_end = find_header_end(raw_bytes).unwrap_or(raw_bytes.len());
            self.stream.write_all(&raw_bytes[..hdr_end]).await.is_ok()
        } else {
            self.stream.write_all(raw_bytes).await.is_ok()
        };
        if !ok {
            ctx.notify_aborted(self.shared, idx);
            return Break(false);
        }
        Continue(())
    }

    /// Coalesce a pre-formatted response from JS into `write_buf`.
    #[inline]
    fn append_raw(&mut self, item: &InFlightReq, raw_bytes: &Bytes, item_close: bool, ka10: bool) {
        if ka10 {
            append_raw_http_with_connection(
                raw_bytes,
                &mut self.write_buf,
                item.is_head,
                b"Connection: keep-alive\r\n",
            );
        } else if item_close {
            append_raw_http_with_close(raw_bytes, &mut self.write_buf, item.is_head);
        } else if item.is_head {
            let hdr_end = find_header_end(raw_bytes).unwrap_or(raw_bytes.len());
            self.write_buf.extend_from_slice(&raw_bytes[..hdr_end]);
        } else {
            self.write_buf.extend_from_slice(raw_bytes);
        }
    }

    /// Flush coalesced responses before one that writes on its own.
    #[inline]
    async fn flush_before(&mut self, ctx: &Collect, idx: usize) -> Flow {
        if !self.write_buf.is_empty() {
            if self.stream.write_all(&self.write_buf).await.is_err() {
                ctx.notify_aborted(self.shared, idx);
                return Break(false);
            }
            self.write_buf.clear();
        }
        Continue(())
    }
}
