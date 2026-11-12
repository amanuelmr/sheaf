import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { MAX_DOCUMENT_BYTES, ERROR_STATUS } from '@sheaf/protocol';
import { log, type Logger } from './log.ts';
import { handle, knownCaller, type IngestRequest, type RouterDeps } from './router.ts';

/**
 * The most a caller without a valid token may send: enough to pair a phone or sign
 * in, nowhere near a document. Only a known caller may send up to a document's size.
 */
export const ANONYMOUS_BODY_BYTES = 64 * 1024;
/** How long the rest of a refused upload is thrown away before the connection is cut. */
const DISCARD_MS = 10_000;

/**
 * Wide open on purpose. The token is what stands between a request and this
 * server, not the browser's same-origin policy -- there are no cookies here for
 * a stray origin to ride along on, only a bearer token a page has to have been
 * told directly. Restricting the origin would protect nothing, and would break
 * the one browser client this protocol has: the admin dashboard, run from
 * wherever its own operator happens to have it open.
 */
const CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, PATCH, POST, DELETE, HEAD, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-sheaf-page-count',
  'access-control-expose-headers': 'x-request-id',
  // A day is generous but bounded; nothing here is secret enough to need the
  // browser asking again every single request.
  'access-control-max-age': '86400',
};

/**
 * On every answer. Nothing here is a page: no other site may frame it, no browser
 * may guess a different type for it, and no link out of a share link says where
 * the reader came from, since the share link's address is its secret.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
};

/**
 * The socket edge, and nothing else. All behaviour lives in `handle`.
 *
 * The one thing that cannot live there is the body limit: refusing an oversized
 * upload has to happen while it is still arriving, not after it has been buffered.
 * CORS is the other exception -- a preflight `OPTIONS` carries no `Authorization`
 * header by design, so it can never reach `handle`'s auth check and must be
 * answered here instead.
 */
export function createIngestServer(
  deps: RouterDeps,
  /** PEM certificate and key: HTTPS when given, HTTP otherwise. */
  tls?: { readonly cert: string; readonly key: string },
  logger: Logger = log,
): Server {
  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    const started = process.hrtime.bigint();
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    // Sent with every answer, and logged with any failure, so the two can be matched.
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    // Over HTTPS, tell browsers never to come back over plain HTTP.
    if (tls !== undefined) res.setHeader('strict-transport-security', 'max-age=31536000');
    // Every answer is counted once it is sent, whichever branch sent it.
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      deps.metrics?.observeRequest(req.method ?? 'GET', path, res.statusCode, seconds);
    });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    void (async () => {
      try {
        const request = (body: Uint8Array): IngestRequest => ({
          method: req.method ?? 'GET',
          path,
          query: (req.url ?? '').split('?')[1] ?? '',
          headers: req.headers as Record<string, string | undefined>,
          body,
          ...(req.socket.remoteAddress === undefined
            ? {}
            : { remoteAddress: req.socket.remoteAddress }),
        });
        // Decide how much to accept before reading any of it. A request that says it
        // carries no body cannot send one, so its token is checked only once, by `handle`.
        const hasBody =
          req.headers['transfer-encoding'] !== undefined ||
          Number(req.headers['content-length'] ?? 0) > 0;
        const known = hasBody && (await knownCaller(req.headers as IngestRequest['headers'], deps));
        const limit = known ? MAX_DOCUMENT_BYTES : ANONYMOUS_BODY_BYTES;
        const declared = Number(req.headers['content-length'] ?? 0);
        const body = declared > limit ? 'too-large' : await readBody(req, limit);
        if (body === 'too-large') {
          // A stranger gets the answer their token earns, from an empty body; a known
          // caller learns the file is too big. The rest of the upload is thrown away
          // unread, for a few seconds at most, so the client is still listening for
          // the answer; then the connection closes.
          res.on('finish', () => {
            const cut = setTimeout(() => req.destroy(), DISCARD_MS);
            req.once('end', () => clearTimeout(cut));
            req.resume();
          });
          send(
            res,
            known
              ? { status: ERROR_STATUS.too_large, json: { error: 'too_large' } }
              : await handle(request(new Uint8Array()), deps),
            req.method,
          );
          return;
        }
        send(res, await handle(request(body), deps), req.method);
      } catch (error) {
        // Never leak an internal message to a client; the log has it, under the same id.
        logger.error('request failed', {
          requestId,
          method: req.method ?? 'GET',
          route: routeOf(path),
          error: error instanceof Error ? error.message : String(error),
        });
        send(res, { status: 500, json: { error: 'server_error', requestId } }, req.method);
      }
    })();
  };
  return tls === undefined ? createServer(listener) : createTlsServer(tls, listener);
}

/**
 * A path fit to log: ids, hashes and share-link secrets become `:id`, so a log line
 * names the route without holding anything that opens a document.
 */
export function routeOf(path: string): string {
  const segments = path.split('/');
  return segments
    .map((segment, i) =>
      segment === '' ||
      (i === 1 && /^v[0-9]+$/.test(segment)) ||
      (/^[a-z][a-z-]*$/.test(segment) && segment.length <= 24 && segments[i - 1] !== 'share')
        ? segment
        : ':id',
    )
    .join('/');
}

function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Stop collecting rather than buffer something already refused; the socket
        // stays open just long enough to carry the answer.
        req.off('data', onData);
        req.pause();
        chunks.length = 0;
        resolve('too-large');
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function send(
  res: ServerResponse,
  response: {
    status: number;
    headers?: Readonly<Record<string, string>>;
    json?: unknown;
    bytes?: Uint8Array;
  },
  method: string | undefined,
): void {
  const headers: Record<string, string> = { ...CORS_HEADERS, ...response.headers };
  let payload: Buffer | null = null;

  if (response.bytes !== undefined) {
    payload = Buffer.from(response.bytes);
  } else if (response.json !== undefined) {
    payload = Buffer.from(JSON.stringify(response.json));
    headers['content-type'] = 'application/json';
  }

  if (payload !== null) headers['content-length'] = String(payload.length);
  res.writeHead(response.status, headers);

  // HEAD carries the headers of the equivalent GET and no body at all.
  if (method === 'HEAD' || payload === null) {
    res.end();
    return;
  }
  res.end(payload);
}
