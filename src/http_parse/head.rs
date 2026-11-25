//! Request-head parsing: request line + header block -> [`ParsedMeta`].

pub struct ParsedMeta {
    pub header_len: usize,
    pub method_start: usize,
    pub method_end: usize,
    pub url_start: usize,
    pub url_end: usize,
    pub headers_start: usize,
    pub headers_end: usize,
    pub content_length: Option<usize>,
    pub is_chunked: bool,
    pub keep_alive: bool,
    pub version: u8,
    pub expect_100: bool,
    pub content_type: Option<(usize, usize)>,
    pub if_none_match: Option<(usize, usize)>,
    pub if_modified_since: Option<(usize, usize)>,
    pub range: Option<(usize, usize)>,
    /// `Connection: upgrade` together with an `Upgrade` header (Node's `req.upgrade`).
    pub upgrade: bool,
    /// `If-Match` or `If-Unmodified-Since` is present (precondition checks are left to JS).
    pub precondition: bool,
}

pub enum ParseOutcome {
    Complete(ParsedMeta),
    Partial,
    Error(u16),
}

#[inline]
fn trim_ows(bytes: &[u8]) -> &[u8] {
    let mut start = 0;
    let mut end = bytes.len();
    while start < end && matches!(bytes[start], b' ' | b'\t') {
        start += 1;
    }
    while end > start && matches!(bytes[end - 1], b' ' | b'\t') {
        end -= 1;
    }
    &bytes[start..end]
}

#[inline]
fn parse_strict_decimal(bytes: &[u8]) -> Option<usize> {
    let v = trim_ows(bytes);
    if v.is_empty() {
        return None;
    }
    let mut acc: usize = 0;
    for &b in v {
        if !b.is_ascii_digit() {
            return None;
        }
        acc = acc.checked_mul(10)?.checked_add((b - b'0') as usize)?;
    }
    Some(acc)
}

#[inline]
pub fn try_parse_request(
    buf: &[u8],
    max_headers_count: usize,
    max_header_size: usize,
) -> ParseOutcome {
    let mut stack_headers = [httparse::EMPTY_HEADER; 64];
    let stack_slice = if max_headers_count > 0 && max_headers_count <= 64 {
        &mut stack_headers[..max_headers_count]
    } else {
        &mut stack_headers[..]
    };

    let mut req = httparse::Request::new(stack_slice);
    match req.parse(buf) {
        Ok(httparse::Status::Complete(n)) => {
            if n > max_header_size {
                return ParseOutcome::Error(431);
            }
            finish_parse(buf, &req, n)
        }
        Ok(httparse::Status::Partial) => {
            if buf.len() > max_header_size {
                ParseOutcome::Error(431)
            } else {
                ParseOutcome::Partial
            }
        }
        Err(httparse::Error::TooManyHeaders) => {
            if max_headers_count > 0 && max_headers_count <= 64 {
                return ParseOutcome::Error(431);
            }
            let cap = if max_headers_count == 0 {
                (max_header_size / 4).clamp(65, 16384)
            } else {
                max_headers_count
            };
            let mut heap_headers = vec![httparse::EMPTY_HEADER; cap];
            let mut req2 = httparse::Request::new(&mut heap_headers);
            match req2.parse(buf) {
                Ok(httparse::Status::Complete(n)) => {
                    if n > max_header_size {
                        return ParseOutcome::Error(431);
                    }
                    finish_parse(buf, &req2, n)
                }
                Ok(httparse::Status::Partial) => {
                    if buf.len() > max_header_size {
                        ParseOutcome::Error(431)
                    } else {
                        ParseOutcome::Partial
                    }
                }
                Err(httparse::Error::TooManyHeaders) => ParseOutcome::Error(431),
                Err(_) => ParseOutcome::Error(400),
            }
        }
        Err(_) => ParseOutcome::Error(400),
    }
}

