use bytes::Bytes;
use crossbeam_queue::ArrayQueue;
use futures_util::task::AtomicWaker;
use parking_lot::Mutex;
use rustc_hash::FxHashMap;
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

pub enum SlotResponse {
    /// Pre-formatted complete HTTP/1.1 response ready to write directly to socket,
    /// OR raw buffered metadata when ETag/file handling is needed.
    RawHttp(Bytes),
    /// Buffered response needing ETag/conditional or HEAD handling
    Buffered {
        status: u16,
        content_type_code: u8,
        flags: u8,
        headers: Vec<(String, String)>,
        body: Bytes,
    },
    /// Chunked streaming / SSE response
    Stream {
        status: u16,
        headers: Vec<(String, String)>,
        suppress_x_powered_by: bool,
        handle: crate::stream::StreamHandle,
    },
}

/// 32768 slots: more than the default `maxConnections` (10k), so with the per-connection
/// pipelining reserve (see `SlotTable::can_pipeline`) every connection can always get a slot.
const SLOT_BITS: u32 = 15;
pub const SLOT_COUNT: usize = 1 << SLOT_BITS;
const SLOT_MASK: usize = SLOT_COUNT - 1;
const GEN_MASK: u32 = (1u32 << (32 - SLOT_BITS)) - 1;

struct Slot {
    generation: AtomicU32,
    waker: AtomicWaker,
    value: Mutex<Option<SlotResponse>>,
    /// How many abandoned ids of this slot are still reserved (see [`Abandoned`]).
    abandoned: AtomicU32,
}

#[inline]
fn next_gen(g: u32) -> u32 {
    let n = g.wrapping_add(1) & GEN_MASK;
    if n == 0 {
        1
    } else {
        n
    }
}

const ABANDONED_SHARDS: usize = 64;
/// Abandoned ids remembered per shard (65 536 in all) before the oldest is forgotten.
const ABANDONED_PER_SHARD: usize = 1024;

/// Request ids whose connection gave up before JS answered (client gone, timeout...).
///
/// The id only has 17 generation bits per slot, so after 2^32 requests it comes around again.
/// JS may still answer an abandoned request much later (a slow handler finishing after the
/// client left); if its id had been handed to a new request in the meantime, that late answer
/// would go to an unrelated client. Abandoned ids are therefore reserved: `acquire` skips them,
/// and they are released when the late answer arrives (and is rejected), or — bounded memory —
/// when more than [`ABANDONED_PER_SHARD`] newer abandonments push them out.
#[derive(Default)]
struct Abandoned {
    ids: FxHashMap<u32, u64>,
    order: VecDeque<(u32, u64)>,
    seq: u64,
}

/// Zero-allocation-per-request response handoff table replacing `oneshot::channel` + `FxHashMap`.
/// Encodes `(generation << SLOT_BITS) | slot_index` directly into `req_id: u32`!
pub struct SlotTable {
    slots: Box<[Slot]>,
    free_list: ArrayQueue<u32>,
    abandoned: Box<[Mutex<Abandoned>]>,
}

impl Default for SlotTable {
    fn default() -> Self {
        Self::new()
    }
}

impl SlotTable {
    pub fn new() -> Self {
        let mut slots = Vec::with_capacity(SLOT_COUNT);
        let free_list = ArrayQueue::new(SLOT_COUNT);
        for i in 0..SLOT_COUNT {
            slots.push(Slot {
                generation: AtomicU32::new(1),
                waker: AtomicWaker::new(),
                value: Mutex::new(None),
                abandoned: AtomicU32::new(0),
            });
            let _ = free_list.push(i as u32);
        }
        Self {
            slots: slots.into_boxed_slice(),
            free_list,
            abandoned: (0..ABANDONED_SHARDS)
                .map(|_| Mutex::new(Abandoned::default()))
                .collect(),
        }
    }

    #[inline]
    fn abandoned_shard(&self, idx: usize) -> &Mutex<Abandoned> {
        &self.abandoned[idx % ABANDONED_SHARDS]
    }

