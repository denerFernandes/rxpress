// `req instanceof http.IncomingMessage` and `res instanceof http.ServerResponse` are true for
// rxpress's request and response, as they are for Express's.
//
// Some libraries guard on these checks. RxRequest and RxResponse are not subclasses of the Node
// classes (an IncomingMessage carries a socket and a stream state that every request would have to
// pay for), so the two Node classes learn to recognise them instead, through `Symbol.hasInstance`.
//
// Only the exact classes are affected: `x instanceof MySubclass` is decided as before. Recognition
// is by a brand (`Symbol.for`), so it holds when a second copy of rxpress (ESM and CJS, say) made
// the object. Like the `http.createServer` interception, this is installed once, on import.
import http from 'node:http';
import { RxRequest } from './request.js';
import { RxResponse } from './response.js';

const REQUEST_BRAND = Symbol.for('rxpress.request');
const RESPONSE_BRAND = Symbol.for('rxpress.response');
const INSTALLED = Symbol.for('rxpress.instanceofPatch');

function brand(proto: object, symbol: symbol): void {
  Object.defineProperty(proto, symbol, { value: true, enumerable: false, configurable: true });
}

function recognise(target: Function, symbol: symbol): void {
  const ordinary = Function.prototype[Symbol.hasInstance];
  Object.defineProperty(target, Symbol.hasInstance, {
    configurable: true,
    writable: true,
    value(this: Function, value: unknown): boolean {
      if (ordinary.call(this, value)) return true;
      // Subclasses inherit this static method; they keep the ordinary answer.
      return (
        this === target &&
        value !== null &&
        typeof value === 'object' &&
        (value as Record<symbol, unknown>)[symbol] === true
      );
    },
  });
}

export function installHttpInstanceof(): void {
  brand(RxRequest.prototype, REQUEST_BRAND);
  brand(RxResponse.prototype, RESPONSE_BRAND);
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;
  recognise(http.IncomingMessage, REQUEST_BRAND);
  recognise(http.ServerResponse, RESPONSE_BRAND);
}
