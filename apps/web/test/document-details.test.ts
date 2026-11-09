/** Saving a document's details sends only what changed, so nothing untouched becomes a choice. */
import { describe as suite, expect, it } from 'vitest';
import type { DocumentRecord } from '@sheaf/protocol';
import { detailsPatch, draftOf } from '../src/pages/DocumentDetails';

const record: DocumentRecord = {
  sha256: 'a'.repeat(64),
  bytes: 1,
  pageCount: 1,
  receivedAt: 0,
  title: 'Power bill',
  correspondent: 'City Power',
  documentType: null,
  tags: ['bills'],
  created: null,
  asn: 4,
  owner: null,
  forward: { state: 'pending', attempts: 0, remoteId: null, error: null },
  bytesReleased: false,
  suggestions: { date: '2026-03-01' },
};

suite('the details form', () => {
  it('starts from the document, filling a missing date from the suggestion', () => {
    expect(draftOf(record)).toMatchObject({ title: 'Power bill', created: '2026-03-01', asn: '4' });
  });

  it('sends only the fields that changed', () => {
    const draft = { ...draftOf(record), created: '' };
    expect(detailsPatch(record, draft)).toEqual({});
    expect(
      detailsPatch(record, { ...draft, documentType: ' Invoice ', tags: ['bills', 'home'] }),
    ).toEqual({
      documentType: 'Invoice',
      tags: ['bills', 'home'],
    });
  });

  it('clears with empty text and refuses a serial number that is not one', () => {
    const draft = { ...draftOf(record), created: '' };
    expect(detailsPatch(record, { ...draft, correspondent: '  ', asn: '' })).toEqual({
      correspondent: null,
      asn: null,
    });
    expect(detailsPatch(record, { ...draft, asn: '12a' })).toBeNull();
  });
});

suite('serial numbers in a series', () => {
  const series = [{ prefix: 'B', name: 'Business', first: 10_000_000 }];
  const inSeries: DocumentRecord = { ...record, asn: 10_000_041 };

  it('shows the number with its series prefix, and saves what is typed back', () => {
    expect(draftOf(inSeries, series).asn).toBe('B-42');
    const draft = draftOf(inSeries, series);
    expect(detailsPatch(inSeries, draft, series)).not.toHaveProperty('asn');
    expect(detailsPatch(inSeries, { ...draft, asn: 'B-43' }, series)).toMatchObject({
      asn: 10_000_042,
    });
    expect(detailsPatch(inSeries, { ...draft, asn: 'Q-1' }, series)).toBeNull();
  });
});
