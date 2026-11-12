/**
 * Just enough MIME to find the PDFs and EPUBs in an email: headers (unfolded, RFC 2047
 * encoded words decoded), nested multiparts, and base64 or quoted-printable bodies.
 * Everything else is skipped, never interpreted.
 */

import { isEpub } from './epub.ts';
import { isPdf } from './storage.ts';

export interface Attachment {
  readonly filename: string | null;
  readonly bytes: Uint8Array;
}

export interface ParsedMail {
  readonly subject: string | null;
  readonly from: string | null;
  readonly attachments: readonly Attachment[];
}

const MAX_DEPTH = 10;

export function parseMail(raw: Uint8Array): ParsedMail {
  const { headers, body } = split(Buffer.from(raw));
  const attachments: Attachment[] = [];
  collect(headers, body, attachments, 0);
  return {
    subject: header(headers, 'subject'),
    from: header(headers, 'from'),
    attachments,
  };
}

type Headers = ReadonlyMap<string, string>;

function split(part: Buffer): { headers: Headers; body: Buffer } {
  let end = part.indexOf('\r\n\r\n');
  let gap = 4;
  if (end === -1) {
    end = part.indexOf('\n\n');
    gap = 2;
  }
  const head = end === -1 ? part.toString('latin1') : part.subarray(0, end).toString('latin1');
  const body = end === -1 ? Buffer.alloc(0) : part.subarray(end + gap);
  const headers = new Map<string, string>();
  // Unfold: a line starting with whitespace continues the one before.
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function header(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value === undefined ? null : decodeWords(value);
}

/** The value of `name=` in a header like `multipart/mixed; boundary="x"`. */
function parameter(value: string, name: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${name}\\*?=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(value);
  if (match === null) return null;
  const raw = match[2] ?? match[1] ?? '';
  // RFC 2231: filename*=utf-8''name%20here
  const extended = /^([\w-]+)''(.*)$/.exec(raw);
  if (extended !== null) {
    try {
      return decodeURIComponent(extended[2] ?? '');
    } catch {
      return extended[2] ?? null;
    }
  }
  return decodeWords(raw);
}

function collect(headers: Headers, body: Buffer, out: Attachment[], depth: number): void {
  if (depth > MAX_DEPTH) return;
  const type = headers.get('content-type') ?? 'text/plain';
  const mediaType = (type.split(';')[0] ?? '').trim().toLowerCase();
  if (mediaType.startsWith('multipart/')) {
    const boundary = parameter(type, 'boundary');
    if (boundary === null) return;
    for (const part of parts(body, boundary)) {
      const inner = split(part);
      collect(inner.headers, inner.body, out, depth + 1);
    }
    return;
  }
  if (mediaType === 'message/rfc822') {
    const inner = split(decode(body, headers.get('content-transfer-encoding')));
    collect(inner.headers, inner.body, out, depth + 1);
    return;
  }
  const disposition = headers.get('content-disposition') ?? '';
  const filename = parameter(disposition, 'filename') ?? parameter(type, 'name');
  const isPdfPart =
    mediaType === 'application/pdf' ||
    (filename !== null &&
      filename.toLowerCase().endsWith('.pdf') &&
      (mediaType === 'application/octet-stream' || mediaType === 'application/x-pdf'));
  const isBook =
    mediaType === 'application/epub+zip' ||
    (filename !== null &&
      filename.toLowerCase().endsWith('.epub') &&
      (mediaType === 'application/octet-stream' || mediaType === 'application/zip'));
  if (!isPdfPart && !isBook) return;
  const bytes = decode(body, headers.get('content-transfer-encoding'));
  // Trust the bytes, not the label: a PDF starts with %PDF-, an EPUB says so first.
  if (isPdfPart && !isPdf(bytes)) return;
  if (isBook && !isEpub(new Uint8Array(bytes))) return;
  out.push({ filename, bytes: new Uint8Array(bytes) });
}

/** The parts between `--boundary` lines, without the closing `--boundary--`. */
function parts(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString('latin1');
  const delimiter = `--${boundary}`;
  const found: Buffer[] = [];
  let start = text.indexOf(delimiter);
  while (start !== -1) {
    const afterLine = text.indexOf('\n', start);
    if (afterLine === -1) break;
    if (text.startsWith(`${delimiter}--`, start)) break;
    const next = text.indexOf(`\n${delimiter}`, afterLine);
    const end = next === -1 ? text.length : next;
    let chunk = text.slice(afterLine + 1, end);
    if (chunk.endsWith('\r')) chunk = chunk.slice(0, -1);
    found.push(Buffer.from(chunk, 'latin1'));
    start = next === -1 ? -1 : next + 1;
  }
  return found;
}

function decode(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'base64':
      return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
    case 'quoted-printable':
      return quotedPrintable(body.toString('latin1'));
    default:
      return body;
  }
}

function quotedPrintable(text: string): Buffer {
  const soft = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const hex = soft.slice(i + 1, i + 3);
    if (soft[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(soft.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** RFC 2047: `=?utf-8?B?...?=` and `=?utf-8?Q?...?=`, with spaces between them dropped. */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(
      /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
      (whole, charset: string, kind: string, text: string) => {
        const bytes =
          kind.toUpperCase() === 'B'
            ? Buffer.from(text, 'base64')
            : quotedPrintable(text.replace(/_/g, ' '));
        try {
          return new TextDecoder(charset.toLowerCase()).decode(bytes);
        } catch {
          return whole;
        }
      },
    );
}
