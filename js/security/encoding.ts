// `encodeurl`: percent-encode a URL without double-encoding existing `%XX` escapes.
const ENCODE_CHARS_REGEXP =
  /(?:[^\x21\x23-\x3B\x3D\x3F-\x5F\x61-\x7A\x7C\x7E]+|%+(?![0-9A-Fa-f]{2})){1,1024}/g;
const SURROGATE_REGEXP = /([\uD800-\uDBFF][\uDC00-\uDFFF])|[\uD800-\uDFFF]/g;

export function encodeUrl(url: string): string {
  return String(url)
    .replace(SURROGATE_REGEXP, (_m: string, pair: string | undefined) => pair || '\uFFFD')
    .replace(ENCODE_CHARS_REGEXP, encodeURI);
}

/** `escape-html` */
export function escapeHtmlText(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );
}
