//! Rust -> JS request encoding: `PendingRequest` and its packed wire layout.

use crate::body::BodyMode;
use crate::router::MethodCode;
use bytes::Bytes;
use std::sync::Arc;

pub const MAX_IPC_REQUEST_SIZE: usize = 0x7FFF_FFFF - 64;

pub struct PendingRequest {
    pub req_id: u32,
    pub route_id: i32,
    pub method: MethodCode,
    pub method_str: Option<String>,
    pub is_tls: bool,
    pub body_mode: BodyMode,
    pub raw_url: Bytes,
    pub path_len: u32,
    pub remote_addr: Arc<str>,
    pub params: Vec<(String, String)>,
    pub raw_headers: Bytes,
    pub body: Bytes,
    /// The connection was handed to JS for an `'upgrade'` event (flag 0x04).
    pub upgrade: bool,
}

impl PendingRequest {
    #[inline]
    pub fn validated_encoded_size(&self) -> Option<usize> {
        if self.method == MethodCode::Other
            && self.method_str.as_deref().map_or(0, |s| s.len()) > u16::MAX as usize
        {
            return None;
        }
        if self.raw_url.len() > u32::MAX as usize
            || self.remote_addr.len() > u16::MAX as usize
            || self.params.len() > u16::MAX as usize
            || self.raw_headers.len() > u32::MAX as usize
            || self.body.len() > u32::MAX as usize
        {
            return None;
        }
        let mut sz: usize = 12; // req_id(4) + route_id(4) + method(1) + flags(1) + body_mode(1) + reserved(1)
        if self.method == MethodCode::Other {
            sz = sz.checked_add(2 + self.method_str.as_deref().map_or(0, |s| s.len()))?;
        }
        sz = sz
            .checked_add(4)?
            .checked_add(self.raw_url.len())?
            .checked_add(4)?;
        sz = sz.checked_add(2)?.checked_add(self.remote_addr.len())?;
        sz = sz.checked_add(4)?; // params_block_len
        if !self.params.is_empty() {
            let mut params_block_len: usize = 2;
            for (k, v) in &self.params {
                if k.len() > u16::MAX as usize || v.len() > u16::MAX as usize {
                    return None;
                }
                params_block_len = params_block_len
                    .checked_add(4)?
                    .checked_add(k.len())?
                    .checked_add(v.len())?;
            }
            if params_block_len > u32::MAX as usize {
                return None;
            }
            sz = sz.checked_add(params_block_len)?;
        }
        sz = sz.checked_add(4)?.checked_add(self.raw_headers.len())?;
        sz = sz.checked_add(4)?.checked_add(self.body.len())?;
        if sz <= MAX_IPC_REQUEST_SIZE {
            Some(sz)
        } else {
            None
        }
    }

    #[inline]
    pub fn can_encode(&self) -> bool {
        self.validated_encoded_size().is_some()
    }

    #[cfg(test)]
    #[inline]
    pub fn encoded_size(&self) -> usize {
        let mut sz: usize = 12; // req_id(4) + route_id(4) + method(1) + flags(1) + body_mode(1) + reserved(1)
        if self.method == MethodCode::Other {
            sz = sz.saturating_add(2 + self.method_str.as_deref().map_or(0, |s| s.len()));
        }
        sz = sz.saturating_add(4 + self.raw_url.len() + 4); // raw_url + path_len
        sz = sz.saturating_add(2 + self.remote_addr.len()); // remote_addr
        sz = sz.saturating_add(4); // params_block_len
        if !self.params.is_empty() {
            sz = sz.saturating_add(2);
            for (k, v) in &self.params {
                sz = sz.saturating_add(4 + k.len() + v.len());
            }
        }
        sz = sz.saturating_add(4 + self.raw_headers.len()); // raw_headers_len + raw HTTP header lines
        sz = sz.saturating_add(4 + self.body.len()); // body_len + body
        sz
    }

    #[cfg(test)]
    #[inline]
    pub fn try_encode_into(&self, dst: &mut [u8], pos: &mut usize) -> Result<(), ()> {
        let Some(needed) = self.validated_encoded_size() else {
            return Err(());
        };
        self.encode_with_size_into(needed, dst, pos)
    }

