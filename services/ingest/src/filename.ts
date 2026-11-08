import type { TEMPLATE_PLACEHOLDERS } from '@sheaf/protocol';
import { templateProblem, type DocumentRecord } from '@sheaf/protocol';

/** Where an exported document goes when nobody chose a format. */
export const DEFAULT_FILENAME_FORMAT = '{{created_year}}/{{correspondent}}/{{title}}';

/** Why a format cannot be used, or null. Unknown placeholders are refused, not left in names. */
export function filenameFormatProblem(format: string): string | null {
  return templateProblem(format);
}

/**
 * A template with each placeholder filled in from the document, `none` for a value
 * it does not have; a document's date falls back to the day it was received.
 * `escape` is applied to each value, never to the template's own text.
 */
export function fillTemplate(
  template: string,
  record: DocumentRecord,
  escape: (value: string) => string = (value) => value,
): string {
  const added = new Date(record.receivedAt).toISOString().slice(0, 10);
  const created = record.created ?? added;
  const values: Readonly<Record<(typeof TEMPLATE_PLACEHOLDERS)[number], string | null>> = {
    title: record.title ?? record.suggestions?.title ?? null,
    correspondent: record.correspondent,
    document_type: record.documentType,
    tag_list: record.tags.length === 0 ? null : record.tags.join(','),
    created,
    created_year: created.slice(0, 4),
    created_month: created.slice(5, 7),
    created_day: created.slice(8, 10),
    added,
    added_year: added.slice(0, 4),
    asn: record.asn === null ? null : String(record.asn).padStart(7, '0'),
    sha256: record.sha256,
  };
  return template.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_, name: string) =>
    escape(values[name as keyof typeof values] ?? 'none'),
  );
}

/**
 * A relative path for one document, without extension: the format filled in, and
 * each part made safe to be a file or folder name on any system.
 */
export function renderFilename(format: string, record: DocumentRecord): string {
  // A value's own slashes must not make folders: only the format's do.
  const filled = fillTemplate(format, record, (value) => value.replace(/[/\\]/g, '-'));
  const parts = filled
    .split('/')
    .map(safePart)
    .filter((part) => part !== '');
  return parts.length === 0 ? record.sha256 : parts.join('/');
}

/** One file or folder name: no control or reserved characters, no dot names, not too long. */
function safePart(part: string): string {
  const cleaned = part
    .normalize('NFC')
    // Control characters (\p{Cc}) and the ones Windows reserves.
    .replace(/[\p{Cc}<>:"|?*\\]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '');
  // Bytes, not characters, are what file systems limit; 120 leaves room for " (2).pdf".
  let out = cleaned;
  while (Buffer.byteLength(out) > 120) out = out.slice(0, -1);
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out) ? `_${out}` : out;
}
