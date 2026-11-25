import { BODY_MODE_JSON, BODY_MODE_TOO_LARGE } from '../protocol.js';
import type { RxRequest } from '../request.js';
import type { RxResponse } from '../response.js';
import { createHttpError, safeJsonParse } from '../security.js';
import type { JsonOptions, NextFunction, RequestHandler } from '../types.js';
import {
  nativeMiddlewareMeta,
  parseSizeLimit,
  normalizeTypes,
  requestCharset,
  unsupportedCharset,
  withParsedBody,
  shouldParse,
  checkVerifyOption,
} from './body-common.js';

/**
 * Express-compatible `express.json(options)` backed by Rust body ingestion & limit enforcement.
 */
export function json(opts?: JsonOptions): RequestHandler {
  const options: JsonOptions = opts ?? {};
  const limit = parseSizeLimit(options.limit, 100 * 1024);
  const strict = options.strict !== false;
  const inflate = options.inflate !== false;
  checkVerifyOption(options.verify);
  const { list, customFn } = normalizeTypes(options.type, [
    'application/json',
    'application/*+json',
  ]);

  const handler: RequestHandler = (req: RxRequest, res: RxResponse, next: NextFunction) => {
    if (req._bodyMode === BODY_MODE_TOO_LARGE) {
      return next(createHttpError(413, 'request entity too large', 'entity.too.large'));
    }

    if (!shouldParse(req, BODY_MODE_JSON, list, customFn)) {
      return next();
    }

    const charset = requestCharset(req) ?? 'utf-8';
    if (!charset.startsWith('utf-')) {
      return next(unsupportedCharset(charset));
    }
    withParsedBody(req, res, next, limit, inflate, options.verify, charset, (body) => {
      const str = body as string;
      if (str.length === 0) {
        req.body = {};
        return next();
      }
      try {
        req.body = safeJsonParse(str, { strict, reviver: options.reviver });
      } catch (err) {
        return next(err);
      }
      next();
    });
  };

  nativeMiddlewareMeta.set(handler, {
    __rxNativeKind: 'json',
    limit,
    contentTypes: list,
  });
  return handler;
}
