/**
 * Cold-start reconciliation: "does the server already hold the document with this
 * content hash?"
 *
 * Paperless-ngx exposes no lookup by content hash, so we smuggle our own identity
 * in through the one field it preserves verbatim: the original filename. Every
 * upload is named `sheaf-<sha256>.pdf`, and reconciliation searches for that.
 *
 * The asymmetry that makes this safe is worth stating plainly:
 *
 *   A false negative is harmless. We conclude "not on the server", re-upload, and
 *   the server's own content hashing refuses it as a duplicate -- which the engine
 *   already reads as success.
 *
 *   A false positive is catastrophic. We conclude "already on the server", mark the
 *   document synced, and a retention policy deletes the only local copy of a
 *   document that was never uploaded.
 *
 * So every step here is built to fail towards the negative. In particular, results
 * are re-checked client-side: DRF ignores unrecognised query parameters instead of
 * rejecting them, so a server that does not support this filter answers with an
 * unfiltered page of documents. Trusting that answer would be exactly the
 * catastrophic case, so a match must prove itself by its filename.
 */

const PREFIX = 'sheaf-';

/** The filename an upload must carry for reconciliation to find it later. */
export function captureFilename(sha256: string): string {
  return `${PREFIX}${sha256}.pdf`;
}

/** Recover the hash from a filename Paperless handed back, if it is one of ours. */
export function parseCaptureId(filename: string | null | undefined): string | null {
  if (typeof filename !== 'string') return null;
  const match = new RegExp(`^${PREFIX}([0-9a-f]{16,64})`, 'i').exec(filename);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Does this filename genuinely belong to the document we are looking for?
 *
 * Paperless may append a disambiguating suffix (`..._01.pdf`), so this is a
 * prefix check on the hash rather than string equality — but it is still a check,
 * and it is the only thing standing between an ignored server-side filter and a
 * false positive.
 */
export function matchesCaptureId(filename: string | null | undefined, sha256: string): boolean {
  const parsed = parseCaptureId(filename);
  return parsed !== null && parsed === sha256.toLowerCase();
}
