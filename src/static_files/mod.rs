use crate::date::write_date_header;
use crate::protocol::status_reason;
use tokio::io::{AsyncWrite, AsyncWriteExt};

mod cache;
mod cached_response;
mod conditional;
mod content_type;
mod file_response;
mod miss;
mod mount;
mod redirect;
mod resolve;
mod sendfile;

// Re-exports keep every pre-split `crate::static_files::X` path valid, even those the crate
// itself does not currently import.
#[allow(unused_imports)]
pub use conditional::{etag_matches, if_range_matches, parse_single_range, RangeParseResult};
#[allow(unused_imports)]
pub use file_response::write_file_response_from_open;
pub use mount::StaticMount;
#[allow(unused_imports)]
pub use sendfile::{decode_sendfile_payload, serve_sendfile, SendFileRequest};

#[derive(Debug)]
pub enum FileServeError {
    /// Error detected before any bytes were written to socket; safe for fallthrough or 400/403/404 status.
    PreHeader(u16),
    /// Error during/after writing response headers/body; caller MUST close socket immediately.
    StreamAborted(std::io::Error),
}

impl From<std::io::Error> for FileServeError {
    fn from(err: std::io::Error) -> Self {
        Self::StreamAborted(err)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DotfilesPolicy {
    Ignore,
    Allow,
    Deny,
}

impl DotfilesPolicy {
    pub fn from_str(s: &str) -> Self {
        match s {
            "allow" => Self::Allow,
            "deny" => Self::Deny,
            _ => Self::Ignore,
        }
    }
}

pub async fn write_simple_status<W: AsyncWrite + Unpin>(
    writer: &mut W,
    write_buf: &mut Vec<u8>,
    status: u16,
    is_head: bool,
    x_powered_by: bool,
    close_conn: bool,
) -> std::io::Result<()> {
    let reason = status_reason(status);
    write_buf.clear();
    let mut nb = itoa::Buffer::new();
    write_buf.extend_from_slice(b"HTTP/1.1 ");
    write_buf.extend_from_slice(nb.format(status).as_bytes());
    write_buf.push(b' ');
    write_buf.extend_from_slice(reason.as_bytes());
    write_buf.extend_from_slice(b"\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ");
    write_buf.extend_from_slice(nb.format(reason.len()).as_bytes());
    write_buf.extend_from_slice(b"\r\n");
    if x_powered_by {
        write_buf.extend_from_slice(b"X-Powered-By: Express\r\n");
    }
    crate::protocol::push_connection_header(write_buf, close_conn);
    write_date_header(write_buf);
    write_buf.extend_from_slice(b"\r\n");
    if !is_head {
        write_buf.extend_from_slice(reason.as_bytes());
    }
    writer.write_all(write_buf).await
}

#[cfg(test)]
mod test_util {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(1);

    pub(super) fn make_temp_dir(name: &str) -> PathBuf {
        let n = TEST_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "rxpress-static-test-{name}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
