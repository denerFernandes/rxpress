use bytes::Bytes;
use rustc_hash::FxHashMap;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Instant;

pub(super) const CACHE_MAX_FILE_SIZE: u64 = 64 * 1024;
const CACHE_TTL_MS: u128 = 1000;
pub(super) const CACHE_MAX_ENTRIES: usize = 256;

pub(super) struct CacheSlot {
    pub(super) mount_id: u64,
    pub(super) key: Rc<str>,
    pub(super) referenced: Cell<bool>,
    pub(super) cached_at: Instant,
    pub(super) body: Bytes,
    pub(super) etag: Option<String>,
    pub(super) last_modified: Option<String>,
    pub(super) content_type: String,
    pub(super) header_prefix: Bytes,
}

pub(super) struct StaticCache {
    index: FxHashMap<u64, FxHashMap<Rc<str>, usize>>,
    pub(super) slots: Vec<CacheSlot>,
    hand: usize,
}

impl StaticCache {
    fn new() -> Self {
        Self {
            index: FxHashMap::default(),
            slots: Vec::with_capacity(CACHE_MAX_ENTRIES),
            hand: 0,
        }
    }

    #[inline]
    pub(super) fn get(&self, mount_id: u64, key: &str) -> Option<&CacheSlot> {
        let mount_map = self.index.get(&mount_id)?;
        let &idx = mount_map.get(key)?;
        let slot = &self.slots[idx];
        if slot.cached_at.elapsed().as_millis() < CACHE_TTL_MS {
            slot.referenced.set(true);
            Some(slot)
        } else {
            None
        }
    }

    pub(super) fn insert(&mut self, slot: CacheSlot) {
        let mount_id = slot.mount_id;
        let key = Rc::clone(&slot.key);

        if let Some(&existing_idx) = self.index.get(&mount_id).and_then(|m| m.get(key.as_ref())) {
            self.slots[existing_idx] = slot;
            return;
        }

        if self.slots.len() < CACHE_MAX_ENTRIES {
            let idx = self.slots.len();
            self.slots.push(slot);
            self.index.entry(mount_id).or_default().insert(key, idx);
            return;
        }

        // Clock (Second-Chance) eviction in O(1) amortized
        let n = self.slots.len();
        for _ in 0..(n * 2) {
            let h = self.hand;
            self.hand = (h + 1) % n;
            let expired = self.slots[h].cached_at.elapsed().as_millis() >= CACHE_TTL_MS;
            if expired || !self.slots[h].referenced.get() {
                let old_mid = self.slots[h].mount_id;
                let old_key = Rc::clone(&self.slots[h].key);
                if let Some(old_map) = self.index.get_mut(&old_mid) {
                    old_map.remove(old_key.as_ref());
                    if old_map.is_empty() {
                        self.index.remove(&old_mid);
                    }
                }
                self.slots[h] = slot;
                self.index.entry(mount_id).or_default().insert(key, h);
                return;
            }
            self.slots[h].referenced.set(false);
        }
    }
}

thread_local! {
    /// Zero-lock O(1) thread-local static file cache with Clock (Second-Chance) eviction.
    pub(super) static TL_STATIC_CACHE: RefCell<StaticCache> = RefCell::new(StaticCache::new());
}
