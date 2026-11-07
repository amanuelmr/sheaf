/** Naming exported files from a template, safely on any file system. */
import { describe as suite, expect, it } from 'vitest';
import type { DocumentRecord } from '@sheaf/protocol';
import { DEFAULT_FILENAME_FORMAT, filenameFormatProblem, renderFilename } from '../src/filename';

const record: DocumentRecord = {
  sha256: 'a'.repeat(64),
  bytes: 1,
  pageCount: 1,
  receivedAt: Date.parse('2026-03-04T10:00:00Z'),
  title: 'March bill',
  correspondent: 'City Power',
  documentType: 'Invoice',
  tags: ['bills', 'home'],
  created: '2026-02-28',
  asn: 42,
  forward: { state: 'pending', attempts: 0, remoteId: null, error: null },
  bytesReleased: false,
  suggestions: null,
};

suite('file names', () => {
  it('fills in each placeholder', () => {
    expect(renderFilename(DEFAULT_FILENAME_FORMAT, record)).toBe('2026/City Power/March bill');
    expect(
      renderFilename('{{document_type}}/{{asn}} {{created}} {{tag_list}} {{added_year}}', record),
    ).toBe('Invoice/0000042 2026-02-28 bills,home 2026');
  });

  it('reads none for what is missing, and the received day for a missing date', () => {
    const bare = { ...record, title: null, correspondent: null, created: null, asn: null };
    expect(renderFilename(DEFAULT_FILENAME_FORMAT, bare)).toBe('2026/none/none');
    expect(renderFilename('{{created}}', bare)).toBe('2026-03-04');
  });

  it('never lets a value make folders or escape them', () => {
    const sneaky = { ...record, title: '../../etc/passwd', correspondent: 'A/B: "C"?' };
    expect(renderFilename('{{correspondent}}/{{title}}', sneaky)).toBe('A-B_ _C__/_-..-etc-passwd');
    expect(renderFilename('{{title}}', { ...record, title: 'con' })).toBe('_con');
    expect(renderFilename('{{title}}', { ...record, title: 'é'.repeat(200) }).length).toBe(60);
  });

  it('refuses a placeholder it does not know', () => {
    expect(filenameFormatProblem(DEFAULT_FILENAME_FORMAT)).toBeNull();
    expect(filenameFormatProblem('{{owner}}/{{title}}')).toMatch(/owner/);
    expect(filenameFormatProblem(' ')).toMatch(/empty/);
  });
});
