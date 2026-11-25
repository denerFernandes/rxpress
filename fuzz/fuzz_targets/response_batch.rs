#![no_main]
use libfuzzer_sys::fuzz_target;
use rxpress_native::fuzz_api::*;

// dispatch_response_batch only needs a SlotTable (no sockets), so drive it directly.
fuzz_target!(|data: &[u8]| {
    let Some((&sel, buf)) = data.split_first() else {
        return;
    };
    let slots = SlotTable::new();
    dispatch_response_batch(buf, &slots, sel & 1 != 0, sel & 2 != 0);
    let _ = is_valid_header_name(buf);
    let _ = is_valid_header_value(buf);
});