/// Methods llhttp accepts on an HTTP/1.x request line: exactly Node's `http.METHODS`
/// (case-sensitive). Anything else is `HPE_INVALID_METHOD` / 400 in Node.
#[inline]
fn is_known_method(m: &[u8]) -> bool {
    match m.len() {
        3 => matches!(m, b"GET" | b"PUT" | b"ACL"),
        4 => matches!(
            m,
            b"POST" | b"HEAD" | b"COPY" | b"LOCK" | b"MOVE" | b"BIND" | b"LINK"
        ),
        5 => matches!(
            m,
            b"PATCH" | b"PURGE" | b"MKCOL" | b"MERGE" | b"TRACE" | b"QUERY"
        ),
        6 => matches!(
            m,
            b"DELETE"
                | b"NOTIFY"
                | b"REPORT"
                | b"SEARCH"
                | b"SOURCE"
                | b"UNLOCK"
                | b"REBIND"
                | b"UNBIND"
                | b"UNLINK"
        ),
        7 => matches!(m, b"OPTIONS" | b"CONNECT"),
        8 => matches!(m, b"PROPFIND" | b"M-SEARCH" | b"CHECKOUT"),
        9 => matches!(m, b"PROPPATCH" | b"SUBSCRIBE"),
        10 => matches!(m, b"MKACTIVITY" | b"MKCALENDAR"),
        11 => m == b"UNSUBSCRIBE",
        _ => false,
    }
}

/// Length of an absolute-form scheme prefix (`1*ALPHA "://"`, any scheme, as llhttp accepts it).
#[inline]
fn scheme_prefix_len(target: &[u8]) -> Option<usize> {
    let n = target.iter().position(|b| !b.is_ascii_alphabetic())?;
    (n > 0 && target[n..].starts_with(b"://")).then_some(n + 3)
}

#[inline]
fn is_absolute_form(target: &[u8]) -> bool {
    scheme_prefix_len(target).is_some()
}

/// Offset of the origin-form (`/path?query`) inside an absolute-form request target.
#[inline]
fn absolute_form_origin_offset(target: &[u8]) -> Option<usize> {
    let after_scheme = scheme_prefix_len(target)?;
    let rest = &target[after_scheme..];
    let slash = rest
        .iter()
        .position(|&b| b == b'/' || b == b'?' || b == b'#')?;
    (rest[slash] == b'/').then_some(after_scheme + slash)
}

/// httparse tolerates bare `\n` line endings, but the JS layer splits the raw header block on
/// `\r\n` only. Accepting them would let Rust frame the request on headers JS never sees
/// (header injection / smuggling), so reject like llhttp in strict mode.
#[inline]
fn has_bare_lf(head: &[u8]) -> bool {
    let mut prev = 0u8;
    for &b in head {
        if b == b'\n' && prev != b'\r' {
            return true;
        }
        prev = b;
    }
    false
}

