#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum BodyMode {
    None = 0,
    Json = 1,
    UrlEncoded = 2,
    Text = 3,
    Raw = 4,
    TooLarge = 5,
    /// Body not buffered: streamed to JS by `reqbody::BodyPump`.
    Streamed = 6,
}

#[derive(Debug, Clone)]
pub struct BodyRule {
    pub prefix: String,
    pub mode: BodyMode,
    pub limit: usize,
    pub content_types: Vec<String>,
    /// Mirrors Express `case sensitive routing` (default `false`).
    pub case_sensitive: bool,
}

impl BodyRule {
    pub fn matches_path(&self, path: &str) -> bool {
        if self.prefix.is_empty() || self.prefix == "/" {
            return true;
        }
        if self.prefix.contains(':') || self.prefix.contains('*') {
            return matches_dynamic_prefix(&self.prefix, path, self.case_sensitive);
        }
        let p = self.prefix.as_bytes();
        let b = path.as_bytes();
        if b.len() < p.len() || !seg_eq(&b[..p.len()], p, self.case_sensitive) {
            return false;
        }
        // Byte-equal up to ASCII case, so `p.len()` is a char boundary in `path` as well.
        let rest = &b[p.len()..];
        rest.is_empty() || rest[0] == b'/' || self.prefix.ends_with('/')
    }

    pub fn matches_content_type(&self, content_type: &str) -> bool {
        let mime = content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if mime.is_empty() {
            return false;
        }
        for pat in &self.content_types {
            if matches_mime(&mime, pat) {
                return true;
            }
        }
        false
    }
}

fn next_seg(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start_matches('/');
    if s.is_empty() {
        return None;
    }
    match s.find('/') {
        Some(idx) => Some((&s[..idx], &s[idx + 1..])),
        None => Some((s, "")),
    }
}

#[inline]
fn seg_eq(a: &[u8], b: &[u8], case_sensitive: bool) -> bool {
    if case_sensitive {
        a == b
    } else {
        a.eq_ignore_ascii_case(b)
    }
}

fn matches_dynamic_prefix(mut pattern: &str, mut path: &str, case_sensitive: bool) -> bool {
    while let Some((pat_seg, pat_rest)) = next_seg(pattern) {
        if pat_seg.starts_with('*') {
            if next_seg(pat_rest).is_none() {
                return true;
            }
            let mut cur_path = path;
            loop {
                if matches_dynamic_prefix(pat_rest, cur_path, case_sensitive) {
                    return true;
                }
                match next_seg(cur_path) {
                    Some((_, next_path)) => cur_path = next_path,
                    None => return false,
                }
            }
        }
        let Some((path_seg, path_rest)) = next_seg(path) else {
            return false;
        };
        if !pat_seg.starts_with(':')
            && !seg_eq(pat_seg.as_bytes(), path_seg.as_bytes(), case_sensitive)
        {
            return false;
        }
        pattern = pat_rest;
        path = path_rest;
    }
    true
}

fn matches_mime(actual: &str, pattern: &str) -> bool {
    let pat = pattern.trim().to_ascii_lowercase();
    if pat == "*/*" || pat == "*" {
        return true;
    }
    if pat == actual {
        return true;
    }
    if let Some(suffix) = pat.strip_prefix("*/") {
        if let Some((_, sub)) = actual.split_once('/') {
            return sub == suffix
                || sub
                    .strip_suffix(suffix)
                    .is_some_and(|prefix| prefix.ends_with('+'));
        }
    }
    if let Some(prefix) = pat.strip_suffix("/*") {
        if let Some((main, _)) = actual.split_once('/') {
            return main == prefix;
        }
    }
    if let Some(suffix) = pat.strip_prefix("application/*+") {
        if let Some(sub) = actual.strip_prefix("application/") {
            return sub
                .strip_suffix(suffix)
                .is_some_and(|prefix| prefix.ends_with('+'));
        }
    }
    false
}

