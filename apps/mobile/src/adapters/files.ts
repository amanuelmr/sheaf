import { Directory, File, Paths } from 'expo-file-system';
import type { DocState } from '@sheaf/core';
import type { EngineFiles } from '@sheaf/engine';
import { underCurrentFolder } from '../lib/paths';

/**
 * Local storage is content-addressed, exactly like the server's view of it: a
 * document's bytes live at `documents/<sha256>.pdf`. Nothing has to remember a
 * path, and a path can never point at the wrong document.
 */
const DOCUMENTS = 'documents';
const THUMBNAILS = 'thumbnails';
const PAGES = 'pages';

function directory(name: string): Directory {
  const dir = new Directory(Paths.document, name);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/** A saved path to one of this app's files, where that file is now (see `lib/paths`). */
export function current(saved: string): string {
  return underCurrentFolder(saved, Paths.document.uri);
}

export function pdfFile(sha256: string): File {
  return new File(directory(DOCUMENTS), `${sha256}.pdf`);
}

export function pageFile(name: string): File {
  return new File(directory(PAGES), name);
}

export function thumbnailFile(sha256: string): File {
  return new File(directory(THUMBNAILS), `${sha256}.jpg`);
}

/**
 * Move a freshly rendered thumbnail into our own storage.
 *
 * The image manipulator writes to a cache directory, which the system is free to
 * empty. A preview that vanishes a week later would leave the outbox showing gaps
 * for documents that are perfectly fine.
 */
export async function storeThumbnail(sha256: string, fromUri: string): Promise<string> {
  const target = thumbnailFile(sha256);
  if (target.exists) target.delete();
  // `move` is asynchronous. Not awaiting it produced a path that occasionally
  // pointed at nothing yet, which shows up as a blank row rather than an error.
  await new File(fromUri).move(target);
  return target.uri;
}

export function writePdf(sha256: string, bytes: Uint8Array): File {
  const file = pdfFile(sha256);
  if (file.exists) return file; // same content, same bytes: nothing to do
  file.create({ overwrite: true });
  file.write(bytes);
  return file;
}

export async function readPageBytes(uri: string): Promise<Uint8Array> {
  return new File(uri).bytes();
}

/**
 * Remove the local copies of documents the server has confirmed.
 *
 * Takes the list of confirmed ids rather than working it out here, so there is no
 * way for this to decide on its own that something is safe to delete. Returns how
 * many were actually removed. Thumbnails stay: the documents are still on the
 * server, and a few kilobytes keep each one recognisable in the outbox.
 */
export function releaseSyncedCopies(confirmed: readonly string[]): number {
  let freed = 0;
  for (const sha256 of confirmed) {
    const pdf = pdfFile(sha256);
    if (pdf.exists) {
      pdf.delete();
      freed += 1;
    }
  }
  return freed;
}

/**
 * Delete the local copies. Only ever reached for a document the server has
 * confirmed, and only when the retention policy asks for it.
 */
export const engineFiles: EngineFiles = {
  release: (state: DocState) => {
    const pdf = pdfFile(state.sha256);
    if (pdf.exists) pdf.delete();
    // The thumbnail stays: the document is still on the server, and the outbox
    // keeps showing what it is.
    for (const page of state.pages) {
      const file = new File(current(page.path));
      if (file.exists) file.delete();
    }
    return Promise.resolve();
  },
};
