//! The socket abstraction the connection driver runs on, and the `'upgrade'` hand-off.

use super::{ServerShared, ShutdownBus};
use crate::protocol::PendingRequest;
use crate::slots::SlotFuture;
use crate::upgrade::{HandoffFd, UPGRADE_TTL};
use crate::write_idle::IdleWrite;
use bytes::{Bytes, BytesMut};
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::futures::Notified;
use tokio::sync::Notify;

pub(super) trait ConnStream: AsyncRead + AsyncWrite + Unpin {
    fn try_read_buf_fast(&mut self, buf: &mut BytesMut) -> std::io::Result<usize>;
    /// A descriptor Node can own for this very socket (plain TCP); `None` when the bytes need
    /// the engine in between (TLS).
    fn handoff_fd(&self) -> Option<HandoffFd>;
    /// Stop enforcing the write idle deadline (upgraded connections relay for the app).
    fn disable_write_timeout(&mut self) {}
}

impl<S: ConnStream> ConnStream for IdleWrite<S> {
    #[inline]
    fn try_read_buf_fast(&mut self, buf: &mut BytesMut) -> std::io::Result<usize> {
        self.get_mut().try_read_buf_fast(buf)
    }

    fn handoff_fd(&self) -> Option<HandoffFd> {
        self.get_ref().handoff_fd()
    }

    fn disable_write_timeout(&mut self) {
        self.disable();
    }
}

impl ConnStream for tokio::net::TcpStream {
    #[inline]
    fn try_read_buf_fast(&mut self, buf: &mut BytesMut) -> std::io::Result<usize> {
        self.try_read_buf(buf)
    }

    #[cfg(unix)]
    fn handoff_fd(&self) -> Option<HandoffFd> {
        use std::os::fd::AsFd;
        self.as_fd().try_clone_to_owned().ok()
    }

    #[cfg(not(unix))]
    fn handoff_fd(&self) -> Option<HandoffFd> {
        None
    }
}

impl ConnStream for tokio_rustls::server::TlsStream<tokio::net::TcpStream> {
    #[inline]
    fn try_read_buf_fast(&mut self, _buf: &mut BytesMut) -> std::io::Result<usize> {
        Err(std::io::Error::from(std::io::ErrorKind::WouldBlock))
    }

    fn handoff_fd(&self) -> Option<HandoffFd> {
        None
    }
}

/// Upgrade hand-off: queue the request for JS with its socket, then either let go of the
/// connection (TCP: JS owns a dup of the fd) or relay TLS plaintext through a socketpair until
/// either side closes or the server force-closes. Never returns a "clean" exit, so the caller
/// does not shut the (now shared) socket down.
#[allow(clippy::too_many_arguments)]
pub(super) async fn hand_off_upgrade<'a, S: ConnStream>(
    stream: &mut S,
    shared: &Arc<ServerShared>,
    pending: PendingRequest,
    slot_future: SlotFuture,
    head: Bytes,
    shutdown_bus: &ShutdownBus,
    shutdown_shard: &'a Notify,
    shutdown_fut: &mut Pin<&mut Notified<'a>>,
) -> bool {
    let req_id = pending.req_id;
    if let Some(fd) = stream.handoff_fd() {
        shared.upgrades.insert(req_id, fd, head, slot_future);
        spawn_upgrade_sweeper(shared);
        shared.queue.push(pending);
        shared.wake_js();
        return false;
    }
    #[cfg(unix)]
    {
        let Ok((mut ours, theirs)) = tokio::net::UnixStream::pair() else {
            return false;
        };
        let Ok(theirs) = theirs.into_std() else {
            return false;
        };
        shared.upgrades.insert(
            req_id,
            std::os::fd::OwnedFd::from(theirs),
            head,
            slot_future,
        );
        spawn_upgrade_sweeper(shared);
        shared.queue.push(pending);
        shared.wake_js();
        stream.disable_write_timeout();
        let relay = tokio::io::copy_bidirectional(stream, &mut ours);
        tokio::pin!(relay);
        loop {
            tokio::select! {
                _ = &mut relay => break,
                _ = shutdown_fut.as_mut() => {
                    shutdown_fut.set(shutdown_shard.notified());
                    let _ = shutdown_fut.as_mut().enable();
                    if shutdown_bus.state() >= 2 {
                        break;
                    }
                }
            }
        }
        false
    }
    #[cfg(not(unix))]
    {
        let _ = (
            shared,
            pending,
            slot_future,
            head,
            shutdown_bus,
            shutdown_shard,
            shutdown_fut,
        );
        false
    }
}

/// Expire upgrade hand-offs JS never takes (one task per server, only while entries exist; it
/// holds no strong reference, so it never keeps a closed server alive).
fn spawn_upgrade_sweeper(shared: &Arc<ServerShared>) {
    if !shared.upgrades.claim_sweeper() {
        return;
    }
    let weak = Arc::downgrade(shared);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(UPGRADE_TTL / 3).await;
            let Some(s) = weak.upgrade() else {
                return;
            };
            if s.is_closed.load(Ordering::Acquire) {
                s.upgrades.clear();
            }
            if s.upgrades.sweep(UPGRADE_TTL) == 0 && !s.upgrades.release_sweeper() {
                return;
            }
        }
    });
}
