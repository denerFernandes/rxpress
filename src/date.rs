use std::cell::RefCell;
use std::time::{SystemTime, UNIX_EPOCH};

struct CachedDate {
    sec: u64,
    bytes: [u8; 37], // "Date: Wed, 21 Oct 2015 07:28:00 GMT\r\n"
}

thread_local! {
    static TL_DATE: RefCell<CachedDate> = const {
        RefCell::new(CachedDate {
            sec: 0,
            bytes: *b"Date: Thu, 01 Jan 1970 00:00:00 GMT\r\n",
        })
    };
}

fn format_date_header(now: SystemTime) -> [u8; 37] {
    let s = httpdate::fmt_http_date(now);
    let mut out = [0u8; 37];
    out[..6].copy_from_slice(b"Date: ");
    let sb = s.as_bytes();
    let copy_len = sb.len().min(29);
    out[6..6 + copy_len].copy_from_slice(&sb[..copy_len]);
    out[35] = b'\r';
    out[36] = b'\n';
    out
}

/// Zero-lock, zero-atomic thread-local RFC 7231 Date header bytes (37 bytes).
#[inline]
pub fn get_date_header_bytes() -> [u8; 37] {
    let now = SystemTime::now();
    let sec = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    TL_DATE.with(|cell| {
        let mut cached = cell.borrow_mut();
        if cached.sec != sec {
            cached.sec = sec;
            cached.bytes = format_date_header(now);
        }
        cached.bytes
    })
}

/// Zero-lock, zero-atomic thread-local RFC 7231 Date header writer.
#[inline]
pub fn write_date_header(out: &mut Vec<u8>) {
    let bytes = get_date_header_bytes();
    out.extend_from_slice(&bytes);
}
