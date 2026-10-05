import { Platform } from 'react-native';
import { recognizeText } from 'expo-ocr-kit';
import type { EngineFiles, EngineText } from '@sheaf/engine';
import type { SqlDriver } from '@sheaf/store';
import { get, remove, save } from '@sheaf/outbox-ocr';

/** Which recogniser read the page, as the server records it (ADR 0009). */
export const OCR_ENGINE = Platform.OS === 'ios' ? 'apple-vision' : 'mlkit';

/**
 * On-device OCR of a capture, for offline search of the outbox itself -- before
 * Paperless has ever seen the document, and whether or not it ever reaches a
 * server that is reachable. Distinct from `library.tsx`'s search, which reads
 * OCR text Paperless already produced for documents already stored there.
 *
 * Uses ML Kit on Android and Apple's own Vision framework on iOS, not Google
 * ML Kit on both: an earlier choice of `@react-native-ml-kit/text-recognition`
 * (Google ML Kit on both platforms) was reverted after a real build proved
 * Google's iOS pods exclude the arm64 simulator slice entirely, breaking the
 * whole app's iOS Simulator build on Apple Silicon -- Vision ships with the OS
 * and has no such restriction.
 *
 * Best effort, deliberately: nothing here is awaited by the capture flow, and a
 * page that fails to recognise is skipped rather than failing the whole
 * document, the same shape `makeThumbnail` in `app/index.tsx` already uses. A
 * capture must never be worse off for OCR having tried and lost.
 *
 * Runs on the full-resolution capture, not the 320px thumbnail used for
 * `pageHash` -- that size answers "does this look like a page seen before", not
 * "what does the page say", and is too small to read reliably.
 */
export async function extractAndSaveText(
  driver: SqlDriver,
  docId: string,
  pages: readonly { readonly path: string }[],
): Promise<boolean> {
  const texts: string[] = [];
  for (const page of pages) {
    try {
      const result = await recognizeText(page.path);
      if (result.text.trim() !== '') texts.push(result.text);
    } catch {
      // This page's text is lost, not the capture. The next page still tries.
    }
  }
  if (texts.length === 0) return false;
  await save(driver, docId, texts.join('\n\n'), Date.now());
  return true;
}

/** Lets the engine read what was recognised, to send it to the server. */
export function outboxText(driver: SqlDriver): EngineText {
  return { read: (docId) => get(driver, docId) };
}

/**
 * Release that also deletes the recognised text, for the same reason the thumbnail
 * goes: kept past release, outbox search would return a document that is no longer
 * in the outbox. The engine only releases once the text is on the server, or is
 * never going to be.
 *
 * Shared by the foreground and background engines, so they cannot drift apart.
 */
export function releasingText(driver: SqlDriver, files: EngineFiles): EngineFiles {
  return {
    ...files,
    release: async (state) => {
      await files.release(state);
      await remove(driver, state.docId);
    },
  };
}
