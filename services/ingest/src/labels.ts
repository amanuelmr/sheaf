import type { Label, LabelBody, LabelKind, LabelPatch } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import type { NameKind, Storage } from './storage.ts';

/** Why a change to labels was refused, in words a person can act on. */
export type LabelRefusal =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string };

type Outcome<T> =
  { readonly ok: true; readonly value: T } | ({ readonly ok: false } & LabelRefusal);

/** Where one kind of label lives: its `names` kind, document column, and field name. */
const STORE: Readonly<
  Record<LabelKind, { name: NameKind; column: string; field: string; noun: string }>
> = {
  correspondent: {
    name: 'correspondent',
    column: 'correspondent',
    field: 'correspondent',
    noun: 'correspondent',
  },
  documentType: {
    name: 'document_type',
    column: 'document_type',
    field: 'documentType',
    noun: 'document type',
  },
  tag: { name: 'tag', column: 'tags', field: 'tags', noun: 'tag' },
};

interface LabelRow {
  id: number;
  name: string;
  colour: string | null;
  documents: number | null;
}

/**
 * Correspondents, document types and tags as things in their own right.
 *
 * Documents keep these as text, so renaming, merging or deleting one rewrites
 * every place the old name is written: the document itself, the record of who set
 * each field, and suggestions not yet acted on. Accepting an old suggestion would
 * otherwise bring a deleted name back. Past extraction runs are history and stay
 * as they were.
 */
export class Labels {
  readonly #driver: SqlDriver;
  readonly #storage: Storage;

  constructor(driver: SqlDriver, storage: Storage) {
    this.#driver = driver;
    this.#storage = storage;
  }

  async list(kind: LabelKind): Promise<readonly Label[]> {
    const rows = await this.#driver.all<LabelRow>(
      `${select(kind)} ORDER BY n.name COLLATE NOCASE, n.id`,
      [STORE[kind].name],
    );
    return rows.map((row) => toLabel(kind, row));
  }

  async get(kind: LabelKind, id: number): Promise<Label | null> {
    const rows = await this.#driver.all<LabelRow>(`${select(kind)} AND n.id = ?`, [
      STORE[kind].name,
      id,
    ]);
    return rows[0] === undefined ? null : toLabel(kind, rows[0]);
  }

  async create(kind: LabelKind, body: LabelBody): Promise<Outcome<Label>> {
    if (body.colour !== undefined && kind !== 'tag') return onlyTags();
    if ((await this.#idOf(kind, body.name)) !== null) return taken(kind, body.name);
    try {
      await this.#driver.run('INSERT INTO names (kind, name, colour) VALUES (?, ?, ?)', [
        STORE[kind].name,
        body.name,
        body.colour ?? null,
      ]);
    } catch (error) {
      // Another request took the name between the check and the insert.
      if (isUniqueViolation(error)) return taken(kind, body.name);
      throw error;
    }
    const id = await this.#idOf(kind, body.name);
    return { ok: true, value: (await this.get(kind, id!))! };
  }

  /** Rename, recolour or both. A new name is written into every document carrying the old. */
  async update(kind: LabelKind, id: number, patch: LabelPatch): Promise<Outcome<Label>> {
    if (patch.colour !== undefined && kind !== 'tag') return onlyTags();
    const current = await this.get(kind, id);
    if (current === null) return { ok: false, kind: 'not_found' };
    const name = patch.name;
    if (name !== undefined && name !== current.name) {
      const other = await this.#idOf(kind, name);
      if (other !== null && other !== id) return taken(kind, name, 'merge into it instead');
    }
    try {
      await this.#driver.transaction(async () => {
        if (name !== undefined && name !== current.name) {
          await this.#driver.run('UPDATE names SET name = ? WHERE id = ?', [name, id]);
          await this.#replace(kind, current.name, name);
        }
        if (patch.colour !== undefined) {
          await this.#driver.run('UPDATE names SET colour = ? WHERE id = ?', [patch.colour, id]);
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) return taken(kind, name!, 'merge into it instead');
      throw error;
    }
    return { ok: true, value: (await this.get(kind, id))! };
  }

  /** Every document carrying `id` carries `into` instead, and `id` is gone. */
  async merge(kind: LabelKind, id: number, into: number): Promise<Outcome<Label>> {
    if (id === into) {
      return {
        ok: false,
        kind: 'invalid',
        message: `a ${STORE[kind].noun} cannot merge into itself`,
      };
    }
    const [source, target] = await Promise.all([this.get(kind, id), this.get(kind, into)]);
    if (source === null) return { ok: false, kind: 'not_found' };
    if (target === null) {
      return {
        ok: false,
        kind: 'invalid',
        message: `there is no ${STORE[kind].noun} ${String(into)}`,
      };
    }
    await this.#driver.transaction(async () => {
      await this.#replace(kind, source.name, target.name);
      await this.#driver.run('DELETE FROM names WHERE id = ?', [id]);
    });
    return { ok: true, value: (await this.get(kind, into))! };
  }

  /** Take the label off every document, then forget it. False when there is no such label. */
  async remove(kind: LabelKind, id: number): Promise<boolean> {
    const current = await this.get(kind, id);
    if (current === null) return false;
    await this.#driver.transaction(async () => {
      await this.#replace(kind, current.name, null);
      await this.#driver.run('DELETE FROM names WHERE id = ?', [id]);
    });
    return true;
  }

  async #idOf(kind: LabelKind, name: string): Promise<number | null> {
    const rows = await this.#driver.all<{ id: number }>(
      'SELECT id FROM names WHERE kind = ? AND name = ?',
      [STORE[kind].name, name],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Write `to` wherever `from` is written for this kind, or take `from` out when `to`
   * is null. A tag list that ends up naming one tag twice keeps it once, in the
   * place it first appeared.
   */
  async #replace(kind: LabelKind, from: string, to: string | null): Promise<void> {
    const { column, field } = STORE[kind];
    const run = (sql: string, params: Array<string | null>) => this.#driver.run(sql, params);

    if (kind === 'tag') {
      const has = (json: string) => `EXISTS (SELECT 1 FROM json_each(${json}) WHERE value = ?)`;
      const affected = await this.#driver.all<{ sha256: string }>(
        `SELECT sha256 FROM documents WHERE ${has('tags')}`,
        [from],
      );
      await run(`UPDATE documents SET tags = ${rewrite('tags')} WHERE ${has('tags')}`, [
        from,
        to,
        from,
      ]);
      await run(
        `UPDATE fields SET value_json = ${rewrite('value_json')}
          WHERE name = 'tags' AND json_type(value_json) = 'array' AND ${has('value_json')}`,
        [from, to, from],
      );
      await run(
        `UPDATE documents
            SET suggestions_json = json_set(suggestions_json, '$.tags',
                                            json(${rewrite("suggestions_json, '$.tags'")}))
          WHERE json_type(suggestions_json, '$.tags') = 'array'
            AND ${has("suggestions_json, '$.tags'")}`,
        [from, to, from],
      );
      await this.#storage.reindexMany(affected.map((row) => row.sha256));
      return;
    }

    const affected = await this.#driver.all<{ sha256: string }>(
      `SELECT sha256 FROM documents WHERE ${column} = ?`,
      [from],
    );
    await run(`UPDATE documents SET ${column} = ? WHERE ${column} = ?`, [to, from]);
    await run(
      `UPDATE fields SET value_json = ?
        WHERE name = ? AND json_type(value_json) = 'text' AND json_extract(value_json, '$') = ?`,
      [JSON.stringify(to), field, from],
    );
    const at = `'$.${field}'`;
    await run(
      to === null
        ? `UPDATE documents SET suggestions_json = json_remove(suggestions_json, ${at})
            WHERE json_extract(suggestions_json, ${at}) = ?`
        : `UPDATE documents SET suggestions_json = json_set(suggestions_json, ${at}, ?)
            WHERE json_extract(suggestions_json, ${at}) = ?`,
      to === null ? [from] : [to, from],
    );
    await this.#storage.reindexMany(affected.map((row) => row.sha256));
  }
}

