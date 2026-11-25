use matchit::Router as MatchitRouter;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MethodCode {
    Get = 0,
    Post = 1,
    Put = 2,
    Delete = 3,
    Patch = 4,
    Options = 5,
    Head = 6,
    Other = 7,
}

impl MethodCode {
    #[inline]
    pub fn from_bytes(m: &[u8]) -> Self {
        match m {
            b"GET" => MethodCode::Get,
            b"POST" => MethodCode::Post,
            b"PUT" => MethodCode::Put,
            b"DELETE" => MethodCode::Delete,
            b"PATCH" => MethodCode::Patch,
            b"OPTIONS" => MethodCode::Options,
            b"HEAD" => MethodCode::Head,
            _ => MethodCode::Other,
        }
    }
}

/// Convert an Express-style path (`/users/:id`, `/files/*splat`, `/files/*`)
/// into a `matchit 0.8` route pattern (`/users/{id}`, `/files/{*splat}`).
pub fn express_to_matchit(path: &str, case_sensitive: bool) -> Option<String> {
    if path.contains('?')
        || path.contains('(')
        || path.contains(')')
        || path.contains('+')
        || path.contains('[')
        || path.contains(']')
        || path.contains('{')
        || path.contains('}')
    {
        return None;
    }

    if path == "/" {
        return Some("/".to_string());
    }

    let mut out = String::with_capacity(path.len() + 8);
    let segments: Vec<&str> = path.split('/').collect();
    for (idx, seg) in segments.iter().enumerate() {
        if idx > 0 {
            out.push('/');
        }
        if seg.is_empty() {
            continue;
        }
        if let Some(param_name) = seg.strip_prefix(':') {
            if param_name.is_empty() {
                return None;
            }
            if !param_name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                return None;
            }
            out.push('{');
            out.push_str(param_name);
            out.push('}');
        } else if let Some(wild_name) = seg.strip_prefix('*') {
            if idx != segments.len() - 1 {
                return None;
            }
            if !wild_name.is_empty() {
                // Express 5 `*name` yields an array of decoded segments: handled by the JS router.
                return None;
            }
            let name = "0";
            out.push_str("{*");
            out.push_str(name);
            out.push('}');
        } else if case_sensitive {
            out.push_str(seg);
        } else {
            out.push_str(&seg.to_ascii_lowercase());
        }
    }

    if out.is_empty() {
        out.push('/');
    }
    Some(out)
}

pub struct CompiledRouter {
    get: MatchitRouter<i32>,
    post: MatchitRouter<i32>,
    put: MatchitRouter<i32>,
    delete: MatchitRouter<i32>,
    patch: MatchitRouter<i32>,
    options: MatchitRouter<i32>,
    head: MatchitRouter<i32>,
    all: MatchitRouter<i32>,
    has_routes: bool,
    pub case_sensitive: bool,
    pub strict_routing: bool,
}

impl CompiledRouter {
    pub fn new(case_sensitive: bool, strict_routing: bool) -> Self {
        Self {
            get: MatchitRouter::new(),
            post: MatchitRouter::new(),
            put: MatchitRouter::new(),
            delete: MatchitRouter::new(),
            patch: MatchitRouter::new(),
            options: MatchitRouter::new(),
            head: MatchitRouter::new(),
            all: MatchitRouter::new(),
            has_routes: false,
            case_sensitive,
            strict_routing,
        }
    }

    pub fn insert(&mut self, method: &str, express_path: &str, route_id: i32) -> bool {
        let Some(mut pattern) = express_to_matchit(express_path, self.case_sensitive) else {
            return false;
        };
        if !self.strict_routing && pattern.len() > 1 && pattern.ends_with('/') {
            pattern.pop();
        }
        let target = match method.to_ascii_uppercase().as_str() {
            "GET" => &mut self.get,
            "POST" => &mut self.post,
            "PUT" => &mut self.put,
            "DELETE" => &mut self.delete,
            "PATCH" => &mut self.patch,
            "OPTIONS" => &mut self.options,
            "HEAD" => &mut self.head,
            "ALL" => &mut self.all,
            _ => return false,
        };
        match target.insert(pattern, route_id) {
            Ok(()) => {
                self.has_routes = true;
                true
            }
            Err(_) => false,
        }
    }

    #[inline]
    pub fn match_route(
        &self,
        method: MethodCode,
        path: &str,
        out_params: &mut Vec<(String, String)>,
    ) -> i32 {
        if !self.has_routes {
            return -1;
        }

        let mut owned_path: Option<String> = None;
        let lookup_path: &str = {
            let needs_strip = !self.strict_routing && path.len() > 1 && path.ends_with('/');
            let base = if needs_strip {
                &path[..path.len() - 1]
            } else {
                path
            };
            if !self.case_sensitive && base.bytes().any(|b| b.is_ascii_uppercase()) {
                owned_path = Some(base.to_ascii_lowercase());
                owned_path.as_deref().unwrap()
            } else {
                base
            }
        };

        let router = match method {
            MethodCode::Get => &self.get,
            MethodCode::Post => &self.post,
            MethodCode::Put => &self.put,
            MethodCode::Delete => &self.delete,
            MethodCode::Patch => &self.patch,
            MethodCode::Options => &self.options,
            MethodCode::Head => &self.head,
            MethodCode::Other => &self.all,
        };

        if let Ok(matched) = router.at(lookup_path) {
            for (k, v) in matched.params.iter() {
                let val = if owned_path.is_some() {
                    extract_original_param(path, lookup_path, v)
                } else {
                    decode_param(v)
                };
                let Some(val) = val else {
                    out_params.clear();
                    return -1;
                };
                out_params.push((k.to_string(), val));
            }
            return *matched.value;
        }

        if method == MethodCode::Head {
            if let Ok(matched) = self.get.at(lookup_path) {
                for (k, v) in matched.params.iter() {
                    let val = if owned_path.is_some() {
                        extract_original_param(path, lookup_path, v)
                    } else {
                        decode_param(v)
                    };
                    let Some(val) = val else {
                        out_params.clear();
                        return -1;
                    };
                    out_params.push((k.to_string(), val));
                }
                return *matched.value;
            }
        }

        if method != MethodCode::Other {
            if let Ok(matched) = self.all.at(lookup_path) {
                for (k, v) in matched.params.iter() {
                    let val = if owned_path.is_some() {
                        extract_original_param(path, lookup_path, v)
                    } else {
                        decode_param(v)
                    };
                    let Some(val) = val else {
                        out_params.clear();
                        return -1;
                    };
                    out_params.push((k.to_string(), val));
                }
                return *matched.value;
            }
        }

        -1
    }
}

