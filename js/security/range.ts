// ---- Range Parser (matching range-parser) ----

export interface RangeItem {
  start: number;
  end: number;
}

export type RangesResult = (RangeItem[] & { type: string }) | -1 | -2 | undefined;

export function parseRangeHeader(
  size: number,
  str: string | undefined,
  options?: { combine?: boolean }
): RangesResult {
  if (!str || typeof str !== 'string') return undefined;
  const idx = str.indexOf('=');
  if (idx === -1) return -2;

  const type = str.slice(0, idx);
  const arr = str.slice(idx + 1).split(',');
  const ranges: RangeItem[] & { type: string } = Object.assign([] as RangeItem[], { type });
  let valid = true;

  for (let i = 0; i < arr.length; i++) {
    const part = arr[i];
    const dash = part.indexOf('-');
    if (dash === -1) {
      valid = false;
      break;
    }
    const startStr = part.slice(0, dash).trim();
    const endStr = part.slice(dash + 1).trim();

    let start: number;
    let end: number;

    if (startStr === '') {
      // Suffix byte range: -<length>
      if (!/^\d+$/.test(endStr)) {
        valid = false;
        break;
      }
      const suffix = parseInt(endStr, 10);
      start = size - suffix;
      end = size - 1;
    } else if (endStr === '') {
      if (!/^\d+$/.test(startStr)) {
        valid = false;
        break;
      }
      start = parseInt(startStr, 10);
      end = size - 1;
    } else {
      if (!/^\d+$/.test(startStr) || !/^\d+$/.test(endStr)) {
        valid = false;
        break;
      }
      start = parseInt(startStr, 10);
      end = parseInt(endStr, 10);
    }

    if (end > size - 1) {
      end = size - 1;
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0) {
      continue;
    }
    ranges.push({ start, end });
  }

  if (!valid) return -2;
  if (ranges.length < 1) return -1;

  if (options?.combine && ranges.length > 1) {
    const sorted = ranges
      .map((r, i) => ({ start: r.start, end: r.end, idx: i }))
      .sort((a, b) => a.start - b.start);
    const combined: RangeItem[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      const prev = combined[combined.length - 1];
      if (!prev || cur.start > prev.end + 1) {
        combined.push({ start: cur.start, end: cur.end });
      } else if (cur.end > prev.end) {
        prev.end = cur.end;
      }
    }
    return Object.assign(combined, { type });
  }

  return ranges;
}