/**
 * A JSON array of strings with every `from` (the first parameter) swapped for `to`
 * (the second), or dropped when `to` is null, keeping each name once and in order.
 */
function rewrite(json: string): string {
  return `(SELECT json_group_array(v ORDER BY k) FROM (
             SELECT v, MIN(key) AS k FROM (
               SELECT CASE WHEN value = ? THEN ? ELSE value END AS v, key FROM json_each(${json})
             ) WHERE v IS NOT NULL GROUP BY v))`;
}

/** Labels of one kind (the first parameter) with how many documents outside the trash carry each. */
function select(kind: LabelKind): string {
  const counts =
    kind === 'tag'
      ? `SELECT t.value AS name, COUNT(DISTINCT d.sha256) AS n
           FROM documents d, json_each(d.tags) t
          WHERE d.trashed_at IS NULL GROUP BY t.value`
      : `SELECT ${STORE[kind].column} AS name, COUNT(*) AS n FROM documents
          WHERE trashed_at IS NULL AND ${STORE[kind].column} IS NOT NULL
          GROUP BY ${STORE[kind].column}`;
  return `SELECT n.id, n.name, n.colour, c.n AS documents
            FROM names n LEFT JOIN (${counts}) c ON c.name = n.name
           WHERE n.kind = ?`;
}

function toLabel(kind: LabelKind, row: LabelRow): Label {
  return {
    id: row.id,
    kind,
    name: row.name,
    documents: row.documents ?? 0,
    colour: kind === 'tag' ? row.colour : null,
  };
}

function taken(kind: LabelKind, name: string, advice?: string) {
  const message = `a ${STORE[kind].noun} named "${name}" already exists`;
  return {
    ok: false,
    kind: 'conflict',
    message: advice === undefined ? message : `${message}; ${advice}`,
  } as const;
}

function onlyTags() {
  return { ok: false, kind: 'invalid', message: 'only tags have a colour' } as const;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}
