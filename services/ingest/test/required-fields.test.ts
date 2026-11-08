/** Custom fields every document should have a value for. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, expect, it } from 'vitest';
import { paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { CustomFields } from '../src/custom-fields';
import { handle } from '../src/router';
import { Storage, sha256Hex } from '../src/storage';

const TOKEN = 'admin-token-required';
const NOW = 1_700_000_000_000;

suite('required custom fields', () => {
  it('refuses a person saving a document without them, and can be turned off', async () => {
    const driver = nodeSqliteDriver();
    const storage = await Storage.open({
      driver,
      objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-req-')),
    });
    const customFields = new CustomFields(driver, storage);
    const deps = { storage, customFields, token: TOKEN, now: () => NOW };
    const call = (method: string, path: string, body: unknown) =>
      handle(
        {
          method,
          path,
          query: '',
          headers: { authorization: `Bearer ${TOKEN}` },
          body: new Uint8Array(Buffer.from(JSON.stringify(body))),
        },
        deps,
      );
    const bytes = new Uint8Array(Buffer.from('%PDF-1.4\nx\n%%EOF\n'));
    const sha = sha256Hex(bytes);
    await storage.put(sha, bytes, NOW, 1);

    const invoice = (
      await call('POST', paths.customFields(), {
        name: 'Invoice number',
        type: 'text',
        required: true,
      })
    ).json as { id: number; required: boolean };
    expect(invoice.required).toBe(true);
    const note = (await call('POST', paths.customFields(), { name: 'Note', type: 'text' }))
      .json as { id: number; required: boolean };
    expect(note.required).toBe(false);

    const save = (values: unknown[]) => call('PUT', paths.documentCustomFields(sha), { values });
    const refused = await save([{ field: note.id, value: 'hello' }]);
    expect(refused.status).toBe(400);
    expect((refused.json as { detail: string }).detail).toMatch(/Invoice number is required/);
    expect((await save([{ field: invoice.id, value: null }])).status).toBe(400);
    expect((await save([{ field: invoice.id, value: 'INV-7' }])).status).toBe(200);

    await call('PATCH', paths.customField(invoice.id), { required: false });
    expect((await save([])).status).toBe(200);
    expect(
      (await call('POST', paths.customFields(), { name: 'X', type: 'text', required: 'yes' }))
        .status,
    ).toBe(400);
  });
});
