import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  LABEL_KINDS,
  type CustomFieldData,
  type CustomFieldType,
  type DocumentFilter,
  type LabelKind,
  type MatchingRule,
} from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import type { CustomFields } from './custom-fields.ts';
import { renderFilename } from './filename.ts';
import type { Labels } from './labels.ts';
import { AsnTaken, sha256Hex, type Storage } from './storage.ts';
import type { SavedViews } from './views.ts';

export const MANIFEST = 'manifest.json';
export const MANIFEST_VERSION = 1;

/**
 * Everything a person put into Sheaf, in one file beside the documents themselves.
 * Ids are left out on purpose: custom fields are matched by name and documents by
 * their hash, so a manifest imports into a server that already has other things.
 */
export interface Manifest {
  readonly version: number;
  readonly exportedAt: number;
  readonly labels: readonly {
    readonly kind: LabelKind;
    readonly name: string;
    readonly colour: string | null;
    readonly matching: MatchingRule;
    readonly inbox: boolean;
  }[];
  readonly customFields: readonly {
    readonly name: string;
    readonly type: CustomFieldType;
    readonly options: readonly string[];
  }[];
  readonly views: readonly {
    readonly name: string;
    readonly filter: DocumentFilter;
    readonly onDashboard: boolean;
    readonly position: number;
  }[];
  readonly documents: readonly ManifestDocument[];
}

export interface ManifestDocument {
  readonly sha256: string;
  /** Relative to the manifest; null when the server had already released the bytes. */
  readonly file: string | null;
  readonly receivedAt: number;
  readonly pageCount: number | null;
  readonly title: string | null;
  readonly correspondent: string | null;
  readonly documentType: string | null;
  readonly tags: readonly string[];
  readonly created: string | null;
  readonly asn: number | null;
  readonly texts: readonly { source: string; engine: string; text: string }[];
  readonly notes: readonly { text: string; createdAt: number }[];
  /** By field name; a document link holds hashes. */
  readonly customFields: readonly { field: string; value: CustomFieldData | null }[];
}

export interface BackupParts {
  readonly driver: SqlDriver;
  readonly storage: Storage;
  readonly labels: Labels;
  readonly fields: CustomFields;
  readonly views: SavedViews;
}

export interface ExportReport {
  readonly documents: number;
  /** Released by retention: in the manifest, but with no file. */
  readonly withoutFile: number;
}

