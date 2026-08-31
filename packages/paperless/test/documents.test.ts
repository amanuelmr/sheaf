import { describe as suite, expect, it } from 'vitest';
import { resolveDocument } from '../src/documents';

const vocabulary = {
  correspondents: [
    { id: 3, name: 'Amazon' },
    { id: 9, name: 'Vattenfall' },
  ],
  documentTypes: [{ id: 7, name: 'Receipt' }],
  tags: [
    { id: 1, name: 'shopping' },
    { id: 2, name: 'electronics' },
  ],
};

const raw = {
  id: 4821,
  title: 'Amazon receipt',
  correspondent: 3,
  document_type: 7,
  tags: [1, 2],
  created: '2026-08-22',
};

suite('resolveDocument', () => {
  it('resolves every id to the name a person actually recognises', () => {
    expect(resolveDocument(raw, vocabulary)).toEqual({
      id: 4821,
      title: 'Amazon receipt',
      correspondent: 'Amazon',
      documentType: 'Receipt',
      tags: ['shopping', 'electronics'],
      created: '2026-08-22',
      contentSnippet: null,
    });
  });

  it('leaves an unset correspondent or type as null rather than a dropped field', () => {
    const resolved = resolveDocument(
      { ...raw, correspondent: null, document_type: null },
      vocabulary,
    );
    expect(resolved.correspondent).toBeNull();
    expect(resolved.documentType).toBeNull();
  });

  it('drops a tag id it cannot name rather than showing a number', () => {
    expect(resolveDocument({ ...raw, tags: [1, 99] }, vocabulary).tags).toEqual(['shopping']);
  });

  it('resolves a correspondent or type id it cannot name to null, the same as unset', () => {
    const resolved = resolveDocument(
      { ...raw, correspondent: 404, document_type: 404 },
      vocabulary,
    );
    expect(resolved.correspondent).toBeNull();
    expect(resolved.documentType).toBeNull();
  });

  it('excerpts long OCR content rather than carrying the whole thing', () => {
    const content = 'x'.repeat(500);
    expect(resolveDocument({ ...raw, content }, vocabulary).contentSnippet).toBe(
      `${'x'.repeat(240)}…`,
    );
  });

  it('leaves a short excerpt untouched', () => {
    expect(
      resolveDocument({ ...raw, content: 'short receipt text' }, vocabulary).contentSnippet,
    ).toBe('short receipt text');
  });

  it('treats blank or missing content as no snippet, not an empty one', () => {
    expect(resolveDocument({ ...raw, content: '   ' }, vocabulary).contentSnippet).toBeNull();
    expect(resolveDocument(raw, vocabulary).contentSnippet).toBeNull();
  });
});
