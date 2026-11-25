//! Runtime, bind, accept loop, connection limits and graceful drain.

use super::conn::handle_connection;
use super::{RunningServer, ServerShared, ShutdownBus};
use crate::protocol::build_simple_raw_response;
use crate::tls::{build_tls_acceptor, TlsInput};
use socket2::{Domain, Protocol, Socket, Type};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::futures::Notified;
use tokio::sync::{watch, Notify, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AcceptErrorAction {
    RetryImmediately,
    Backoff { wait: Duration, next_ms: u64 },
}

#[inline]
pub(crate) fn accept_backoff_for_error(
    err: &std::io::Error,
    prev_backoff_ms: u64,
) -> AcceptErrorAction {
    use std::io::ErrorKind;
    if matches!(
        err.kind(),
        ErrorKind::ConnectionAborted | ErrorKind::ConnectionReset | ErrorKind::Interrupted
    ) {
        return AcceptErrorAction::RetryImmediately;
    }
    let wait = Duration::from_millis(prev_backoff_ms);
    let next_ms = match prev_backoff_ms {
        10 => 20,
        20 => 50,
        50 => 100,
        _ => 200,
    };
    AcceptErrorAction::Backoff { wait, next_ms }
}

struct ConnectionGuard {
    shared: Arc<ServerShared>,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        if self
            .shared
            .active_connections
            .fetch_sub(1, Ordering::AcqRel)
            == 1
        {
            self.shared.drain_notify.notify_waiters();
        }
    }
}

static IO_RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();

pub fn get_io_runtime() -> &'static tokio::runtime::Runtime {
    IO_RUNTIME.get_or_init(|| {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        // Leave headroom for Node's main thread + wrk/clients; cap at 4 P-cores
        let workers = cores.clamp(2, 4);
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(workers)
            .enable_all()
            .thread_name("rxpress-io")
            .build()
            .expect("Failed to build rxpress Tokio runtime")
    })
}

pub fn resolve_bind_addrs(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Failed to resolve bind host '{host}': {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("No addresses resolved for bind host '{host}'"));
    }
    Ok(addrs)
}

fn bind_reusable_listener(addr: SocketAddr) -> Result<std::net::TcpListener, String> {
    let domain = if addr.is_ipv6() {
        Domain::IPV6
    } else {
        Domain::IPV4
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))
        .map_err(|e| format!("Failed to create socket: {e}"))?;
    // On Unix SO_REUSEADDR only allows rebinding over TIME_WAIT (what Node does). On Windows it
    // lets another socket bind the same port, so it is left off there, like libuv.
    #[cfg(not(windows))]
    socket
        .set_reuse_address(true)
        .map_err(|e| format!("Failed to set SO_REUSEADDR: {e}"))?;
    if addr.is_ipv6() {
        let _ = socket.set_only_v6(false);
    }
    socket
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to set nonblocking: {e}"))?;
    socket
        .bind(&addr.into())
        .map_err(|e| format!("Failed to bind to {addr}: {e}"))?;
    socket
        .listen(4096)
        .map_err(|e| format!("Failed to listen on {addr}: {e}"))?;
    Ok(socket.into())
}

