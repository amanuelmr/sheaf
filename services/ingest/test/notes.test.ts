/**
 * Notes people write on a document: kept in order, attributed to the phone that
 * wrote them, searchable with the rest of the document, and part of its history.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { isNoteBody, MAX_NOTE_LENGTH } from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { Devices } from '../src/devices';
import { toMatch } from '../src/search-query';
import { Storage, sha256Hex } from '../src/storage';

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const A = pdf('a');
const B = pdf('b');
const hashA = sha256Hex(A);
const hashB = sha256Hex(B);
const NOW = 1_700_000_000_000;

let driver: SqlDriver;
let storage: Storage;

beforeEach(async () => {
  driver = nodeSqliteDriver();
  storage = await Storage.open({
    driver,
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-notes-')),
  });
  await storage.put(hashA, A, NOW, 1);
  await storage.put(hashB, B, NOW, 1);
});

const find = async (q: string): Promise<string[]> =>
  (await storage.search(toMatch(q)!, 20, 0)).hits.map((hit) => hit.sha256);

suite('notes on a document', () => {
  it('keeps notes oldest first, each with its own id', async () => {
    const first = await storage.addNote(hashA, 'Paid by card', null, NOW + 2);
    const second = await storage.addNote(hashA, 'Warranty until 2028', null, NOW + 1);
    expect(first?.id).not.toBe(second?.id);
    expect((await storage.notes(hashA)).map((note) => note.text)).toEqual([
      'Warranty until 2028',
      'Paid by card',
    ]);
    expect(await storage.notes(hashB)).toEqual([]);
  });

  it('names the paired phone that wrote a note, and nobody for the admin token', async () => {
    const devices = new Devices(driver, { now: () => NOW });
    const { code } = await devices.createPairingCode();
    const { deviceId } = (await devices.pair(code, 'Kitchen iPhone'))!;

    const fromPhone = await storage.addNote(hashA, 'Scanned at home', deviceId, NOW);
    const fromAdmin = await storage.addNote(hashA, 'Checked', null, NOW + 1);
    expect(fromPhone?.author).toBe('Kitchen iPhone');
    expect(fromAdmin?.author).toBeNull();
  });

  it('refuses a note on a document it does not hold', async () => {
    expect(await storage.addNote(sha256Hex(pdf('nope')), 'x', null, NOW)).toBeNull();
  });

  it('makes a note searchable, and forgets it once deleted', async () => {
    const note = await storage.addNote(hashA, 'returned the blender', null, NOW);
    expect(await find('blender')).toEqual([hashA]);

    expect(await storage.deleteNote(hashA, note!.id)).toBe(true);
    expect(await find('blender')).toEqual([]);
    expect(await storage.notes(hashA)).toEqual([]);
  });

  it('keeps the recognised text searchable alongside the notes', async () => {
    await storage.putText(hashA, { source: 'edge', engine: 'mlkit', text: 'CINEMA CITY' }, NOW);
    await storage.addNote(hashA, 'date night', null, NOW);
    expect(await find('cinema')).toEqual([hashA]);
    expect(await find('night')).toEqual([hashA]);
  });

  it('deletes only a note that belongs to the document named', async () => {
    const note = await storage.addNote(hashA, 'mine', null, NOW);
    expect(await storage.deleteNote(hashB, note!.id)).toBe(false);
    expect(await storage.deleteNote(hashA, note!.id + 1)).toBe(false);
    expect(await storage.notes(hashA)).toHaveLength(1);
  });

  it('shows each note in the document history', async () => {
    await storage.addNote(hashA, 'one', null, NOW + 5);
    const events = await storage.history(hashA);
    expect(events.map((event) => event.text)).toContain('Note added');
    expect(events.at(-1)?.at).toBe(NOW + 5);
  });
});

suite('what a note body may be', () => {
  it('needs some non-blank text within the limit', () => {
    expect(isNoteBody({ text: 'ok' })).toBe(true);
    expect(isNoteBody({ text: '   ' })).toBe(false);
    expect(isNoteBody({ text: 'x'.repeat(MAX_NOTE_LENGTH + 1) })).toBe(false);
    expect(isNoteBody({ text: 3 })).toBe(false);
    expect(isNoteBody(null)).toBe(false);
  });
});
