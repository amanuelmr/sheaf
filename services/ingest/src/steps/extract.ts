import { SCHEMA_VERSION, type DateOrder, type Extractor } from '@sheaf/extract';
import type { ApiResult } from '@sheaf/http';
import type { Step } from '../jobs.ts';
import type { Storage } from '../storage.ts';

export interface ExtractStepOptions {
  readonly extractor: Extractor;
  readonly dateOrder: DateOrder;
  readonly defaultCurrency: string;
  /**
   * How long a document with no text yet waits for some before extraction runs on
   * nothing. The phone sends its text seconds after the document, so this only
   * matters when it never does.
   */
  readonly graceMs: number;
}

/** Separate version ranges per provider, so changing provider re-extracts everything. */
const PROVIDER_OFFSET: Readonly<Record<Extractor['name'], number>> = {
  heuristic: 0,
  claude: 100_000,
  ollama: 200_000,
};

/**
 * Reads each stored document's details (ADR 0010) and turns them into the
 * suggestions the phone already asks for.
 *
 * The version folds in the provider, its own version and the schema's, so any of
 * them changing re-runs extraction over every document, and earlier runs are kept to
 * compare against. Text arriving later re-runs it too (`Storage.putText`).
 *
 * It always leaves an answer: suggestions, or "nothing to suggest" when there was no
 * text or the extractor gave up. Without one, the phone keeps asking until its own
 * budget runs out.
 */
export function extractStep(storage: Storage, options: ExtractStepOptions): Step {
  const { extractor } = options;
  return {
    name: 'extract',
    version: PROVIDER_OFFSET[extractor.name] + extractor.version * 100 + SCHEMA_VERSION,
    after: ['ocr'],
    budget: 5,

    async notBefore(document) {
      const hasText = (await storage.texts(document.sha256)).length > 0;
      return hasText ? 0 : document.receivedAt + options.graceMs;
    },

    applies: () => Promise.resolve(true),

    async run(document, context): Promise<ApiResult<null>> {
      const text = (await storage.texts(document.sha256)).map((t) => t.text).join('\n\n');
      if (text.trim() === '') {
        await storage.recordNoSuggestions(document.sha256);
        return { ok: true, value: null };
      }

      const [correspondents, documentTypes, tags] = await Promise.all([
        storage.names('correspondent'),
        storage.names('document_type'),
        storage.names('tag'),
      ]);
      const started = Date.now();
      const result = await extractor.extract({
        text,
        vocabulary: {
          correspondents: correspondents.map((n) => n.name),
          documentTypes: documentTypes.map((n) => n.name),
          tags: tags.map((n) => n.name),
        },
        today: new Date(context.now).toISOString().slice(0, 10),
        dateOrder: options.dateOrder,
        defaultCurrency: options.defaultCurrency,
      });
      if (!result.ok) return result;

      await storage.saveExtraction(
        document.sha256,
        {
          version: this.version,
          provider: extractor.name,
          model: result.value.model,
          fields: result.value.fields,
          usage: result.value.usage,
          latencyMs: Date.now() - started,
        },
        context.now,
      );
      return { ok: true, value: null };
    },

    async onGiveUp(document) {
      await storage.recordNoSuggestions(document.sha256);
    },
  };
}