    /// Reserve `req_id`: its connection is gone but JS may still answer it.
    fn mark_abandoned(&self, req_id: u32) {
        let idx = (req_id as usize) & SLOT_MASK;
        let mut sh = self.abandoned_shard(idx).lock();
        sh.seq += 1;
        let seq = sh.seq;
        if sh.ids.insert(req_id, seq).is_none() {
            self.slots[idx].abandoned.fetch_add(1, Ordering::Relaxed);
        }
        sh.order.push_back((req_id, seq));
        while sh.ids.len() > ABANDONED_PER_SHARD {
            let Some((old, old_seq)) = sh.order.pop_front() else {
                break;
            };
            if sh.ids.get(&old) == Some(&old_seq) {
                sh.ids.remove(&old);
                self.slots[(old as usize) & SLOT_MASK]
                    .abandoned
                    .fetch_sub(1, Ordering::Relaxed);
            }
        }
        // Entries released by late answers leave stale order records behind; compact them.
        if sh.order.len() > 2 * ABANDONED_PER_SHARD {
            let Abandoned { ids, order, .. } = &mut *sh;
            order.retain(|(id, s)| ids.get(id) == Some(s));
        }
    }

    /// JS answered an abandoned id (rejected as stale): the id is no longer in use.
    #[cold]
    fn forget_abandoned(&self, req_id: u32) {
        let idx = (req_id as usize) & SLOT_MASK;
        let mut sh = self.abandoned_shard(idx).lock();
        if sh.ids.remove(&req_id).is_some() {
            self.slots[idx].abandoned.fetch_sub(1, Ordering::Relaxed);
        }
    }

    /// First generation at or after `gen` whose id is not reserved; `None` if all are.
    #[cold]
    fn skip_abandoned(&self, idx: usize, mut gen: u32) -> Option<u32> {
        let sh = self.abandoned_shard(idx).lock();
        for _ in 0..GEN_MASK {
            if !sh.ids.contains_key(&((gen << SLOT_BITS) | idx as u32)) {
                return Some(gen);
            }
            gen = next_gen(gen);
        }
        None
    }

    /// Whether a connection may put *additional* pipelined requests in flight: only while more
    /// slots are free than `reserve` (one per possible connection), so a few clients pipelining
    /// slow requests can never starve everybody else of their first slot.
    #[inline]
    pub fn can_pipeline(&self, reserve: usize) -> bool {
        self.free_list.len() > reserve
    }

    /// Acquire a free slot and return packed `req_id = (gen << SLOT_BITS) | index`.
    #[inline]
    pub fn acquire(&self) -> Option<u32> {
        loop {
            let idx = self.free_list.pop()?;
            let slot = &self.slots[idx as usize];
            let gen = slot.generation.load(Ordering::Relaxed) & GEN_MASK;
            // Ensure req_id is never 0
            let mut safe_gen = if gen == 0 { 1 } else { gen };
            if slot.abandoned.load(Ordering::Relaxed) > 0 {
                match self.skip_abandoned(idx as usize, safe_gen) {
                    Some(g) => safe_gen = g,
                    // Every generation of this slot is reserved: retire it.
                    None => continue,
                }
            }
            slot.generation.store(safe_gen, Ordering::Release);
            return Some((safe_gen << SLOT_BITS) | (idx & (SLOT_MASK as u32)));
        }
    }

    #[inline]
    pub fn complete(&self, req_id: u32, resp: SlotResponse) -> bool {
        let idx = (req_id as usize) & SLOT_MASK;
        let expected_gen = req_id >> SLOT_BITS;
        let slot = &self.slots[idx];
        if slot.generation.load(Ordering::Acquire) != expected_gen {
            if slot.abandoned.load(Ordering::Relaxed) > 0 {
                self.forget_abandoned(req_id);
            }
            return false;
        }
        {
            let mut guard = slot.value.lock();
            if slot.generation.load(Ordering::Acquire) != expected_gen {
                drop(guard);
                if slot.abandoned.load(Ordering::Relaxed) > 0 {
                    self.forget_abandoned(req_id);
                }
                return false;
            }
            *guard = Some(resp);
        }
        slot.waker.wake();
        true
    }

    /// Give the slot back. `settled`: JS is known to be done with the id (it answered, or took
    /// the request over); otherwise the id stays reserved until JS answers it.
    #[inline]
    fn release(&self, req_id: u32, settled: bool) {
        let idx = (req_id as usize) & SLOT_MASK;
        let slot = &self.slots[idx];
        slot.waker.take();
        let answered = {
            let mut guard = slot.value.lock();
            let answered = guard.take().is_some();
            // Bump generation INSIDE the lock so no concurrent complete() can write
            // a stale response after *guard = None and before generation changes.
            let cur = slot.generation.load(Ordering::Relaxed);
            slot.generation.store(next_gen(cur), Ordering::Release);
            answered
        };
        if !answered && !settled {
            self.mark_abandoned(req_id);
        }
        let _ = self.free_list.push(idx as u32);
    }

    #[inline]
    pub fn wait(self: &Arc<Self>, req_id: u32) -> SlotFuture {
        SlotFuture {
            table: self.clone(),
            req_id,
            released: false,
        }
    }
}

