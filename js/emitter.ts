/*
 * Lightweight EventEmitter logic shared by `RxRequest` and `RxResponse` (zero overhead unless
 * `.on()` is called: the listener map is only allocated on the first registration).
 *
 * The classes keep `on`/`emit`/... as their own prototype methods (so `express.request.on`,
 * prototype extension and the d.ts stay the same); those methods are thin wrappers over the
 * plain module functions below, which allocate nothing beyond what the original inline
 * implementations did.
 */

export type EventListenerFn = (...args: unknown[]) => void;

/** A `once()` wrapper remembers the original listener (for `off()` and `listeners()`). */
export type TaggedEventListener = EventListenerFn & { listener?: EventListenerFn };

/**
 * What the emitter helpers need from their host object.
 * @internal
 */
export interface EmitterHost {
  _listeners: Map<string, EventListenerFn[]> | null;
  off(event: string, listener: EventListenerFn): unknown;
}

/** @internal Register `listener` for `event`, at the end (or the start when `prepend`). */
export function addEventListener(
  host: EmitterHost,
  event: string,
  listener: EventListenerFn,
  prepend: boolean
): void {
  if (host._listeners === null) {
    host._listeners = new Map();
  }
  let arr = host._listeners.get(event);
  if (!arr) {
    arr = [];
    host._listeners.set(event, arr);
  }
  if (prepend) {
    arr.unshift(listener);
  } else {
    arr.push(listener);
  }
}

/** @internal A one-shot wrapper that unregisters itself (through `host.off`) before calling. */
export function onceWrapper(
  host: EmitterHost,
  event: string,
  listener: EventListenerFn
): TaggedEventListener {
  const wrapper: TaggedEventListener = (...args) => {
    host.off(event, wrapper);
    listener(...args);
  };
  wrapper.listener = listener;
  return wrapper;
}

/** @internal Remove the most recently added registration of `listener` (or its once-wrapper). */
export function removeEventListener(
  host: EmitterHost,
  event: string,
  listener: EventListenerFn
): void {
  if (host._listeners === null) return;
  const arr = host._listeners.get(event);
  if (!arr) return;
  for (let i = arr.length - 1; i >= 0; i--) {
    const fn = arr[i] as TaggedEventListener;
    if (fn === listener || fn.listener === listener) {
      arr.splice(i, 1);
      break;
    }
  }
}

/** @internal */
export function removeAllEventListeners(host: EmitterHost, event?: string): void {
  if (host._listeners === null) return;
  if (event === undefined) {
    host._listeners.clear();
  } else {
    host._listeners.delete(event);
  }
}

/** @internal Listeners for `event`; once-wrappers are unwrapped unless `raw`. */
export function getListeners(host: EmitterHost, event: string, raw: boolean): EventListenerFn[] {
  if (host._listeners === null) return [];
  const arr = host._listeners.get(event);
  if (!arr) return [];
  if (raw) return arr.slice();
  return arr.map((fn) => (fn as TaggedEventListener).listener ?? fn);
}

/** @internal */
export function countListeners(host: EmitterHost, event: string): number {
  if (host._listeners === null) return 0;
  return host._listeners.get(event)?.length ?? 0;
}

/** @internal */
export function getEventNames(host: EmitterHost): string[] {
  if (host._listeners === null) return [];
  const names: string[] = [];
  for (const [k, arr] of host._listeners) {
    if (arr.length > 0) names.push(k);
  }
  return names;
}

/** @internal Call a snapshot of the listeners for `event` with `args`. */
export function emitEvent(host: EmitterHost, event: string, args: unknown[]): boolean {
  if (host._listeners === null) return false;
  const arr = host._listeners.get(event);
  if (!arr || arr.length === 0) return false;
  const snapshot = arr.slice();
  for (let i = 0; i < snapshot.length; i++) {
    snapshot[i](...args);
  }
  return true;
}
