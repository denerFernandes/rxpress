#![no_main]
use libfuzzer_sys::fuzz_target;
use rxpress_native::fuzz_api::decode_sendfile_payload;

fuzz_target!(|data: &[u8]| {
    let Some((&sel, body)) = data.split_first() else {
        return;
    };
    let _ = decode_sendfile_payload(body, sel & 1 != 0, sel & 2 != 0, sel & 4 != 0);
});
