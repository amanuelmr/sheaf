import {
  customFieldValueProblem,
  type BulkAction,
  type CustomFieldValue,
  type DocumentPatch,
  type DocumentRecord,
} from '@sheaf/protocol';
import type { CustomFields } from './custom-fields.ts';
import type { Rules } from './rules.ts';
import type { Storage } from './storage.ts';

export type BulkOutcome =
  | { readonly ok: true; readonly changed: number }
  | { readonly ok: false; readonly message: string };

/**
 * One change to many documents. Each document is changed the way a person editing
 * it alone would change it, so what was set is recorded as theirs and search is
 * kept in step. Documents in the trash, or not held at all, are skipped.
 *
 * A custom field value is checked once, up front: a value that does not fit the
 * field is refused before any document is touched.
 */
export class BulkEditor {
  readonly #storage: Storage;
  readonly #fields: CustomFields | undefined;
  readonly #rules: Rules | undefined;

  constructor(storage: Storage, fields?: CustomFields, rules?: Rules) {
    this.#storage = storage;
    this.#fields = fields;
    this.#rules = rules;
  }

  async edit(documents: readonly string[], action: BulkAction, now: number): Promise<BulkOutcome> {
    const unique = [...new Set(documents)];
    if (action.kind === 'applyRules') {
      if (this.#rules === undefined) return { ok: false, message: 'rules are not available' };
      return { ok: true, changed: await this.#rules.applyAll(unique) };
    }
    if (action.kind === 'setCustomField' || action.kind === 'removeCustomField') {
      return this.#customField(unique, action, now);
    }

    let changed = 0;
    for (const sha256 of unique) {
      const record = await this.#storage.record(sha256);
      if (record === null || record.trashedAt !== undefined) continue;
      if (action.kind === 'trash') {
        await this.#storage.trash(sha256, now);
        changed++;
        continue;
      }
      const patch = patchFor(record, action);
      if (patch === null) continue;
      await this.#storage.patch(sha256, patch, now);
      changed++;
    }
    return { ok: true, changed };
  }

  async #customField(
    documents: readonly string[],
    action: Extract<BulkAction, { kind: 'setCustomField' | 'removeCustomField' }>,
    now: number,
  ): Promise<BulkOutcome> {
    const fields = this.#fields;
    if (fields === undefined) return { ok: false, message: 'custom fields are not available' };
    const field = await fields.get(action.field);
    if (field === null)
      return { ok: false, message: `there is no custom field ${String(action.field)}` };
    if (action.kind === 'setCustomField') {
      const problem = customFieldValueProblem(field, action.value);
      if (problem !== null) return { ok: false, message: problem };
    }

    let changed = 0;
    for (const sha256 of documents) {
      const record = await this.#storage.record(sha256);
      if (record === null || record.trashedAt !== undefined) continue;
      const current = await fields.valuesOf(sha256);
      const others: CustomFieldValue[] = current
        .filter((value) => value.field !== action.field)
        .map(({ field: id, value }) => ({ field: id, value }));
      const before = current.find((value) => value.field === action.field);
      if (action.kind === 'removeCustomField') {
        if (before === undefined) continue;
      } else if (
        before !== undefined &&
        JSON.stringify(before.value) === JSON.stringify(action.value)
      ) {
        continue;
      }
      const next =
        action.kind === 'removeCustomField'
          ? others
          : [...others, { field: action.field, value: action.value }];
      const result = await fields.setValues(sha256, next, now);
      if (!result.ok) {
        return {
          ok: false,
          message: `stopped after ${String(changed)} document${changed === 1 ? '' : 's'}: ${
            result.kind === 'not_found' ? 'a document went away' : result.message
          }`,
        };
      }
      changed++;
    }
    return { ok: true, changed };
  }
}

/** What to change on one document, or null when it already is that way. */
function patchFor(
  record: DocumentRecord,
  action: Extract<BulkAction, { kind: 'setCorrespondent' | 'setDocumentType' | 'modifyTags' }>,
): DocumentPatch | null {
  switch (action.kind) {
    case 'setCorrespondent':
      return record.correspondent === action.value ? null : { correspondent: action.value };
    case 'setDocumentType':
      return record.documentType === action.value ? null : { documentType: action.value };
    case 'modifyTags': {
      const tags = [
        ...new Set([...record.tags.filter((tag) => !action.remove.includes(tag)), ...action.add]),
      ];
      const same = tags.length === record.tags.length && tags.every((t, i) => t === record.tags[i]);
      return same ? null : { tags };
    }
  }
}