pub fn start_http_server_sync(
    host: String,
    port: u16,
    shared: Arc<ServerShared>,
    tls: Option<TlsInput>,
) -> Result<RunningServer, String> {
    let tls_acceptor: Option<TlsAcceptor> = match tls {
        Some(input) => Some(build_tls_acceptor(input)?),
        None => None,
    };

    let addrs = resolve_bind_addrs(&host, port)?;
    let mut std_listener = None;
    let mut last_err = None;
    for addr in addrs {
        match bind_reusable_listener(addr) {
            Ok(l) => {
                std_listener = Some(l);
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }
    let std_listener = std_listener
        .ok_or_else(|| last_err.unwrap_or_else(|| format!("Failed to bind to '{host}:{port}'")))?;
    let local_addr = std_listener
        .local_addr()
        .map_err(|e| format!("Failed to get local_addr: {e}"))?;

    let shutdown_bus = ShutdownBus::new(32);
    let (accept_done_tx, accept_done_rx) = watch::channel(false);
    let conn_sem = shared
        .config
        .max_connections_limit()
        .map(|n| Arc::new(Semaphore::new(n)));

    get_io_runtime().spawn(accept_loop(
        std_listener,
        shared.clone(),
        shutdown_bus.clone(),
        tls_acceptor,
        conn_sem,
        accept_done_tx,
    ));

    Ok(RunningServer {
        local_addr,
        shutdown_bus,
        accept_done_rx,
        shared,
    })
}

/// Accepts until the shutdown bus leaves state 0, then closes the listener and reports it.
async fn accept_loop(
    std_listener: std::net::TcpListener,
    shared: Arc<ServerShared>,
    bus: ShutdownBus,
    tls_acceptor: Option<TlsAcceptor>,
    conn_sem: Option<Arc<Semaphore>>,
    accept_done_tx: watch::Sender<bool>,
) {
    let listener = match TcpListener::from_std(std_listener) {
        Ok(l) => l,
        Err(_) => {
            let _ = accept_done_tx.send(true);
            return;
        }
    };
    let reject_tasks = Arc::new(AtomicUsize::new(0));

    let mut backoff_ms: u64 = 10;
    let mut conn_seq: usize = 0;
    let accept_shard = bus.shard(0);
    let accept_shutdown_fut = accept_shard.notified();
    tokio::pin!(accept_shutdown_fut);
    let _ = accept_shutdown_fut.as_mut().enable();

    loop {
        if bus.state() >= 1 {
            break;
        }
        tokio::select! {
            biased;
            _ = accept_shutdown_fut.as_mut() => {
                accept_shutdown_fut.set(accept_shard.notified());
                let _ = accept_shutdown_fut.as_mut().enable();
                if bus.state() >= 1 {
                    break;
                }
            }
            accept_res = listener.accept() => {
                match accept_res {
                    Ok((stream, peer_addr)) => {
                        backoff_ms = 10;
                        let _ = stream.set_nodelay(true);

                        let permit = if let Some(ref sem) = conn_sem {
                            match sem.clone().try_acquire_owned() {
                                Ok(p) => Some(p),
                                Err(_) => {
                                    reject_over_limit(
                                        &shared,
                                        stream,
                                        tls_acceptor.is_some(),
                                        &reject_tasks,
                                    );
                                    continue;
                                }
                            }
                        } else {
                            None
                        };

                        conn_seq = conn_seq.wrapping_add(1);
                        spawn_connection(
                            stream,
                            peer_addr,
                            &shared,
                            &bus,
                            tls_acceptor.clone(),
                            permit,
                            conn_seq,
                        );
                    }
                    Err(e) => {
                        let wait = match accept_backoff_for_error(&e, backoff_ms) {
                            AcceptErrorAction::RetryImmediately => continue,
                            AcceptErrorAction::Backoff { wait, next_ms } => {
                                backoff_ms = next_ms;
                                wait
                            }
                        };
                        backoff_sleep(wait, &bus, accept_shard, &mut accept_shutdown_fut).await;
                        if bus.state() >= 1 {
                            break;
                        }
                    }
                }
            }
        }
    }

    drop(listener);
    let _ = accept_done_tx.send(true);
}

/// Sleep after an accept error (EMFILE...), waking early on shutdown.
async fn backoff_sleep<'a>(
    wait: Duration,
    bus: &ShutdownBus,
    accept_shard: &'a Notify,
    accept_shutdown_fut: &mut Pin<&mut Notified<'a>>,
) {
    let sleep = tokio::time::sleep(wait);
    tokio::pin!(sleep);
    loop {
        if bus.state() >= 1 {
            break;
        }
        tokio::select! {
            biased;
            _ = accept_shutdown_fut.as_mut() => {
                accept_shutdown_fut.set(accept_shard.notified());
                let _ = accept_shutdown_fut.as_mut().enable();
                if bus.state() >= 1 {
                    break;
                }
            }
            _ = &mut sleep => break,
        }
    }
}

/// Over `maxConnections`: count it and (plain TCP, bounded number of tasks) answer 503 before
/// closing, draining a little input so the response is not lost to an RST.
fn reject_over_limit(
    shared: &ServerShared,
    mut stream: TcpStream,
    is_tls: bool,
    reject_tasks: &Arc<AtomicUsize>,
) {
    shared
        .metrics
        .rejected_connections
        .fetch_add(1, Ordering::Relaxed);
    if is_tls || reject_tasks.load(Ordering::Relaxed) >= 256 {
        return;
    }
    let tasks_ctr = reject_tasks.clone();
    let xpb = shared.config.x_powered_by;
    tasks_ctr.fetch_add(1, Ordering::Relaxed);
    tokio::spawn(async move {
        struct DropCounter(Arc<AtomicUsize>);
        impl Drop for DropCounter {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::Relaxed);
            }
        }
        let _counter = DropCounter(tasks_ctr);
        let bytes = build_simple_raw_response(503, xpb, true);
        let _ = tokio::time::timeout(Duration::from_millis(500), async {
            if stream.write_all(&bytes).await.is_ok() {
                let _ = stream.flush().await;
                let _ = stream.shutdown().await;
                let _ = tokio::time::timeout(Duration::from_millis(200), async {
                    let mut drain_buf = [0u8; 1024];
                    let mut drained = 0usize;
                    while drained < 16_384 {
                        match stream.read(&mut drain_buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => drained += n,
                        }
                    }
                })
                .await;
            }
        })
        .await;
    });
}

