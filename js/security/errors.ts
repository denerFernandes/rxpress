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
