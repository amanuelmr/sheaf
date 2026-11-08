/** The audit log: every change that went through, and who made it. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { AuditLog, describe as describeChange } from '../src/audit';
import { handle, type IngestRequest } from '../src/router';
import { Storage, sha256Hex } from '../src/storage';
import { Users } from '../src/users';

const TOKEN = 'admin-token-for-audit';
const NOW = 1_700_000_000_000;
const PDF = new Uint8Array(Buffer.from('%PDF-1.4\naudit\n%%EOF\n'));
const SHA = sha256Hex(PDF);

let deps: Parameters<typeof handle>[1];
let storage: Storage;

const req = (method: string, path: string, token: string, body?: unknown): IngestRequest => ({
  method,
  path,
  query: '',
  headers: { authorization: `Bearer ${token}` },
  body:
    body instanceof Uint8Array
      ? body
      : new Uint8Array(Buffer.from(body === undefined ? '' : JSON.stringify(body))),
});

beforeEach(async () => {
  const driver = nodeSqliteDriver();
  storage = await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-au-')) });
  const users = new Users(driver);
  await users.create({ username: 'ed', password: 'a long password', role: 'editor' }, NOW);
  deps = { storage, token: TOKEN, now: () => NOW, users, audit: new AuditLog(driver) };
});

suite('the audit log', () => {
  it('writes down each change that went through, with who made it, and nothing else', async () => {
    const signed = await handle(
      {
        ...req('POST', paths.sessions(), ''),
        headers: {},
        body: new Uint8Array(Buffer.from('{"username":"ed","password":"a long password"}')),
      },
      deps,
    );
    const ed = (signed.json as { token: string }).token;
    await handle(req('PUT', paths.document(SHA), TOKEN, PDF), deps);
    await handle(req('PATCH', paths.document(SHA), ed, { title: 'Lease' }), deps);
    await handle(req('PATCH', paths.document(SHA), ed, { asn: 0 }), deps); // refused: not written down
    await handle(req('GET', paths.documentRecord(SHA), ed), deps); // a read: not written down

    const log = await handle(req('GET', paths.audit(), TOKEN), deps);
    expect((log.json as { entries: object[] }).entries).toEqual([
      { id: 2, at: NOW, who: 'ed', what: 'Edited the details', sha256: SHA },
      { id: 1, at: NOW, who: 'admin token', what: 'Uploaded the document', sha256: SHA },
    ]);
    const older = await handle({ ...req('GET', paths.audit(), TOKEN), query: 'before=2' }, deps);
    expect((older.json as { entries: { id: number }[] }).entries.map((e) => e.id)).toEqual([1]);
    expect((await handle(req('GET', paths.audit(), ed), deps)).status).toBe(403);
  });

  it('shows in a document’s history who changed it', async () => {
    await storage.put(SHA, PDF, NOW, 1);
    await deps.audit!.record(
      { kind: 'user', id: 1, name: 'ed' },
      'POST',
      `/v1/documents/${SHA}/notes`,
      201,
      NOW + 1,
    );
    const history = await storage.history(SHA);
    expect(history.map((e) => e.text)).toContain('Added a note (ed)');
  });

  it('puts a change in a few words', () => {
    expect(describeChange('DELETE', `/v1/documents/${SHA}`)).toBe('Moved it to the trash');
    expect(describeChange('POST', '/v1/labels/tags')).toBe('Added to labels');
    expect(describeChange('PATCH', '/v1/custom-fields/3')).toBe('Changed custom fields');
  });

  it('names page edits, stamps and restores for what they are', () => {
    const doc = `/v1/documents/${'a'.repeat(64)}`;
    expect(describeChange('POST', `${doc}/stamp`)).toBe('Stamped it');
    expect(describeChange('POST', `${doc}/pages`)).toBe('Edited its pages');
    expect(describeChange('POST', `${doc}/split`)).toBe('Split it into new documents');
    expect(describeChange('POST', `${doc}/versions/${'b'.repeat(64)}/restore`)).toBe(
      'Restored an earlier version',
    );
  });
});