/** Write every document outside the trash, named by `format`, and the manifest. */
export async function exportTo(
  dir: string,
  parts: BackupParts,
  format: string,
  now: number,
): Promise<ExportReport> {
  const { driver, storage, labels, fields, views } = parts;
  mkdirSync(dir, { recursive: true });
  const root = resolve(dir);
  const shas = await driver.all<{ sha256: string }>(
    'SELECT sha256 FROM documents WHERE trashed_at IS NULL ORDER BY received_at, sha256',
  );
  const used = new Set<string>();
  const documents: ManifestDocument[] = [];
  let withoutFile = 0;

  for (const { sha256 } of shas) {
    const record = (await storage.record(sha256))!;
    const bytes = storage.bytes(sha256);
    let file: string | null = null;
    if (bytes === null) {
      withoutFile++;
    } else {
      const base = renderFilename(format, record);
      file = `${base}.pdf`;
      for (let n = 2; used.has(file.toLowerCase()); n++) file = `${base} (${String(n)}).pdf`;
      used.add(file.toLowerCase());
      const target = resolve(root, file);
      // renderFilename keeps names inside; this is the check that it did.
      if (!target.startsWith(root + sep)) throw new Error(`refusing to write outside ${root}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    documents.push({
      sha256,
      file,
      receivedAt: record.receivedAt,
      pageCount: record.pageCount,
      title: record.title,
      correspondent: record.correspondent,
      documentType: record.documentType,
      tags: record.tags,
      created: record.created,
      asn: record.asn,
      texts: (await storage.texts(sha256)).map(({ source, engine, text }) => ({
        source,
        engine,
        text,
      })),
      notes: (await storage.notes(sha256)).map(({ text, createdAt }) => ({ text, createdAt })),
      customFields: (await fields.valuesOf(sha256)).map(({ name, value }) => ({
        field: name,
        value,
      })),
    });
  }

  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    exportedAt: now,
    labels: (await Promise.all(LABEL_KINDS.map((kind) => labels.list(kind)))).flatMap((list) =>
      list.map(({ kind, name, colour, matching, inbox }) => ({
        kind,
        name,
        colour,
        matching,
        inbox,
      })),
    ),
    customFields: (await fields.list()).map(({ name, type, options }) => ({ name, type, options })),
    views: (await views.list()).map(({ name, filter, onDashboard, position }) => ({
      name,
      filter,
      onDashboard,
      position,
    })),
    documents,
  };
  writeFileSync(join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { documents: documents.length, withoutFile };
}

export interface ImportReport {
  readonly imported: number;
  readonly alreadyHere: number;
  /** Each with the reason, for the person running the import to act on. */
  readonly problems: readonly string[];
}

/**
 * Read an export back. Safe to run again: documents already here are updated, not
 * duplicated, and notes already here are not added twice. Every file is checked
 * against its hash before it is stored.
 */
export async function importFrom(
  dir: string,
  parts: BackupParts,
  now: number,
): Promise<ImportReport> {
  const { storage, labels, fields, views } = parts;
  const root = resolve(dir);
  const path = join(root, MANIFEST);
  if (!existsSync(path)) throw new Error(`no ${MANIFEST} in ${root}`);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(
      `this is a version ${String(manifest.version)} export; only ${String(MANIFEST_VERSION)} can be read`,
    );
  }
  const problems: string[] = [];

  for (const label of manifest.labels) {
    const existing = (await labels.list(label.kind)).find((l) => l.name === label.name);
    const settings = {
      matching: label.matching,
      ...(label.kind === 'tag'
        ? { inbox: label.inbox, ...(label.colour === null ? {} : { colour: label.colour }) }
        : {}),
    };
    const result =
      existing === undefined
        ? await labels.create(label.kind, { name: label.name, ...settings })
        : await labels.update(label.kind, existing.id, settings);
    if (!result.ok) problems.push(`label ${label.name}: ${result.kind}`);
  }

  const fieldIds = new Map<string, number>();
  for (const field of manifest.customFields) {
    const existing = (await fields.list()).find(
      (f) => f.name.toLowerCase() === field.name.toLowerCase(),
    );
    if (existing !== undefined) {
      if (existing.type === field.type) fieldIds.set(field.name, existing.id);
      else
        problems.push(`custom field ${field.name}: here it is ${existing.type}, not ${field.type}`);
      continue;
    }
    const created = await fields.create(
      {
        name: field.name,
        type: field.type,
        ...(field.type === 'select' ? { options: field.options } : {}),
      },
      now,
    );
    if (created.ok) fieldIds.set(field.name, created.value.id);
    else problems.push(`custom field ${field.name}: ${created.kind}`);
  }

  const viewNames = new Set((await views.list()).map((v) => v.name.toLowerCase()));
  for (const view of manifest.views) {
    if (viewNames.has(view.name.toLowerCase())) continue;
    await views.create(
      { name: view.name, filter: view.filter, onDashboard: view.onDashboard },
      now,
    );
  }

  let imported = 0;
  let alreadyHere = 0;
  const stored: ManifestDocument[] = [];
  for (const doc of manifest.documents) {
    if (doc.file === null) {
      if (!(await storage.has(doc.sha256))) {
        problems.push(`${doc.sha256}: exported without its file, and not here`);
        continue;
      }
    } else {
      const target = resolve(root, doc.file);
      if (!target.startsWith(root + sep) || !existsSync(target)) {
        problems.push(`${doc.sha256}: ${doc.file} is missing`);
        continue;
      }
      const bytes = new Uint8Array(readFileSync(target));
      if (sha256Hex(bytes) !== doc.sha256) {
        problems.push(`${doc.sha256}: ${doc.file} does not match its hash`);
        continue;
      }
      const outcome = await storage.put(doc.sha256, bytes, doc.receivedAt, doc.pageCount);
      if (outcome === 'stored') imported++;
      else alreadyHere++;
    }
    const patch = {
      title: doc.title,
      correspondent: doc.correspondent,
      documentType: doc.documentType,
      tags: doc.tags,
      created: doc.created,
    };
    try {
      await storage.patch(doc.sha256, { ...patch, asn: doc.asn }, now);
    } catch (error) {
      if (!(error instanceof AsnTaken)) throw error;
      await storage.patch(doc.sha256, patch, now);
      problems.push(`${doc.sha256}: ${error.message}; imported without it`);
    }
    for (const text of doc.texts) await storage.putText(doc.sha256, text, now);
    const notes = await storage.notes(doc.sha256);
    for (const note of doc.notes) {
      if (!notes.some((n) => n.text === note.text && n.createdAt === note.createdAt)) {
        await storage.addNote(doc.sha256, note.text, null, note.createdAt);
      }
    }
    stored.push(doc);
  }

  // Values last: a document link needs the document it points at to be here.
  for (const doc of stored) {
    if (doc.customFields.length === 0) continue;
    const current = await fields.valuesOf(doc.sha256);
    const values = new Map(current.map((v) => [v.field, v.value]));
    for (const { field, value } of doc.customFields) {
      const id = fieldIds.get(field);
      if (id !== undefined) values.set(id, value);
    }
    const result = await fields.setValues(
      doc.sha256,
      [...values].map(([field, value]) => ({ field, value })),
      now,
    );
    if (!result.ok) {
      problems.push(
        `${doc.sha256}: custom fields not set (${result.kind === 'not_found' ? 'missing' : result.message})`,
      );
    }
  }
  return { imported, alreadyHere, problems };
}
