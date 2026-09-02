/**
 * Everything below talks to a real Paperless-ngx, brought up by `run.sh` and
 * torn down again when this file finishes. It exists because two assumptions
 * in ADR 0002 and ADR 0004 were checked once, by hand, and both turned out to
 * be wrong in ways no fixture-based unit test could have caught -- the
 * fixtures were written from the same wrong belief as the code they tested.
 * This file is what "catch the next one without a person watching" actually
 * means: it pins the specific, sometimes-surprising behaviour those ADRs
 * document, so a future Paperless-ngx release that changes any of it fails a
 * test instead of silently drifting out from under the assumption.
 *
 * Skipped entirely, rather than failing, when PAPERLESS_CONTRACT_URL is unset
 * -- which is every environment except `run.sh`'s own, including a plain
 * `pnpm test`.
 */
import { createHash } from 'node:crypto';
import { describe as suite, beforeAll, expect, it } from 'vitest';
import {
  PaperlessClient,
  captureFilename,
  interpretTask,
  resolveSuggestions,
} from '../../src/index';

const BASE_URL = process.env['PAPERLESS_CONTRACT_URL'];
const TOKEN = process.env['PAPERLESS_CONTRACT_TOKEN'];

const describeOrSkip = BASE_URL !== undefined && TOKEN !== undefined ? suite : suite.skip;

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A minimal, valid, single-page PDF with a real text layer -- no OCR needed. */
function buildTextPdf(text: string): Uint8Array {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = `BT /F1 18 Tf 20 150 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 200] /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

/**
 * No colon in this text, deliberately. Confirmed live: `text=` search works
 * with a colon in the query when nothing matches, but a colon in a query that
 * *does* match a document 400s with "Field does not exist: 'x'" -- the
 * highlighter runs a matched query through its field:value parser regardless
 * of which search param was used to get there. That is a real Paperless-ngx
 * server bug, not a client one (see `PaperlessClient#listDocuments`), so it
 * has nothing to do with what this suite is checking -- it would just make an
 * otherwise-passing run fail on a known, already-documented limitation.
 */
function uniqueText(label: string): string {
  return `Sheaf contract test ${label} ${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function pollTask(
  client: PaperlessClient,
  taskId: string,
  timeoutMs = 90_000,
): Promise<ReturnType<typeof interpretTask>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await client.getTask(taskId);
    if (!result.ok) throw new Error(`getTask failed: ${JSON.stringify(result.reason)}`);
    if (result.value !== null) {
      const outcome = interpretTask(result.value);
      if (outcome !== 'pending') return outcome;
    }
    if (Date.now() > deadline) throw new Error(`task ${taskId} still pending after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

/** Upload, wait for consumption, and resolve to the id Paperless gave it -- by
 * name if the task named it, by a lookup if it did not (ADR 0002: "some
 * versions name the document it became; some do not"). */
async function uploadAndResolve(
  client: PaperlessClient,
  text: string,
): Promise<{ id: number; sha256: string }> {
  const bytes = buildTextPdf(text);
  const sha256 = sha256Hex(bytes);
  const filename = captureFilename(sha256);
  const posted = await client.postDocument(
    { part: new Blob([bytes], { type: 'application/pdf' }), filename },
    { title: text },
  );
  if (!posted.ok) throw new Error(`postDocument failed: ${JSON.stringify(posted)}`);

  const outcome = await pollTask(client, posted.value);
  if (typeof outcome !== 'object' || outcome.kind !== 'stored') {
    throw new Error(`expected the upload to be stored, got ${JSON.stringify(outcome)}`);
  }
  if (outcome.remoteId !== null) return { id: Number(outcome.remoteId), sha256 };

  const found = await client.findByCaptureId(sha256);
  if (!found.ok || found.value === null) {
    throw new Error(`stored but could not resolve an id: ${JSON.stringify(found)}`);
  }
  return { id: found.value, sha256 };
}

describeOrSkip('a real Paperless-ngx', () => {
  const client = new PaperlessClient({
    baseUrl: BASE_URL ?? '',
    token: TOKEN ?? '',
    fetch: (url, init) => fetch(url, init as RequestInit),
    formData: () => new FormData(),
  });

  it('accepts the token this suite was given', async () => {
    const result = await client.testConnection();
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  suite('upload, consumption, and reconciliation', () => {
    let first: { id: number; sha256: string };

    it('reports a lowercase-status task as stored, with an id reconciliation can use', async () => {
      first = await uploadAndResolve(client, uniqueText('upload'));
      expect(first.id).toBeGreaterThan(0);
    });

    it('finds the document by the content-hash filename it was given', async () => {
      const found = await client.findByCaptureId(first.sha256);
      expect(found.ok, JSON.stringify(found)).toBe(true);
      if (found.ok) expect(found.value).toBe(first.id);
    });

    it('confirms the reconciliation filter actually narrows results', async () => {
      const probe = await client.probeReconciliation();
      expect(probe.ok, JSON.stringify(probe)).toBe(true);
      if (probe.ok) expect(probe.value.filterSupported).toBe(true);
    });

    // ADR 0002's documented, current behaviour: Paperless does not deduplicate
    // a re-sent document on its own. This is *why* the forwarder asks
    // `findByCaptureId` before ever sending rather than trusting a rejection --
    // if this test ever fails, that assumption needs revisiting, not this test.
    it('creates a second document for a re-sent identical upload, rather than rejecting it', async () => {
      // Sent twice below, deliberately identical both times -- the point is
      // what happens when the *same* bytes arrive again, not two documents
      // that merely look alike.
      const text = uniqueText('will be resent');
      const bytes = buildTextPdf(text);
      const filename = captureFilename(sha256Hex(bytes));
      const send = () =>
        client.postDocument(
          { part: new Blob([bytes], { type: 'application/pdf' }), filename },
          { title: text },
        );

      const firstSend = await send();
      expect(firstSend.ok, JSON.stringify(firstSend)).toBe(true);
      const secondSend = await send();
      expect(secondSend.ok, JSON.stringify(secondSend)).toBe(true);
      if (!firstSend.ok || !secondSend.ok) return;

      const [outcomeA, outcomeB] = await Promise.all([
        pollTask(client, firstSend.value),
        pollTask(client, secondSend.value),
      ]);
      expect(outcomeA).toMatchObject({ kind: 'stored' });
      expect(outcomeB).toMatchObject({ kind: 'stored' });

      // Neither task reliably names the document it became (ADR 0002: "some
      // versions name the document it became; some do not"), so count what
      // actually has this unique title rather than compare two possibly-null
      // ids.
      const found = await client.listDocuments({ text });
      expect(found.ok, JSON.stringify(found)).toBe(true);
      if (found.ok) expect(found.value.count).toBe(2);
    });
  });

  suite('vocabulary', () => {
    it('paginates correspondents, document types and tags without erroring', async () => {
      const [correspondents, documentTypes, tags] = await Promise.all([
        client.getCorrespondents(),
        client.getDocumentTypes(),
        client.getTags(),
      ]);
      expect(correspondents.ok, JSON.stringify(correspondents)).toBe(true);
      expect(documentTypes.ok, JSON.stringify(documentTypes)).toBe(true);
      expect(tags.ok, JSON.stringify(tags)).toBe(true);
    });
  });

  suite('suggestions', () => {
    let documentId: number;

    beforeAll(async () => {
      ({ id: documentId } = await uploadAndResolve(client, uniqueText('suggestions probe')));
    });

    it('answers in the shape resolveSuggestions expects, whether or not it has an opinion', async () => {
      const raw = await client.getSuggestions(documentId);
      expect(raw.ok, JSON.stringify(raw)).toBe(true);
      if (!raw.ok) return;
      // Never trained on anything, so an empty answer is the correct one here --
      // the point is that resolving it does not throw on the real shape.
      expect(() =>
        resolveSuggestions(raw.value, { correspondents: [], documentTypes: [], tags: [] }),
      ).not.toThrow();
    });
  });

  suite('browsing the archive', () => {
    let documentId: number;
    let text: string;

    beforeAll(async () => {
      text = uniqueText('browse probe');
      ({ id: documentId } = await uploadAndResolve(client, text));
    });

    it('finds the document with a full-text search on its own unique title', async () => {
      const result = await client.listDocuments({ text });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (result.ok) expect(result.value.results.some((row) => row.id === documentId)).toBe(true);
    });

    it('fetches the same document directly by id', async () => {
      const result = await client.getDocument(documentId);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (result.ok) expect(result.value.title).toBe(text);
    });

    it('fetches a thumbnail, with a real content type', async () => {
      const result = await client.getDocumentThumbnail(documentId);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (result.ok) {
        expect(result.value.bytes.length).toBeGreaterThan(0);
        expect(result.value.contentType).toMatch(/^image\//);
      }
    });

    it('patches the title, and the change actually sticks', async () => {
      const patched = await client.patchDocument(documentId, { title: `${text} (edited)` });
      expect(patched.ok, JSON.stringify(patched)).toBe(true);

      const refetched = await client.getDocument(documentId);
      expect(refetched.ok).toBe(true);
      if (refetched.ok) expect(refetched.value.title).toBe(`${text} (edited)`);
    });
  });
});
