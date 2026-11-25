use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EtagMode {
    Off,
    Weak,
    Strong,
}

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub x_powered_by: bool,
    pub etag_mode: EtagMode,
    pub case_sensitive: bool,
    pub strict_routing: bool,
    /// `0` disables the timeout; otherwise clamped to `1..=86_400_000` ms.
    pub headers_timeout_ms: u64,
    /// `0` disables the timeout; otherwise clamped to `1..=86_400_000` ms.
    pub request_timeout_ms: u64,
    /// `0` disables the timeout; otherwise clamped to `1..=86_400_000` ms.
    pub keep_alive_timeout_ms: u64,
    /// `0` disables the timeout; otherwise clamped to `1..=300_000` ms.
    pub tls_handshake_timeout_ms: u64,
    /// Write idle timeout: a response write that makes no progress for this long (peer not
    /// reading) closes the connection. `0` disables; otherwise clamped to `1..=86_400_000` ms.
    pub write_timeout_ms: u64,
    /// `0` disables the timeout; otherwise clamped to `1..=86_400_000` ms.
    pub handler_timeout_ms: u64,
    /// `0` performs immediate force-close; otherwise clamped to `1..=300_000` ms.
    pub shutdown_timeout_ms: u64,
    /// `0` disables connection limit; otherwise clamped to `1..=1_000_000`.
    pub max_connections: usize,
    /// Maximum header count per request, clamped to `1..=4096`.
    pub max_headers_count: usize,
    /// Maximum total header block bytes per request, clamped to `1024..=16_777_216`.
    pub max_header_size_bytes: usize,
    /// Default body limit when no body-parser rule matches, clamped to `0..=536_870_912`.
    pub default_body_limit_bytes: usize,
    /// `default_body_limit_bytes` was set by the app. Then bodies no parser claims are capped by
    /// it (413); otherwise they stream to JS unbounded, like Node/Express.
    pub explicit_default_body_limit: bool,
    /// Stream backpressure queue capacity, clamped to `1..=65_536`.
    pub stream_queue_capacity: usize,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            x_powered_by: true,
            etag_mode: EtagMode::Weak,
            case_sensitive: false,
            strict_routing: false,
            headers_timeout_ms: 60_000,
            request_timeout_ms: 300_000,
            keep_alive_timeout_ms: 5_000,
            tls_handshake_timeout_ms: 10_000,
            write_timeout_ms: 30_000,
            handler_timeout_ms: 300_000,
            shutdown_timeout_ms: 10_000,
            max_connections: 10_000,
            max_headers_count: 128,
            max_header_size_bytes: 65_536,
            default_body_limit_bytes: 1_048_576,
            explicit_default_body_limit: false,
            stream_queue_capacity: 256,
        }
    }
}

#[inline]
pub fn clamp_optional_timeout_ms(v: u32, max_ms: u64) -> u64 {
    if v == 0 {
        0
    } else {
        (v as u64).clamp(1, max_ms)
    }
}

impl EngineConfig {
    #[inline]
    pub fn headers_timeout(&self) -> Option<Duration> {
        (self.headers_timeout_ms > 0).then(|| Duration::from_millis(self.headers_timeout_ms))
    }

    #[inline]
    pub fn request_timeout(&self) -> Option<Duration> {
        (self.request_timeout_ms > 0).then(|| Duration::from_millis(self.request_timeout_ms))
    }

    #[inline]
    pub fn keep_alive_timeout(&self) -> Option<Duration> {
        (self.keep_alive_timeout_ms > 0).then(|| Duration::from_millis(self.keep_alive_timeout_ms))
    }

    #[inline]
    pub fn tls_handshake_timeout(&self) -> Option<Duration> {
        (self.tls_handshake_timeout_ms > 0)
            .then(|| Duration::from_millis(self.tls_handshake_timeout_ms))
    }

    #[inline]
    pub fn write_timeout(&self) -> Option<Duration> {
        (self.write_timeout_ms > 0).then(|| Duration::from_millis(self.write_timeout_ms))
    }

    #[inline]
    pub fn handler_timeout(&self) -> Option<Duration> {
        (self.handler_timeout_ms > 0).then(|| Duration::from_millis(self.handler_timeout_ms))
    }

    #[inline]
    pub fn shutdown_timeout(&self) -> Duration {
        Duration::from_millis(self.shutdown_timeout_ms)
    }

    #[inline]
    pub fn max_connections_limit(&self) -> Option<usize> {
        (self.max_connections > 0).then_some(self.max_connections)
    }

    pub fn set_headers_timeout_ms(&mut self, v: u32) {
        self.headers_timeout_ms = clamp_optional_timeout_ms(v, 86_400_000);
    }

    pub fn set_request_timeout_ms(&mut self, v: u32) {
        self.request_timeout_ms = clamp_optional_timeout_ms(v, 86_400_000);
    }

    pub fn set_keep_alive_timeout_ms(&mut self, v: u32) {
        self.keep_alive_timeout_ms = clamp_optional_timeout_ms(v, 86_400_000);
    }

    pub fn set_tls_handshake_timeout_ms(&mut self, v: u32) {
        self.tls_handshake_timeout_ms = clamp_optional_timeout_ms(v, 300_000);
    }