/// Strict `decodeURIComponent`: `None` for a malformed escape or invalid UTF-8, so the request
/// falls back to the JS router, which answers 400 like Express.
#[inline]
fn decode_param(v: &str) -> Option<String> {
    let b = v.as_bytes();
    if !b.contains(&b'%') {
        return Some(v.to_string());
    }
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if i + 2 >= b.len() || !b[i + 1].is_ascii_hexdigit() || !b[i + 2].is_ascii_hexdigit() {
                return None;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    percent_encoding::percent_decode_str(v)
        .decode_utf8()
        .ok()
        .map(|c| c.into_owned())
}

fn extract_original_param(
    original_path: &str,
    lower_path: &str,
    lower_val: &str,
) -> Option<String> {
    let base_ptr = lower_path.as_ptr() as usize;
    let val_ptr = lower_val.as_ptr() as usize;
    if val_ptr >= base_ptr && val_ptr + lower_val.len() <= base_ptr + lower_path.len() {
        let start = val_ptr - base_ptr;
        let end = start + lower_val.len();
        if end <= original_path.len()
            && original_path.is_char_boundary(start)
            && original_path.is_char_boundary(end)
        {
            return decode_param(&original_path[start..end]);
        }
    }
    decode_param(lower_val)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn method_code_parses_standard_and_other() {
        assert_eq!(MethodCode::from_bytes(b"GET"), MethodCode::Get);
        assert_eq!(MethodCode::from_bytes(b"POST"), MethodCode::Post);
        assert_eq!(MethodCode::from_bytes(b"PUT"), MethodCode::Put);
        assert_eq!(MethodCode::from_bytes(b"DELETE"), MethodCode::Delete);
        assert_eq!(MethodCode::from_bytes(b"PATCH"), MethodCode::Patch);
        assert_eq!(MethodCode::from_bytes(b"OPTIONS"), MethodCode::Options);
        assert_eq!(MethodCode::from_bytes(b"HEAD"), MethodCode::Head);
        assert_eq!(MethodCode::from_bytes(b"MKCOL"), MethodCode::Other);
    }

    #[test]
    fn express_to_matchit_converts_and_rejects_regex_syntax() {
        // Named wildcards yield arrays (Express 5): left to the JS router.
        assert_eq!(express_to_matchit("/Users/:id/Posts/*rest", false), None);
        assert_eq!(
            express_to_matchit("/Users/:id", true),
            Some("/Users/{id}".to_string())
        );
        assert_eq!(
            express_to_matchit("/files/*", false),
            Some("/files/{*0}".to_string())
        );
        assert_eq!(express_to_matchit("/ab?cd", false), None);
        assert_eq!(express_to_matchit("/(foo|bar)", false), None);
        assert_eq!(express_to_matchit("/files/*/mid", false), None);
    }

    #[test]
    fn compiled_router_matches_case_strict_head_all_and_decodes_params() {
        let mut r = CompiledRouter::new(false, false);
        assert!(r.insert("GET", "/users/:id", 1));
        assert!(!r.insert("GET", "/users/:id", 2)); // duplicate
        assert!(r.insert("ALL", "/any/*", 3));

        let mut params = Vec::new();
        assert_eq!(
            r.match_route(MethodCode::Get, "/USERS/Alice%20B/", &mut params),
            1
        );
        assert_eq!(params, vec![("id".to_string(), "Alice B".to_string())]);

        // HEAD falls back to GET
        params.clear();
        assert_eq!(
            r.match_route(MethodCode::Head, "/users/bob", &mut params),
            1
        );
        assert_eq!(params, vec![("id".to_string(), "bob".to_string())]);

        // ALL fallback
        params.clear();
        assert_eq!(r.match_route(MethodCode::Post, "/any/a/b", &mut params), 3);
        assert_eq!(params, vec![("0".to_string(), "a/b".to_string())]);

        // Malformed escapes / invalid UTF-8 are not decoded lossily: JS answers 400.
        for bad in ["/users/%", "/users/%zz", "/users/%E0%A4%A", "/users/%FF"] {
            params.clear();
            assert_eq!(
                r.match_route(MethodCode::Get, bad, &mut params),
                -1,
                "{bad}"
            );
            assert!(params.is_empty());
        }

        // strict_routing = true distinguishes trailing slash
        let mut strict = CompiledRouter::new(true, true);
        assert!(strict.insert("GET", "/Users", 10));
        params.clear();
        assert_eq!(
            strict.match_route(MethodCode::Get, "/users", &mut params),
            -1
        );
        assert_eq!(
            strict.match_route(MethodCode::Get, "/Users/", &mut params),
            -1
        );
        assert_eq!(
            strict.match_route(MethodCode::Get, "/Users", &mut params),
            10
        );
    }
}
