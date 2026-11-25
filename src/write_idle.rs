//! Write-side idle deadline (slow-read defence).
//!
//! A client that stops reading leaves every write `Pending` forever: the connection, its slot and
//! its buffers stay pinned. [`IdleWrite`] wraps a connection stream and fails a write, flush or
//! shutdown with `TimedOut` once the socket has accepted no byte for `idle`. Each byte of progress
//! re-arms the deadline, so slow but live clients (large downloads, long-lived SSE) are not cut.
//!
//! Cost on the hot path: none. The timer is only armed (and lazily allocated, once per connection)
//! when a write returns `Pending`; a write that completes immediately only clears a flag.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::{Instant, Sleep};

pub struct IdleWrite<S> {
    inner: S,
    idle: Option<Duration>,
    sleep: Option<Pin<Box<Sleep>>>,
    armed: bool,
}

impl<S> IdleWrite<S> {
    pub fn new(inner: S, idle: Option<Duration>) -> Self {
        Self {
            inner,
            idle,
            sleep: None,
            armed: false,
        }
    }

    #[inline]
    pub fn get_ref(&self) -> &S {
        &self.inner
    }

    #[inline]
    pub fn get_mut(&mut self) -> &mut S {
        &mut self.inner
    }

    /// Turn the deadline off (e.g. a relayed upgrade, whose idleness the app owns).
    pub fn disable(&mut self) {
        self.idle = None;
        self.armed = false;
    }

    /// A write made progress (or failed): the next stall starts a fresh deadline.
    #[inline]
    fn progressed<T>(&mut self, r: Poll<io::Result<T>>) -> Poll<io::Result<T>> {
        self.armed = false;
        r
    }

    /// The inner write is stalled: arm the deadline if needed and fail once it has passed.
    fn stalled<T>(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<T>> {
        let Some(idle) = self.idle else {
            return Poll::Pending;
        };
        if !self.armed {
            let dl = Instant::now() + idle;
            match self.sleep.as_mut() {
                Some(s) => s.as_mut().reset(dl),
                None => self.sleep = Some(Box::pin(tokio::time::sleep_until(dl))),
            }
            self.armed = true;
        }
        let Some(s) = self.sleep.as_mut() else {
            return Poll::Pending;
        };
        if s.as_mut().poll(cx).is_ready() {
            self.armed = false;
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "write idle timeout: peer is not reading",
            )));
        }
        Poll::Pending
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for IdleWrite<S> {
    #[inline]
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for IdleWrite<S> {
    #[inline]
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_write(cx, buf) {
            Poll::Pending => this.stalled(cx),
            r => this.progressed(r),
        }
    }

    #[inline]
    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_write_vectored(cx, bufs) {
            Poll::Pending => this.stalled(cx),
            r => this.progressed(r),
        }
    }

    #[inline]
    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    #[inline]
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_flush(cx) {
            Poll::Pending => this.stalled(cx),
            r => this.progressed(r),
        }
    }

    #[inline]
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_shutdown(cx) {
            Poll::Pending => this.stalled(cx),
            r => this.progressed(r),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test(start_paused = true)]
    async fn stalled_writer_times_out_and_progress_rearms() {
        let (a, mut b) = tokio::io::duplex(1024);
        let mut w = IdleWrite::new(a, Some(Duration::from_secs(30)));

        // Peer reads slowly but steadily: every write makes progress before the deadline.
        let reader = tokio::spawn(async move {
            let mut got = 0usize;
            let mut buf = [0u8; 512];
            while got < 8 * 1024 {
                tokio::time::sleep(Duration::from_secs(20)).await;
                got += b.read(&mut buf).await.unwrap();
            }
            b
        });
        w.write_all(&[7u8; 8 * 1024]).await.unwrap();
        let _b = reader.await.unwrap();

        // Peer stops reading: the write fails once nothing moved for 30 s.
        let start = Instant::now();
        let err = w.write_all(&[7u8; 64 * 1024]).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        let waited = start.elapsed();
        assert!(waited >= Duration::from_secs(30) && waited < Duration::from_secs(31));
    }

    #[tokio::test(start_paused = true)]
    async fn disabled_deadline_never_fires() {
        let (a, _b) = tokio::io::duplex(16);
        let mut w = IdleWrite::new(a, None);
        let r = tokio::time::timeout(Duration::from_secs(3600), w.write_all(&[0u8; 64])).await;
        assert!(r.is_err(), "still pending after an hour without a deadline");
    }
}