fn spawn_connection(
    stream: TcpStream,
    peer_addr: SocketAddr,
    shared: &Arc<ServerShared>,
    bus: &ShutdownBus,
    acceptor: Option<TlsAcceptor>,
    permit: Option<OwnedSemaphorePermit>,
    shard_idx: usize,
) {
    let shared_conn = shared.clone();
    shared_conn
        .active_connections
        .fetch_add(1, Ordering::AcqRel);
    let guard = ConnectionGuard {
        shared: shared_conn.clone(),
    };
    let peer_ip: Arc<str> = Arc::from(peer_addr.ip().to_string());
    let bus_conn = bus.clone();

    tokio::spawn(async move {
        let _permit = permit;
        let _guard = guard;
        let shard = bus_conn.shard(shard_idx);
        let shutdown_fut = shard.notified();
        tokio::pin!(shutdown_fut);
        let _ = shutdown_fut.as_mut().enable();

        if let Some(tls_acc) = acceptor {
            if bus_conn.state() >= 1 {
                return;
            }
            let Some(tls_stream) = tls_handshake(
                tls_acc,
                stream,
                &shared_conn,
                &bus_conn,
                shard,
                &mut shutdown_fut,
            )
            .await
            else {
                return;
            };
            handle_connection(
                tls_stream,
                shared_conn,
                peer_ip,
                true,
                &bus_conn,
                shard,
                &mut shutdown_fut,
            )
            .await;
        } else {
            handle_connection(
                stream,
                shared_conn,
                peer_ip,
                false,
                &bus_conn,
                shard,
                &mut shutdown_fut,
            )
            .await;
        }
    });
}

/// TLS handshake bounded by `tlsHandshakeTimeout` (when set) and by shutdown. `None` = drop
/// the connection (handshake error, timeout or shutdown; the first two are counted).
async fn tls_handshake<'a>(
    tls_acc: TlsAcceptor,
    stream: TcpStream,
    shared: &ServerShared,
    bus: &ShutdownBus,
    shard: &'a Notify,
    shutdown_fut: &mut Pin<&mut Notified<'a>>,
) -> Option<TlsStream<TcpStream>> {
    let hs_timeout = shared.config.tls_handshake_timeout();
    let accept_fut = tls_acc.accept(stream);
    tokio::pin!(accept_fut);

    if let Some(dur) = hs_timeout {
        let hs_sleep = tokio::time::sleep(dur);
        tokio::pin!(hs_sleep);
        loop {
            tokio::select! {
                biased;
                res = &mut accept_fut => match res {
                    Ok(s) => return Some(s),
                    Err(_) => {
                        shared.metrics.tls_handshake_errors.fetch_add(1, Ordering::Relaxed);
                        return None;
                    }
                },
                _ = &mut hs_sleep => {
                    shared.metrics.tls_handshake_timeouts.fetch_add(1, Ordering::Relaxed);
                    return None;
                }
                _ = shutdown_fut.as_mut() => {
                    shutdown_fut.set(shard.notified());
                    let _ = shutdown_fut.as_mut().enable();
                    if bus.state() >= 1 {
                        return None;
                    }
                }
            }
        }
    } else {
        loop {
            if bus.state() >= 1 {
                return None;
            }
            tokio::select! {
                biased;
                res = &mut accept_fut => match res {
                    Ok(s) => return Some(s),
                    Err(_) => {
                        shared.metrics.tls_handshake_errors.fetch_add(1, Ordering::Relaxed);
                        return None;
                    }
                },
                _ = shutdown_fut.as_mut() => {
                    shutdown_fut.set(shard.notified());
                    let _ = shutdown_fut.as_mut().enable();
                    if bus.state() >= 1 {
                        return None;
                    }
                }
            }
        }
    }
}