    #[inline]
    pub fn encode_with_size_into(
        &self,
        needed: usize,
        dst: &mut [u8],
        pos: &mut usize,
    ) -> Result<(), ()> {
        if dst.len().saturating_sub(*pos) < needed {
            return Err(());
        }
        let mut p = *pos;

        dst[p..p + 4].copy_from_slice(&self.req_id.to_le_bytes());
        p += 4;
        dst[p..p + 4].copy_from_slice(&self.route_id.to_le_bytes());
        p += 4;

        let flags: u8 = (if self.is_tls { 0x01 } else { 0 })
            | (if !self.body.is_empty() { 0x02 } else { 0 })
            | (if self.upgrade { 0x04 } else { 0 });
        dst[p] = self.method as u8;
        dst[p + 1] = flags;
        dst[p + 2] = self.body_mode as u8;
        dst[p + 3] = 0;
        p += 4;

        if self.method == MethodCode::Other {
            let mb = self.method_str.as_deref().unwrap_or("").as_bytes();
            let mlen = u16::try_from(mb.len()).map_err(|_| ())?;
            dst[p..p + 2].copy_from_slice(&mlen.to_le_bytes());
            p += 2;
            dst[p..p + mb.len()].copy_from_slice(mb);
            p += mb.len();
        }

        // raw_url + path_len
        let ulen = u32::try_from(self.raw_url.len()).map_err(|_| ())?;
        dst[p..p + 4].copy_from_slice(&ulen.to_le_bytes());
        p += 4;
        dst[p..p + self.raw_url.len()].copy_from_slice(&self.raw_url);
        p += self.raw_url.len();
        dst[p..p + 4].copy_from_slice(&self.path_len.to_le_bytes());
        p += 4;

        // remote_addr
        let ab = self.remote_addr.as_bytes();
        let alen = u16::try_from(ab.len()).map_err(|_| ())?;
        dst[p..p + 2].copy_from_slice(&alen.to_le_bytes());
        p += 2;
        dst[p..p + ab.len()].copy_from_slice(ab);
        p += ab.len();

        // params block
        if self.params.is_empty() {
            dst[p..p + 4].copy_from_slice(&0u32.to_le_bytes());
            p += 4;
        } else {
            let len_pos = p;
            p += 4;
            let start = p;
            let pcount = u16::try_from(self.params.len()).map_err(|_| ())?;
            dst[p..p + 2].copy_from_slice(&pcount.to_le_bytes());
            p += 2;
            for (k, v) in &self.params {
                let kb = k.as_bytes();
                let vb = v.as_bytes();
                let klen = u16::try_from(kb.len()).map_err(|_| ())?;
                let vlen = u16::try_from(vb.len()).map_err(|_| ())?;
                dst[p..p + 2].copy_from_slice(&klen.to_le_bytes());
                p += 2;
                dst[p..p + kb.len()].copy_from_slice(kb);
                p += kb.len();
                dst[p..p + 2].copy_from_slice(&vlen.to_le_bytes());
                p += 2;
                dst[p..p + vb.len()].copy_from_slice(vb);
                p += vb.len();
            }
            let blen = u32::try_from(p - start).map_err(|_| ())?;
            dst[len_pos..len_pos + 4].copy_from_slice(&blen.to_le_bytes());
        }

        // raw headers block
        let hlen = u32::try_from(self.raw_headers.len()).map_err(|_| ())?;
        dst[p..p + 4].copy_from_slice(&hlen.to_le_bytes());
        p += 4;
        if !self.raw_headers.is_empty() {
            dst[p..p + self.raw_headers.len()].copy_from_slice(&self.raw_headers);
            p += self.raw_headers.len();
        }

        // body
        let blen = u32::try_from(self.body.len()).map_err(|_| ())?;
        dst[p..p + 4].copy_from_slice(&blen.to_le_bytes());
        p += 4;
        if !self.body.is_empty() {
            dst[p..p + self.body.len()].copy_from_slice(&self.body);
            p += self.body.len();
        }

        *pos = p;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_request_bounds_prevent_u16_truncation() {
        let mut req = PendingRequest {
            req_id: 1,
            route_id: 0,
            method: MethodCode::Get,
            method_str: None,
            is_tls: false,
            body_mode: BodyMode::None,
            raw_url: Bytes::from_static(b"/test"),
            path_len: 5,
            remote_addr: Arc::from("127.0.0.1"),
            params: vec![("k".into(), "v".into())],
            raw_headers: Bytes::new(),
            body: Bytes::new(),
            upgrade: false,
        };
        assert!(req.can_encode());
        let mut buf = vec![0u8; req.encoded_size()];
        let mut pos = 0;
        assert!(req.try_encode_into(&mut buf, &mut pos).is_ok());
        assert_eq!(pos, req.encoded_size());

        req.params = vec![("k".into(), "x".repeat(70_000))];
        assert!(!req.can_encode());
        let mut small = vec![0u8; 1024];
        let mut p2 = 0;
        assert!(req.try_encode_into(&mut small, &mut p2).is_err());
    }
}
