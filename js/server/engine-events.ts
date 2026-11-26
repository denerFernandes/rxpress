/*
 * Lets code that is about to answer a client ask the engine for what it already knows about that
 * client, without waiting for the engine's wake-up to reach the event loop. A client that
 * disconnected moments ago is then seen as gone (`res.sendFile()` does this after its asynchronous
 * file checks). Kept apart from the runtime so the response code does not import it.
 */
export type FileCallback = (err?: Error) => void;

interface Pollable {
  pollEvents(): void;
  expectFile(cb: FileCallback): number;
  cancelFile(token: number): void;
}

const runtimes = new WeakMap<object, Pollable>();

/** @internal Called by the runtime that owns `native`. */
export function registerEngineEvents(native: object, runtime: Pollable): void {
  runtimes.set(native, runtime);
}

/** Delivers the closed-connection notifications the engine has queued so far. */
export function pollEngineEvents(native: object): void {
  runtimes.get(native)?.pollEvents();
}

/**
 * Registers the callback of a `res.sendFile()` call that the engine will answer when the response
 * ends. Returns its token (to put in the file request), or 0 when the engine cannot report (the
 * caller then calls back at once, as before).
 */
export function expectFileResult(native: object, cb: FileCallback): number {
  return runtimes.get(native)?.expectFile(cb) ?? 0;
}

/** Forgets a callback whose file request never reached the engine. */
export function cancelFileResult(native: object, token: number): void {
  runtimes.get(native)?.cancelFile(token);
}
