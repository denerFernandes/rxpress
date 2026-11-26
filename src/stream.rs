use bytes::Bytes;
use crossbeam_queue::SegQueue;
use parking_lot::Mutex;
use rustc_hash::FxHashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

/// A file response reached the client in full.
pub const FILE_SENT: u32 = 0;
/// A file response did not: the client went away or the write failed. Any larger code is the
/// HTTP status the engine answered with instead (404, 403...).
pub const FILE_ABORTED: u32 = 1;

pub struct CloseNotifier {
    pub closed_queue: Arc<SegQueue<u32>>,
    pub drained_queue: Arc<SegQueue<u32>>,
    /// `(token, code)` pairs for `res.sendFile()` calls waiting for their callback.
    pub file_queue: Arc<SegQueue<(u32, u32)>>,
    pub wakeup: Arc<dyn Fn() + Send + Sync>,
    pub scheduled: Arc<AtomicBool>,
}

impl CloseNotifier {
    #[inline]
    pub fn notify_closed(&self, req_id: u32) {
        self.closed_queue.push(req_id);
        if !self.scheduled.swap(true, Ordering::SeqCst) {
            (self.wakeup)();
        }
    }

    #[inline]
    pub fn notify_file(&self, token: u32, code: u32) {
        self.file_queue.push((token, code));
        if !self.scheduled.swap(true, Ordering::SeqCst) {
            (self.wakeup)();
        }
    }

    #[inline]
    pub fn notify_drained(&self, req_id: u32) {
        self.drained_queue.push(req_id);
        if !self.scheduled.swap(true, Ordering::SeqCst) {
            (self.wakeup)();
        }
    }
}

/// Reports how a file response ended to the `res.sendFile()` callback waiting for it.
///
/// It travels with the response, so wherever the response ends up the callback is answered: the
/// connection finishes it with the real outcome, and if the response is dropped instead (the client
/// disconnected before or while it was written, the slot was abandoned) `Drop` reports
/// [`FILE_ABORTED`].
pub struct FileNotify {
    token: u32,
    notifier: Arc<CloseNotifier>,
    sent: bool,
}

impl FileNotify {
    pub fn new(token: u32, notifier: Arc<CloseNotifier>) -> Self {
        Self {
            token,
            notifier,
            sent: false,
        }
    }

    /// The response ended with `code` ([`FILE_SENT`], [`FILE_ABORTED`] or an HTTP status).
    pub fn finish(mut self, code: u32) {
        self.sent = true;
        self.notifier.notify_file(self.token, code);
    }
}

impl Drop for FileNotify {
    fn drop(&mut self) {
        if !self.sent {
            self.notifier.notify_file(self.token, FILE_ABORTED);
        }
    }
}

impl std::fmt::Debug for FileNotify {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileNotify")
            .field("token", &self.token)
            .finish()
    }
}

const SHARDS: usize = 32;

struct StreamEntry {
    tx: mpsc::Sender<Bytes>,
    drain_armed: Arc<AtomicBool>,
    capacity: usize,
    aborted: Arc<AtomicBool>,
}

pub struct StreamHandle {
    pub req_id: u32,
    pub rx: mpsc::Receiver<Bytes>,
    pub drain_armed: Arc<AtomicBool>,
    pub capacity: usize,
    /// Set by `StreamRegistry::abort`: the writer must drop the connection without the
    /// terminating zero-length chunk so the client can tell the body is truncated.
    pub aborted: Arc<AtomicBool>,
    pub streams: Arc<StreamRegistry>,
    pub close_notifier: Arc<CloseNotifier>,
}

impl Drop for StreamHandle {
    fn drop(&mut self) {
        self.streams.remove(self.req_id);
        self.close_notifier.notify_closed(self.req_id);
    }
}

pub struct StreamRegistry {
    shards: Vec<Mutex<FxHashMap<u32, StreamEntry>>>,
}

