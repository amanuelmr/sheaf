import { describe as suite, expect, it } from 'vitest';
import {
  minorDigits,
  ERROR_STATUS,
  MAX_DOCUMENT_BYTES,
  authorization,
  bearerToken,
  isDocumentTextBody,
  isLabelBody,
  isLabelMergeBody,
  isLabelPatch,
  isBulkEditBody,
  filterFromParams,
  filterToParams,
  isSavedViewBody,
  isSavedViewPatch,
  matchingRuleProblem,
  labelKindOf,
  isPaperlessId,
  isSha256,
  pairingUri,
  parsePairingUri,
  paths,
} from '../src/index';

const HASH = 'a'.repeat(64);

suite('addressing', () => {
  it('puts a document at the address of its own content', () => {
    // This is the whole design: the same bytes always target the same URL, so a
    // retry cannot create a second document.
    expect(paths.document(HASH)).toBe(`/v1/documents/${HASH}`);
    expect(paths.document(HASH)).toBe(paths.document(HASH));
    expect(paths.suggestions(HASH)).toBe(`/v1/documents/${HASH}/suggestions`);
    expect(paths.documentText(HASH)).toBe(`/v1/documents/${HASH}/text`);
    expect(paths.search()).toBe('/v1/search');
    expect(paths.archive()).toBe('/v1/archive');
    expect(paths.archiveVocabulary()).toBe('/v1/archive/vocabulary');
    expect(paths.archiveDocument(4821)).toBe('/v1/archive/4821');
    expect(paths.archiveThumbnail(4821)).toBe('/v1/archive/4821/thumbnail');
  });

  it('accepts only a positive integer as a downstream-system id', () => {
    expect(isPaperlessId('4821')).toBe(true);
    for (const bad of ['0', '-1', '4821.5', '4821a', '', '01', ' 4821']) {
      expect(isPaperlessId(bad), bad).toBe(false);
    }
  });

  it('accepts only a real hash as an identifier', () => {
    expect(isSha256(HASH)).toBe(true);
    for (const bad of [
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64), // uppercase: one hash, one spelling
      `${'a'.repeat(63)}g`,
      '../../etc/passwd',
      `${HASH}/..`,
    ]) {
      expect(isSha256(bad), bad).toBe(false);
    }
  });

  it('rejects path traversal by construction, not by sanitising', () => {
    // Because ids must match the hash pattern, a traversal attempt can never reach
    // the filesystem layer at all.
    expect(isSha256('..')).toBe(false);
    expect(isSha256('%2e%2e%2f')).toBe(false);
  });
});

suite('authorization', () => {
  it('round-trips a token', () => {
    expect(bearerToken(authorization('s3cret'))).toBe('s3cret');
  });

  it('refuses anything that is not a bearer token', () => {
    for (const header of [undefined, '', 'Token abc', 'Bearer', 'Bearer   ', 'bearer abc']) {
      expect(bearerToken(header), String(header)).toBeNull();
    }
  });
});

suite('error mapping', () => {
  it('gives every error exactly one status, shared by both sides', () => {
    expect(ERROR_STATUS.unauthenticated).toBe(401);
    expect(ERROR_STATUS.not_found).toBe(404);
    expect(ERROR_STATUS.hash_mismatch).toBe(409);
    expect(ERROR_STATUS.too_large).toBe(413);
    expect(new Set(Object.keys(ERROR_STATUS)).size).toBe(Object.keys(ERROR_STATUS).length);
  });

  it('bounds what a single request can cost', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(26_214_400);
  });
});

suite('document text', () => {
  it('accepts text from the phone, with the engine that read it', () => {
    expect(
      isDocumentTextBody({ source: 'edge', engine: 'apple-vision', text: 'TOTAL 12.50' }),
    ).toBe(true);
    expect(isDocumentTextBody({ source: 'edge', engine: 'mlkit', text: '' })).toBe(true);
  });

  it.each([
    ['not an object', 'text'],
    ['null', null],
    ['an unknown source', { source: 'server', engine: 'x', text: 't' }],
    ['no engine', { source: 'edge', text: 't' }],
    ['an engine that is not a short slug', { source: 'edge', engine: 'Apple Vision!', text: 't' }],
    ['text that is not a string', { source: 'edge', engine: 'mlkit', text: 42 }],
  ])('refuses %s', (_, body) => {
    expect(isDocumentTextBody(body)).toBe(false);
  });
});

