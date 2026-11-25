/*
 * Node's `OutgoingMessage.prototype.setHeader/getHeader/removeHeader` called directly on an
 * `RxResponse` (the `cookies` package does this, so `cookie-session` relies on it) read and write
 * the internal `kOutHeaders` table. `RxResponse` exposes that slot as a view over its own headers,
 * built only when such code touches it.
 */
import { OutgoingMessage } from 'node:http';
import type { RxResponse } from './response.js';
import { putHeader, readHeader, readHeaders } from './response-headers.js';

type Entry = [string, string | string[]];

const kOutHeaders: symbol | undefined = Object.getOwnPropertySymbols(new OutgoingMessage()).find(
  (s) => s.description === 'kOutHeaders'
);

const views = new WeakMap<RxResponse, Record<string, Entry>>();

function outHeadersView(res: RxResponse): Record<string, Entry> {
  let view = views.get(res);
  if (view !== undefined) return view;
  view = new Proxy(Object.create(null) as Record<string, Entry>, {
    get(_t, key) {
      if (typeof key !== 'string') return undefined;
      const v = readHeader(res, key);
      return v === undefined ? undefined : ([key, v] as Entry);
    },
    set(_t, key, entry) {
      if (typeof key !== 'string') return false;
      const [name, value] = Array.isArray(entry) ? (entry as Entry) : [key, entry as string];
      putHeader(res, name, value);
      return true;
    },
    deleteProperty(_t, key) {
      if (typeof key === 'string') res.removeHeader(key);
      return true;
    },
    has(_t, key) {
      return typeof key === 'string' && readHeader(res, key) !== undefined;
    },
    ownKeys() {
      return Object.keys(readHeaders(res));
    },
    getOwnPropertyDescriptor(_t, key) {
      if (typeof key !== 'string') return undefined;
      const v = readHeader(res, key);
      return v === undefined
        ? undefined
        : { value: [key, v] as Entry, writable: true, enumerable: true, configurable: true };
    },
  });
  views.set(res, view);
  return view;
}

/** @internal Installs the `kOutHeaders` view on `RxResponse.prototype`. */
export function installOutHeadersView(proto: object): void {
  if (kOutHeaders === undefined) return;
  // Node 24+'s setHeader asks whether lenient header validation applies (never, here).
  if (!('_isLenientHeaderValidation' in proto)) {
    Object.defineProperty(proto, '_isLenientHeaderValidation', {
      configurable: true,
      writable: true,
      value: () => false,
    });
  }
  Object.defineProperty(proto, kOutHeaders, {
    configurable: true,
    get(this: RxResponse) {
      return outHeadersView(this);
    },
    set(this: RxResponse, value: unknown) {
      // `removeHeader`/`setHeader` on an empty table assign a fresh object: copy it over.
      if (value && typeof value === 'object') {
        for (const [k, entry] of Object.entries(value as Record<string, Entry>)) {
          outHeadersView(this)[k] = entry;
        }
      }
    },
  });
}
