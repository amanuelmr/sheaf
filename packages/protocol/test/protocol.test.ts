import { describe as suite, expect, it } from 'vitest';
import {
  ERROR_STATUS,
  MAX_DOCUMENT_BYTES,
  authorization,
  bearerToken,
  isDocumentTextBody,
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
