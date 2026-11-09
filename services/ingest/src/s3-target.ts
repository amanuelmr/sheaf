import { createHash, createHmac } from 'node:crypto';
import type { ServerOutcome } from '@sheaf/core';
import { classifyResponse, classifyThrown, err, ok, type ApiResult } from '@sheaf/http';
import type { DocumentRecord } from '@sheaf/protocol';
import type { Connector } from './forwarder.ts';

export interface S3Options {
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * Another S3 service, such as MinIO, Garage, Backblaze B2 or Cloudflare R2. Its
   * buckets are addressed by path. Absent means Amazon S3 itself, addressed by host.
   */
  readonly endpoint?: string;
  /** Put in front of every key, such as `sheaf/`. */
  readonly prefix?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

/** The name in the deliveries table. Never change it: a new name sends everything again. */
export const S3_CONNECTOR = 's3';

const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding, as Signature Version 4 wants it: only A-Z a-z 0-9 - _ . ~ left alone. */
const encodeSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export interface SignInput {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly now: Date;
}

/**
 * AWS Signature Version 4 for S3, in headers. Returns the headers to send:
 * those given, plus the date, the payload hash and the authorisation. Written out
 * rather than taken from an SDK, which would be this server's largest dependency
 * by far for four requests.
 */
export function signS3(input: SignInput): Record<string, string> {
  const amzDate = input.now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v])),
    host: input.url.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...input.url.searchParams]
    .map(([k, v]) => `${encodeSegment(k)}=${encodeSegment(v)}`)
    .sort()
    .join('&');
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  // fetch sets the host itself, from the URL.
  const rest = Object.fromEntries(Object.entries(headers).filter(([n]) => n !== 'host'));
  return {
    ...rest,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * An S3 bucket as a forwarding target: every document kept off this machine, by
 * its hash, as `<prefix>ab/abcdef….pdf`. Keys by hash rather than by title, so a
 * renamed document is not stored twice and a restore can find each file without
 * this server's database. A PUT of the same bytes to the same key is harmless,
 * which makes sending again after a lost reply safe.
 */
export function s3Target(options: S3Options): Connector {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const prefix = options.prefix ?? '';
  const keyOf = (sha: string): string => `${prefix}${sha.slice(0, 2)}/${sha}.pdf`;
  const urlOf = (key: string): URL => {
    const path = key.split('/').map(encodeSegment).join('/');
    if (options.endpoint === undefined) {
      return new URL(`https://${options.bucket}.s3.${options.region}.amazonaws.com/${path}`);
    }
    const base = options.endpoint.replace(/\/+$/, '');
    return new URL(`${base}/${encodeSegment(options.bucket)}/${path}`);
  };

  async function request(
    method: 'PUT' | 'HEAD',
    key: string,
    body?: Uint8Array,
  ): Promise<ApiResult<number>> {
    const url = urlOf(key);
    const headers = signS3({
      method,
      url,
      headers: body === undefined ? {} : { 'content-type': 'application/pdf' },
      payloadHash: sha256(body ?? new Uint8Array()),
      region: options.region,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      now: now(),
    });
    try {
      const response = await doFetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(120_000),
      });
      await response.body?.cancel();
      return ok(response.status);
    } catch (error) {
      return err(classifyThrown(error));
    }
  }

  async function exists(key: string): Promise<ApiResult<boolean>> {
    const head = await request('HEAD', key);
    if (!head.ok) return head;
    if (head.value === 404) return ok(false);
    if (head.value >= 200 && head.value < 300) return ok(true);
    return err(classifyResponse(head.value));
  }

  return {
    name: S3_CONNECTOR,

    async send(document: DocumentRecord, bytes: Uint8Array): Promise<ApiResult<string>> {
      const key = keyOf(document.sha256);
      const put = await request('PUT', key, bytes);
      if (!put.ok) return put;
      if (put.value < 200 || put.value >= 300) return err(classifyResponse(put.value));
      return ok(key);
    },

    async poll(taskId: string): Promise<ApiResult<ServerOutcome | 'pending' | null>> {
      const there = await exists(taskId);
      if (!there.ok) return there;
      // Not there after a PUT that said yes: someone removed it. Send it again.
      return ok(there.value ? { kind: 'stored', remoteId: taskId } : null);
    },

    async locate(sha: string): Promise<ApiResult<string | null>> {
      const key = keyOf(sha);
      const there = await exists(key);
      if (!there.ok) return there;
      return ok(there.value ? key : null);
    },
  };
}
