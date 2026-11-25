// ---- Content-Disposition (RFC 6266 / RFC 8187, after the `content-disposition` package) ----

const CD_ATTR_CHAR_RE = /[\x00-\x20"'()*,/:;<=>?@[\\\]{}\x7f]/g;

/**
 * `attachment; filename="<ascii fallback>"[; filename*=UTF-8''<pct-encoded>]`.
 * The quoted fallback is pure printable ASCII (the engine writes header values as UTF-8, so
 * Latin-1 bytes would not survive); the exact name always travels in `filename*` when needed.
 */
export function contentDisposition(filename?: string, type = 'attachment'): string {
  if (filename === undefined) return type;
  const name = filename;
  const fallback = name.replace(/[^\x20-\x7e]/g, '?');
  let out = `${type}; filename="${fallback.replace(/([\\"])/g, '\\$1')}"`;
  if (fallback !== name || /%[0-9A-Fa-f]{2}/.test(name)) {
    const encoded = encodeURIComponent(name).replace(
      CD_ATTR_CHAR_RE,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
    );
    out += `; filename*=UTF-8''${encoded}`;
  }
  return out;
}

