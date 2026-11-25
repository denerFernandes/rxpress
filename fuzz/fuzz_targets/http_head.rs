#![no_main]
use libfuzzer_sys::fuzz_target;
use rxpress_native::fuzz_api::{try_parse_request, ParseOutcome};

// Layout: u16 LE max_headers_count, u16 LE max_header_size, then the raw head bytes.
fuzz_target!(|data: &[u8]| {
    if data.len() < 4 {
        return;
    }
    let max_headers = u16::from_le_bytes([data[0], data[1]]) as usize % 300;
    let max_size = u16::from_le_bytes([data[2], data[3]]) as usize;
    let buf = &data[4..];
    if let ParseOutcome::Complete(m) = try_parse_request(buf, max_headers, max_size) {
        // Returned offsets must lie inside the buffer and be ordered.
        assert!(m.header_len <= buf.len());
        assert!(m.method_start <= m.method_end && m.method_end <= buf.len());
        assert!(m.url_start <= m.url_end && m.url_end <= buf.len());
        assert!(m.headers_start <= m.headers_end && m.headers_end <= buf.len());
        for (s, e) in [
            m.content_type,
            m.if_none_match,
            m.if_modified_since,
            m.range,
        ]
        .into_iter()
        .flatten()
        {
            assert!(s <= e && e <= buf.len());
        }
    }
});
