import { EventEmitter } from 'node:events';
import type { RxRequest } from './request.js';

/**
 * `req.socket` / `res.socket`: a `net.Socket`-shaped EventEmitter for the connection.
 * Built lazily on first access; it emits 'close' when the client goes away before the
 * response finished (what on-finished, morgan and friends listen for).
 */
export class RxSocket extends EventEmitter {
  public readable = true;
  public writable = true;
  public destroyed = false;
  public readonly remoteAddress: string;
  public readonly remoteFamily: string;
  public readonly encrypted: boolean;
  public timeout: number | undefined = undefined;
  /** @internal */
  declare private readonly _ownerReq: RxRequest;

  constructor(req: RxRequest, remoteAddress: string, encrypted: boolean) {
    super();
    Object.defineProperty(this, '_ownerReq', { value: req, enumerable: false });
    this.remoteAddress = remoteAddress;
    this.remoteFamily = remoteAddress.includes(':') ? 'IPv6' : 'IPv4';
    this.encrypted = encrypted;
  }

  /** The client's TCP port (undefined when the request came through the Node bridge). */
  get remotePort(): number | undefined {
    return this._ownerReq._getRemotePort();
  }

  public setTimeout(msecs: number, cb?: () => void): this {
    this.timeout = msecs;
    if (cb) this.once('timeout', cb);
    return this;
  }

  public setNoDelay(noDelay?: boolean): this {
    void noDelay;
    return this;
  }

  public setKeepAlive(enable?: boolean, initialDelay?: number): this {
    void enable;
    void initialDelay;
    return this;
  }

  public ref(): this {
    return this;
  }

  public unref(): this {
    return this;
  }

  /** Destroying the socket aborts the response, like `socket.destroy()` in Node. */
  public destroy(err?: Error): this {
    if (!this.destroyed) {
      const res = this._ownerReq.res;
      if (res && !res.destroyed) res.destroy(err);
      this._markClosed(err !== undefined);
    }
    return this;
  }

  /** @internal */
  public _markClosed(hadError: boolean): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.readable = false;
    this.writable = false;
    this.emit('close', hadError);
  }
}
