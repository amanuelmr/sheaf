import {
  MAX_DOCUMENT_LINKS,
  customFieldValueProblem,
  type CustomField,
  type CustomFieldBody,
  type CustomFieldData,
  type CustomFieldPatch,
  type CustomFieldType,
  type CustomFieldValue,
  type DocumentCustomField,
} from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import type { Storage } from './storage.ts';

/** Why a change to custom fields was refused, in words a person can act on. */
export type CustomFieldRefusal =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string };

type Outcome<T> =
  { readonly ok: true; readonly value: T } | ({ readonly ok: false } & CustomFieldRefusal);

interface FieldRow {
  id: number;
  name: string;
  data_type: CustomFieldType;
  options_json: string;
  document_count: number;
}

/**
 * Custom fields: definitions, and each
 * document's values of them.
 *
 * Document links are kept symmetric: linking A to B also
 * links B back to A, and unlinking undoes both. A link to a document that has since
 * been deleted for good is dropped when read rather than chased down at delete time.
 */
export class CustomFields {
  readonly #driver: SqlDriver;
  readonly #storage: Storage;

  constructor(driver: SqlDriver, storage: Storage) {
    this.#driver = driver;
    this.#storage = storage;
  }

  async list(): Promise<readonly CustomField[]> {
    const rows = await this.#driver.all<FieldRow>(
      `SELECT f.id, f.name, f.data_type, f.options_json,
              (SELECT COUNT(*) FROM custom_field_values v WHERE v.field_id = f.id) AS document_count
         FROM custom_fields f ORDER BY f.name COLLATE NOCASE, f.id`,
    );
    return rows.map(toField);
  }

  async get(id: number): Promise<CustomField | null> {
    return (await this.list()).find((field) => field.id === id) ?? null;
  }

  async create(body: CustomFieldBody, now: number): Promise<Outcome<CustomField>> {
    const name = body.name.trim();
    const taken = {
      ok: false,
      kind: 'conflict',
      message: `a field named "${name}" already exists`,
    } as const;
    if (await this.#nameTaken(name, null)) return taken;
    try {
      await this.#driver.run(
        'INSERT INTO custom_fields (name, data_type, options_json, created_at) VALUES (?, ?, ?, ?)',
        [name, body.type, JSON.stringify(body.options ?? []), now],
      );
    } catch (error) {
      // Another request took the name between the check and the insert.
      if (isUniqueViolation(error)) return taken;
      throw error;
    }
    const rows = await this.#driver.all<{ id: number }>(
      'SELECT id FROM custom_fields WHERE name = ?',
      [name],
    );
    return { ok: true, value: (await this.get(rows[0]!.id))! };
  }

  /**
   * Rename a field, or change a select's options. A document whose value is an
   * option that no longer exists keeps the field, with no value.
   */
  async update(id: number, patch: CustomFieldPatch, now: number): Promise<Outcome<CustomField>> {
    const field = await this.get(id);
    if (field === null) return { ok: false, kind: 'not_found' };
    if (patch.options !== undefined && field.type !== 'select') {
      return { ok: false, kind: 'invalid', message: 'only a select field has options' };
    }
    const name = patch.name?.trim();
    if (name !== undefined && (await this.#nameTaken(name, id))) {
      return { ok: false, kind: 'conflict', message: `a field named "${name}" already exists` };
    }
    try {
      await this.#rename(id, name, patch, now);
    } catch (error) {
      if (name !== undefined && isUniqueViolation(error)) {
        return { ok: false, kind: 'conflict', message: `a field named "${name}" already exists` };
      }
      throw error;
    }
    return { ok: true, value: (await this.get(id))! };
  }

  async #rename(
    id: number,
    name: string | undefined,
    patch: CustomFieldPatch,
    now: number,
  ): Promise<void> {
    await this.#driver.transaction(async () => {
      if (name !== undefined) {
        await this.#driver.run('UPDATE custom_fields SET name = ? WHERE id = ?', [name, id]);
      }
      if (patch.options !== undefined) {
        await this.#driver.run('UPDATE custom_fields SET options_json = ? WHERE id = ?', [
          JSON.stringify(patch.options),
          id,
        ]);
        await this.#driver.run(
          `UPDATE custom_field_values SET value_json = 'null', updated_at = ?
            WHERE field_id = ? AND value_json <> 'null'
              AND json_extract(value_json, '$') NOT IN (SELECT value FROM json_each(?))`,
          [now, id, JSON.stringify(patch.options)],
        );
      }
      for (const sha256 of await this.#documentsWith(id)) await this.#storage.reindex(sha256);
    });
  }

  /** Delete a field and every document's value of it. */
  async remove(id: number): Promise<boolean> {
    return this.#driver.transaction(async () => {
      if ((await this.get(id)) === null) return false;
      const documents = await this.#documentsWith(id);
      await this.#driver.run('DELETE FROM custom_field_values WHERE field_id = ?', [id]);
      await this.#driver.run('DELETE FROM custom_fields WHERE id = ?', [id]);
      for (const sha256 of documents) await this.#storage.reindex(sha256);
      return true;
    });
  }

  /** A document's fields, by name. Links to documents no longer stored are left out. */
  async valuesOf(sha256: string): Promise<readonly DocumentCustomField[]> {
    const rows = await this.#driver.all<{
      field_id: number;
      name: string;
      data_type: CustomFieldType;
      value_json: string;
    }>(
      `SELECT v.field_id, f.name, f.data_type, v.value_json
         FROM custom_field_values v JOIN custom_fields f ON f.id = v.field_id
        WHERE v.sha256 = ? ORDER BY f.name COLLATE NOCASE, f.id`,
      [sha256],
    );
    const result: DocumentCustomField[] = [];
    for (const row of rows) {
      let value = JSON.parse(row.value_json) as CustomFieldData | null;
      if (row.data_type === 'documentLink' && Array.isArray(value)) {
        const kept: string[] = [];
        for (const id of value as readonly string[]) if (await this.#storage.has(id)) kept.push(id);
        value = kept;
      }
      result.push({ field: row.field_id, name: row.name, type: row.data_type, value });
    }
    return result;
  }

  /**
   * Make a document carry exactly these fields, with these values. Every value is
   * checked against its field first, so a refusal changes nothing.
   */
  async setValues(
    sha256: string,
    values: readonly CustomFieldValue[],
    now: number,
  ): Promise<Outcome<readonly DocumentCustomField[]>> {
    if (!(await this.#storage.has(sha256))) return { ok: false, kind: 'not_found' };
    const fields = new Map((await this.list()).map((field) => [field.id, field]));
    for (const { field: id, value } of values) {
      const field = fields.get(id);
      if (field === undefined) {
        return { ok: false, kind: 'invalid', message: `there is no custom field ${String(id)}` };
      }
      const problem = customFieldValueProblem(field, value);
      if (problem !== null) {
        return { ok: false, kind: 'invalid', message: `${field.name} must be ${problem}` };
      }
      if (field.type === 'documentLink' && asLinks(value).includes(sha256)) {
        return { ok: false, kind: 'invalid', message: 'a document cannot link to itself' };
      }
    }

    // Checked and written in one transaction, so what was checked is what is written
    // over, and a refusal leaves everything as it was.
    const refused = await this.#driver.transaction(async (): Promise<string | null> => {
      const before = await this.#rawValues(sha256);
      const changes: { field: number; added: string[]; removed: string[] }[] = [];
      for (const field of new Set([...before.keys(), ...values.map((v) => v.field)])) {
        if (fields.get(field)?.type !== 'documentLink') continue;
        const was = new Set(asLinks(before.get(field)));
        const after = new Set(asLinks(values.find((v) => v.field === field)?.value ?? null));
        changes.push({
          field,
          added: [...after].filter((target) => !was.has(target)),
          removed: [...was].filter((target) => !after.has(target)),
        });
      }

      // Every newly linked document must exist and have room for the link back.
      for (const { field, added } of changes) {
        if (added.length === 0) continue;
        const present = new Set(
          (
            await this.#driver.all<{ sha256: string }>(
              'SELECT sha256 FROM documents WHERE sha256 IN (SELECT value FROM json_each(?))',
              [JSON.stringify(added)],
            )
          ).map((row) => row.sha256),
        );
        const missing = added.find((target) => !present.has(target));
        if (missing !== undefined) return `no document ${missing.slice(0, 8)}…`;
        const theirs = await this.#driver.all<{ sha256: string; value_json: string }>(
          `SELECT sha256, value_json FROM custom_field_values
            WHERE field_id = ? AND sha256 IN (SELECT value FROM json_each(?))`,
          [field, JSON.stringify(added)],
        );
        for (const row of theirs) {
          if (asLinks(JSON.parse(row.value_json)).length >= MAX_DOCUMENT_LINKS) {
            return `${row.sha256.slice(0, 8)}… already links ${String(MAX_DOCUMENT_LINKS)} documents`;
          }
        }
      }

      await this.#driver.run('DELETE FROM custom_field_values WHERE sha256 = ?', [sha256]);
      for (const { field, value } of values) {
        await this.#write(sha256, field, value, now);
      }
      // Mirror every link change onto the other document.
      const touched = new Set<string>([sha256]);
      for (const { field, added, removed } of changes) {
        for (const target of added) {
          await this.#link(target, field, sha256, true, now);
          touched.add(target);
        }
        for (const target of removed) {
          await this.#link(target, field, sha256, false, now);
          touched.add(target);
        }
      }
      for (const document of touched) await this.#storage.reindex(document);
      return null;
    });
    if (refused !== null) return { ok: false, kind: 'invalid', message: refused };
    return { ok: true, value: await this.valuesOf(sha256) };
  }

  /** Add or remove one link from `document`'s value of `field`. */
  async #link(
    document: string,
    field: number,
    other: string,
    present: boolean,
    now: number,
  ): Promise<void> {
    const current = asLinks((await this.#rawValues(document)).get(field) ?? null);
    const next = present
      ? current.includes(other)
        ? current
        : [...current, other]
      : current.filter((id) => id !== other);
    await this.#write(document, field, next, now);
  }

  async #write(sha256: string, field: number, value: unknown, now: number): Promise<void> {
    await this.#driver.run(
      `INSERT INTO custom_field_values (sha256, field_id, value_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (sha256, field_id) DO UPDATE SET
         value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [sha256, field, JSON.stringify(value), now],
    );
  }

  async #rawValues(sha256: string): Promise<Map<number, unknown>> {
    const rows = await this.#driver.all<{ field_id: number; value_json: string }>(
      'SELECT field_id, value_json FROM custom_field_values WHERE sha256 = ?',
      [sha256],
    );
    return new Map(rows.map((row) => [row.field_id, JSON.parse(row.value_json) as unknown]));
  }

  async #documentsWith(field: number): Promise<readonly string[]> {
    const rows = await this.#driver.all<{ sha256: string }>(
      'SELECT sha256 FROM custom_field_values WHERE field_id = ?',
      [field],
    );
    return rows.map((row) => row.sha256);
  }

  async #nameTaken(name: string, except: number | null): Promise<boolean> {
    const rows = await this.#driver.all<{ id: number }>(
      'SELECT id FROM custom_fields WHERE name = ? COLLATE NOCASE',
      [name],
    );
    return rows.some((row) => row.id !== except);
  }
}

/** SQLite refusing a write because a UNIQUE constraint would be broken. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}

function asLinks(value: unknown): readonly string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

function toField(row: FieldRow): CustomField {
  return {
    id: row.id,
    name: row.name,
    type: row.data_type,
    options: JSON.parse(row.options_json) as string[],
    documentCount: row.document_count,
  };
}
