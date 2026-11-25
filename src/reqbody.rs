//! Streaming request bodies (Rust -> JS).
//!
//! Bodies no rxpress body parser claims are not buffered: the request is dispatched to JS right
//! after its head, and a [`BodyPump`] running inside the connection task moves body bytes from the
//! socket into a per-request queue in [`RequestBodies`]. JS pulls queued chunks with
//! `takeRequestBody(reqId)`. The queue is bounded: while it is full the pump stops reading the
//! socket, so a paused `req` stream applies TCP backpressure to the client, exactly like Node.

use crate::http_parse::{find_crlf_bounded, parse_chunk_size_line};
use crate::protocol::{is_valid_header_name, is_valid_header_value};
use bytes::{Bytes, BytesMut};
use crossbeam_queue::SegQueue;
use parking_lot::Mutex;
use rustc_hash::FxHashMap;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

/// Bytes queued per request before the pump stops reading the socket.
pub const BODY_QUEUE_CAP: usize = 256 * 1024;
/// Largest single chunk handed to JS.
const MAX_PIECE: usize = 64 * 1024;
/// Pieces smaller than this are copied into an open tail buffer instead of being queued on
/// their own: a body sent as 1-byte chunks must not become one queue entry (and one JS
/// `Buffer`) per byte.
const COALESCE_BELOW: usize = 4 * 1024;
/// Capacity of the tail buffer small pieces are gathered into.
const TAIL_CAP: usize = 16 * 1024;
/// Bookkeeping charged against [`BODY_QUEUE_CAP`] per queued entry, so the cap bounds memory
/// (entries + JS objects), not just payload bytes.
const ENTRY_OVERHEAD: usize = 64;

struct Entry {
    queue: VecDeque<Bytes>,
    /// Small pieces not yet handed out; always logically after `queue`.
    tail: BytesMut,
    /// Payload plus [`ENTRY_OVERHEAD`] per queued entry.
    bytes: usize,
    ended: bool,
    aborted: bool,
    space: Arc<Notify>,
}

/// State reported to JS with each take.
pub const TAKE_OPEN: u32 = 0;
pub const TAKE_ENDED: u32 = 1;
pub const TAKE_ABORTED: u32 = 2;

pub struct RequestBodies {
    map: Mutex<FxHashMap<u32, Entry>>,
    ready: SegQueue<u32>,
    wakeup: Arc<dyn Fn() + Send + Sync>,
    scheduled: Arc<AtomicBool>,
}

impl RequestBodies {
    pub fn new(wakeup: Arc<dyn Fn() + Send + Sync>, scheduled: Arc<AtomicBool>) -> Self {
        Self {
            map: Mutex::new(FxHashMap::default()),
            ready: SegQueue::new(),
            wakeup,
            scheduled,
        }
    }

    #[inline]
    fn signal(&self, req_id: u32) {
        self.ready.push(req_id);
        if !self.scheduled.swap(true, Ordering::SeqCst) {
            (self.wakeup)();
        }
    }

    pub fn has_ready(&self) -> bool {
        !self.ready.is_empty()
    }

    pub fn drain_ready(&self, out: &mut Vec<u32>) {
        while let Some(id) = self.ready.pop() {
            out.push(id);
        }
    }

    /// Start a body for `req_id` (replacing any stale entry of a recycled slot).
    pub fn open(&self, req_id: u32) -> Arc<Notify> {
        let space = Arc::new(Notify::new());
        self.map.lock().insert(
            req_id,
            Entry {
                queue: VecDeque::new(),
                tail: BytesMut::new(),
                bytes: 0,
                ended: false,
                aborted: false,
                space: space.clone(),
            },
        );
        space
    }

    /// Queue a chunk. Returns whether there is still room for more (false also when gone).
    pub fn push(&self, req_id: u32, data: Bytes) -> bool {
        let (was_empty, room) = {
            let mut map = self.map.lock();
            let Some(e) = map.get_mut(&req_id) else {
                return false;
            };
            let was_empty = e.queue.is_empty() && e.tail.is_empty();
            if data.len() < COALESCE_BELOW {
                if e.tail.len() + data.len() > TAIL_CAP {
                    let full = e.tail.split().freeze();
                    e.queue.push_back(full);
                }
                if e.tail.is_empty() {
                    if e.tail.capacity() < TAIL_CAP {
                        e.tail.reserve(TAIL_CAP);
                    }
                    // A new entry (the tail) starts: charge its overhead once.
                    e.bytes += ENTRY_OVERHEAD;
                }
                e.tail.extend_from_slice(&data);
                e.bytes += data.len();
            } else {
                if !e.tail.is_empty() {
                    let t = e.tail.split().freeze();
                    e.queue.push_back(t);
                }
                e.bytes += data.len() + ENTRY_OVERHEAD;
                e.queue.push_back(data);
            }
            (was_empty, e.bytes < BODY_QUEUE_CAP)
        };
        if was_empty {
            self.signal(req_id);
        }
        room
    }

