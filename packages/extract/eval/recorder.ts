/**
 * Record and replay a model provider's HTTP answers, so the eval runs in CI with no
 * API key and gives the same numbers every time.
 *
 * A recording is keyed by the SHA-256 of the request body: the same document, prompt
 * and model always find the same answer, and changing any of them misses. In replay
 * mode a miss is an error, never a silent call out, so a stale recording is noticed.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchLike, HttpResponse } from '@sheaf/http';

export type Mode = 'live' | 'record' | 'replay';

interface Recording {
  readonly status: number;
  readonly body: string;
  readonly latencyMs: number;
}

export interface RecordingFetch {
  readonly fetch: FetchLike;
  /** How long the last answer took, live or as recorded. */
  lastLatencyMs(): number;
}

export function recordingFetch(dir: string, mode: Mode, live: FetchLike): RecordingFetch {
  let latency = 0;
  const fileFor = (body: unknown): string =>
    join(dir, `${createHash('sha256').update(String(body)).digest('hex').slice(0, 32)}.json`);

  return {
    lastLatencyMs: () => latency,
    fetch: async (url, init) => {
      const file = fileFor(init?.body);
      if (mode === 'replay') {
        if (!existsSync(file)) {
          throw new Error(`no recording for this request (${file}); run the eval with --record`);
        }
        const saved = JSON.parse(readFileSync(file, 'utf8')) as Recording;
        latency = saved.latencyMs;
        return respond(saved.status, saved.body);
      }
      const started = Date.now();
      const response = await live(url, init);
      const body = await response.text();
      latency = Date.now() - started;
      if (mode === 'record') {
        mkdirSync(dir, { recursive: true });
        const saved: Recording = { status: response.status, body, latencyMs: latency };
        writeFileSync(file, JSON.stringify(saved, null, 2) + '\n');
      }
      return respond(response.status, body);
    },
  };
}

function respond(status: number, body: string): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: () => Promise.resolve(body),
  };
}
