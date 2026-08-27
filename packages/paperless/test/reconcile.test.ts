import { describe as suite, expect, it } from 'vitest';
import { PaperlessClient } from '../src/client';
import { captureFilename, matchesCaptureId, parseCaptureId } from '../src/reconcile';
import type { FetchLike, HttpResponse } from '@sheaf/http';

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const TOKEN = 'secret-token-value';

function client(respond: (url: string) => { status?: number; body: string }) {
  const urls: string[] = [];
  const fetch: FetchLike = (url) => {
    urls.push(url);
    const canned = respond(url);
    const status = canned.status ?? 200;
    const response: HttpResponse = {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      text: () => Promise.resolve(canned.body),
    };
    return Promise.resolve(response);
  };
  return {
    urls,
    client: new PaperlessClient({
      baseUrl: 'https://paperless.example.com',
      token: TOKEN,
      fetch,
    }),
  };
}

suite('capture filenames', () => {
  it('round-trips a hash through the filename', () => {
    expect(captureFilename(HASH)).toBe(`sheaf-${HASH}.pdf`);
    expect(parseCaptureId(captureFilename(HASH))).toBe(HASH);
  });

  it('ignores filenames that are not ours', () => {
    for (const name of [
      'scan.pdf',
      'IMG_0042.jpg',
      `${HASH}.pdf`,
      'sheaf-.pdf',
      'sheaf-nothex.pdf',
      'sheaf-abc.pdf',
      null,
      undefined,
      '',
    ]) {
      expect(parseCaptureId(name), String(name)).toBeNull();
    }
  });

  it('survives the suffix Paperless adds to disambiguate', () => {
    expect(matchesCaptureId(`sheaf-${HASH}_01.pdf`, HASH)).toBe(true);
    expect(matchesCaptureId(`sheaf-${HASH}.pdf`, HASH)).toBe(true);
    expect(matchesCaptureId(`SHEAF-${HASH.toUpperCase()}.pdf`, HASH)).toBe(true);
  });

  it('does not match a different document', () => {
    expect(matchesCaptureId(`sheaf-${OTHER}.pdf`, HASH)).toBe(false);
    expect(matchesCaptureId('scan.pdf', HASH)).toBe(false);
  });
});

suite('findByCaptureId', () => {
  it('finds a document the server already holds', async () => {
    const { client: c, urls } = client(() => ({
      body: JSON.stringify({ results: [{ id: 4821, original_filename: captureFilename(HASH) }] }),
    }));
    expect(await c.findByCaptureId(HASH)).toEqual({ ok: true, value: 4821 });
    expect(urls[0]).toContain('original_filename__istartswith=');
    expect(urls[0]).toContain(HASH);
  });

  it('picks deterministically when the server holds more than one match', async () => {
    const { client: c } = client(() => ({
      body: JSON.stringify({
        results: [
          { id: 91, original_filename: `sheaf-${HASH}_01.pdf` },
          { id: 47, original_filename: captureFilename(HASH) },
        ],
      }),
    }));
    expect(await c.findByCaptureId(HASH)).toEqual({ ok: true, value: 47 });
  });

  it('reports not-found for an empty result', async () => {
    const { client: c } = client(() => ({ body: JSON.stringify({ results: [] }) }));
    expect(await c.findByCaptureId(HASH)).toEqual({ ok: true, value: null });
  });

  it('reports not-found when the server ignored the filter entirely', async () => {
    // This is the case that matters. DRF drops query parameters it does not
    // recognise, so an unsupported filter answers with an unfiltered page. A
    // client that trusted the response would mark an un-uploaded document synced
    // and then let retention delete the only copy of it.
    const { client: c } = client(() => ({
      body: JSON.stringify({
        count: 4_312,
        results: [
          { id: 1, original_filename: 'electricity-bill.pdf' },
          { id: 2, original_filename: 'insurance.pdf' },
          { id: 3, original_filename: `sheaf-${OTHER}.pdf` },
          { id: 4, original_filename: null },
        ],
      }),
    }));
    expect(await c.findByCaptureId(HASH)).toEqual({ ok: true, value: null });
  });

  it('reports not-found rather than guessing when filenames are absent', async () => {
    const { client: c } = client(() => ({
      body: JSON.stringify({ results: [{ id: 7 }, { id: 8, original_filename: null }] }),
    }));
    expect(await c.findByCaptureId(HASH)).toEqual({ ok: true, value: null });
  });

  it('surfaces a transport failure instead of pretending the document is absent', async () => {
    const { client: c } = client(() => ({ status: 503, body: 'down' }));
    const result = await c.findByCaptureId(HASH);
    expect(result).toEqual({ ok: false, reason: { kind: 'server_error', status: 503 } });
  });

  it('never puts the token in the lookup URL', async () => {
    const { client: c, urls } = client(() => ({ body: JSON.stringify({ results: [] }) }));
    await c.findByCaptureId(HASH);
    expect(urls[0]).not.toContain(TOKEN);
  });
});