fn finish_parse(buf: &[u8], req: &httparse::Request<'_, '_>, header_len: usize) -> ParseOutcome {
    if has_bare_lf(&buf[..header_len]) {
        return ParseOutcome::Error(400);
    }
    let version = match req.version {
        Some(v @ (0 | 1)) => v,
        _ => return ParseOutcome::Error(400),
    };
    let method = match req.method {
        Some(m) if is_known_method(m.as_bytes()) => m,
        _ => return ParseOutcome::Error(400),
    };
    let path = match req.path {
        Some(p) if !p.is_empty() && !p.as_bytes().contains(&0) => p,
        _ => return ParseOutcome::Error(400),
    };

    let base_ptr = buf.as_ptr() as usize;
    let method_start = method.as_ptr() as usize - base_ptr;
    let method_end = method_start + method.len();
    let mut url_start = path.as_ptr() as usize - base_ptr;
    let url_end = url_start + path.len();
    // Request-target forms llhttp accepts (RFC 9112 3.2): origin-form `/...`, asterisk-form `*`
    // (llhttp: any method, any suffix), absolute-form `scheme://...`, and for CONNECT anything
    // (authority-form). Everything else (`-p`, `p`, `?x`, `host:80`) is HPE_INVALID_URL.
    let target = path.as_bytes();
    if !matches!(target[0], b'/' | b'*') {
        // absolute-form (RFC 9112 3.2.2): servers MUST accept it; route on origin-form path+query.
        if let Some(origin_off) = absolute_form_origin_offset(target) {
            url_start += origin_off;
        } else if is_absolute_form(target) || method.as_bytes() != b"CONNECT" {
            // `http://host` / `http://host?q` with no path (nothing to route on), or not a
            // request-target form at all.
            return ParseOutcome::Error(400);
        }
    }

    let mut content_length: Option<usize> = None;
    let mut seen_cl = false;
    let mut is_chunked = false;
    let mut seen_te = false;
    let mut host_count: usize = 0;
    let mut saw_close = false;
    let mut saw_keep_alive = false;
    let mut saw_upgrade_token = false;
    let mut has_upgrade_header = false;
    let mut expect_100 = false;
    let mut expect_invalid = false;

    let mut content_type = None;
    let mut if_none_match = None;
    let mut if_modified_since = None;
    let mut range = None;
    let mut precondition = false;

    let mut headers_start = header_len;
    let headers_end = header_len.saturating_sub(2);

    for (idx, h) in req.headers.iter().enumerate() {
        if idx == 0 {
            headers_start = h.name.as_ptr() as usize - base_ptr;
        }
        let name = h.name.as_bytes();
        let val = h.value;

        // Fast first-byte jump table
        match name.first().copied().unwrap_or(0) | 0x20 {
            b'c' => {
                if name.eq_ignore_ascii_case(b"content-length") {
                    if seen_cl {
                        return ParseOutcome::Error(400);
                    }
                    seen_cl = true;
                    let Some(parsed) = parse_strict_decimal(val) else {
                        return ParseOutcome::Error(400);
                    };
                    content_length = Some(parsed);
                } else if name.eq_ignore_ascii_case(b"content-type") {
                    let vs = val.as_ptr() as usize - base_ptr;
                    content_type = Some((vs, vs + val.len()));
                } else if name.eq_ignore_ascii_case(b"connection") {
                    for raw_tok in val.split(|&b| b == b',') {
                        let tok = trim_ows(raw_tok);
                        if tok.eq_ignore_ascii_case(b"close") {
                            saw_close = true;
                        } else if tok.eq_ignore_ascii_case(b"keep-alive") {
                            saw_keep_alive = true;
                        } else if tok.eq_ignore_ascii_case(b"upgrade") {
                            saw_upgrade_token = true;
                        }
                    }
                }
            }
            b't' => {
                if name.eq_ignore_ascii_case(b"transfer-encoding") {
                    if version == 0 || seen_te {
                        return ParseOutcome::Error(400);
                    }
                    seen_te = true;
                    let v = trim_ows(val);
                    if !v.eq_ignore_ascii_case(b"chunked") {
                        return ParseOutcome::Error(400);
                    }
                    is_chunked = true;
                }
            }
            b'h' => {
                if name.eq_ignore_ascii_case(b"host") {
                    host_count += 1;
                    if host_count > 1 {
                        return ParseOutcome::Error(400);
                    }
                    let v = trim_ows(val);
                    if v.iter().any(|&b| b == b' ' || b == b'\t' || b == b'@') {
                        return ParseOutcome::Error(400);
                    }
                }
            }
            b'e' => {
                if name.eq_ignore_ascii_case(b"expect") {
                    let v = trim_ows(val);
                    if v.eq_ignore_ascii_case(b"100-continue") {
                        expect_100 = true;
                    } else if !v.is_empty() {
                        expect_invalid = true;
                    }
                }
            }
            b'i' => {
                if name.eq_ignore_ascii_case(b"if-none-match") {
                    let vs = val.as_ptr() as usize - base_ptr;
                    if_none_match = Some((vs, vs + val.len()));
                } else if name.eq_ignore_ascii_case(b"if-modified-since") {
                    let vs = val.as_ptr() as usize - base_ptr;
                    if_modified_since = Some((vs, vs + val.len()));
                } else if name.eq_ignore_ascii_case(b"if-match")
                    || name.eq_ignore_ascii_case(b"if-unmodified-since")
                {
                    precondition = true;
                }
            }
            b'u' if name.eq_ignore_ascii_case(b"upgrade") => {
                has_upgrade_header = !trim_ows(val).is_empty();
            }
            b'r' if name.eq_ignore_ascii_case(b"range") => {
                let vs = val.as_ptr() as usize - base_ptr;
                range = Some((vs, vs + val.len()));
            }
            _ => {}
        }
    }

    if seen_cl && seen_te {
        return ParseOutcome::Error(400);
    }
    if version == 1 && host_count != 1 {
        return ParseOutcome::Error(400);
    }
    if expect_invalid {
        return ParseOutcome::Error(417);
    }

    let keep_alive = if saw_close {
        false
    } else if saw_keep_alive {
        true
    } else {
        version == 1
    };

    if headers_start > headers_end {
        headers_start = headers_end;
    }

    ParseOutcome::Complete(ParsedMeta {
        header_len,
        method_start,
        method_end,
        url_start,
        url_end,
        headers_start,
        headers_end,
        content_length,
        is_chunked,
        keep_alive,
        version,
        expect_100,
        content_type,
        if_none_match,
        if_modified_since,
        range,
        upgrade: saw_upgrade_token && has_upgrade_header,
        precondition,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_http11_and_http10_and_pipelined() {
        let req1 = b"GET /users/42?a=1 HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive, Upgrade\r\n\r\nPOST /x HTTP/1.0\r\nContent-Length: 2\r\n\r\nhi";
        let ParseOutcome::Complete(m1) = try_parse_request(req1, 128, 65536) else {
            panic!("expected Complete");
        };
        assert_eq!(&req1[m1.method_start..m1.method_end], b"GET");
        assert_eq!(&req1[m1.url_start..m1.url_end], b"/users/42?a=1");
        assert!(m1.keep_alive);
        assert_eq!(m1.version, 1);

        let ParseOutcome::Complete(m2) = try_parse_request(&req1[m1.header_len..], 128, 65536)
        else {
            panic!("expected Complete 2");
        };
        assert_eq!(m2.content_length, Some(2));
        assert!(!m2.keep_alive);
        assert_eq!(m2.version, 0);
    }

    #[test]
    fn connection_close_always_wins_over_keep_alive() {
        let raw = b"GET / HTTP/1.1\r\nHost: example.com\r\nConnection: keep-alive\r\nConnection: foo, close\r\n\r\n";
        let ParseOutcome::Complete(m) = try_parse_request(raw, 128, 65536) else {
            panic!("expected Complete");
        };
        assert!(!m.keep_alive);

        let raw2 = b"GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n";
        let ParseOutcome::Complete(m2) = try_parse_request(raw2, 128, 65536) else {
            panic!("expected Complete");
        };
        assert!(m2.keep_alive);
    }

    #[test]
    fn rejects_smuggling_cl_te_and_malformed_headers_with_400() {
        let cases: &[&[u8]] = &[
            // Duplicate CL (even identical)
            b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\nhello",
            // Differing CL
            b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello!",
            // Plus-prefixed CL
            b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: +5\r\n\r\nhello",
            // Negative CL
            b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: -1\r\n\r\n",
            // Non-numeric / empty CL
            b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: abc\r\n\r\n",
            b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: \r\n\r\n",
            // CL + TE in both orders
            b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
            b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n0\r\n\r\n",
            // Malformed TE
            b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: xchunked\r\n\r\n",
            b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip, chunked\r\n\r\n",
            b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: identity\r\n\r\n",
            // HTTP/1.0 with TE
            b"POST / HTTP/1.0\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
            // Missing Host in HTTP/1.1
            b"GET / HTTP/1.1\r\nUser-Agent: test\r\n\r\n",
            // Duplicate Host
            b"GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n",
            // Host with @ or internal whitespace
            b"GET / HTTP/1.1\r\nHost: user@evil.com\r\n\r\n",
            b"GET / HTTP/1.1\r\nHost: bad host\r\n\r\n",
        ];

        for raw in cases {
            match try_parse_request(raw, 128, 65536) {
                ParseOutcome::Error(400) => {}
                other => panic!(
                    "Expected 400 for {:?}, got {:?}",
                    String::from_utf8_lossy(raw),
                    match other {
                        ParseOutcome::Complete(_) => "Complete".to_string(),
                        ParseOutcome::Partial => "Partial".to_string(),
                        ParseOutcome::Error(c) => format!("Error({c})"),
                    }
                ),
            }
        }
    }

    #[test]
    fn enforces_max_headers_count_and_max_header_size_with_431() {
        let mut raw_70 = String::from("GET / HTTP/1.1\r\nHost: localhost\r\n");
        for i in 0..69 {
            raw_70.push_str(&format!("X-H-{i}: v\r\n"));
        }
        raw_70.push_str("\r\n");

        // 70 headers total (> 64 stack path) fails when max_headers_count = 64, succeeds at 70, fails at 69
        assert!(matches!(
            try_parse_request(raw_70.as_bytes(), 64, 65536),
            ParseOutcome::Error(431)
        ));
        assert!(matches!(
            try_parse_request(raw_70.as_bytes(), 69, 65536),
            ParseOutcome::Error(431)
        ));
        assert!(matches!(
            try_parse_request(raw_70.as_bytes(), 70, 65536),
            ParseOutcome::Complete(_)
        ));

        // Partial exceeding max_header_size -> 431
        let partial = format!(
            "GET / HTTP/1.1\r\nHost: localhost\r\nX-Big: {}",
            "a".repeat(2048)
        );
        assert!(matches!(
            try_parse_request(partial.as_bytes(), 128, 1024),
            ParseOutcome::Error(431)
        ));

        // Complete exceeding max_header_size -> 431
        let complete = format!(
            "GET / HTTP/1.1\r\nHost: localhost\r\nX-Big: {}\r\n\r\n",
            "a".repeat(1024)
        );
        assert!(matches!(
            try_parse_request(complete.as_bytes(), 128, 1024),
            ParseOutcome::Error(431)
        ));
    }

    #[test]
    fn routes_absolute_form_targets_on_their_origin_form() {
        let req = b"GET http://evil.com:8080/echo?q=1 HTTP/1.1\r\nHost: a\r\n\r\n";
        let ParseOutcome::Complete(m) = try_parse_request(req, 128, 65536) else {
            panic!("expected Complete");
        };
        assert_eq!(&req[m.url_start..m.url_end], b"/echo?q=1");
        assert!(matches!(
            try_parse_request(b"GET HTTPS://h?x HTTP/1.1\r\nHost: a\r\n\r\n", 128, 65536),
            ParseOutcome::Error(400)
        ));
        // Any `1*ALPHA "://"` scheme is absolute-form (llhttp accepts ftp://, ws://, ...).
        let req = b"GET ws://h/sock HTTP/1.1\r\nHost: a\r\n\r\n";
        let ParseOutcome::Complete(m) = try_parse_request(req, 128, 65536) else {
            panic!("expected Complete");
        };
        assert_eq!(&req[m.url_start..m.url_end], b"/sock");
    }

    fn outcome(raw: &[u8]) -> Result<String, u16> {
        match try_parse_request(raw, 128, 65536) {
            ParseOutcome::Complete(m) => {
                Ok(String::from_utf8_lossy(&raw[m.url_start..m.url_end]).into_owned())
            }
            ParseOutcome::Partial => Err(0),
            ParseOutcome::Error(c) => Err(c),
        }
    }

    /// `node -p http.METHODS` on Node 24 (llhttp 9.4.3).
    const NODE_METHODS: [&str; 35] = [
        "ACL",
        "BIND",
        "CHECKOUT",
        "CONNECT",
        "COPY",
        "DELETE",
        "GET",
        "HEAD",
        "LINK",
        "LOCK",
        "M-SEARCH",
        "MERGE",
        "MKACTIVITY",
        "MKCALENDAR",
        "MKCOL",
        "MOVE",
        "NOTIFY",
        "OPTIONS",
        "PATCH",
        "POST",
        "PROPFIND",
        "PROPPATCH",
        "PURGE",
        "PUT",
        "QUERY",
        "REBIND",
        "REPORT",
        "SEARCH",
        "SOURCE",
        "SUBSCRIBE",
        "TRACE",
        "UNBIND",
        "UNLINK",
        "UNLOCK",
        "UNSUBSCRIBE",
    ];

    #[test]
    fn accepts_exactly_nodes_method_list_case_sensitively() {
        for m in NODE_METHODS {
            assert!(is_known_method(m.as_bytes()), "{m}");
            let raw = format!("{m} / HTTP/1.1\r\nHost: a\r\n\r\n");
            assert_eq!(outcome(raw.as_bytes()), Ok("/".into()), "{m}");
            assert!(!is_known_method(m.to_ascii_lowercase().as_bytes()), "{m}");
            assert!(!is_known_method(format!("{m}X").as_bytes()), "{m}");
            assert!(!is_known_method(&m.as_bytes()[..m.len() - 1]), "{m}");
        }
        for m in [
            "FOO",
            "get",
            "Get",
            "abcGET",
            "GETX",
            "GE",
            "PRI",
            "DESCRIBE",
            "SETUP",
            "PLAY",
            "M-SEARCh",
            "MSEARCH",
            "UNSUBSCRIBEX",
            "",
        ] {
            assert!(!is_known_method(m.as_bytes()), "{m}");
        }
        for m in ["FOO", "get", "abcGET", "PRI"] {
            let raw = format!("{m} / HTTP/1.1\r\nHost: a\r\n\r\n");
            assert_eq!(outcome(raw.as_bytes()), Err(400), "{m}");
        }
    }

    #[test]
    fn request_target_forms_match_llhttp() {
        let ok: &[(&str, &str)] = &[
            ("GET / HTTP/1.1", "/"),
            ("GET //x HTTP/1.1", "//x"),
            ("GET * HTTP/1.1", "*"),
            ("OPTIONS * HTTP/1.1", "*"),
            ("GET *x HTTP/1.1", "*x"),
            ("GET http://a/b?c HTTP/1.1", "/b?c"),
            ("GET HTTP://a/b HTTP/1.1", "/b"),
            ("GET ftp://a/b HTTP/1.1", "/b"),
            ("CONNECT host:80 HTTP/1.1", "host:80"),
            ("CONNECT a HTTP/1.1", "a"),
            ("CONNECT /x HTTP/1.1", "/x"),
        ];
        for (line, url) in ok {
            let raw = format!("{line}\r\nHost: a\r\n\r\n");
            assert_eq!(outcome(raw.as_bytes()), Ok((*url).into()), "{line}");
        }
        for line in [
            "GET -p HTTP/1.1",
            "GET p HTTP/1.1",
            "GET chunked/p HTTP/1.1",
            "GET ?x HTTP/1.1",
            "GET host:80 HTTP/1.1",
            "GET a:b HTTP/1.1",
            "GET http:/a HTTP/1.1",
            "GET 1http://a/ HTTP/1.1",
            "POST -p HTTP/1.1",
        ] {
            let raw = format!("{line}\r\nHost: a\r\n\r\n");
            assert_eq!(outcome(raw.as_bytes()), Err(400), "{line}");
        }
    }

    #[test]
    fn rejects_bare_lf_line_endings_in_request_head() {
        let cases: [&[u8]; 3] = [
            b"GET / HTTP/1.1\nHost: a\n\n",
            b"GET / HTTP/1.1\r\nHost: a\r\nX-A: one\nX-Forwarded-For: 6.6.6.6\r\n\r\n",
            b"POST / HTTP/1.1\r\nHost: a\nContent-Length: 3\r\n\r\nabc",
        ];
        for c in cases {
            assert!(matches!(
                try_parse_request(c, 128, 65536),
                ParseOutcome::Error(400)
            ));
        }
        assert!(matches!(
            try_parse_request(b"GET / HTTP/1.1\r\nHost: a\r\n\r\n", 128, 65536),
            ParseOutcome::Complete(_)
        ));
    }

    #[test]
    fn handles_expect_100_continue_and_rejects_unknown_expect_with_417() {
        let ok = b"POST /upload HTTP/1.1\r\nHost: localhost\r\nExpect: 100-Continue\r\nContent-Length: 4\r\n\r\n";
        let ParseOutcome::Complete(m) = try_parse_request(ok, 128, 65536) else {
            panic!("expected Complete");
        };
        assert!(m.expect_100);

        let bad = b"POST /upload HTTP/1.1\r\nHost: localhost\r\nExpect: something-weird\r\n\r\n";
        assert!(matches!(
            try_parse_request(bad, 128, 65536),
            ParseOutcome::Error(417)
        ));
    }
}
