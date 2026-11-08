import { searchablePdf } from './pdf-edit.ts';
import type { Storage } from './storage.ts';

/**
 * A document's file with its recognised text inside, for taking elsewhere. The
 * stored file is never changed: this is made fresh each time, from the longest
 * text any reader produced. With no text, or a file that cannot be rewritten, it is
 * the stored file as it is.
 */
export async function searchableBytes(
  storage: Storage,
  sha256: string,
): Promise<Uint8Array | null> {
  const bytes = storage.bytes(sha256);
  if (bytes === null) return null;
  const text = (await storage.texts(sha256))
    .map((t) => t.text)
    .sort((a, b) => b.length - a.length)[0];
  if (text === undefined || text.trim() === '') return bytes;
  try {
    return await searchablePdf(bytes, text);
  } catch {
    return bytes;
  }
}