    pub fn has_space(&self, req_id: u32) -> bool {
        self.map
            .lock()
            .get(&req_id)
            .is_some_and(|e| e.bytes < BODY_QUEUE_CAP)
    }

    /// The body is complete (`aborted = false`) or the client went away mid-body.
    pub fn finish(&self, req_id: u32, aborted: bool) {
        {
            let mut map = self.map.lock();
            let Some(e) = map.get_mut(&req_id) else {
                return;
            };
            if e.ended || e.aborted {
                return;
            }
            if aborted {
                e.aborted = true;
            } else {
                e.ended = true;
            }
        }
        self.signal(req_id);
    }

    /// Forget the body (response done). A later take from JS sees it as ended.
    pub fn remove(&self, req_id: u32) {
        self.map.lock().remove(&req_id);
    }

    /// Hand every queued chunk to JS. `None` when there is no body entry (ended/abandoned).
    pub fn take(&self, req_id: u32) -> Option<(Vec<Bytes>, u32)> {
        let mut map = self.map.lock();
        let e = map.get_mut(&req_id)?;
        let mut chunks: Vec<Bytes> = Vec::with_capacity(e.queue.len() + 1);
        chunks.extend(e.queue.drain(..));
        if !e.tail.is_empty() {
            chunks.push(e.tail.split().freeze());
        }
        let freed = e.bytes > 0;
        e.bytes = 0;
        let state = if e.aborted {
            TAKE_ABORTED
        } else if e.ended {
            TAKE_ENDED
        } else {
            TAKE_OPEN
        };
        let space = e.space.clone();
        if state != TAKE_OPEN {
            map.remove(&req_id);
        }
        drop(map);
        if freed {
            space.notify_one();
        }
        Some((chunks, state))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChunkState {
    Size,
    Data(usize),
    DataCrlf,
    Trailer,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PumpError {
    /// Malformed framing (400).
    Bad,
    /// Over the configured body limit (413).
    TooLarge,
    /// Trailer section too large (431).
    TrailerTooLarge,
}

enum Framing {
    Length(u64),
    Chunked {
        state: ChunkState,
        trailer_bytes: usize,
        trailer_count: usize,
    },
}

/// Moves one request's body from the connection's read buffer into [`RequestBodies`].
pub struct BodyPump {
    pub req_id: u32,
    framing: Framing,
    /// Body fully received (and reported to JS).
    pub done: bool,
    /// Queue full: wait for `space` before reading the socket again.
    pub blocked: bool,
    pub space: Arc<Notify>,
    limit: Option<usize>,
    received: usize,
    max_chunk_line: usize,
    max_trailer_bytes: usize,
    max_trailer_count: usize,
    bodies: Arc<RequestBodies>,
}

/// The pump lives until the response is done; then any unread body is forgotten (JS sees it as
/// ended), like Node dumping an unconsumed request body.
/// The connection is done with this body. An unfinished body becomes aborted; the entry (and
/// any bytes JS has not taken yet) stays until JS takes its final state or releases it, so a
/// complete body is never cut short by the connection closing first.
impl Drop for BodyPump {
    fn drop(&mut self) {
        self.abort();
    }
}

impl BodyPump {
    pub fn new(
        req_id: u32,
        content_length: Option<usize>,
        limit: Option<usize>,
        bodies: &Arc<RequestBodies>,
        max_chunk_line: usize,
        max_trailer_bytes: usize,
        max_trailer_count: usize,
    ) -> Self {
        let space = bodies.open(req_id);
        let framing = match content_length {
            Some(cl) => Framing::Length(cl as u64),
            None => Framing::Chunked {
                state: ChunkState::Size,
                trailer_bytes: 0,
                trailer_count: 0,
            },
        };
        Self {
            req_id,
            framing,
            done: false,
            blocked: false,
            space,
            limit,
            received: 0,
            max_chunk_line,
            max_trailer_bytes,
            max_trailer_count,
            bodies: bodies.clone(),
        }
    }

    fn deliver(&mut self, piece: Bytes) -> Result<(), PumpError> {
        let bodies = &*self.bodies;
        self.received = self.received.saturating_add(piece.len());
        if self.limit.is_some_and(|l| self.received > l) {
            return Err(PumpError::TooLarge);
        }
        if !bodies.push(self.req_id, piece) {
            self.blocked = true;
        }
        Ok(())
    }

    fn complete(&mut self) {
        self.done = true;
        self.bodies.finish(self.req_id, false);
    }

    /// The client went away (or sent garbage) before the body ended.
    pub fn abort(&mut self) {
        if !self.done {
            self.done = true;
            self.bodies.finish(self.req_id, true);
        }
    }

    /// Consume as much body as `read_buf` holds and the queue accepts.
    pub fn feed(&mut self, read_buf: &mut BytesMut) -> Result<(), PumpError> {
        if self.done {
            return Ok(());
        }
        if self.blocked {
            if !self.bodies.has_space(self.req_id) {
                return Ok(());
            }
            self.blocked = false;
        }
        loop {
            if self.done || self.blocked {
                return Ok(());
            }
            match &mut self.framing {
                Framing::Length(remaining) => {
                    if *remaining == 0 {
                        self.complete();
                        return Ok(());
                    }
                    if read_buf.is_empty() {
                        return Ok(());
                    }
                    let n = (*remaining)
                        .min(read_buf.len() as u64)
                        .min(MAX_PIECE as u64) as usize;
                    *remaining -= n as u64;
                    let last = *remaining == 0;
                    let piece = read_buf.split_to(n).freeze();
                    self.deliver(piece)?;
                    if last {
                        // Complete even when the queue just filled up: no more bytes to wait for.
                        self.complete();
                        return Ok(());
                    }
                }
                Framing::Chunked {
                    state,
                    trailer_bytes,
                    trailer_count,
                } => match *state {
                    ChunkState::Size => {
                        let line_end = match find_crlf_bounded(read_buf, self.max_chunk_line) {
                            Ok(Some(p)) => p,
                            Ok(None) => return Ok(()),
                            Err(()) => return Err(PumpError::Bad),
                        };
                        let line = read_buf.split_to(line_end + 2);
                        // Sizes past i64::MAX are framing errors, not bodies (8 EiB).
                        let Some(size) = parse_chunk_size_line(&line[..line_end])
                            .filter(|&n| n <= i64::MAX as usize)
                        else {
                            return Err(PumpError::Bad);
                        };
                        *state = if size == 0 {
                            ChunkState::Trailer
                        } else {
                            ChunkState::Data(size)
                        };
                    }
                    ChunkState::Data(rem) => {
                        if read_buf.is_empty() {
                            return Ok(());
                        }
                        let n = rem.min(read_buf.len()).min(MAX_PIECE);
                        *state = if n == rem {
                            ChunkState::DataCrlf
                        } else {
                            ChunkState::Data(rem - n)
                        };
                        let piece = read_buf.split_to(n).freeze();
                        self.deliver(piece)?;
                    }
                    ChunkState::DataCrlf => {
                        if read_buf.len() < 2 {
                            return Ok(());
                        }
                        if &read_buf[..2] != b"\r\n" {
                            return Err(PumpError::Bad);
                        }
                        let _ = read_buf.split_to(2);
                        *state = ChunkState::Size;
                    }
                    ChunkState::Trailer => {
                        let budget = self.max_trailer_bytes.saturating_sub(*trailer_bytes);
                        let t_end = match find_crlf_bounded(read_buf, budget) {
                            Ok(Some(p)) => p,
                            Ok(None) => {
                                if read_buf.len() > budget + 1 {
                                    return Err(PumpError::TrailerTooLarge);
                                }
                                return Ok(());
                            }
                            Err(()) => {
                                if read_buf.len() > budget {
                                    return Err(PumpError::TrailerTooLarge);
                                }
                                return Err(PumpError::Bad);
                            }
                        };
                        let line = read_buf.split_to(t_end + 2);
                        if t_end == 0 {
                            *state = ChunkState::Done;
                            self.complete();
                            return Ok(());
                        }
                        *trailer_bytes = trailer_bytes.saturating_add(t_end + 2);
                        *trailer_count += 1;
                        if *trailer_bytes > self.max_trailer_bytes
                            || *trailer_count > self.max_trailer_count
                        {
                            return Err(PumpError::TrailerTooLarge);
                        }
                        let raw = &line[..t_end];
                        let Some(colon) = raw.iter().position(|&b| b == b':') else {
                            return Err(PumpError::Bad);
                        };
                        if !is_valid_header_name(&raw[..colon])
                            || !is_valid_header_value(&raw[colon + 1..])
                        {
                            return Err(PumpError::Bad);
                        }
                    }
                    ChunkState::Done => {
                        self.complete();
                        return Ok(());
                    }
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn bodies() -> (Arc<RequestBodies>, Arc<AtomicUsize>) {
        let wakes = Arc::new(AtomicUsize::new(0));
        let w = wakes.clone();
        let rb = Arc::new(RequestBodies::new(
            Arc::new(move || {
                w.fetch_add(1, Ordering::SeqCst);
            }),
            Arc::new(AtomicBool::new(false)),
        ));
        (rb, wakes)
    }

    fn collect(rb: &RequestBodies, id: u32) -> (Vec<u8>, u32) {
        let (chunks, state) = rb.take(id).unwrap_or((Vec::new(), TAKE_ENDED));
        (chunks.concat(), state)
    }

    #[test]
    fn length_body_is_split_and_ends() {
        let (rb, wakes) = bodies();
        let mut p = BodyPump::new(7, Some(10), None, &rb, 4096, 16384, 64);
        let mut buf = BytesMut::from(&b"hello"[..]);
        p.feed(&mut buf).unwrap();
        assert!(!p.done);
        assert_eq!(collect(&rb, 7), (b"hello".to_vec(), TAKE_OPEN));
        let mut buf = BytesMut::from(&b"worldGET / HTTP/1.1"[..]);
        p.feed(&mut buf).unwrap();
        assert!(p.done);
        assert_eq!(
            &buf[..],
            b"GET / HTTP/1.1",
            "pipelined bytes stay in the buffer"
        );
        assert_eq!(collect(&rb, 7), (b"world".to_vec(), TAKE_ENDED));
        assert!(rb.take(7).is_none());
        assert!(wakes.load(Ordering::SeqCst) >= 1);
    }

    #[test]
    fn chunked_body_across_arbitrary_splits_with_trailers() {
        let wire = b"5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nX-T: 1\r\n\r\nNEXT";
        for split in 1..wire.len() {
            let (rb, _) = bodies();
            let mut p = BodyPump::new(1, None, None, &rb, 4096, 16384, 64);
            let mut buf = BytesMut::from(&wire[..split]);
            p.feed(&mut buf).unwrap();
            buf.extend_from_slice(&wire[split..]);
            p.feed(&mut buf).unwrap();
            assert!(p.done, "split {split}");
            assert_eq!(&buf[..], b"NEXT");
            assert_eq!(collect(&rb, 1), (b"hello world".to_vec(), TAKE_ENDED));
        }
    }

    #[test]
    fn rejects_bad_framing_and_enforces_limit() {
        let (rb, _) = bodies();
        let mut p = BodyPump::new(1, None, None, &rb, 4096, 16384, 64);
        assert_eq!(
            p.feed(&mut BytesMut::from(&b"zz\r\n"[..])),
            Err(PumpError::Bad)
        );
        let mut p = BodyPump::new(2, None, None, &rb, 4096, 16384, 64);
        assert_eq!(
            p.feed(&mut BytesMut::from(&b"3\r\nabcX\r\n"[..])),
            Err(PumpError::Bad)
        );
        // Whitespace in the chunk-size line is a 400 in llhttp (strict), so here too.
        let bad_lines: [&[u8]; 5] = [b"5 \r\n", b"5\t\r\n", b"5 ;a\r\n", b"5;a \r\n", b"5;\r\n"];
        for (i, line) in bad_lines.into_iter().enumerate() {
            let mut p = BodyPump::new(20 + i as u32, None, None, &rb, 4096, 16384, 64);
            assert_eq!(
                p.feed(&mut BytesMut::from(line)),
                Err(PumpError::Bad),
                "{line:?}"
            );
        }
        let mut p = BodyPump::new(3, Some(100), Some(10), &rb, 4096, 16384, 64);
        assert_eq!(
            p.feed(&mut BytesMut::from(&[b'a'; 20][..])),
            Err(PumpError::TooLarge)
        );
    }

    #[test]
    fn backpressure_blocks_until_js_takes() {
        let (rb, _) = bodies();
        let total = BODY_QUEUE_CAP * 2;
        let mut p = BodyPump::new(9, Some(total), None, &rb, 4096, 16384, 64);
        let mut buf = BytesMut::from(&vec![b'x'; total][..]);
        p.feed(&mut buf).unwrap();
        assert!(p.blocked);
        assert!(!buf.is_empty(), "stops consuming while the queue is full");
        let (first, _) = collect(&rb, 9);
        assert!(first.len() >= BODY_QUEUE_CAP);
        p.feed(&mut buf).unwrap();
        let (rest, state) = collect(&rb, 9);
        assert_eq!(first.len() + rest.len(), total);
        assert!(p.done);
        assert_eq!(state, TAKE_ENDED);
    }

    #[test]
    fn tiny_chunks_are_coalesced_and_bounded() {
        let (rb, _) = bodies();
        // 1-byte chunked pieces: "1\r\nx\r\n" repeated.
        let n = 100_000;
        let mut p = BodyPump::new(11, None, None, &rb, 4096, 16384, 64);
        let mut wire = Vec::with_capacity(n * 6 + 5);
        for _ in 0..n {
            wire.extend_from_slice(b"1\r\nx\r\n");
        }
        wire.extend_from_slice(b"0\r\n\r\n");
        let mut buf = BytesMut::from(&wire[..]);
        let mut total = 0usize;
        let mut max_entries = 0usize;
        loop {
            p.feed(&mut buf).unwrap();
            let (chunks, state) = rb.take(11).unwrap_or((Vec::new(), TAKE_ENDED));
            max_entries = max_entries.max(chunks.len());
            for c in &chunks {
                assert!(c.iter().all(|&b| b == b'x'));
                total += c.len();
            }
            if state == TAKE_ENDED {
                break;
            }
        }
        assert_eq!(total, n);
        assert!(
            max_entries <= 2 * (BODY_QUEUE_CAP / TAIL_CAP) + 2,
            "{max_entries} entries"
        );

        // Mixed sizes keep their order.
        let _ = rb.open(12);
        rb.push(12, Bytes::from_static(b"a"));
        rb.push(12, Bytes::from(vec![b'B'; COALESCE_BELOW]));
        rb.push(12, Bytes::from_static(b"c"));
        rb.push(12, Bytes::from_static(b"d"));
        let (chunks, _) = rb.take(12).unwrap();
        assert_eq!(chunks.len(), 3);
        let all = chunks.concat();
        assert_eq!(all[0], b'a');
        assert_eq!(&all[all.len() - 2..], b"cd");
        assert_eq!(all.len(), COALESCE_BELOW + 3);
    }

    #[test]
    fn abort_and_remove_are_reported() {
        let (rb, _) = bodies();
        let _ = rb.open(4);
        rb.push(4, Bytes::from_static(b"ab"));
        rb.finish(4, true);
        assert_eq!(collect(&rb, 4), (b"ab".to_vec(), TAKE_ABORTED));
        let _ = rb.open(5);
        rb.remove(5);
        assert!(rb.take(5).is_none());
    }

    #[test]
    fn dropping_the_pump_keeps_queued_bytes_for_js() {
        let (rb, _) = bodies();
        let mut done = BodyPump::new(6, Some(3), None, &rb, 4096, 8192, 64);
        done.feed(&mut BytesMut::from(&b"abc"[..])).unwrap();
        drop(done);
        assert_eq!(collect(&rb, 6), (b"abc".to_vec(), TAKE_ENDED));
        assert!(rb.take(6).is_none());

        let mut cut = BodyPump::new(7, Some(10), None, &rb, 4096, 8192, 64);
        cut.feed(&mut BytesMut::from(&b"ab"[..])).unwrap();
        drop(cut);
        assert_eq!(collect(&rb, 7), (b"ab".to_vec(), TAKE_ABORTED));
        assert!(rb.take(7).is_none());
    }
}
