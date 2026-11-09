/** Custom field values learned from the documents most like a new one. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, expect, it } from 'vitest';
import { paths } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { CustomFields } from '../src/custom-fields';
import { handle } from '../src/router';
import { Storage, sha256Hex } from '../src/storage';

const TOKEN = 'admin-token-field-suggest';
const NOW = 1_700_000_000_000;

const INSURER =
  'Northwind Insurance policy schedule renewal notice home contents cover premium excess';
const GROCER = 'Corner grocery receipt bread milk apples cheese total cash change thank you';

async function setup() {
  const driver = nodeSqliteDriver();
  const storage = await Storage.open({
    driver,
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-fsug-')),
  });
  const fields = new CustomFields(driver, storage);
  let n = 0;
  const add = async (text: string, correspondent: string) => {
    const bytes = new Uint8Array(Buffer.from(`%PDF-1.4\n${String(n++)}\n%%EOF\n`));
    const sha = sha256Hex(bytes);
    await storage.put(sha, bytes, NOW + n, 1);
    await storage.putText(
      sha,
      { source: 'test', engine: 'test', text: `${text} ${String(n)}` },
      NOW,
    );
    await storage.patch(sha, { correspondent });
    return sha;
  };
  const created = async (body: object) => {
    const result = await fields.create(body as never, NOW);
    if (!result.ok) throw new Error(result.kind);
    return result.value.id;
  };
  return { storage, fields, add, created };
}

suite('suggesting custom field values', () => {
  it('offers the value documents like this one share, and not a one-off', async () => {
    const { fields, add, created } = await setup();
    const policy = await created({ name: 'Policy number', type: 'text' });
    const area = await created({
      name: 'Area',
      type: 'select',
      options: ['Home', 'Food', 'Car'],
    });
    const invoice = await created({ name: 'Invoice number', type: 'text' });
    for (let i = 0; i < 3; i++) {
      const sha = await add(INSURER, 'Northwind');
      await fields.setValues(
        sha,
        [
          { field: policy, value: 'NW-55102' },
          { field: area, value: 'Home' },
          { field: invoice, value: `INV-${String(i)}` },
        ],
        NOW,
      );
    }
    for (let i = 0; i < 3; i++) {
      const sha = await add(GROCER, 'Corner Grocery');
      await fields.setValues(sha, [{ field: area, value: 'Food' }], NOW);
    }

    const fresh = await add(INSURER, 'Northwind');
    const suggestions = await fields.suggestions(fresh, null);
    expect(suggestions.map((s) => [s.field, s.value])).toEqual(
      expect.arrayContaining([
        [policy, 'NW-55102'],
        [area, 'Home'],
      ]),
    );
    // Each invoice number is on one document only: nothing to learn.
    expect(suggestions.find((s) => s.field === invoice)).toBeUndefined();
    expect(suggestions.every((s) => s.confidence >= 0.6 && s.basedOn >= 2)).toBe(true);

    const receipt = await add(GROCER, 'Corner Grocery');
    expect((await fields.suggestions(receipt, null)).map((s) => s.value)).toEqual(['Food']);
  });

  it('leaves out fields the document already has, and answers over the API', async () => {
    const { storage, fields, add, created } = await setup();
    const area = await created({ name: 'Area', type: 'select', options: ['Home', 'Food'] });
    for (let i = 0; i < 2; i++) {
      await fields.setValues(
        await add(GROCER, 'Corner Grocery'),
        [{ field: area, value: 'Food' }],
        NOW,
      );
    }
    const receipt = await add(GROCER, 'Corner Grocery');
    const call = () =>
      handle(
        {
          method: 'GET',
          path: paths.documentFieldSuggestions(receipt),
          query: '',
          headers: { authorization: `Bearer ${TOKEN}` },
          body: new Uint8Array(),
        },
        { storage, customFields: fields, token: TOKEN, now: () => NOW },
      );
    expect(((await call()).json as { suggestions: unknown[] }).suggestions).toHaveLength(1);
    await fields.setValues(receipt, [{ field: area, value: 'Home' }], NOW);
    expect(((await call()).json as { suggestions: unknown[] }).suggestions).toEqual([]);
  });
});
