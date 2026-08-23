import { Directory, File, Paths } from 'expo-file-system';
import type { DocState } from '@sheaf/core';
import type { EngineFiles } from '@sheaf/engine';

/**
 * Local storage is content-addressed, exactly like the server's view of it: a
 * document's bytes live at `documents/<sha256>.pdf`. Nothing has to remember a
 * path, and a path can never point at the wrong document.
 */
const DOCUMENTS = 'documents';
const PAGES = 'pages';

function directory(name: string): Directory {
  const dir = new Directory(Paths.document, name);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export function pdfFile(sha256: string): File {
  return new File(directory(DOCUMENTS), `${sha256}.pdf`);
}

export function pageFile(name: string): File {
  return new File(directory(PAGES), name);
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
 * Delete the local copies. Only ever reached for a document the server has
 * confirmed, and only when the retention policy asks for it.
 */
export const engineFiles: EngineFiles = {
  release: (state: DocState) => {
    const pdf = pdfFile(state.sha256);
    if (pdf.exists) pdf.delete();
    for (const page of state.pages) {
      const file = new File(page.path);
      if (file.exists) file.delete();
    }
    return Promise.resolve();
  },
};
