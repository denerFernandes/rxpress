//! HTTP Upgrade (WebSocket...) hand-off to Node.js.
//!
//! When the app listens for `'upgrade'`, a request carrying `Connection: upgrade` + `Upgrade`
//! leaves the engine: the connection is handed to JS as a file descriptor, which Node wraps in a
//! real `net.Socket` (what `ws`, socket.io and friends require). Plain TCP hands over a dup of the
//! socket itself (no relay afterwards); TLS hands over one end of a socketpair while the engine
//! relays the decrypted bytes. Bytes already read past the request head go along as `head`.
//!
//! Entries JS never takes (handler threw, request dropped, server closing) expire after
//! [`UPGRADE_TTL`]: a sweeper task runs while any entry is parked, and closing the server clears
//! them. Dropping an entry closes its descriptor and releases its request id.

use crate::slots::SlotFuture;
use bytes::Bytes;
use parking_lot::Mutex;
use rustc_hash::FxHashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// How long a handed-off socket waits for JS to take it.
pub const UPGRADE_TTL: Duration = Duration::from_secs(30);

#[cfg(unix)]
pub type HandoffFd = std::os::fd::OwnedFd;
#[cfg(not(unix))]
pub type HandoffFd = ();

struct Entry {
    fd: HandoffFd,
    head: Bytes,
    created: Instant,
    /// Keeps the request id reserved until JS takes the socket (ids are reused afterwards).
    _slot: SlotFuture,
}

#[derive(Default)]
pub struct Upgrades {
    map: Mutex<FxHashMap<u32, Entry>>,
    /// JS has `'upgrade'` listeners (otherwise upgrade requests are ordinary requests, as in
    /// Node when no listener is attached).
    enabled: AtomicBool,
    /// A sweeper task is running (see [`Upgrades::claim_sweeper`]).
    sweeping: AtomicBool,
}

impl Upgrades {
    pub fn new() -> Self {
        Self::default()
    }

    #[inline]
    pub fn enabled(&self) -> bool {
        cfg!(unix) && self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
    }

    pub fn insert(&self, req_id: u32, fd: HandoffFd, head: Bytes, slot: SlotFuture) {
        let now = Instant::now();
        let expired: Vec<Entry> = {
            let mut map = self.map.lock();
            let old = Self::remove_older_than(&mut map, now, UPGRADE_TTL);
            map.insert(
                req_id,
                Entry {
                    fd,
                    head,
                    created: now,
                    _slot: slot,
                },
            );
            old
        };
        // Close fds / release slots outside the lock.
        drop(expired);
    }

    /// Hand the socket to JS (ownership of the fd moves to the caller).
    pub fn take(&self, req_id: u32) -> Option<(HandoffFd, Bytes)> {
        let e = self.map.lock().remove(&req_id)?;
        if e.created.elapsed() >= UPGRADE_TTL {
            return None;
        }
        // JS owns the socket now and never answers the request through the engine.
        e._slot.settle();
        Some((e.fd, e.head))
    }

    fn remove_older_than(
        map: &mut FxHashMap<u32, Entry>,
        now: Instant,
        ttl: Duration,
    ) -> Vec<Entry> {
        if map.is_empty() {
            return Vec::new();
        }
        let ids: Vec<u32> = map
            .iter()
            .filter(|(_, e)| now.duration_since(e.created) >= ttl)
            .map(|(&id, _)| id)
            .collect();
        ids.into_iter().filter_map(|id| map.remove(&id)).collect()
    }

    /// Drop entries older than `ttl`. Returns how many remain.
    pub fn sweep(&self, ttl: Duration) -> usize {
        let (expired, left) = {
            let mut map = self.map.lock();
            let old = Self::remove_older_than(&mut map, Instant::now(), ttl);
            (old, map.len())
        };
        drop(expired);
        left
    }

    /// Server closed: every parked socket is closed.
    pub fn clear(&self) {
        let all: Vec<Entry> = self.map.lock().drain().map(|(_, e)| e).collect();
        drop(all);
    }

    /// Whether the caller should start the sweeper task (only one runs at a time).
    pub fn claim_sweeper(&self) -> bool {
        !self.sweeping.swap(true, Ordering::AcqRel)
    }

    /// The sweeper found nothing parked and stops. Returns `true` when an entry raced in, in
    /// which case the caller keeps sweeping.
    pub fn release_sweeper(&self) -> bool {
        self.sweeping.store(false, Ordering::Release);
        !self.map.lock().is_empty() && self.claim_sweeper()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slots::SlotTable;
    use std::sync::Arc;

    #[cfg(unix)]
    fn fd() -> HandoffFd {
        let (a, _b) = std::os::unix::net::UnixStream::pair().unwrap();
        std::os::fd::OwnedFd::from(a)
    }
    #[cfg(not(unix))]
    fn fd() -> HandoffFd {}

    #[test]
    fn expired_entries_are_swept_and_cleared_releasing_slots() {
        let slots = Arc::new(SlotTable::new());
        let up = Upgrades::new();
        let id1 = slots.acquire().unwrap();
        up.insert(id1, fd(), Bytes::new(), slots.wait(id1));
        let id2 = slots.acquire().unwrap();
        up.insert(id2, fd(), Bytes::new(), slots.wait(id2));
        assert_eq!(up.sweep(UPGRADE_TTL), 2, "fresh entries stay");
        assert_eq!(up.sweep(Duration::ZERO), 0, "expired entries go");
        assert!(up.take(id1).is_none());

        let id3 = slots.acquire().unwrap();
        up.insert(id3, fd(), Bytes::from_static(b"h"), slots.wait(id3));
        assert_eq!(up.sweep(UPGRADE_TTL), 1);
        up.clear();
        assert_eq!(up.sweep(UPGRADE_TTL), 0);

        let id4 = slots.acquire().unwrap();
        up.insert(id4, fd(), Bytes::from_static(b"h"), slots.wait(id4));
        let (_, head) = up.take(id4).expect("fresh entry is taken");
        assert_eq!(&head[..], b"h");

        assert!(up.claim_sweeper());
        assert!(!up.claim_sweeper());
        assert!(!up.release_sweeper(), "nothing parked: sweeper stops");
        assert!(up.claim_sweeper());
    }
}