pub async fn drain_server(
    shared: Arc<ServerShared>,
    mut accept_done_rx: watch::Receiver<bool>,
    shutdown_bus: ShutdownBus,
    timeout: Duration,
) {
    let deadline = Instant::now() + timeout;

    loop {
        if !*accept_done_rx.borrow() {
            let rem = deadline.saturating_duration_since(Instant::now());
            if rem.is_zero() {
                break;
            }
            let _ = tokio::time::timeout(rem, accept_done_rx.changed()).await;
            continue;
        }

        let notified = shared.drain_notify.notified();
        if shared.active_connections.load(Ordering::Acquire) == 0 {
            return;
        }
        let rem = deadline.saturating_duration_since(Instant::now());
        if rem.is_zero() {
            break;
        }
        if tokio::time::timeout(rem, notified).await.is_err() {
            break;
        }
    }

    if shared.active_connections.load(Ordering::Acquire) > 0 {
        shared.is_closed.store(true, Ordering::Release);
        shutdown_bus.send_state(2);
        let _ = tokio::time::timeout(Duration::from_millis(100), async {
            loop {
                let notified = shared.drain_notify.notified();
                if shared.active_connections.load(Ordering::Acquire) == 0 {
                    break;
                }
                notified.await;
            }
        })
        .await;
    }

    if !*accept_done_rx.borrow() {
        let _ = tokio::time::timeout(Duration::from_millis(100), async {
            while !*accept_done_rx.borrow() {
                if accept_done_rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_util::make_test_shared;
    use super::*;
    use crate::config::EngineConfig;
    use tokio::io::AsyncBufReadExt;

    #[test]
    fn resolve_bind_addrs_supports_localhost_and_rejects_invalid() {
        let addrs = resolve_bind_addrs("localhost", 8080).unwrap();
        assert!(!addrs.is_empty());
        assert_eq!(addrs[0].port(), 8080);

        let ip_addrs = resolve_bind_addrs("127.0.0.1", 0).unwrap();
        assert_eq!(ip_addrs.len(), 1);

        assert!(resolve_bind_addrs("invalid.host.that.does.not.exist.localdomain", 80).is_err());
    }

    #[tokio::test]
    async fn graceful_shutdown_closes_idle_keepalive_and_drains_listener() {
        let cfg = EngineConfig {
            keep_alive_timeout_ms: 60_000,
            ..EngineConfig::default()
        };
        let shared = make_test_shared(cfg);
        let running = start_http_server_sync("127.0.0.1".into(), 0, shared.clone(), None).unwrap();
        let addr = running.local_addr;

        // Open an idle client socket and send nothing (Keep-Alive/pre-request idle)
        let _client = tokio::net::TcpStream::connect(addr).await.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(shared.active_connections.load(Ordering::Acquire), 1);

        shared.draining.store(true, Ordering::Release);
        running.shutdown_bus.send_state(1);
        drain_server(
            shared.clone(),
            running.accept_done_rx,
            running.shutdown_bus,
            Duration::from_secs(2),
        )
        .await;

        assert_eq!(shared.active_connections.load(Ordering::Acquire), 0);
        // Listener must be closed so rebinding same port succeeds immediately
        let rebound = bind_reusable_listener(addr);
        assert!(rebound.is_ok(), "rebind failed: {:?}", rebound.err());
    }

    #[tokio::test]
    async fn max_connections_rejects_excess_with_503() {
        let cfg = EngineConfig {
            max_connections: 1,
            ..EngineConfig::default()
        };
        let shared = make_test_shared(cfg);
        let running = start_http_server_sync("127.0.0.1".into(), 0, shared.clone(), None).unwrap();
        let addr = running.local_addr;

        let _c1 = tokio::net::TcpStream::connect(addr).await.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;

        let mut c2 = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut reader = tokio::io::BufReader::new(&mut c2);
        let mut status_line = String::new();
        reader.read_line(&mut status_line).await.unwrap();
        assert!(
            status_line.starts_with("HTTP/1.1 503"),
            "expected 503, got: {status_line}"
        );
        assert!(shared.metrics.rejected_connections.load(Ordering::Relaxed) >= 1);

        shared.draining.store(true, Ordering::Release);
        running.shutdown_bus.send_state(1);
        drain_server(
            shared,
            running.accept_done_rx,
            running.shutdown_bus,
            Duration::from_secs(1),
        )
        .await;
    }

    #[tokio::test]
    async fn tls_handshake_timeout_closes_stalled_client_and_increments_metric() {
        let cfg = EngineConfig {
            tls_handshake_timeout_ms: 60,
            ..EngineConfig::default()
        };
        let shared = make_test_shared(cfg);
        let tls = TlsInput {
            cert_pem: crate::tls::test_pems::TEST_CERT_PEM.to_vec(),
            key_pem: crate::tls::test_pems::TEST_KEY_PEM.to_vec(),
        };
        let running =
            start_http_server_sync("127.0.0.1".into(), 0, shared.clone(), Some(tls)).unwrap();
        let addr = running.local_addr;

        // Connect raw TCP and send no TLS ClientHello
        let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut buf = [0u8; 16];
        let n = tokio::time::timeout(Duration::from_secs(2), client.read(&mut buf))
            .await
            .expect("client should see EOF after tls handshake timeout")
            .unwrap_or(0);
        assert_eq!(n, 0);
        assert!(
            shared
                .metrics
                .tls_handshake_timeouts
                .load(Ordering::Relaxed)
                >= 1
        );

        shared.draining.store(true, Ordering::Release);
        running.shutdown_bus.send_state(1);
        drain_server(
            shared,
            running.accept_done_rx,
            running.shutdown_bus,
            Duration::from_secs(1),
        )
        .await;
    }

    #[test]
    fn accept_backoff_skips_transient_and_escalates_emfile_enfile() {
        use std::io::{Error, ErrorKind};

        for kind in [
            ErrorKind::ConnectionAborted,
            ErrorKind::ConnectionReset,
            ErrorKind::Interrupted,
        ] {
            let err = Error::new(kind, "transient");
            assert_eq!(
                accept_backoff_for_error(&err, 10),
                AcceptErrorAction::RetryImmediately
            );
        }

        #[cfg(unix)]
        let emfile = Error::from_raw_os_error(24); // EMFILE
        #[cfg(not(unix))]
        let emfile = Error::new(ErrorKind::Other, "EMFILE");

        let mut backoff = 10u64;
        for expected in [10u64, 20, 50, 100, 200, 200] {
            match accept_backoff_for_error(&emfile, backoff) {
                AcceptErrorAction::Backoff { wait, next_ms } => {
                    assert_eq!(wait, Duration::from_millis(expected));
                    backoff = next_ms;
                }
                AcceptErrorAction::RetryImmediately => panic!("expected backoff for EMFILE"),
            }
        }

        #[cfg(unix)]
        {
            let enfile = Error::from_raw_os_error(23); // ENFILE
            assert_eq!(
                accept_backoff_for_error(&enfile, 10),
                AcceptErrorAction::Backoff {
                    wait: Duration::from_millis(10),
                    next_ms: 20,
                }
            );
        }
    }

    #[tokio::test]
    async fn force_close_drains_listener_and_idle_connections_for_immediate_rebind() {
        let cfg = EngineConfig {
            keep_alive_timeout_ms: 60_000,
            ..EngineConfig::default()
        };
        let shared = make_test_shared(cfg);
        let mut running =
            start_http_server_sync("127.0.0.1".into(), 0, shared.clone(), None).unwrap();
        let addr = running.local_addr;

        let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(shared.active_connections.load(Ordering::Acquire), 1);

        running.force_close();
        running.force_close(); // idempotent

        let mut accept_done_rx = running.accept_done_rx.clone();
        let accept_closed = tokio::time::timeout(Duration::from_secs(2), async {
            while !*accept_done_rx.borrow() {
                if accept_done_rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
        assert!(
            accept_closed.is_ok(),
            "accept loop did not exit on force_close"
        );

        let mut buf = [0u8; 16];
        let client_closed =
            tokio::time::timeout(Duration::from_secs(2), client.read(&mut buf)).await;
        assert!(
            client_closed.is_ok(),
            "idle client did not close on force_close"
        );

        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(shared.active_connections.load(Ordering::Acquire), 0);
        assert!(bind_reusable_listener(addr).is_ok());
    }
}
