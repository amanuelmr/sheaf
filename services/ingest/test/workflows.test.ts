/** Workflows: when a document is added or edited, and it is like this, do that. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { paths, workflowProblem, type WorkflowBody } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { CustomFields } from '../src/custom-fields';
import { Rules } from '../src/rules';
import { handle, type IngestRequest } from '../src/router';
import { matchStep } from '../src/steps/match';
import { Storage, sha256Hex } from '../src/storage';
import { Workflows } from '../src/workflows';

const pdf = (s: string): Uint8Array => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));
const A = pdf('a');
const hashA = sha256Hex(A);
const NOW = Date.parse('2026-03-04T10:00:00Z');
const TOKEN = 'admin-token-for-workflows';

let storage: Storage;
let fields: CustomFields;
let workflows: Workflows;
let calls: { url: string; body: string }[];
let warnings: string[];
let rules: Rules;

const body = (overrides: Partial<WorkflowBody>): WorkflowBody => ({
  name: 'w',
  enabled: true,
  trigger: 'added',
  conditions: {},
  actions: { addTags: ['x'] },
  ...overrides,
});

beforeEach(async () => {
  const driver = nodeSqliteDriver();
  storage = await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-wf-')) });
  fields = new CustomFields(driver, storage);
  rules = new Rules(driver, storage);
  calls = [];
  warnings = [];
  workflows = new Workflows(driver, storage, fields, {
    fetch: (url, init) => {
      calls.push({ url, body: init.body as string });
      return Promise.resolve({
        ok: url.includes('good'),
        status: url.includes('good') ? 200 : 500,
      });
    },
    warn: (message) => warnings.push(message),
  });
  await storage.put(hashA, A, NOW, 1);
  await storage.putText(
    hashA,
    { source: 'edge', engine: 'x', text: 'Invoice from City Power' },
    NOW,
  );
});

suite('workflows', () => {
  it('run in order for their trigger, each seeing what the last did', async () => {
    await workflows.create(
      body({
        name: 'file power bills',
        conditions: { text: { algorithm: 'exact', pattern: 'city power', caseSensitive: false } },
        actions: { correspondent: 'City Power', addTags: ['bills', 'unpaid'] },
      }),
      NOW,
    );
    await workflows.create(
      body({
        name: 'title bills',
        conditions: { tags: ['bills'], correspondent: 'City Power' },
        actions: { title: '{{correspondent}} {{added}}', removeTags: ['unpaid'] },
      }),
      NOW,
    );
    await workflows.create(body({ name: 'off', enabled: false }), NOW);
    await workflows.create(body({ name: 'on edit', trigger: 'updated' }), NOW);

    expect(await workflows.run('added', hashA, NOW)).toEqual(['file power bills', 'title bills']);
    expect(await storage.record(hashA)).toMatchObject({
      correspondent: 'City Power',
      tags: ['bills'],
      title: 'City Power 2026-03-04',
    });
    // The server's doing, not a person's: rules and extraction may still fill these in.
    expect((await storage.fields(hashA)).filter((f) => f.source === 'user')).toEqual([]);
  });

  it('skip a document that does not meet every condition', async () => {
    await workflows.create(
      body({ conditions: { notTags: ['done'], documentType: 'Invoice' } }),
      NOW,
    );
    expect(await workflows.run('added', hashA, NOW)).toEqual([]);
  });

  it('set a custom field and call a webhook, reporting one that fails', async () => {
    const ref = await fields.create({ name: 'Ref', type: 'text' }, NOW);
    if (!ref.ok) throw new Error('no field');
    await workflows.create(
      body({
        actions: {
          customField: { field: ref.value.id, value: 'auto' },
          webhook: 'https://good.example/hook',
        },
      }),
      NOW,
    );
    await workflows.create(
      body({ name: 'bad hook', actions: { webhook: 'https://bad.example/hook' } }),
      NOW,
    );
    expect(await workflows.run('added', hashA, NOW)).toEqual(['w', 'bad hook']);
    expect((await fields.valuesOf(hashA)).map((v) => v.value)).toEqual(['auto']);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      workflow: 'w',
      document: { sha256: hashA },
    });
    expect(warnings).toEqual(['workflow "bad hook": webhook answered 500']);
  });

  it('run for a new document after its rules, as part of the matching step', async () => {
    await workflows.create(body({ actions: { addTags: ['seen'] } }), NOW);
    const step = matchStep(storage, rules, { graceMs: 0, workflows });
    await step.run((await storage.record(hashA))!, { now: NOW });
    expect((await storage.record(hashA))?.tags).toEqual(['seen']);
  });

  it('run on a person’s edit, and the answer shows what they did', async () => {
    await workflows.create(
      body({
        trigger: 'updated',
        conditions: { tags: ['paid'] },
        actions: { removeTags: ['unpaid'] },
      }),
      NOW,
    );
    const deps = { storage, token: TOKEN, now: () => NOW, workflows };
    const req = (method: string, path: string, json?: unknown): IngestRequest => ({
      method,
      path,
      query: '',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: new Uint8Array(Buffer.from(json === undefined ? '' : JSON.stringify(json))),
    });
    const patched = await handle(
      req('PATCH', paths.document(hashA), { tags: ['unpaid', 'paid'] }),
      deps,
    );
    expect((patched.json as { tags: string[] }).tags).toEqual(['paid']);

    const bad = await handle(req('POST', paths.workflows(), { ...body({}), actions: {} }), deps);
    expect(bad).toMatchObject({ status: 400 });
    const made = await handle(req('POST', paths.workflows(), body({ name: 'new' })), deps);
    const { id } = made.json as { id: number };
    const replaced = await handle(req('PUT', paths.workflow(id), body({ name: 'renamed' })), deps);
    expect(replaced.json).toMatchObject({ id, name: 'renamed' });
    expect((await handle(req('DELETE', paths.workflow(id)), deps)).status).toBe(204);
  });

  it('refuse a body they cannot run, saying why', () => {
    expect(workflowProblem(body({}))).toBeNull();
    expect(workflowProblem(body({ actions: {} }))).toMatch(/at least one action/);
    expect(workflowProblem(body({ actions: { title: '{{owner}}' } }))).toMatch(/owner/);
    expect(workflowProblem(body({ actions: { webhook: 'ftp://x' } }))).toMatch(/http/);
    expect(
      workflowProblem(
        body({ conditions: { text: { algorithm: 'none', pattern: '', caseSensitive: false } } }),
      ),
    ).toMatch(/leave it out/);
    expect(workflowProblem({ ...body({}), trigger: 'monthly' })).toMatch(/trigger/);
  });
});
