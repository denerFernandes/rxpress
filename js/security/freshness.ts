// ---- HTTP Freshness Check (matching fresh) ----

const CACHE_CONTROL_NO_CACHE_REGEXP = /(?:^|,)\s*?no-cache\s*?(?:,|$)/i;

export function checkFreshness(
  cacheControl: string | undefined,
  ifNoneMatch: string | undefined,
  ifModifiedSince: string | undefined,
  etag: string | undefined,
  lastModified: string | undefined
): boolean {
  if (!ifNoneMatch && !ifModifiedSince) return false;
  if (cacheControl && CACHE_CONTROL_NO_CACHE_REGEXP.test(cacheControl)) return false;

  if (ifNoneMatch) {
    if (ifNoneMatch.trim() !== '*') {
      if (!etag) return false;
      let etagStale = true;
      const parts = ifNoneMatch.split(',');
      for (let i = 0; i < parts.length; i++) {
        const match = parts[i].trim();
        if (match === etag || match === `W/${etag}` || `W/${match}` === etag) {
          etagStale = false;
          break;
        }
      }
      if (etagStale) return false;
    }
  }

  if (ifModifiedSince) {
    if (!lastModified) return false;
    const imsDate = Date.parse(ifModifiedSince);
    const lmDate = Date.parse(lastModified);
    if (Number.isNaN(imsDate) || Number.isNaN(lmDate) || lmDate > imsDate) {
      return false;
    }
  }

  return true;
}