impl StreamRegistry {
    pub fn new() -> Self {
        let mut shards = Vec::with_capacity(SHARDS);
        for _ in 0..SHARDS {
            shards.push(Mutex::new(FxHashMap::default()));
        }
        Self { shards }
    }

    #[inline]
    fn shard(&self, id: u32) -> &Mutex<FxHashMap<u32, StreamEntry>> {
        &self.shards[(id as usize) & (SHARDS - 1)]
    }

    pub fn insert(
        &self,
        req_id: u32,
        tx: mpsc::Sender<Bytes>,
        drain_armed: Arc<AtomicBool>,
        capacity: usize,
    ) -> Arc<AtomicBool> {
        let aborted = Arc::new(AtomicBool::new(false));
        self.shard(req_id).lock().insert(
            req_id,
            StreamEntry {
                tx,
                drain_armed,
                capacity: capacity.max(1),
                aborted: aborted.clone(),
            },
        );
        aborted
    }

    /// Abort a stream (e.g. an error after headers were sent): queued chunks are dropped and
    /// the connection is closed without a terminating chunk.
    pub fn abort(&self, req_id: u32) {
        if let Some(entry) = self.shard(req_id).lock().remove(&req_id) {
            entry.aborted.store(true, Ordering::SeqCst);
        }
    }

    pub fn remove(&self, req_id: u32) -> bool {
        self.shard(req_id).lock().remove(&req_id).is_some()
    }

    #[inline]
    fn check_after_send(entry: &StreamEntry) -> u8 {
        if entry.tx.capacity() == 0 {
            entry.drain_armed.store(true, Ordering::SeqCst);
            let low_water = entry.capacity / 2;
            let free_thresh = entry.capacity - low_water;
            if entry.tx.capacity() >= free_thresh && entry.drain_armed.swap(false, Ordering::SeqCst)
            {
                1
            } else {
                2
            }
        } else {
            1
        }
    }

    /// Write a chunk to a bounded stream.
    /// Returns:
    /// - `0`: stream closed / missing
    /// - `1`: sent ok, capacity remaining
    /// - `2`: sent ok, channel full (`drain_armed` armed)
    /// - `3`: already full, chunk not sent (`drain_armed` armed)
    pub fn write(&self, req_id: u32, data: Bytes) -> u8 {
        let guard = self.shard(req_id).lock();
        let Some(entry) = guard.get(&req_id) else {
            return 0;
        };
        match entry.tx.try_send(data) {
            Ok(()) => Self::check_after_send(entry),
            Err(mpsc::error::TrySendError::Full(returned)) => {
                entry.drain_armed.store(true, Ordering::SeqCst);
                let low_water = entry.capacity / 2;
                let free_thresh = entry.capacity - low_water;
                if entry.tx.capacity() >= free_thresh
                    && entry.drain_armed.swap(false, Ordering::SeqCst)
                {
                    match entry.tx.try_send(returned) {
                        Ok(()) => Self::check_after_send(entry),
                        Err(mpsc::error::TrySendError::Full(_)) => {
                            entry.drain_armed.store(true, Ordering::SeqCst);
                            3
                        }
                        Err(mpsc::error::TrySendError::Closed(_)) => 0,
                    }
                } else {
                    3
                }
            }
            Err(mpsc::error::TrySendError::Closed(_)) => 0,
        }
    }

