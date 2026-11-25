#![no_main]
use libfuzzer_sys::fuzz_target;
use rxpress_native::fuzz_api::*;

fuzz_target!(|data: &[u8]| {
    if data.len() < 8 {
        return;
    }
    let size = u64::from_le_bytes(data[..8].try_into().unwrap());
    let text = String::from_utf8_lossy(&data[8..]);
    // U+FFFD (what lossy decoding yields for invalid bytes) splits the input into three strings.
    let mut parts = text.split('\u{FFFD}');
    let a = parts.next().unwrap_or("");
    let b = parts.next().unwrap_or("");
    let c = parts.next().unwrap_or("");

    for s in [size, 0, 1, u64::MAX] {
        if let RangeParseResult::Satisfiable(start, end) = parse_single_range(a, s) {
            assert!(start <= end && end < s, "range {start}-{end} for size {s}");
        }
    }
    let _ = if_range_matches(a, Some(b), Some(c));
    let _ = if_range_matches(a, None, Some(c));
    let _ = if_range_matches(a, Some(b), None);
    let _ = etag_matches(a, b);
});
