//! Request bodies: limits, `Expect: 100-continue`, and reading buffered (Content-Length or
//! chunked) bodies, or deciding that the body streams to JS.

use super::conn::{Batch, Conn, Flow, Step, STREAM_BODY_THRESHOLD};
use super::handoff::ConnStream;
use crate::body::{resolve_body_rule, BodyMode};
use crate::http_parse::{
    read_chunked_body, read_exact_body, ChunkedError, ExactBodyError, ParsedMeta,
    DEFAULT_MAX_CHUNK_LINE, DEFAULT_MAX_TRAILER_BYTES, DEFAULT_MAX_TRAILER_COUNT,
};
use bytes::Bytes;
use std::ops::ControlFlow::{Break, Continue};
use std::sync::atomic::Ordering;
use tokio::io::AsyncWriteExt;
use tokio::time::Instant;

/// How the request body was (or will be) received.
#[derive(Clone, Copy)]
pub(super) struct BodyPlan {
    pub(super) mode: BodyMode,
    pub(super) limit: usize,
    pub(super) too_large: bool,
    pub(super) stream_body: bool,
    pub(super) unparsed_unbounded: bool,
}

enum BodyRead {
    Got(Bytes),
    /// Over the limit of a route with a body parser: JS raises Express's 413.
    TooLarge,
    Stop,
}

impl<S: ConnStream> Conn<'_, '_, S> {
    /// `read_body` for a request without body framing (no Transfer-Encoding: chunked and no
    /// or a zero Content-Length): nothing to limit, read, stream or `100-continue`.
    #[inline]
    pub(super) fn plan_without_body(&self, path_str: &str, content_type: Option<&str>) -> BodyPlan {
        let shared = self.shared;
        let (body_mode, body_limit) = resolve_body_rule(
            &shared.body_rules,
            path_str,
            content_type,
            shared.config.default_body_limit_bytes,
        );
        BodyPlan {
            mode: body_mode,
            limit: body_limit,
            too_large: false,
            stream_body: false,
            unparsed_unbounded: body_mode == BodyMode::None
                && !shared.config.explicit_default_body_limit,
        }
    }

    /// Read the request body with strict limits & timeouts, or decide it streams to JS.
    pub(super) async fn read_body(
        &mut self,
        batch: &mut Batch,
        meta: &ParsedMeta,
        path_str: &str,
        content_type: Option<&str>,
        cur_req_start: Option<Instant>,
    ) -> Flow<Result<(Bytes, BodyPlan), Step>> {
        let shared = self.shared;
        let (body_mode, body_limit) = resolve_body_rule(
            &shared.body_rules,
            path_str,
            content_type,
            shared.config.default_body_limit_bytes,
        );

        // A body over the limit of a route that has a body parser goes to JS as
        // `BodyMode::TooLarge` (body unread, connection closed afterwards) so the parser
        // raises Express's 413 `entity.too.large` through the app's error middleware.
        // Without a parser the engine answers 413 itself (DoS guard).
        let mut too_large = false;
        // Bodies no rxpress parser claims are streamed to JS rather than buffered, without a
        // size cap (Node/Express parity) unless the app set `defaultBodyLimitBytes`.
        let unparsed_unbounded =
            body_mode == BodyMode::None && !shared.config.explicit_default_body_limit;
        // Enforce Content-Length limit BEFORE Expect: 100-continue or allocating/reading body!
        if let Some(cl) = meta.content_length {
            if cl > body_limit && body_mode != BodyMode::None {
                too_large = true;
            } else if cl > body_limit && !unparsed_unbounded {
                return self.reject(batch, 413, Err(Step::Stop)).await;
            }
        }

        if !too_large
            && meta.expect_100
            && meta.version == 1
            && (meta.is_chunked
                || meta
                    .content_length
                    .is_some_and(|cl| cl > 0 && self.read_buf.len() < cl))
            && (self
                .stream
                .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
                .await
                .is_err()
                || self.stream.flush().await.is_err())
        {
            return Break(false);
        }

        let body_deadline = self
            .r_dur
            .map(|d| cur_req_start.unwrap_or_else(Instant::now) + d);

        // Only the first request of a batch can stream (later ones arrive fully buffered).
        let stream_body = !too_large
            && body_mode == BodyMode::None
            && self.in_flight.is_empty()
            && (meta.is_chunked
                || meta
                    .content_length
                    .is_some_and(|cl| cl > STREAM_BODY_THRESHOLD || cl > body_limit));

        let read = if too_large || stream_body {
            BodyRead::Got(Bytes::new())
        } else if meta.is_chunked {
            self.read_chunked(batch, body_mode, body_limit, body_deadline)
                .await?
        } else if let Some(cl) = meta.content_length {
            if cl == 0 {
                BodyRead::Got(Bytes::new())
            } else {
                self.read_exact(batch, cl, body_deadline).await?
            }
        } else {
            BodyRead::Got(Bytes::new())
        };
        let body = match read {
            BodyRead::Got(b) => b,
            BodyRead::TooLarge => {
                too_large = true;
                Bytes::new()
            }
            BodyRead::Stop => return Continue(Err(Step::Stop)),
        };

        let mode = if too_large {
            BodyMode::TooLarge
        } else if stream_body {
            BodyMode::Streamed
        } else {
            body_mode
        };
        let plan = BodyPlan {
            mode,
            limit: body_limit,
            too_large,
            stream_body,
            unparsed_unbounded,
        };
        Continue(Ok((body, plan)))
    }

