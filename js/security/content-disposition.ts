// ---- Content-Disposition (RFC 6266 / RFC 8187, after the `content-disposition` package) ----

const CD_ATTR_CHAR_RE = /[\x00-\x20"'()*,/:;<=>?@[\\\]{}\x7f]/g;

const CD_TOKEN_RE = /^[!#$%&'*+.0-9A-Z^_`a-z|~-]+$/;
const CD_ASCII_TEXT_RE = /^[\x20-\x7e]*$/;

/** One parameter: a token as is, anything else as a quoted-string (content-disposition 2). */
function cdParam(name: string, value: string): string {
  return CD_TOKEN_RE.test(value)
    ? `; ${name}=${value}`
    : `; ${name}="${value.replace(/[\\"]/g, '\\$&')}"`;
}

/**
 * `content-disposition` 2 `create()`: `filename` alone when the name is plain ASCII, otherwise
 * an ASCII fallback (`?` for other characters) plus the exact name in `filename*`.
 */
export function contentDisposition(filename?: string, type = 'attachment'): string {
  if (filename === undefined) return type;
  if (CD_ASCII_TEXT_RE.test(filename) && !/%[0-9A-Fa-f]{2}/.test(filename)) {
    return type + cdParam('filename', filename);
  }
  const encoded = encodeURIComponent(filename).replace(
    CD_ATTR_CHAR_RE,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
  );
  return (
    type + cdParam('filename', filename.replace(/[^\x20-\x7e]/g, '?')) + `; filename*=UTF-8''${encoded}`
  );
}

