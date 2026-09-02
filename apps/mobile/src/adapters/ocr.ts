import { recognizeText } from 'expo-ocr-kit';
import type { SqlDriver } from '@sheaf/store';
import { save } from '@sheaf/outbox-ocr';

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
): Promise<void> {
  const texts: string[] = [];
  for (const page of pages) {
    try {
      const result = await recognizeText(page.path);
      if (result.text.trim() !== '') texts.push(result.text);
    } catch {
      // This page's text is lost, not the capture. The next page still tries.
    }
  }
  if (texts.length > 0) await save(driver, docId, texts.join('\n\n'), Date.now());
}
