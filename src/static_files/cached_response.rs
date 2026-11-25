use super::cache::CacheSlot;
use super::conditional::{
    append_304, append_416, append_cache_control, etag_matches, http_date_not_modified,
    if_range_matches, parse_single_range, RangeParseResult,
};
use super::mount::StaticMount;
use crate::date::write_date_header;

impl StaticMount {
    #[allow(clippy::too_many_arguments)]
    #[inline]
    pub(super) fn append_cached_slot(
        &self,
        slot: &CacheSlot,
        out_buf: &mut Vec<u8>,
        is_head: bool,
        if_none_match: Option<&str>,
        if_modified_since: Option<&str>,
        range_header: Option<&str>,
        if_range: Option<&str>,
        x_powered_by: bool,
        close_conn: bool,
    ) {
        if let (Some(ref etag), Some(inm)) = (&slot.etag, if_none_match) {
            if etag_matches(inm, etag) {
                append_304(
                    out_buf,
                    Some(etag),
                    slot.last_modified.as_deref(),
                    x_powered_by,
                    close_conn,
                );
                return;
            }
        } else if let (Some(ref lm), Some(ims)) = (&slot.last_modified, if_modified_since) {
            if http_date_not_modified(ims, lm) {
                append_304(
                    out_buf,
                    slot.etag.as_deref(),
                    Some(lm),
                    x_powered_by,
                    close_conn,
                );
                return;
            }
        }

        if let Some(rh) = range_header {
            if self.append_cached_range(
                slot,
                out_buf,
                is_head,
                rh,
                if_range,
                x_powered_by,
                close_conn,
            ) {
                return;
            }
        }

        out_buf.extend_from_slice(&slot.header_prefix);
        crate::protocol::push_connection_header(out_buf, close_conn);
        write_date_header(out_buf);
        out_buf.extend_from_slice(b"\r\n");
        if !is_head {
            out_buf.extend_from_slice(&slot.body);
        }
    }

    /// Serves a `Range` request from a cached slot (206 or 416). Returns `false` when the range
    /// is ignored (`If-Range` mismatch or unparsable header) and the full response applies.
    #[allow(clippy::too_many_arguments)]
    #[inline]
    fn append_cached_range(
        &self,
        slot: &CacheSlot,
        out_buf: &mut Vec<u8>,
        is_head: bool,
        rh: &str,
        if_range: Option<&str>,
        x_powered_by: bool,
        close_conn: bool,
    ) -> bool {
        let allow_range = match if_range {
            Some(ir) => if_range_matches(ir, slot.etag.as_deref(), slot.last_modified.as_deref()),
            None => true,
        };
        if !allow_range {
            return false;
        }
        let file_size = slot.body.len() as u64;
        match parse_single_range(rh, file_size) {
            RangeParseResult::Satisfiable(start, end) => {
                let content_len = end - start + 1;
                let mut nb = itoa::Buffer::new();
                out_buf.extend_from_slice(b"HTTP/1.1 206 Partial Content\r\nContent-Type: ");
                out_buf.extend_from_slice(slot.content_type.as_bytes());
                out_buf.extend_from_slice(b"\r\nAccept-Ranges: bytes\r\nContent-Length: ");
                out_buf.extend_from_slice(nb.format(content_len).as_bytes());
                out_buf.extend_from_slice(b"\r\nContent-Range: bytes ");
                out_buf.extend_from_slice(nb.format(start).as_bytes());
                out_buf.push(b'-');
                out_buf.extend_from_slice(nb.format(end).as_bytes());
                out_buf.push(b'/');
                out_buf.extend_from_slice(nb.format(file_size).as_bytes());
                out_buf.extend_from_slice(b"\r\n");
                if let Some(ref et) = slot.etag {
                    out_buf.extend_from_slice(b"ETag: ");
                    out_buf.extend_from_slice(et.as_bytes());
                    out_buf.extend_from_slice(b"\r\n");
                }
                if let Some(ref lm) = slot.last_modified {
                    out_buf.extend_from_slice(b"Last-Modified: ");
                    out_buf.extend_from_slice(lm.as_bytes());
                    out_buf.extend_from_slice(b"\r\n");
                }
                append_cache_control(out_buf, self.max_age_secs, self.immutable);
                if x_powered_by {
                    out_buf.extend_from_slice(b"X-Powered-By: Express\r\n");
                }
                crate::protocol::push_connection_header(out_buf, close_conn);
                write_date_header(out_buf);
                out_buf.extend_from_slice(b"\r\n");
                if !is_head {
                    out_buf.extend_from_slice(&slot.body[start as usize..=(end as usize)]);
                }
                true
            }
            RangeParseResult::Unsatisfiable => {
                append_416(out_buf, file_size, x_powered_by, close_conn);
                true
            }
            RangeParseResult::Ignore => false,
        }
    }
}
