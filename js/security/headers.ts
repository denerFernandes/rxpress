// ---- Header Token & Value Validation (RFC 9110) ----

const TCHAR_CHARS =
  "!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const TCHAR_TABLE = new Uint8Array(128);
for (let i = 0; i < TCHAR_CHARS.length; i++) {
  TCHAR_TABLE[TCHAR_CHARS.charCodeAt(i)] = 1;
}

export function isValidHeaderName(name: string): boolean {
  if (name.length === 0) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c >= 128 || TCHAR_TABLE[c] === 0) {
      return false;
    }
  }
  return true;
}

/** Node's `checkInvalidHeaderChar`: `/[^\t\x20-\x7e\x80-\xff]/` (code units above 0xFF too). */
export function hasInvalidHeaderValue(val: string): boolean {
  for (let i = 0; i < val.length; i++) {
    const c = val.charCodeAt(i);
    if ((c < 32 && c !== 9) || c === 127 || c > 255) {
      return true;
    }
  }
  return false;
}

export function validateHeaderName(name: string): string {
  if (typeof name !== 'string' || !isValidHeaderName(name)) {
    const err = new TypeError(`Header name must be a valid HTTP token ["${String(name)}"]`);
    (err as NodeJS.ErrnoException).code = 'ERR_INVALID_HTTP_TOKEN';
    throw err;
  }
  return name;
}

export function validateHeaderValue(name: string, val: string): string {
  if (hasInvalidHeaderValue(val)) {
    const err = new TypeError(`Invalid character in header content ["${name}"]`);
    (err as NodeJS.ErrnoException).code = 'ERR_INVALID_CHAR';
    throw err;
  }
  return val;
}
