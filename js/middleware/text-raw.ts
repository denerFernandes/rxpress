import { BODY_MODE_RAW, BODY_MODE_TEXT, BODY_MODE_TOO_LARGE } from '../protocol.js';
import type { RxRequest } from '../request.js';
import type { RxResponse } from '../response.js';
import { createHttpError } from '../security.js';
import type { NextFunction, RawOptions, RequestHandler, TextOptions } from '../types.js';
import {
  nativeMiddlewareMeta,
  parseSizeLimit,
  normalizeTypes,
  requestCharset,
  withParsedBody,
  shouldParse,
  checkVerifyOption,
} from './body-common.js';

/**
 * Express-compatible `express.text(options)` backed by Rust body ingestion.
 */
export function text(opts?: TextOptions): RequestHandler {
  const options: TextOptions = opts ?? {};
  const limit = parseSizeLimit(options.limit, 100 * 1024);
  const defaultCharset = (options.defaultCharset || 'utf-8').toLowerCase();
  const inflate = options.inflate !== false;
  checkVerifyOption(options.verify);
  const { list, customFn } = normalizeTypes(options.type, ['text/plain']);

  const handler: RequestHandler = (req: RxRequest, res: RxResponse, next: NextFunction) => {
    if (req._bodyMode === BODY_MODE_TOO_LARGE) {
      return next(createHttpError(413, 'request entity too large', 'entity.too.large'));
    }

    if (!shouldParse(req, BODY_MODE_TEXT, list, customFn)) {
      return next();
    }

    const charset = requestCharset(req) ?? defaultCharset;
    withParsedBody(req, res, next, limit, inflate, options.verify, charset, (body) => {
      req.body = body as string;
      next();
    });
  };

  nativeMiddlewareMeta.set(handler, {
    __rxNativeKind: 'text',
    limit,
    contentTypes: list,
  });
  return handler;
}

/**
 * Express-compatible `express.raw(options)` backed by Rust body ingestion.
 */
export function raw(opts?: RawOptions): RequestHandler {
  const options: RawOptions = opts ?? {};
  const limit = parseSizeLimit(options.limit, 100 * 1024);
  const inflate = options.inflate !== false;
  checkVerifyOption(options.verify);
  const { list, customFn } = normalizeTypes(options.type, ['application/octet-stream']);

  const handler: RequestHandler = (req: RxRequest, res: RxResponse, next: NextFunction) => {
    if (req._bodyMode === BODY_MODE_TOO_LARGE) {
      return next(createHttpError(413, 'request entity too large', 'entity.too.large'));
    }

    if (!shouldParse(req, BODY_MODE_RAW, list, customFn)) {
      return next();
    }

    withParsedBody(req, res, next, limit, inflate, options.verify, null, (body) => {
      // Own the bytes: the batch buffer behind `_getRawBody()` is reused.
      req.body = Buffer.from(body as Buffer);
      next();
    });
  };

  nativeMiddlewareMeta.set(handler, {
    __rxNativeKind: 'raw',
    limit,
    contentTypes: list,
  });
  return handler;
}
