import { BODY_MODE_TOO_LARGE, BODY_MODE_URLENCODED } from '../protocol.js';
import type { RxRequest } from '../request.js';
import type { RxResponse } from '../response.js';
import { countFormParameters, createHttpError, parseUrlencodedBody } from '../security.js';
import type { NextFunction, RequestHandler, UrlencodedOptions } from '../types.js';
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
 * Express-compatible `express.urlencoded(options)` backed by Rust body ingestion.
 */
export function urlencoded(opts?: UrlencodedOptions): RequestHandler {
  const options: UrlencodedOptions = opts ?? {};
  const limit = parseSizeLimit(options.limit, 100 * 1024);
  const extended = Boolean(options.extended);
  const inflate = options.inflate !== false;
  checkVerifyOption(options.verify);
  const parameterLimit = options.parameterLimit ?? 1000;
  if (
    typeof parameterLimit !== 'number' ||
    Number.isNaN(parameterLimit) ||
    parameterLimit < 1
  ) {
    throw new TypeError('option parameterLimit must be a positive number');
  }
  const { list, customFn } = normalizeTypes(options.type, ['application/x-www-form-urlencoded']);

  const handler: RequestHandler = (req: RxRequest, res: RxResponse, next: NextFunction) => {
    if (req._bodyMode === BODY_MODE_TOO_LARGE) {
      return next(createHttpError(413, 'request entity too large', 'entity.too.large'));
    }

    if (!shouldParse(req, BODY_MODE_URLENCODED, list, customFn)) {
      return next();
    }

    const charset = requestCharset(req) ?? 'utf-8';
    if (charset !== 'utf-8' && charset !== 'iso-8859-1') {
      return next(unsupportedCharset(charset));
    }
    withParsedBody(req, res, next, limit, inflate, options.verify, charset, (body) => {
      const str = body as string;
      const paramCount = countFormParameters(str, parameterLimit);
      if (paramCount === undefined) {
        return next(createHttpError(413, 'too many parameters', 'parameters.too.many'));
      }
      try {
        req.body = parseUrlencodedBody(str, extended, parameterLimit, paramCount);
      } catch (err) {
        return next(err);
      }
      next();
    });
  };

  nativeMiddlewareMeta.set(handler, {
    __rxNativeKind: 'urlencoded',
    limit,
    contentTypes: list,
  });
  return handler;
}
