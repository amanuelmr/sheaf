import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MAX_DOCUMENT_BYTES, ERROR_STATUS } from '@sheaf/protocol';
import { handle, type RouterDeps } from './router.ts';

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
  'access-control-allow-methods': 'GET, PUT, PATCH, HEAD, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-sheaf-page-count',
  // A day is generous but bounded; nothing here is secret enough to need the
  // browser asking again every single request.
  'access-control-max-age': '86400',
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
export function createIngestServer(deps: RouterDeps): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    void (async () => {
      try {
        const body = await readBody(req);
        if (body === 'too-large') {
          send(res, { status: ERROR_STATUS.too_large, json: { error: 'too_large' } }, req.method);
          return;
        }
        const response = await handle(
          {
            method: req.method ?? 'GET',
            path: (req.url ?? '/').split('?')[0] ?? '/',
            query: (req.url ?? '').split('?')[1] ?? '',
            headers: req.headers as Record<string, string | undefined>,
            body,
          },
          deps,
        );
        send(res, response, req.method);
      } catch {
        // Never leak an internal message to a client.
        send(res, { status: 500, json: { error: 'server_error' } }, req.method);
      }
    })();
  });
}

function readBody(req: IncomingMessage): Promise<Uint8Array | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_DOCUMENT_BYTES) {
        // Stop reading rather than buffer something we have already decided to
        // refuse.
        req.destroy();
        resolve('too-large');
        return;
      }
      chunks.push(chunk);
    });
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