    pub fn set_write_timeout_ms(&mut self, v: u32) {
        self.write_timeout_ms = clamp_optional_timeout_ms(v, 86_400_000);
    }

    pub fn set_handler_timeout_ms(&mut self, v: u32) {
        self.handler_timeout_ms = clamp_optional_timeout_ms(v, 86_400_000);
    }

    pub fn set_shutdown_timeout_ms(&mut self, v: u32) {
        self.shutdown_timeout_ms = clamp_optional_timeout_ms(v, 300_000);
    }

    pub fn set_max_connections(&mut self, v: u32) {
        self.max_connections = if v == 0 {
            0
        } else {
            (v as usize).clamp(1, 1_000_000)
        };
    }

    pub fn set_max_headers_count(&mut self, v: u32) {
        self.max_headers_count = (v as usize).clamp(1, 4096);
    }

    pub fn set_max_header_size_bytes(&mut self, v: u32) {
        self.max_header_size_bytes = (v as usize).clamp(1024, 16 * 1024 * 1024);
    }

    pub fn set_default_body_limit_bytes(&mut self, v: u32) {
        self.default_body_limit_bytes = (v as usize).clamp(0, 512 * 1024 * 1024);
        self.explicit_default_body_limit = true;
    }

    pub fn set_stream_queue_capacity(&mut self, v: u32) {
        self.stream_queue_capacity = (v as usize).clamp(1, 65_536);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_production_policy() {
        let cfg = EngineConfig::default();
        assert!(cfg.x_powered_by);
        assert_eq!(cfg.etag_mode, EtagMode::Weak);
        assert!(!cfg.case_sensitive);
        assert!(!cfg.strict_routing);
        assert_eq!(cfg.headers_timeout(), Some(Duration::from_secs(60)));
        assert_eq!(cfg.request_timeout(), Some(Duration::from_secs(300)));
        assert_eq!(cfg.keep_alive_timeout(), Some(Duration::from_secs(5)));
        assert_eq!(cfg.tls_handshake_timeout(), Some(Duration::from_secs(10)));
        assert_eq!(cfg.handler_timeout(), Some(Duration::from_secs(300)));
        assert_eq!(cfg.write_timeout(), Some(Duration::from_secs(30)));
        assert_eq!(cfg.shutdown_timeout(), Duration::from_secs(10));
        assert_eq!(cfg.max_connections_limit(), Some(10_000));
        assert_eq!(cfg.max_headers_count, 128);
        assert_eq!(cfg.max_header_size_bytes, 65_536);
        assert_eq!(cfg.default_body_limit_bytes, 1_048_576);
        assert_eq!(cfg.stream_queue_capacity, 256);
    }

    #[test]
    fn zero_disables_timeouts_and_connection_limit() {
        let mut cfg = EngineConfig::default();
        cfg.set_headers_timeout_ms(0);
        cfg.set_request_timeout_ms(0);
        cfg.set_keep_alive_timeout_ms(0);
        cfg.set_tls_handshake_timeout_ms(0);
        cfg.set_handler_timeout_ms(0);
        cfg.set_write_timeout_ms(0);
        cfg.set_shutdown_timeout_ms(0);
        cfg.set_max_connections(0);
        cfg.set_default_body_limit_bytes(0);

        assert_eq!(cfg.headers_timeout(), None);
        assert_eq!(cfg.request_timeout(), None);
        assert_eq!(cfg.keep_alive_timeout(), None);
        assert_eq!(cfg.tls_handshake_timeout(), None);
        assert_eq!(cfg.handler_timeout(), None);
        assert_eq!(cfg.write_timeout(), None);
        assert_eq!(cfg.shutdown_timeout(), Duration::ZERO);
        assert_eq!(cfg.max_connections_limit(), None);
        assert_eq!(cfg.default_body_limit_bytes, 0);
    }

    #[test]
    fn clamps_out_of_range_values() {
        let mut cfg = EngineConfig::default();
        cfg.set_headers_timeout_ms(u32::MAX);
        cfg.set_tls_handshake_timeout_ms(999_999);
        cfg.set_shutdown_timeout_ms(999_999);
        cfg.set_max_connections(5_000_000);
        cfg.set_max_headers_count(0);
        assert_eq!(cfg.max_headers_count, 1);
        cfg.set_max_headers_count(99_999);
        assert_eq!(cfg.max_headers_count, 4096);

        cfg.set_max_header_size_bytes(10);
        assert_eq!(cfg.max_header_size_bytes, 1024);
        cfg.set_max_header_size_bytes(u32::MAX);
        assert_eq!(cfg.max_header_size_bytes, 16 * 1024 * 1024);

        cfg.set_stream_queue_capacity(0);
        assert_eq!(cfg.stream_queue_capacity, 1);
        cfg.set_stream_queue_capacity(999_999);
        assert_eq!(cfg.stream_queue_capacity, 65_536);

        assert_eq!(cfg.headers_timeout_ms, 86_400_000);
        assert_eq!(cfg.tls_handshake_timeout_ms, 300_000);
        assert_eq!(cfg.shutdown_timeout_ms, 300_000);
        assert_eq!(cfg.max_connections, 1_000_000);
    }
}