suite('probeReconciliation', () => {
  it('confirms the filter works when an impossible name matches nothing', async () => {
    const { client: c } = client((url) =>
      url.includes('istartswith')
        ? { body: JSON.stringify({ count: 0, results: [] }) }
        : { body: JSON.stringify({ count: 4_312 }) },
    );
    expect(await c.probeReconciliation()).toEqual({
      ok: true,
      value: {
        filterSupported: true,
        conclusive: true,
        detail: 'filter narrows results as expected',
      },
    });
  });

  it('detects a server that ignores the filter', async () => {
    const { client: c } = client((url) =>
      url.includes('istartswith')
        ? { body: JSON.stringify({ count: 4_312, results: [{ id: 1 }] }) }
        : { body: JSON.stringify({ count: 4_312 }) },
    );
    const result = await c.probeReconciliation();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.filterSupported).toBe(false);
      expect(result.value.conclusive).toBe(true);
    }
  });

  it('admits when an empty server makes the probe meaningless', async () => {
    const { client: c, urls } = client(() => ({ body: JSON.stringify({ count: 0 }) }));
    const result = await c.probeReconciliation();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.conclusive).toBe(false);
      expect(result.value.filterSupported).toBe(false);
    }
    // No point issuing the second request.
    expect(urls).toHaveLength(1);
  });

  it('propagates a failure rather than reporting a capability it did not verify', async () => {
    const { client: c } = client(() => ({ status: 401, body: 'nope' }));
    expect(await c.probeReconciliation()).toEqual({
      ok: false,
      reason: { kind: 'auth', status: 401 },
    });
  });
});

suite('filenames a store may have rewritten', () => {
  /**
   * Defensive rather than observed: filenames are the one thing a document store
   * feels free to rewrite. A long prefix stays unambiguous, and the asymmetry is
   * unchanged — a false negative costs one redundant upload.
   */
  it('recognises a filename that has been shortened', () => {
    expect(matchesCaptureId(`sheaf-${HASH.slice(0, 40)}`, HASH)).toBe(true);
    expect(matchesCaptureId(`sheaf-${HASH.slice(0, 16)}`, HASH)).toBe(true);
  });

  it('will not match on a prefix too short to be meaningful', () => {
    // A false positive is the dangerous direction, so short prefixes are refused
    // rather than treated as probably-fine.
    expect(matchesCaptureId(`sheaf-${HASH.slice(0, 15)}`, HASH)).toBe(false);
    expect(matchesCaptureId('sheaf-ab', HASH)).toBe(false);
  });

  it('still refuses a prefix of a different document', () => {
    expect(matchesCaptureId(`sheaf-${OTHER.slice(0, 40)}`, HASH)).toBe(false);
  });
});

suite('the response field, as a real server names it', () => {
  it('reads original_file_name, which is not what the filter is called', async () => {
    // Paperless filters on `original_filename__istartswith` and returns the value
    // as `original_file_name`. Reading only the query spelling made every
    // reconciliation report "not found" for documents that were plainly there.
    const { client: c } = client(() => ({
      body: JSON.stringify({ results: [{ id: 3, original_file_name: `sheaf-${HASH}.pdf` }] }),
    }));
    expect(await c.findByCaptureId(HASH)).toEqual({ ok: true, value: 3 });
  });

  it('still reads the older spelling', async () => {
    const { client: c } = client(() => ({
      body: JSON.stringify({ results: [{ id: 9, original_filename: `sheaf-${HASH}.pdf` }] }),
    }));
    expect(await c.findByCaptureId(HASH)).toEqual({ ok: true, value: 9 });
  });
});

/**
 * Finding a hand-off that has been accepted but not yet consumed.
 *
 * The asymmetry here runs the opposite way from finding a document. A miss costs a
 * redundant upload, and on a target that does not deduplicate that is a second
 * document -- annoying. A wrong hit means watching a task that belongs to somebody
 * else and reporting its outcome as ours -- which is how a document quietly never
 * gets forwarded while the record says it did.
 */
suite('finding an in-flight hand-off', () => {
  const task = (id: string, filename: string | null) => ({
    task_id: id,
    status: 'pending',
    task_file_name: filename,
  });

  it('finds the task carrying our filename', async () => {
    const h = client(() => ({
      body: JSON.stringify({
        results: [task('t-1', 'someone-elses.pdf'), task('t-2', captureFilename(HASH))],
      }),
    }));
    expect(await h.client.findTaskByCaptureId(HASH)).toEqual({ ok: true, value: 't-2' });
  });

  it('reads an unpaginated list too', async () => {
    const h = client(() => ({ body: JSON.stringify([task('t-9', captureFilename(HASH))]) }));
    expect(await h.client.findTaskByCaptureId(HASH)).toEqual({ ok: true, value: 't-9' });
  });

  it('never claims a task that belongs to another document', async () => {
    const h = client(() => ({
      body: JSON.stringify({
        results: [
          task('t-1', captureFilename(OTHER)),
          task('t-2', 'invoice.pdf'),
          task('t-3', null),
          task('t-4', 'sheaf-.pdf'),
        ],
      }),
    }));
    expect(await h.client.findTaskByCaptureId(HASH)).toEqual({ ok: true, value: null });
  });

  it('takes the newest when an earlier attempt left one behind', async () => {
    const h = client(() => ({
      body: JSON.stringify({
        results: [task('t-old', captureFilename(HASH)), task('t-new', captureFilename(HASH))],
      }),
    }));
    expect(await h.client.findTaskByCaptureId(HASH)).toEqual({ ok: true, value: 't-new' });
  });

  it('reports a failure as a failure rather than as an absence', async () => {
    // The distinction the forwarder depends on: "I could not ask" must not arrive
    // looking like "there is nothing in flight", or it will send again.
    const h = client(() => ({ status: 503, body: 'nope' }));
    const result = await h.client.findTaskByCaptureId(HASH);
    expect(result.ok).toBe(false);
  });
});
