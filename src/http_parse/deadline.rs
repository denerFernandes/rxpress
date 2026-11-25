//! Deadline-armed socket reads shared by the head and body readers.
use super::body::ExactBodyError;
use bytes::BytesMut;
use std::pin::Pin;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::futures::Notified;
use tokio::sync::Notify;
use tokio::time::{Instant, Sleep};

#[inline]
pub fn arm_deadline(
    sleep: &mut Pin<&mut Sleep>,
    armed_until: &mut Option<Instant>,
    target: Option<Instant>,
    phase_dur: Duration,
) {
    let slack = phase_dur.div_f32(5.0).min(Duration::from_millis(10_000));
    arm_deadline_with_slack(sleep, armed_until, target, slack);
}

#[inline]
pub fn arm_deadline_with_slack(
    sleep: &mut Pin<&mut Sleep>,
    armed_until: &mut Option<Instant>,
    target: Option<Instant>,
    slack: Duration,
) {
    let Some(t) = target else {
        return;
    };
    let desired = t + slack;
    let should_reset = match *armed_until {
        None => true,
        Some(armed) => sleep.is_elapsed() || t > armed || desired < armed,
    };
    if should_reset {
        sleep.as_mut().reset(desired);
        *armed_until = Some(desired);
    }
}

#[inline]
#[allow(clippy::too_many_arguments)]
pub async fn read_buf_timed<'a, S: AsyncRead + Unpin>(
    stream: &mut S,
    read_buf: &mut BytesMut,
    deadline: Option<Instant>,
    sleep: &mut Pin<&mut Sleep>,
    armed_until: &mut Option<Instant>,
    shutdown_state: &AtomicU8,
    shutdown_shard: &'a Notify,
    shutdown_fut: &mut Pin<&mut Notified<'a>>,
) -> Result<usize, ExactBodyError> {
    if shutdown_state.load(Ordering::Acquire) >= 2 {
        return Err(ExactBodyError::Shutdown);
    }

    let Some(dl) = deadline else {
        loop {
            tokio::select! {
                biased;
                _ = shutdown_fut.as_mut() => {
                    shutdown_fut.set(shutdown_shard.notified());
                    let _ = shutdown_fut.as_mut().enable();
                    if shutdown_state.load(Ordering::Acquire) >= 2 {
                        return Err(ExactBodyError::Shutdown);
                    }
                }
                res = stream.read_buf(read_buf) => {
                    return match res {
                        Ok(0) => Err(ExactBodyError::Eof),
                        Ok(n) => Ok(n),
                        Err(_) => Err(ExactBodyError::Io),
                    };
                }
            }
        }
    };

    loop {
        if shutdown_state.load(Ordering::Acquire) >= 2 {
            return Err(ExactBodyError::Shutdown);
        }
        if Instant::now() >= dl {
            return Err(ExactBodyError::Timeout);
        }
        arm_deadline_with_slack(sleep, armed_until, Some(dl), Duration::ZERO);
        tokio::select! {
            biased;
            _ = shutdown_fut.as_mut() => {
                shutdown_fut.set(shutdown_shard.notified());
                let _ = shutdown_fut.as_mut().enable();
                if shutdown_state.load(Ordering::Acquire) >= 2 {
                    return Err(ExactBodyError::Shutdown);
                }
            }
            res = stream.read_buf(read_buf) => {
                return match res {
                    Ok(0) => Err(ExactBodyError::Eof),
                    Ok(n) => {
                        if Instant::now() >= dl {
                            Err(ExactBodyError::Timeout)
                        } else {
                            Ok(n)
                        }
                    }
                    Err(_) => Err(ExactBodyError::Io),
                };
            }
            _ = sleep.as_mut() => {
                *armed_until = None;
                if Instant::now() >= dl {
                    return Err(ExactBodyError::Timeout);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_buf_timed_aborts_on_forced_shutdown_in_timed_and_untimed_modes() {
        use std::sync::Arc;

        let sleep = tokio::time::sleep(Duration::from_secs(60));
        tokio::pin!(sleep);
        let mut armed = None;

        // 1. Timed mode: state=1 (graceful drain) does NOT abort; state=2 (forced shutdown) aborts immediately
        let state = Arc::new(AtomicU8::new(0));
        let shard = Arc::new(Notify::new());
        let shutdown_fut = shard.notified();
        tokio::pin!(shutdown_fut);
        let _ = shutdown_fut.as_mut().enable();

        let (_c1, mut s1) = tokio::io::duplex(1024);
        let mut b1 = BytesMut::new();
        let state_bg = state.clone();
        let shard_bg = shard.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(15)).await;
            state_bg.store(1, Ordering::Release);
            shard_bg.notify_waiters();
            tokio::time::sleep(Duration::from_millis(20)).await;
            state_bg.store(2, Ordering::Release);
            shard_bg.notify_waiters();
        });

        let res1 = tokio::time::timeout(
            Duration::from_secs(1),
            read_buf_timed(
                &mut s1,
                &mut b1,
                Some(Instant::now() + Duration::from_secs(30)),
                &mut sleep,
                &mut armed,
                &state,
                &shard,
                &mut shutdown_fut,
            ),
        )
        .await
        .expect("timed read_buf_timed should abort promptly on state=2");
        assert!(matches!(res1, Err(ExactBodyError::Shutdown)));

        // 2. Untimed mode (deadline = None): state=2 also aborts immediately
        let state2 = Arc::new(AtomicU8::new(0));
        let shard2 = Arc::new(Notify::new());
        let shutdown_fut2 = shard2.notified();
        tokio::pin!(shutdown_fut2);
        let _ = shutdown_fut2.as_mut().enable();

        let (_c2, mut s2) = tokio::io::duplex(1024);
        let mut b2 = BytesMut::new();
        let state2_bg = state2.clone();
        let shard2_bg = shard2.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(15)).await;
            state2_bg.store(2, Ordering::Release);
            shard2_bg.notify_waiters();
        });

        let res2 = tokio::time::timeout(
            Duration::from_secs(1),
            read_buf_timed(
                &mut s2,
                &mut b2,
                None,
                &mut sleep,
                &mut armed,
                &state2,
                &shard2,
                &mut shutdown_fut2,
            ),
        )
        .await
        .expect("untimed read_buf_timed should abort promptly on state=2");
        assert!(matches!(res2, Err(ExactBodyError::Shutdown)));
    }
}
