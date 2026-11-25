//! Wire protocol between the Rust engine and the JS layer, plus raw HTTP/1.1 response helpers.
//!
//! - `request`: Rust -> JS request encoding (`PendingRequest`).
//! - `batch`: JS -> Rust response batch decoding (`dispatch_response_batch`).
//! - `validate`: header/status/reason validators.
//! - `raw_response`: reason phrases, pre-built responses, `Connection` header helpers.

mod batch;
mod raw_response;
mod request;
mod validate;

pub use batch::{
    dispatch_response_batch, CT_HTML, CT_JSON, CT_OCTET_STREAM, CT_TEXT_PLAIN, RESP_FLAG_FILE_META,
    RESP_FLAG_IS_FILE, RESP_FLAG_SEND, RESP_FLAG_SUPPRESS_ETAG, RESP_FLAG_SUPPRESS_POWERED_BY,
};
pub use raw_response::{
    append_raw_http_with_close, append_raw_http_with_connection, build_simple_raw_response,
    push_connection_header, reason_for, set_http10_keep_alive, status_reason, HTTP10_KEEP_ALIVE,
};
pub use request::PendingRequest;
pub use validate::{
    content_length_matches, is_reason_header, is_valid_header_name, is_valid_header_value,
    is_valid_response_header, is_valid_status,
};