pub struct SlotFuture {
    table: Arc<SlotTable>,
    req_id: u32,
    released: bool,
}

impl SlotFuture {
    /// The request id this future is waiting on.
    #[inline]
    pub fn req_id(&self) -> u32 {
        self.req_id
    }

    /// Release the slot knowing JS will not answer through it (e.g. it took the upgraded
    /// socket), so the id need not stay reserved.
    pub fn settle(mut self) {
        if !self.released {
            self.released = true;
            self.table.release(self.req_id, true);
        }
    }
}

impl Future for SlotFuture {
    type Output = SlotResponse;

    #[inline]
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let idx = (self.req_id as usize) & SLOT_MASK;
        let slot = &self.table.slots[idx];
        {
            let mut guard = slot.value.lock();
            if let Some(val) = guard.take() {
                let next_gen = slot.generation.load(Ordering::Relaxed).wrapping_add(1) & GEN_MASK;
                slot.generation
                    .store(if next_gen == 0 { 1 } else { next_gen }, Ordering::Release);
                drop(guard);
                slot.waker.take();
                let _ = self.table.free_list.push(idx as u32);
                self.released = true;
                return Poll::Ready(val);
            }
        }

        slot.waker.register(cx.waker());

        // Double check after registering waker to prevent lost wakeup
        {
            let mut guard = slot.value.lock();
            if let Some(val) = guard.take() {
                let next_gen = slot.generation.load(Ordering::Relaxed).wrapping_add(1) & GEN_MASK;
                slot.generation
                    .store(if next_gen == 0 { 1 } else { next_gen }, Ordering::Release);
                drop(guard);
                slot.waker.take();
                let _ = self.table.free_list.push(idx as u32);
                self.released = true;
                return Poll::Ready(val);
            }
        }

        Poll::Pending
    }
}

