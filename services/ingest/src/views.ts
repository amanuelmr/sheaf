import type { DocumentFilter, SavedView, SavedViewBody, SavedViewPatch } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';

export type ViewRefusal =
  { readonly kind: 'not_found' } | { readonly kind: 'conflict'; readonly message: string };

type Outcome<T> = { readonly ok: true; readonly value: T } | ({ readonly ok: false } & ViewRefusal);

interface ViewRow {
  id: number;
  name: string;
  filter_json: string;
  on_dashboard: number;
  position: number;
}

const SELECT = 'SELECT id, name, filter_json, on_dashboard, position FROM saved_views';

/** Filters kept under a name; names are unique whatever their case. */
export class SavedViews {
  readonly #driver: SqlDriver;

  constructor(driver: SqlDriver) {
    this.#driver = driver;
  }

  /** Those on the dashboard first, in their order; then the rest by name. */
  async list(): Promise<readonly SavedView[]> {
    const rows = await this.#driver.all<ViewRow>(
      `${SELECT} ORDER BY on_dashboard DESC,
                          CASE WHEN on_dashboard = 1 THEN position END,
                          name COLLATE NOCASE, id`,
    );
    return rows.map(toView);
  }

  async get(id: number): Promise<SavedView | null> {
    const rows = await this.#driver.all<ViewRow>(`${SELECT} WHERE id = ?`, [id]);
    return rows[0] === undefined ? null : toView(rows[0]);
  }

  async create(body: SavedViewBody, now: number): Promise<Outcome<SavedView>> {
    const last = await this.#driver.all<{ n: number | null }>(
      'SELECT MAX(position) AS n FROM saved_views',
    );
    try {
      await this.#driver.run(
        `INSERT INTO saved_views (name, filter_json, on_dashboard, position, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          body.name,
          JSON.stringify(body.filter),
          body.onDashboard === true ? 1 : 0,
          (last[0]?.n ?? 0) + 1,
          now,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) return taken(body.name);
      throw error;
    }
    const rows = await this.#driver.all<ViewRow>(`${SELECT} WHERE name = ?`, [body.name]);
    return { ok: true, value: toView(rows[0]!) };
  }

  async update(id: number, patch: SavedViewPatch): Promise<Outcome<SavedView>> {
    if ((await this.get(id)) === null) return { ok: false, kind: 'not_found' };
    const sets: string[] = [];
    const values: Array<string | number> = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      values.push(patch.name);
    }
    if (patch.filter !== undefined) {
      sets.push('filter_json = ?');
      values.push(JSON.stringify(patch.filter));
    }
    if (patch.onDashboard !== undefined) {
      sets.push('on_dashboard = ?');
      values.push(patch.onDashboard ? 1 : 0);
    }
    if (patch.position !== undefined) {
      sets.push('position = ?');
      values.push(patch.position);
    }
    if (sets.length > 0) {
      try {
        await this.#driver.run(`UPDATE saved_views SET ${sets.join(', ')} WHERE id = ?`, [
          ...values,
          id,
        ]);
      } catch (error) {
        if (isUniqueViolation(error)) return taken(patch.name ?? '');
        throw error;
      }
    }
    return { ok: true, value: (await this.get(id))! };
  }

  async remove(id: number): Promise<boolean> {
    if ((await this.get(id)) === null) return false;
    await this.#driver.run('DELETE FROM saved_views WHERE id = ?', [id]);
    return true;
  }
}

function toView(row: ViewRow): SavedView {
  return {
    id: row.id,
    name: row.name,
    filter: JSON.parse(row.filter_json) as DocumentFilter,
    onDashboard: row.on_dashboard === 1,
    position: row.position,
  };
}

function taken(name: string) {
  return { ok: false, kind: 'conflict', message: `a view named "${name}" already exists` } as const;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}
