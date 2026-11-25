/**
 * The end of the middleware chain (finalhandler@2 parity): 404 / error pages, OPTIONS `Allow`
 * answers, bridged "unhandled" hand-backs, and the last-resort 500.
 */
import { STATUS_CODES } from 'node:http';
import type { Application } from '../application.js';
import { BRIDGE_NEXT_HEADER } from '../bridge.js';
import { CT_TEXT_PLAIN, type ResponseBatchWriter } from '../protocol.js';
import type { RxRequest } from '../request.js';
import type { RxResponse } from '../response.js';
import { encodeUrl, escapeHtmlText } from '../security.js';

const FINAL_ERROR_HEADERS = new Map<string, string | string[]>([
  ['x-content-type-options', 'nosniff'],
  ['content-security-policy', "default-src 'none'"],
]);

/** Bridged request with a parent `next`: hand "unhandled"/errors back instead of answering. */
function answerBridgeNext(res: RxResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader(BRIDGE_NEXT_HEADER, status === 404 && message === '' ? '0' : String(status));
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(message);
}

/**
 * Last-resort 500 when user code left `req`/`res` unusable (e.g. `Object.freeze(res)`).
 * Never throws and never answers the same request twice, so the rest of a pipelined
 * batch keeps flowing.
 */
export function emergencyAnswer(writer: ResponseBatchWriter, req: RxRequest, res: RxResponse): void {
  let ended = true;
  try {
    ended = res.writableEnded || res._streaming;
  } catch {
    ended = false;
  }
  if (ended || writer.lastReqId === req._reqId) return;
  try {
    writer.writeFastString(
      req._reqId,
      500,
      CT_TEXT_PLAIN,
      0,
      FINAL_ERROR_HEADERS,
      'Internal Server Error'
    );
  } catch {
    // Ignore secondary errors if native handle is already closed
  }
  try {
    res.writableEnded = true;
    res.finished = true;
  } catch {
    // Frozen/sealed response: state is tracked through writer.lastReqId instead
  }
}

/** The `done` callback the router calls when no layer answered `req`. */
export function makeFinalHandler(
  app: Application,
  writer: ResponseBatchWriter,
  req: RxRequest,
  res: RxResponse
): (err?: unknown) => void {
  return (err?: unknown) => {
    if (res.writableEnded) return;
    if (res.headersSent) {
      if (err !== undefined && err !== null && res._streaming) {
        res.destroy();
      }
      return;
    }
    try {
      finalAnswer(app, req, res, err);
    } catch {
      emergencyAnswer(writer, req, res);
    }
  };
}

function finalAnswer(app: Application, req: RxRequest, res: RxResponse, err: unknown): void {
  let status: number;
  let msg: string;
  let errHeaders: Record<string, string | string[]> | undefined;
  if (err !== undefined && err !== null) {
    const errObj = err as {
      status?: number;
      statusCode?: number;
      headers?: Record<string, string | string[]>;
      message?: string;
      stack?: string;
    };
    let errStatus: number | undefined;
    if (typeof errObj.status === 'number' && errObj.status >= 400 && errObj.status < 600) {
      errStatus = errObj.status;
    } else if (
      typeof errObj.statusCode === 'number' &&
      errObj.statusCode >= 400 &&
      errObj.statusCode < 600
    ) {
      errStatus = errObj.statusCode;
    }
    if (errStatus === undefined) {
      status = res.statusCode >= 400 && res.statusCode < 600 ? res.statusCode : 500;
    } else {
      status = errStatus;
      if (errObj.headers && typeof errObj.headers === 'object') {
        errHeaders = { ...errObj.headers };
      }
    }
    if (req._bridgeNext) {
      const m = (err as { message?: unknown }).message;
      answerBridgeNext(res, status, typeof m === 'string' && m ? m : STATUS_CODES[status] || 'Error');
      return;
    }
    // finalhandler: the stack outside production, else the status message.
    if (app.get('env') !== 'production') {
      msg = errObj.stack || '';
      if (!msg) {
        try {
          msg = String(err);
        } catch {
          msg = '';
        }
      }
    } else {
      msg = '';
    }
    if (!msg) msg = STATUS_CODES[status] || 'Internal Server Error';
  } else if (
    req.method === 'OPTIONS' &&
    req._optionsMethods !== null &&
    req._optionsMethods.length > 0
  ) {
    // router@2 `sendOptionsResponse`: unique, sorted, ", "-joined, bare text/plain.
    const allowVal = Array.from(new Set(req._optionsMethods)).sort().join(', ');
    res.statusCode = 200;
    res.setHeader('Allow', allowVal);
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(allowVal);
    return;
  } else {
    if (req._bridgeNext) {
      answerBridgeNext(res, 404, '');
      return;
    }
    status = 404;
    msg = `Cannot ${req.method} ${encodeUrl(originalPathname(req))}`;
  }

  res.removeHeader('content-encoding');
  res.removeHeader('content-language');
  res.removeHeader('content-range');
  if (errHeaders !== undefined) {
    for (const [hk, hv] of Object.entries(errHeaders)) res.setHeader(hk, hv);
  }
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.statusCode = status;
  res.statusMessage = STATUS_CODES[status] || '';
  res.end(finalHandlerHtml(msg));
}

/** finalhandler@2 `createHtmlDocument`. */
function finalHandlerHtml(message: string): string {
  const body = escapeHtmlText(message).replaceAll('\n', '<br>').replaceAll('  ', ' &nbsp;');
  return (
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n' +
    '</head>\n<body>\n<pre>' + body + '</pre>\n</body>\n</html>\n'
  );
}

/** `parseurl.original(req).pathname`, as finalhandler names the missing resource. */
function originalPathname(req: RxRequest): string {
  try {
    const url = req.originalUrl || req.url || '/';
    const q = url.indexOf('?');
    let p = q === -1 ? url : url.slice(0, q);
    const h = p.indexOf('#');
    if (h !== -1) p = p.slice(0, h);
    return p;
  } catch {
    return 'resource';
  }
}
