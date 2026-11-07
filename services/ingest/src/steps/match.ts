import type { Step } from '../jobs.ts';
import type { Rules } from '../rules.ts';
import type { Storage } from '../storage.ts';

/**
 * Files each new document by the labels' rules, and puts the inbox tags on it.
 *
 * Do not bump the version: that would run the step over every document again and
 * put inbox tags on old ones. Applying rules to existing documents is
 * `POST /v1/labels/apply`. Migration 14 counts this version as done for documents
 * stored before the step existed.
 */
export function matchStep(storage: Storage, rules: Rules, options: { graceMs: number }): Step {
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

    async run(document) {
      await rules.apply(document.sha256, { inbox: true });
      return { ok: true, value: null };
    },
  };
}
