import { Directory, File, Paths } from 'expo-file-system';
import type { ArchiveDocument } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import {
  evictUnstarred,
  get,
  save,
  search,
  setStarred,
  type CachedDocument,
} from '@sheaf/archive-cache';

export type { CachedDocument } from '@sheaf/archive-cache';

const ARCHIVE_THUMBNAILS = 'archive-thumbnails';

/**
 * How many documents that were merely *viewed* (not starred) to keep offline.
 * Arbitrary but deliberately generous: a thumbnail is a few kilobytes, and the
 * point is to never make someone think about the limit.
 */
const MAX_UNSTARRED = 200;

function directory(): Directory {
  const dir = new Directory(Paths.document, ARCHIVE_THUMBNAILS);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function extensionFor(contentType: string): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
  return 'webp';
}

/**
 * Best effort. A thumbnail that fails to download is not a reason to fail
 * caching the document itself -- the title, tags and snippet are worth having
 * offline even as a blank square where the picture would be.
 */
async function downloadThumbnail(
  id: number,
  source: { readonly uri: string; readonly headers: Record<string, string> },
): Promise<string | null> {
  try {
    const response = await fetch(source.uri, { headers: source.headers });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') ?? 'image/webp';
    const bytes = new Uint8Array(await response.arrayBuffer());
    const file = new File(directory(), `${id}.${extensionFor(contentType)}`);
    if (file.exists) file.delete();
    file.create({ overwrite: true });
    file.write(bytes);
    return file.uri;
  } catch {
    return null;
  }
}

/**
 * Cache a document that was actually opened, thumbnail included, and keep the
 * unstarred half of the cache from growing without bound. The one place this
 * package's pure SQL meets the filesystem.
 */
export async function cacheOpenedDocument(
  driver: SqlDriver,
  document: ArchiveDocument,
  thumbnailSource: { readonly uri: string; readonly headers: Record<string, string> },
  now: number,
): Promise<void> {
  const thumbnailPath = await downloadThumbnail(document.id, thumbnailSource);
  await save(driver, document, thumbnailPath, now);

  const evicted = await evictUnstarred(driver, MAX_UNSTARRED);
  for (const path of evicted) {
    const file = new File(path);
    if (file.exists) file.delete();
  }
}

export function starCachedDocument(driver: SqlDriver, id: number, starred: boolean): Promise<void> {
  return setStarred(driver, id, starred);
}

export function getCachedDocument(driver: SqlDriver, id: number): Promise<CachedDocument | null> {
  return get(driver, id);
}

export function searchCache(driver: SqlDriver, text: string): Promise<readonly CachedDocument[]> {
  return search(driver, text);
}
