import { describe as suite, expect, it } from 'vitest';
import {
  ERROR_STATUS,
  MAX_DOCUMENT_BYTES,
  authorization,
  bearerToken,
  isSha256,
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