suite('pairing links', () => {
  it('round-trip a server and code', () => {
    const uri = pairingUri('http://192.168.1.20:8787', 'K7QX-ABCD');
    expect(uri).toBe('sheaf://pair?server=http%3A%2F%2F192.168.1.20%3A8787&code=K7QX-ABCD');
    expect(parsePairingUri(uri)).toEqual({ server: 'http://192.168.1.20:8787', code: 'K7QX-ABCD' });
  });

  it('drops a trailing slash from the server', () => {
    expect(parsePairingUri(pairingUri('https://sheaf.example/', 'X'))?.server).toBe(
      'https://sheaf.example',
    );
  });

  it.each([
    'https://evil.example/pair?server=x&code=y',
    'sheaf://other?server=http%3A%2F%2Fa&code=y',
    'sheaf://pair?server=http%3A%2F%2Fa',
    'sheaf://pair?server=ftp%3A%2F%2Fa&code=y',
    'sheaf://pair?server=javascript%3Aalert(1)&code=y',
    'not a link',
  ])('refuses %j', (uri) => {
    expect(parsePairingUri(uri)).toBeNull();
  });
});

suite('minorDigits', () => {
  it('follows ISO 4217, not a display convention', () => {
    expect(minorDigits('EUR')).toBe(2);
    expect(minorDigits('JPY')).toBe(0);
    expect(minorDigits('ISK')).toBe(0);
    expect(minorDigits('KWD')).toBe(3);
    expect(minorDigits('IQD')).toBe(3);
    expect(minorDigits('CLF')).toBe(4);
    // CLDR shows these without decimals; ISO gives them two.
    expect(minorDigits('HUF')).toBe(2);
    expect(minorDigits('IDR')).toBe(2);
  });

  it('counts anything it does not list as two digits', () => {
    expect(minorDigits('XYZ')).toBe(2);
    expect(minorDigits('constructor')).toBe(2);
  });
});

suite('labels', () => {
  it('addresses each kind by its own path', () => {
    expect(paths.labels('documentType')).toBe('/v1/labels/document-types');
    expect(paths.label('tag', 7)).toBe('/v1/labels/tags/7');
    expect(paths.labelMerge('correspondent', 3)).toBe('/v1/labels/correspondents/3/merge');
    expect(labelKindOf('tags')).toBe('tag');
    expect(labelKindOf('tag')).toBeNull();
  });

  it('takes a trimmed name and, optionally, a #rrggbb colour', () => {
    expect(isLabelBody({ name: 'Bills' })).toBe(true);
    expect(isLabelBody({ name: 'Bills', colour: '#a1B2c3' })).toBe(true);
    expect(isLabelBody({ name: ' Bills' })).toBe(false);
    expect(isLabelBody({ name: '' })).toBe(false);
    expect(isLabelBody({ name: 'x'.repeat(129) })).toBe(false);
    expect(isLabelBody({ name: 'Bills', colour: 'red' })).toBe(false);
    expect(isLabelBody({ name: 'Bills', extra: 1 })).toBe(false);
  });

  it('patches a name or a colour, and null clears the colour', () => {
    expect(isLabelPatch({})).toBe(true);
    expect(isLabelPatch({ colour: null })).toBe(true);
    expect(isLabelPatch({ name: 'Rent', colour: '#000000' })).toBe(true);
    expect(isLabelPatch({ name: null })).toBe(false);
    expect(isLabelPatch([])).toBe(false);
  });

  it('merges into a positive id and nothing else', () => {
    expect(isLabelMergeBody({ into: 2 })).toBe(true);
    expect(isLabelMergeBody({ into: 0 })).toBe(false);
    expect(isLabelMergeBody({ into: '2' })).toBe(false);
    expect(isLabelMergeBody({ into: 2, also: 3 })).toBe(false);
  });
});

