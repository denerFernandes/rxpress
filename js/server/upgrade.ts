/**
 * HTTP Upgrade (WebSocket...): the engine hands the connection over as a socket, delivered as an
 * `'upgrade'` event on the server object(s) the user holds.
 */
import type { EventEmitter } from 'node:events';
import { closeSync } from 'node:fs';
import { Socket } from 'node:net';
import type { NativeServerInstance } from '../native.js';
import type { RxRequest, RxSocket } from '../request.js';
import type { ServerHandle } from '../types.js';

/** Per server handle: register another emitter whose 'upgrade' listeners receive upgrades. */
const upgradeTargetHooks = new WeakMap<ServerHandle, (target: EventEmitter) => void>();

/**
 * Deliver this handle's `'upgrade'` events to `target` too (an `http.createServer()` wrapper):
 * Node emits them on the server object the user holds.
 */
export function addUpgradeTarget(handle: ServerHandle, target: EventEmitter): void {
  upgradeTargetHooks.get(handle)?.(target);
}

/** Lifecycle view of the owning server (upgrades stop being toggled once it closed). */
interface ClosedFlag {
  readonly closed: boolean;
}

/** The emitters of one server whose `'upgrade'` listeners receive handed-over connections. */
export class UpgradeTargets {
  private readonly targets: EventEmitter[] = [];

  constructor(
    private readonly native: NativeServerInstance,
    private readonly server: ClosedFlag
  ) {}

  /** Expose `watch` through `addUpgradeTarget(handle, ...)` and watch `handle` itself. */
  public attach(handle: ServerHandle): void {
    upgradeTargetHooks.set(handle, this.watch);
    this.watch(handle);
  }

  /** Enable engine-side upgrades only while some target has an `'upgrade'` listener. */
  public readonly refresh = (): void => {
    if (this.server.closed) return;
    const upgradeTargets = this.targets;
    let on = false;
    for (let i = 0; i < upgradeTargets.length; i++) {
      if (upgradeTargets[i].listenerCount('upgrade') > 0) on = true;
    }
    this.native.setUpgradeEnabled?.(on);
  };

  public readonly watch = (target: EventEmitter): void => {
    const upgradeTargets = this.targets;
    if (upgradeTargets.includes(target)) return;
    upgradeTargets.push(target);
    target.on('newListener', (event: string | symbol) => {
      if (event === 'upgrade') process.nextTick(this.refresh);
    });
    target.on('removeListener', (event: string | symbol) => {
      if (event === 'upgrade') this.refresh();
    });
    this.refresh();
  };

  public dispatch(req: RxRequest): void {
    const taken = this.native.takeUpgrade?.(req._reqId);
    if (!taken) return;
    const fd = taken[0] as number;
    const head = taken[1] as Buffer;
    // The user's server object wins (http.createServer wrapper), else the listen() handle.
    const upgradeTargets = this.targets;
    let target: EventEmitter | null = null;
    for (let i = upgradeTargets.length - 1; i >= 0; i--) {
      if (upgradeTargets[i].listenerCount('upgrade') > 0) {
        target = upgradeTargets[i];
        break;
      }
    }
    let socket: Socket;
    try {
      socket = new Socket({ fd, readable: true, writable: true });
    } catch {
      try {
        closeSync(fd);
      } catch {
        // already gone
      }
      return;
    }
    if (req._isTls) {
      // TLS is terminated by the engine; the socket carries the decrypted stream.
      const remote = req._getRemoteAddr();
      Object.defineProperty(socket, 'encrypted', { value: true, configurable: true });
      Object.defineProperty(socket, 'remoteAddress', { value: remote, configurable: true });
      Object.defineProperty(socket, 'remoteFamily', {
        value: remote.includes(':') ? 'IPv6' : 'IPv4',
        configurable: true,
      });
    }
    req._socket = socket as unknown as RxSocket;
    if (target === null) {
      socket.destroy();
      return;
    }
    try {
      target.emit('upgrade', req, socket, head);
    } catch (err) {
      // Node: a throwing 'upgrade' listener is an uncaught exception.
      process.nextTick(() => {
        throw err;
      });
    }
  }
}