impl Drop for SlotFuture {
    fn drop(&mut self) {
        if !self.released {
            self.released = true;
            self.table.release(self.req_id, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn slot_acquire_complete_poll_and_reuse() {
        let table = Arc::new(SlotTable::new());
        for _ in 0..(SLOT_COUNT + 16) {
            let id = table.acquire().expect("slot available");
            assert_ne!(id, 0);
            let fut = table.wait(id);
            assert!(table.complete(id, SlotResponse::RawHttp(Bytes::from_static(b"ok"))));
            match fut.await {
                SlotResponse::RawHttp(b) => assert_eq!(&b[..], b"ok"),
                _ => panic!("unexpected variant"),
            }
        }
    }

    #[tokio::test]
    async fn slot_generation_bump_rejects_stale_complete() {
        let table = Arc::new(SlotTable::new());
        let id1 = table.acquire().unwrap();
        let fut1 = table.wait(id1);
        drop(fut1); // releases slot and bumps generation

        // Acquire all remaining slots until we wrap around to same index
        let mut held = Vec::new();
        let mut id2 = None;
        for _ in 0..SLOT_COUNT {
            let id = table.acquire().unwrap();
            if (id as usize & SLOT_MASK) == (id1 as usize & SLOT_MASK) {
                id2 = Some(id);
                break;
            }
            held.push(table.wait(id));
        }
        let id2 = id2.expect("re-acquired same index");
        assert_ne!(id1, id2);
        // Stale completion with id1 must fail
        assert!(!table.complete(id1, SlotResponse::RawHttp(Bytes::from_static(b"stale"))));

        let fut2 = table.wait(id2);
        assert!(table.complete(id2, SlotResponse::RawHttp(Bytes::from_static(b"fresh"))));
        match fut2.await {
            SlotResponse::RawHttp(b) => assert_eq!(&b[..], b"fresh"),
            _ => panic!("unexpected variant"),
        }
    }

    #[test]
    fn slot_generation_wrap_never_zero() {
        let table = Arc::new(SlotTable::new());
        let id = table.acquire().unwrap();
        let idx = (id as usize) & SLOT_MASK;
        table.slots[idx]
            .generation
            .store(GEN_MASK, Ordering::Release);
        let wrapped_req_id = (GEN_MASK << SLOT_BITS) | (idx as u32);
        table.release(wrapped_req_id, true);
        assert_eq!(table.slots[idx].generation.load(Ordering::Acquire), 1);
        assert!(!table.complete(0, SlotResponse::RawHttp(Bytes::from_static(b"x"))));
    }

    /// Cycle `idx` through `n` generations, each acquired and answered normally.
    fn cycle(table: &Arc<SlotTable>, n: u32) {
        for _ in 0..n {
            let id = table.acquire().unwrap();
            let fut = table.wait(id);
            assert!(table.complete(id, SlotResponse::RawHttp(Bytes::from_static(b"x"))));
            drop(fut);
        }
    }

    #[test]
    fn abandoned_id_is_never_reissued_until_answered() {
        let table = Arc::new(SlotTable::new());
        let abandoned = table.acquire().unwrap();
        let idx = (abandoned as usize) & SLOT_MASK;
        drop(table.wait(abandoned)); // connection gone, JS still holds `abandoned`

        // Fast-forward this slot to the generation right before the id wraps around.
        let gen = abandoned >> SLOT_BITS;
        table.slots[idx]
            .generation
            .store(gen.wrapping_sub(1) & GEN_MASK, Ordering::Release);
        // Rotate the FIFO free list until `idx` comes up again.
        let mut held = Vec::new();
        let mut reissued = None;
        for _ in 0..SLOT_COUNT * 3 {
            let id = table.acquire().unwrap();
            if (id as usize) & SLOT_MASK == idx {
                if id >> SLOT_BITS == gen.wrapping_sub(1) & GEN_MASK {
                    // One step before the wrap: release (answered) and keep rotating.
                    let f = table.wait(id);
                    assert!(table.complete(id, SlotResponse::RawHttp(Bytes::new())));
                    drop(f);
                    continue;
                }
                reissued = Some(id);
                break;
            }
            let f = table.wait(id);
            assert!(table.complete(id, SlotResponse::RawHttp(Bytes::new())));
            held.push(f);
            if held.len() > 64 {
                held.clear();
            }
        }
        let reissued = reissued.expect("slot came around");
        assert_ne!(reissued, abandoned, "abandoned id handed to a new request");

        // The late answer for the abandoned id cannot reach the new request...
        let fut = table.wait(reissued);
        assert!(!table.complete(
            abandoned,
            SlotResponse::RawHttp(Bytes::from_static(b"late"))
        ));
        assert!(table.complete(reissued, SlotResponse::RawHttp(Bytes::from_static(b"new"))));
        drop(fut);
        // ...and, being answered, it is no longer reserved.
        assert_eq!(table.slots[idx].abandoned.load(Ordering::Relaxed), 0);
        cycle(&table, 4);
    }

    #[test]
    fn abandoned_reservations_are_bounded() {
        let table = Arc::new(SlotTable::new());
        let total = ABANDONED_SHARDS * ABANDONED_PER_SHARD + 5000;
        for _ in 0..total {
            let id = table.acquire().unwrap();
            drop(table.wait(id));
        }
        let kept: usize = table.abandoned.iter().map(|s| s.lock().ids.len()).sum();
        assert!(kept <= ABANDONED_SHARDS * ABANDONED_PER_SHARD, "{kept}");
        let counted: u32 = table
            .slots
            .iter()
            .map(|s| s.abandoned.load(Ordering::Relaxed))
            .sum();
        assert_eq!(counted as usize, kept);
        for s in table.abandoned.iter() {
            assert!(s.lock().order.len() <= 2 * ABANDONED_PER_SHARD + 1);
        }

        // Settled releases (upgrade taken by JS) reserve nothing.
        let table = Arc::new(SlotTable::new());
        let id = table.acquire().unwrap();
        table.wait(id).settle();
        assert_eq!(
            table
                .abandoned
                .iter()
                .map(|s| s.lock().ids.len())
                .sum::<usize>(),
            0
        );
    }

    #[test]
    fn slot_exhaustion_and_cancellation_recovery() {
        let table = Arc::new(SlotTable::new());
        let mut futs = Vec::with_capacity(SLOT_COUNT);
        for _ in 0..SLOT_COUNT {
            let id = table.acquire().expect("slot");
            futs.push(table.wait(id));
        }
        assert!(table.acquire().is_none());
        futs.pop();
        assert!(table.acquire().is_some());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn slot_concurrent_complete_vs_drop_race() {
        let table = Arc::new(SlotTable::new());
        for round in 0..2000 {
            let id = table.acquire().unwrap();
            let fut = table.wait(id);
            let t_clone = table.clone();
            let h = tokio::spawn(async move {
                let _ = t_clone.complete(id, SlotResponse::RawHttp(Bytes::from_static(b"stale")));
            });
            drop(fut);
            let _ = h.await;

            // Immediately verify slot value is None after both complete and drop settle
            let idx = (id as usize) & SLOT_MASK;
            assert!(
                table.slots[idx].value.lock().is_none(),
                "stale value leaked at round {round}"
            );
        }
    }
}
