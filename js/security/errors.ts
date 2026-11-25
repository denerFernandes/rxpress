import { STATUS_CODES } from 'node:http';

export function createHttpError(
  status: number,
  message: string,
  type: string
): Error & { status: number; statusCode: number; type: string; expose: boolean } {
  return Object.assign(new Error(message), {
    status,
    statusCode: status,
    // http-errors: client errors are safe to show (frameworks such as NestJS key on this).
    expose: status < 500,
    type,
  });
}

type HttpErrorShape = Error & { status: number; statusCode: number; expose: boolean };

const httpErrorClasses = new Map<number, new (message: string) => Error>();

/** http-errors class name for a status: 404 -> `NotFoundError`. */
function httpErrorName(status: number): string {
  const msg = STATUS_CODES[status] ?? String(status);
  const id = msg
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
    .replace(/[^ _0-9a-z]/gi, '');
  return id.endsWith('Error') ? id : id + 'Error';
}

/**
 * `http-errors`' `createError(status[, err])` as `send` uses it: a named error
 * (`ForbiddenError: Forbidden`), or `err` itself tagged with the status.
 */
export function httpError(status: number, cause?: unknown): HttpErrorShape {
  if (cause instanceof Error) {
    return Object.assign(cause, { status, statusCode: status, expose: false });
  }
  let Cls = httpErrorClasses.get(status);
  if (Cls === undefined) {
    const name = httpErrorName(status);
    Cls = { [name]: class extends Error {} }[name];
    Object.defineProperty(Cls.prototype, 'name', {
      value: name,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    httpErrorClasses.set(status, Cls);
  }
  const err = new Cls(STATUS_CODES[status] ?? String(status));
  return Object.assign(err, { status, statusCode: status, expose: status < 500 });
}
