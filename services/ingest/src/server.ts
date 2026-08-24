import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MAX_DOCUMENT_BYTES, ERROR_STATUS } from '@sheaf/protocol';
import { handle, type RouterDeps } from './router';

/**
 * The socket edge, and nothing else. All behaviour lives in `handle`.
 *
 * The one thing that cannot live there is the body limit: refusing an oversized
 * upload has to happen while it is still arriving, not after it has been buffered.
 */
export function createIngestServer(deps: RouterDeps): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
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
  const headers: Record<string, string> = { ...response.headers };
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
