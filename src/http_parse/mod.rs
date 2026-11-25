//! HTTP/1.x request parsing: request head ([`head`]), message bodies ([`body`]) and the
//! deadline-armed reads both are built on ([`deadline`]).
mod body;
mod deadline;
mod head;

pub(crate) use body::{find_crlf_bounded, parse_chunk_size_line};
pub use body::{
    read_chunked_body, read_exact_body, ChunkedError, ExactBodyError, DEFAULT_MAX_CHUNK_LINE,
    DEFAULT_MAX_TRAILER_BYTES, DEFAULT_MAX_TRAILER_COUNT,
};
pub use deadline::{arm_deadline, arm_deadline_with_slack, read_buf_timed};
#[allow(unused_imports)] // `ParsedMeta` is named only through field access today.
pub use head::ParsedMeta;
pub use head::{try_parse_request, ParseOutcome};