suite('matching rules', () => {
  const rule = (algorithm: string, pattern: string) => ({
    algorithm,
    pattern,
    caseSensitive: false,
  });

  it('accepts each algorithm with a pattern, and none without', () => {
    for (const algorithm of ['any', 'all', 'exact', 'regex', 'fuzzy']) {
      expect(matchingRuleProblem(rule(algorithm, 'city power'))).toBeNull();
    }
    expect(matchingRuleProblem(rule('none', ''))).toBeNull();
  });

  it('says what is wrong with a rule it cannot use', () => {
    expect(matchingRuleProblem(rule('any', '  '))).toMatch(/needs a pattern/);
    expect(matchingRuleProblem(rule('none', 'x'))).toMatch(/no pattern/);
    expect(matchingRuleProblem(rule('regex', '(unclosed'))).toMatch(/regular expression/);
    expect(matchingRuleProblem(rule('auto', 'x'))).toMatch(/algorithm/);
    expect(matchingRuleProblem({ ...rule('any', 'x'), extra: 1 })).toMatch(/only/);
  });

  it('lets a label body carry a rule and the inbox flag', () => {
    expect(isLabelBody({ name: 'Inbox', inbox: true, matching: rule('any', 'a b') })).toBe(true);
    expect(isLabelBody({ name: 'Inbox', matching: rule('regex', '[') })).toBe(false);
    expect(isLabelPatch({ inbox: 'yes' })).toBe(false);
  });
});

suite('document filters', () => {
  const full = {
    text: 'gas bill',
    correspondents: ['City Power', 'Water Co'],
    documentTypes: ['Invoice'],
    tags: ['bills'],
    anyTags: ['home', 'office'],
    notTags: ['paid'],
    receivedFrom: '2026-01-01',
    receivedTo: '2026-03-31',
    fields: [3],
    sort: 'oldest' as const,
  };

  it('goes to query parameters and comes back the same', () => {
    const params = filterToParams(full);
    expect(params.getAll('correspondent')).toEqual(['City Power', 'Water Co']);
    expect(filterFromParams(params)).toEqual({ ok: true, filter: full });
    expect(filterFromParams(new URLSearchParams())).toEqual({ ok: true, filter: {} });
  });

  it('says what is wrong with parameters it cannot use', () => {
    const bad = (query: string) => {
      const read = filterFromParams(new URLSearchParams(query));
      return read.ok ? null : read.problem;
    };
    expect(bad('from=2026-02-30')).toMatch(/day/);
    expect(bad('to=yesterday')).toMatch(/day/);
    expect(bad('sort=random')).toMatch(/sort/);
    expect(bad('field=abc')).toMatch(/field/);
    expect(bad('tag=')).toMatch(/tag/);
  });

  it('checks a saved view body and patch', () => {
    expect(isSavedViewBody({ name: 'Unpaid', filter: full, onDashboard: true })).toBe(true);
    expect(isSavedViewBody({ name: 'Unpaid', filter: { sort: 'random' } })).toBe(false);
    expect(isSavedViewBody({ name: '', filter: {} })).toBe(false);
    expect(isSavedViewBody({ name: 'x', filter: { tags: 'bills' } })).toBe(false);
    expect(isSavedViewPatch({ position: 2 })).toBe(true);
    expect(isSavedViewPatch({ position: 1.5 })).toBe(false);
  });
});

suite('bulk edit bodies', () => {
  const docs = ['a'.repeat(64)];
  it('takes documents and one action', () => {
    for (const action of [
      { kind: 'setCorrespondent', value: 'City Power' },
      { kind: 'setDocumentType', value: null },
      { kind: 'modifyTags', add: ['bills'], remove: ['unread'] },
      { kind: 'setCustomField', field: 2, value: 'INV-1' },
      { kind: 'setCustomField', field: 2, value: null },
      { kind: 'removeCustomField', field: 2 },
      { kind: 'applyRules' },
      { kind: 'trash' },
    ]) {
      expect(isBulkEditBody({ documents: docs, action }), action.kind).toBe(true);
    }
  });

  it('refuses no documents, bad ids, empty tag changes and unknown actions', () => {
    const tags = { kind: 'modifyTags', add: [], remove: [] };
    expect(isBulkEditBody({ documents: [], action: { kind: 'trash' } })).toBe(false);
    expect(isBulkEditBody({ documents: ['nope'], action: { kind: 'trash' } })).toBe(false);
    expect(isBulkEditBody({ documents: docs, action: tags })).toBe(false);
    expect(isBulkEditBody({ documents: docs, action: { kind: 'purge' } })).toBe(false);
    expect(isBulkEditBody({ documents: docs, action: { kind: 'trash', x: 1 } })).toBe(false);
    expect(isBulkEditBody({ documents: docs, action: { kind: 'setCustomField', field: 2 } })).toBe(
      false,
    );
  });
});