    async fn read_chunked(
        &mut self,
        batch: &mut Batch,
        body_mode: BodyMode,
        body_limit: usize,
        body_deadline: Option<Instant>,
    ) -> Flow<BodyRead> {
        match read_chunked_body(
            &mut *self.stream,
            &mut self.read_buf,
            body_limit,
            DEFAULT_MAX_CHUNK_LINE,
            DEFAULT_MAX_TRAILER_BYTES,
            DEFAULT_MAX_TRAILER_COUNT,
            body_deadline,
            &mut self.req_sleep,
            &mut self.req_armed_until,
            self.bus.state_atomic(),
            self.shard,
            &mut self.sfut,
        )
        .await
        {
            Ok(b) => Continue(BodyRead::Got(b)),
            Err(ChunkedError::TooLarge) if body_mode != BodyMode::None => {
                Continue(BodyRead::TooLarge)
            }
            Err(err) => {
                let status = match err {
                    ChunkedError::TooLarge => 413,
                    ChunkedError::HeaderTooLarge => 431,
                    ChunkedError::BadRequest => 400,
                    ChunkedError::Timeout => {
                        self.shared
                            .metrics
                            .request_timeouts
                            .fetch_add(1, Ordering::Relaxed);
                        408
                    }
                    ChunkedError::Eof | ChunkedError::Io | ChunkedError::Shutdown => {
                        return Break(false)
                    }
                };
                self.reject(batch, status, BodyRead::Stop).await
            }
        }
    }

    async fn read_exact(
        &mut self,
        batch: &mut Batch,
        cl: usize,
        body_deadline: Option<Instant>,
    ) -> Flow<BodyRead> {
        match read_exact_body(
            &mut *self.stream,
            &mut self.read_buf,
            cl,
            body_deadline,
            &mut self.req_sleep,
            &mut self.req_armed_until,
            self.bus.state_atomic(),
            self.shard,
            &mut self.sfut,
        )
        .await
        {
            Ok(b) => Continue(BodyRead::Got(b)),
            Err(ExactBodyError::Timeout) => {
                self.shared
                    .metrics
                    .request_timeouts
                    .fetch_add(1, Ordering::Relaxed);
                self.reject(batch, 408, BodyRead::Stop).await
            }
            Err(ExactBodyError::Eof | ExactBodyError::Io | ExactBodyError::Shutdown) => {
                Break(false)
            }
        }
    }
}
