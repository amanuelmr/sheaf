import type { Step } from '../jobs.ts';
import type { Rules } from '../rules.ts';
import type { Storage } from '../storage.ts';
import type { Workflows } from '../workflows.ts';

/**
 * Files each new document by the labels' rules, puts the inbox tags on it, then
 * runs the workflows for added documents.
 *
 * Do not bump the version: that would run the step over every document again and
 * put inbox tags on old ones. Applying rules to existing documents is
 * `POST /v1/labels/apply`. Migration 14 counts this version as done for documents
 * stored before the step existed.
 */
export function matchStep(
  storage: Storage,
  rules: Rules,
  options: { graceMs: number; workflows?: Workflows },
): Step {
  return {
    name: 'match',
    version: 1,
    after: ['ocr'],
    budget: 5,

    async notBefore(document) {
      const hasText = (await storage.texts(document.sha256)).length > 0;
      return hasText ? 0 : document.receivedAt + options.graceMs;
    },

    applies: () => Promise.resolve(true),

    async run(document, context) {
      await rules.apply(document.sha256, { inbox: true });
      // Workflows for new documents see it filed by the rules first.
      await options.workflows?.run('added', document.sha256, context.now);
      return { ok: true, value: null };
    },
  };
}
