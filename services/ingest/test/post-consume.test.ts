/** The operator's script, run once a new document is filed. */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, beforeEach, expect, it } from 'vitest';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { Rules } from '../src/rules';
import { matchStep } from '../src/steps/match';
import { Storage, sha256Hex } from '../src/storage';

const PDF = new Uint8Array(Buffer.from('%PDF-1.4\nscript\n%%EOF\n'));
const SHA = sha256Hex(PDF);
const NOW = 1_700_000_000_000;

let storage: Storage;
let driver: ReturnType<typeof nodeSqliteDriver>;
let dir: string;
let warnings: string[];

function script(body: string): string {
  const path = join(dir, 'script.sh');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sheaf-pc-'));
  driver = nodeSqliteDriver();
  storage = await Storage.open({ driver, objectsDir: join(dir, 'objects') });
  await storage.put(SHA, PDF, NOW, 1);
  await storage.patch(SHA, { title: 'Lease; rm -rf /', tags: ['home', 'legal'] }, NOW);
  warnings = [];
});

const run = async (path: string) => {
  const step = matchStep(storage, new Rules(driver, storage), {
    graceMs: 0,
    postConsume: { script: path, warn: (message) => warnings.push(message) },
  });
  return step.run((await storage.record(SHA))!, { now: NOW });
};

suite('the post-consume script', () => {
  it('gets the document in its environment, and a title is never run as a command', async () => {
    const out = join(dir, 'out.txt');
    const path = script(
      `printf '%s|%s|%s|%s|%s' "$1" "$DOCUMENT_TITLE" "$DOCUMENT_TAGS" "$DOCUMENT_ID" "$(head -c 8 "$DOCUMENT_FILE")" > ${out}`,
    );
    expect(await run(path)).toEqual({ ok: true, value: null });
    expect(readFileSync(out, 'utf8')).toBe(`${SHA}|Lease; rm -rf /|home,legal|${SHA}|%PDF-1.4`);
    expect(warnings).toEqual([]);
  });

  it('reports a script that fails, and the step still succeeds', async () => {
    const path = script('echo "no space left" >&2; exit 3');
    expect(await run(path)).toEqual({ ok: true, value: null });
    expect(warnings).toEqual([`post-consume script on ${SHA}: exited with 3: no space left`]);
  });
});
