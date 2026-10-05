import { classifyResponse, classifyThrown, err, ok, type ApiResult } from '@sheaf/http';
import type { Step } from '../jobs.ts';
import type { Storage } from '../storage.ts';

/** One POST of a PDF to the OCR service. A narrow seam, so tests need no network. */
export type OcrFetch = (
  url: string,
  body: Uint8Array,
) => Promise<{ readonly status: number; text(): Promise<string> }>;

export interface OcrStepOptions {
  /** Base URL of the OCR sidecar, e.g. `http://ocr:8080`. */
  readonly url: string;
  readonly fetch: OcrFetch;
  /**
   * How long a new document waits for the phone's own text before the server reads
   * it itself. Phone OCR finishes in seconds; this only has to cover the upload.
   */
  readonly graceMs: number;
}

/** Name of this source in `document_text`, beside the phone's `edge`. */
export const OCR_SOURCE = 'ocrmypdf';

/**
 * Server-side OCR, the fallback of ADR 0009: a document with no text from anywhere
 * after the grace period is sent to the OCRmyPDF sidecar, and what comes back is
 * kept and indexed like the phone's text. A document that already has text, or
 * whose bytes retention has released, is skipped.
 *
 * A PDF the sidecar cannot read is refused once and given up on. An empty answer is
 * a success: the page has no text, and asking again would not change that.
 */
export function ocrStep(storage: Storage, options: OcrStepOptions): Step {
  return {
    name: 'ocr',
    version: 1,
    after: [],
    budget: 8,
    notBefore: (document) => document.receivedAt + options.graceMs,

    async applies(document) {
      if (document.bytesReleased) return false;
      return (await storage.texts(document.sha256)).length === 0;
    },

    async run(document, context): Promise<ApiResult<null>> {
      const bytes = storage.bytes(document.sha256);
      if (bytes === null) return err({ kind: 'not_found' });

      let response: Awaited<ReturnType<OcrFetch>>;
      try {
        response = await options.fetch(`${options.url.replace(/\/+$/, '')}/ocr`, bytes);
      } catch (error) {
        return err(classifyThrown(error));
      }
      const body = await response.text().catch(() => '');
      if (response.status !== 200) return err(classifyResponse(response.status, body));

      const answer = parseAnswer(body);
      if (answer === null) {
        return err({ kind: 'rejected', status: 502, message: 'the OCR service answered nonsense' });
      }
      if (answer.text.trim() !== '') {
        await storage.putText(
          document.sha256,
          { source: OCR_SOURCE, engine: answer.engine, text: answer.text },
          context.now,
        );
      }
      return ok(null);
    },
  };
}

function parseAnswer(body: string): { text: string; engine: string } | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { text, engine } = parsed as Record<string, unknown>;
    if (typeof text !== 'string') return null;
    return { text, engine: typeof engine === 'string' ? engine.slice(0, 40) : 'ocrmypdf' };
  } catch {
    return null;
  }
}