/// Determine which body parser rule applies (if any) and the max allowed body limit.
#[inline]
pub fn resolve_body_rule(
    rules: &[BodyRule],
    path: &str,
    content_type: Option<&str>,
    default_limit: usize,
) -> (BodyMode, usize) {
    if let Some(ct) = content_type {
        if !ct.is_empty() {
            for rule in rules {
                if rule.matches_path(path) && rule.matches_content_type(ct) {
                    return (rule.mode, rule.limit);
                }
            }
        }
    }
    (BodyMode::None, default_limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_path_boundaries() {
        let root_rule = BodyRule {
            prefix: "/".into(),
            mode: BodyMode::Json,
            limit: 100,
            content_types: vec!["application/json".into()],
            case_sensitive: false,
        };
        assert!(root_rule.matches_path("/anything"));

        let api_rule = BodyRule {
            prefix: "/api".into(),
            mode: BodyMode::Json,
            limit: 100,
            content_types: vec!["application/json".into()],
            case_sensitive: false,
        };
        assert!(api_rule.matches_path("/api"));
        assert!(api_rule.matches_path("/api/users"));
        assert!(!api_rule.matches_path("/apiv2"));
    }

    #[test]
    fn matches_dynamic_param_and_wildcard_prefixes_without_bleed() {
        let upload_rule = BodyRule {
            prefix: "/tenants/:tid/upload".into(),
            mode: BodyMode::Json,
            limit: 5 * 1024 * 1024,
            content_types: vec!["application/json".into()],
            case_sensitive: false,
        };
        assert!(upload_rule.matches_path("/tenants/acme/upload"));
        assert!(upload_rule.matches_path("/tenants/acme/upload/part"));
        assert!(!upload_rule.matches_path("/tenants/acme/default-limit"));
        assert!(!upload_rule.matches_path("/tenants/acme/upload2"));
        assert!(!upload_rule.matches_path("/tenants/acme"));
        assert!(!upload_rule.matches_path("/"));

        let wild_rule = BodyRule {
            prefix: "/files/*splat".into(),
            mode: BodyMode::Raw,
            limit: 2 * 1024 * 1024,
            content_types: vec!["application/octet-stream".into()],
            case_sensitive: false,
        };
        assert!(wild_rule.matches_path("/files"));
        assert!(wild_rule.matches_path("/files/a/b.bin"));
        assert!(!wild_rule.matches_path("/other/a/b.bin"));

        let mid_wild = BodyRule {
            prefix: "/orgs/*/upload".into(),
            mode: BodyMode::Json,
            limit: 4096,
            content_types: vec!["application/json".into()],
            case_sensitive: false,
        };
        assert!(mid_wild.matches_path("/orgs/a/b/upload"));
        assert!(!mid_wild.matches_path("/orgs/a/default-limit"));

        let rules = vec![upload_rule];
        assert_eq!(
            resolve_body_rule(
                &rules,
                "/tenants/acme/upload",
                Some("application/json"),
                1024
            ),
            (BodyMode::Json, 5 * 1024 * 1024)
        );
        assert_eq!(
            resolve_body_rule(
                &rules,
                "/tenants/acme/default-limit",
                Some("application/json"),
                1024
            ),
            (BodyMode::None, 1024)
        );
    }

    #[test]
    fn matches_path_honours_case_sensitive_routing() {
        let mut rule = BodyRule {
            prefix: "/upload".into(),
            mode: BodyMode::Json,
            limit: 5 * 1024 * 1024,
            content_types: vec!["application/json".into()],
            case_sensitive: false,
        };
        assert!(rule.matches_path("/UPLOAD"));
        assert!(rule.matches_path("/Upload/part"));
        assert!(!rule.matches_path("/UPLOADS"));
        rule.case_sensitive = true;
        assert!(!rule.matches_path("/UPLOAD"));
        assert!(rule.matches_path("/upload"));

        let mut dynamic = BodyRule {
            prefix: "/ci/:id/upload".into(),
            mode: BodyMode::Json,
            limit: 5 * 1024 * 1024,
            content_types: vec!["application/json".into()],
            case_sensitive: false,
        };
        assert!(dynamic.matches_path("/CI/123/UPLOAD"));
        dynamic.case_sensitive = true;
        assert!(!dynamic.matches_path("/CI/123/UPLOAD"));
        assert!(dynamic.matches_path("/ci/123/upload"));

        let multibyte = BodyRule {
            prefix: "/café".into(),
            mode: BodyMode::Json,
            limit: 10,
            content_types: vec!["application/json".into()],
            case_sensitive: false,
        };
        assert!(multibyte.matches_path("/CAFé/x"));
        assert!(!multibyte.matches_path("/CAFÉ"));
    }

    #[test]
    fn matches_content_type_wildcards_and_suffixes() {
        let rule = BodyRule {
            prefix: "/".into(),
            mode: BodyMode::Json,
            limit: 1024,
            content_types: vec!["application/json".into(), "application/*+json".into()],
            case_sensitive: false,
        };
        assert!(rule.matches_content_type("application/json; charset=utf-8"));
        assert!(rule.matches_content_type("Application/Problem+JSON"));
        assert!(!rule.matches_content_type("text/plain"));
        assert!(!rule.matches_content_type("application/notjson"));

        let star = BodyRule {
            prefix: "/".into(),
            mode: BodyMode::Raw,
            limit: 512,
            content_types: vec!["*/json".into(), "text/*".into()],
            case_sensitive: false,
        };
        assert!(star.matches_content_type("application/ld+json"));
        assert!(star.matches_content_type("text/csv"));
        assert!(!star.matches_content_type("image/png"));
    }

    #[test]
    fn resolve_body_rule_respects_order_and_default_limit() {
        let rules = vec![
            BodyRule {
                prefix: "/webhooks".into(),
                mode: BodyMode::Raw,
                limit: 8192,
                content_types: vec!["application/json".into()],
                case_sensitive: false,
            },
            BodyRule {
                prefix: "/".into(),
                mode: BodyMode::Json,
                limit: 1024,
                content_types: vec!["application/json".into()],
                case_sensitive: false,
            },
        ];
        assert_eq!(
            resolve_body_rule(&rules, "/webhooks/stripe", Some("application/json"), 65536),
            (BodyMode::Raw, 8192)
        );
        assert_eq!(
            resolve_body_rule(&rules, "/api/users", Some("application/json"), 65536),
            (BodyMode::Json, 1024)
        );
        assert_eq!(
            resolve_body_rule(&rules, "/api/users", Some("text/plain"), 65536),
            (BodyMode::None, 65536)
        );
        assert_eq!(
            resolve_body_rule(&rules, "/api/users", None, 4096),
            (BodyMode::None, 4096)
        );
    }
}
