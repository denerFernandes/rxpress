/**
 * Streamed request bodies and engine stream notifications: body-ready events for requests whose
 * body the engine streams, and close/drain events for responses still in flight.
 */
import type { NativeServerInstance } from '../native.js';
import type { BodySource, RxRequest } from '../request.js';

/**
 * Where streamed bodies of one server come from. `bodies` holds the requests whose body the
 * engine streams (no native parser buffered it), by request id.
 */
export function createBodySource(native: NativeServerInstance): BodySource {
  return {
    takeRequestBody: (id: number) => native.takeRequestBody(id),
    releaseRequestBody: (id: number) => native.releaseRequestBody(id),
    bodies: new Map<number, RxRequest>(),
  };
}

/**
 * Deliver one `drainStreamEvents()` result:
 * `[closedCount, drainedCount, ...closed, ...drained, ...bodyReady]`.
 */
export function deliverStreamEvents(
  events: Uint32Array,
  bodyStreams: Map<number, RxRequest>,
  activeStreams: Map<number, RxRequest>
): void {
  const closedEnd = Math.min(2 + events[0], events.length);
  const drainedEnd = Math.min(closedEnd + events[1], events.length);
  // Body chunks first: a client that closes right after its last byte still delivers it.
  for (let i = drainedEnd; i < events.length; i++) {
    const req = bodyStreams.get(events[i]);
    if (req) {
      try {
        req._onBodyReady();
      } catch {
        // Isolate user listener error so drainLoop continues cleanly
      }
    }
  }
  for (let i = 2; i < closedEnd; i++) {
    const id = events[i];
    const req = activeStreams.get(id);
    if (req) {
      activeStreams.delete(id);
      try {
        req.res._onNativeClose();
      } catch {
        // Isolate user listener error so drainLoop continues cleanly
      }
    }
  }
  for (let i = closedEnd; i < drainedEnd; i++) {
    const id = events[i];
    const req = activeStreams.get(id);
    if (req) {
      try {
        req.res._onNativeDrain();
      } catch {
        // Isolate user listener error so drainLoop continues cleanly
      }
    }
  }
}

/** Older engines: only closed-stream ids (`drainClosedStreams()`). */
export function deliverClosedStreams(
  closedIds: Uint32Array,
  activeStreams: Map<number, RxRequest>
): void {
  for (let i = 0; i < closedIds.length; i++) {
    const id = closedIds[i];
    const req = activeStreams.get(id);
    if (req) {
      activeStreams.delete(id);
      try {
        req.res._onNativeClose();
      } catch {
        // Isolate user listener error so drainLoop continues cleanly
      }
    }
  }
}
