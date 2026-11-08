import type { SqlDriver } from '@sheaf/store';
import type { MatchingAlgorithm } from '@sheaf/protocol';
import { matches } from './matching.ts';
import type { NameKind, Storage } from './storage.ts';

interface RuleRow {
  kind: NameKind;
  name: string;
  match_algorithm: MatchingAlgorithm;
  match_pattern: string;
  match_case: number;
  inbox: number;
}

/** What applying the rules did to one document. */
export interface Applied {
  readonly correspondent?: string;
  readonly documentType?: string;
  readonly tags: readonly string[];
}

/**
 * Files documents by the labels' own rules.
 *
 * A rule only fills in what nobody chose: a correspondent or document type is set
 * when the document has none and no person cleared it, and tags are added only to a
 * document whose tags no person has set. When several correspondents or document
 * types match, the first by name wins. Inbox tags go on new documents only.
 */
export class Rules {
  readonly #driver: SqlDriver;
  readonly #storage: Storage;

  constructor(driver: SqlDriver, storage: Storage) {
    this.#driver = driver;
    this.#storage = storage;
  }

  /** Apply every rule to one document; null when it is not here or is in the trash. */
  async apply(sha256: string, options: { inbox: boolean }): Promise<Applied | null> {
    const record = await this.#storage.record(sha256);
    if (record === null || record.trashedAt !== undefined) return null;
    const rules = await this.#driver.all<RuleRow>(
      `SELECT kind, name, match_algorithm, match_pattern, match_case, inbox FROM names
        WHERE match_algorithm <> 'none' OR inbox = 1
        ORDER BY name COLLATE NOCASE, id`,
    );
    if (rules.length === 0) return { tags: [] };

    const text = (await this.#storage.texts(sha256)).map((t) => t.text).join('\n\n');
    const chosen = new Set(
      (await this.#storage.fields(sha256)).filter((f) => f.source === 'user').map((f) => f.name),
    );
    const found = (kind: NameKind) =>
      rules
        .filter(
          (rule) =>
            rule.kind === kind &&
            matches(
              {
                algorithm: rule.match_algorithm,
                pattern: rule.match_pattern,
                caseSensitive: rule.match_case === 1,
              },
              text,
            ),
        )
        .map((rule) => rule.name);

    const correspondent =
      record.correspondent === null && !chosen.has('correspondent')
        ? found('correspondent')[0]
        : undefined;
    const documentType =
      record.documentType === null && !chosen.has('documentType')
        ? found('document_type')[0]
        : undefined;
    const wanted = chosen.has('tags')
      ? []
      : [
          ...found('tag'),
          ...(options.inbox ? rules.filter((r) => r.kind === 'tag' && r.inbox === 1) : []).map(
            (r) => r.name,
          ),
        ];
    const tags = [...new Set(wanted)].filter((tag) => !record.tags.includes(tag));

    if (correspondent === undefined && documentType === undefined && tags.length === 0) {
      return { tags: [] };
    }
    await this.#driver.transaction(async () => {
      await this.#driver.run(
        `UPDATE documents SET correspondent = COALESCE(?, correspondent),
                              document_type = COALESCE(?, document_type),
                              tags = ?
          WHERE sha256 = ?`,
        [
          correspondent ?? null,
          documentType ?? null,
          JSON.stringify(await this.#storage.withAncestors([...record.tags, ...tags])),
          sha256,
        ],
      );
      await this.#storage.reindex(sha256);
    });
    return {
      ...(correspondent === undefined ? {} : { correspondent }),
      ...(documentType === undefined ? {} : { documentType }),
      tags,
    };
  }

  /**
   * Apply the rules again to the documents named, or to every one outside the
   * trash. Inbox tags are left off: these documents are not new. Answers how many
   * changed.
   */
  async applyAll(sha256s?: readonly string[]): Promise<number> {
    const targets =
      sha256s ??
      (
        await this.#driver.all<{ sha256: string }>(
          'SELECT sha256 FROM documents WHERE trashed_at IS NULL ORDER BY received_at',
        )
      ).map((row) => row.sha256);
    let changed = 0;
    for (const sha256 of targets) {
      const applied = await this.apply(sha256, { inbox: false });
      if (
        applied !== null &&
        (applied.correspondent !== undefined ||
          applied.documentType !== undefined ||
          applied.tags.length > 0)
      ) {
        changed++;
      }
    }
    return changed;
  }
}
