#![no_main]
use libfuzzer_sys::fuzz_target;
use rxpress_native::fuzz_api::read_chunked_body;
use std::sync::atomic::AtomicU8;
use std::sync::OnceLock;
use tokio::io::AsyncWriteExt;

fn rt() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    })
}

// data[0..4] select small caps; the rest is the stream. The writer closes after the data, so the
// decoder hits EOF instead of blocking.
fuzz_target!(|data: &[u8]| {
    if data.len() < 4 {
        return;
    }
    let limit = (data[0] as usize) * 16;
    let max_line = 1 + data[1] as usize;
    let max_trailer_bytes = (data[2] as usize) * 4;
    let max_trailer_count = (data[3] & 0x0f) as usize;
    let payload = data[4..].to_vec();
    rt().block_on(async move {
        let (mut tx, mut rx) = tokio::io::duplex(16384);
        tokio::spawn(async move {
            let _ = tx.write_all(&payload).await;
            let _ = tx.shutdown().await;
        });
        let state = AtomicU8::new(0);
        let notify = tokio::sync::Notify::new();
        let sleep = tokio::time::sleep(std::time::Duration::from_secs(5));
        tokio::pin!(sleep);
        let mut fut = std::pin::pin!(notify.notified());
        let mut armed = None;
        let mut buf = bytes::BytesMut::new();
        let res = read_chunked_body(
            &mut rx,
            &mut buf,
            limit,
            max_line,
            max_trailer_bytes,
            max_trailer_count,
            None,
            &mut sleep,
            &mut armed,
            &state,
            &notify,
            &mut fut,
        )
        .await;
        if let Ok(b) = res {
            assert!(b.len() <= limit);
        }
    });
});