    pub fn end(&self, req_id: u32, final_chunk: Option<Bytes>) {
        let entry = self.shard(req_id).lock().remove(&req_id);
        if let Some(entry) = entry {
            if let Some(chunk) = final_chunk {
                if !chunk.is_empty() {
                    if let Err(mpsc::error::TrySendError::Full(c)) = entry.tx.try_send(chunk) {
                        crate::server::get_io_runtime().spawn(async move {
                            let _ = entry.tx.send(c).await;
                        });
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn make_notifier(wakeups: Arc<AtomicUsize>) -> Arc<CloseNotifier> {
        Arc::new(CloseNotifier {
            closed_queue: Arc::new(SegQueue::new()),
            drained_queue: Arc::new(SegQueue::new()),
            file_queue: Arc::new(SegQueue::new()),
            wakeup: Arc::new(move || {
                wakeups.fetch_add(1, Ordering::SeqCst);
            }),
            scheduled: Arc::new(AtomicBool::new(false)),
        })
    }

    #[test]
    fn bounded_stream_registry_returns_status_codes_and_arms_drain() {
        let wakeups = Arc::new(AtomicUsize::new(0));
        let notifier = make_notifier(wakeups);
        let reg = Arc::new(StreamRegistry::new());
        let (tx, mut rx) = mpsc::channel(2);
        let drain_armed = Arc::new(AtomicBool::new(false));
        reg.insert(42, tx, drain_armed.clone(), 2);

        // First write -> capacity 1 remaining -> returns 1
        assert_eq!(reg.write(42, Bytes::from_static(b"a")), 1);
        assert!(!drain_armed.load(Ordering::SeqCst));

        // Second write -> capacity 0 remaining -> returns 2 and arms drain_armed
        assert_eq!(reg.write(42, Bytes::from_static(b"b")), 2);
        assert!(drain_armed.load(Ordering::SeqCst));

        // Third write while full -> returns 3 (not sent)
        assert_eq!(reg.write(42, Bytes::from_static(b"c")), 3);
        assert!(drain_armed.load(Ordering::SeqCst));

        // Drain both items
        assert_eq!(rx.try_recv().unwrap(), Bytes::from_static(b"a"));
        assert_eq!(rx.try_recv().unwrap(), Bytes::from_static(b"b"));
        assert!(rx.try_recv().is_err());

        // Missing/closed stream -> returns 0
        assert_eq!(reg.write(999, Bytes::from_static(b"x")), 0);
        drop(rx);
        assert_eq!(reg.write(42, Bytes::from_static(b"d")), 0);
        let _ = notifier;
    }

    #[test]
    fn stream_handle_drop_removes_from_registry_and_notifies_closed() {
        let wakeups = Arc::new(AtomicUsize::new(0));
        let notifier = make_notifier(wakeups.clone());
        let reg = Arc::new(StreamRegistry::new());
        let (tx, rx) = mpsc::channel(4);
        let drain_armed = Arc::new(AtomicBool::new(false));
        reg.insert(77, tx, drain_armed.clone(), 4);

        let handle = StreamHandle {
            req_id: 77,
            rx,
            drain_armed,
            capacity: 4,
            aborted: Arc::new(AtomicBool::new(false)),
            streams: reg.clone(),
            close_notifier: notifier.clone(),
        };

        assert_eq!(reg.write(77, Bytes::from_static(b"hi")), 1);
        drop(handle);

        // Removed from registry and closed notification queued
        assert_eq!(reg.write(77, Bytes::from_static(b"after")), 0);
        assert_eq!(notifier.closed_queue.pop(), Some(77));
        assert!(wakeups.load(Ordering::SeqCst) >= 1);
    }

    #[tokio::test]
    async fn stream_end_delivers_final_chunk_even_when_channel_full() {
        let reg = Arc::new(StreamRegistry::new());
        let (tx, mut rx) = mpsc::channel(1);
        let drain_armed = Arc::new(AtomicBool::new(false));
        reg.insert(10, tx, drain_armed, 1);

        assert_eq!(reg.write(10, Bytes::from_static(b"first")), 2);
        // Channel is now full; end() spawns async send on IO runtime
        reg.end(10, Some(Bytes::from_static(b"last")));
        // Immediately removed from registry
        assert_eq!(reg.write(10, Bytes::from_static(b"x")), 0);

        assert_eq!(rx.recv().await.unwrap(), Bytes::from_static(b"first"));
        assert_eq!(rx.recv().await.unwrap(), Bytes::from_static(b"last"));
        assert!(rx.recv().await.is_none());
    }
}
