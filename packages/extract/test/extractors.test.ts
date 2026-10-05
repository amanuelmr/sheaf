/**
 * Every extractor is held to the same suite (ADR 0010): same input, normalised
 * output, refusal of malformed answers, and failures classified so the job runner
 * retries what is worth retrying.
 *
 * Claude and Ollama answer through fakes that return their real response formats.
 * Live answers are compared in the eval, which records them.
 */
import { describe as suite, expect, it } from 'vitest';
import { ok, type FetchLike, type HttpResponse } from '@sheaf/http';
import {
  claudeExtractor,
  heuristicExtractor,
  ollamaExtractor,
  type ExtractionInput,
} from '../src/index';

const RECEIPT = `CINEMA CITY SDN BHD
Lot 3, Jalan Ampang
Tax Invoice
Date: 05/10/2026 19:42
2 x Adult            25.00
Popcorn               9.50
Subtotal             34.50
SST 6%                2.07
TOTAL               36.57
Cash                 50.00
Change               13.43
Thank you`;

const input = (text = RECEIPT, overrides: Partial<ExtractionInput> = {}): ExtractionInput => ({
  text,
  vocabulary: { correspondents: ['Cinema City'], documentTypes: ['Invoice'], tags: ['leisure'] },
  today: '2026-10-05',
  dateOrder: 'DMY',
  defaultCurrency: 'MYR',
  ...overrides,
});

/** What a model is expected to say about RECEIPT, in the answer schema. */
const MODEL_ANSWER = {
  title: { value: 'Cinema City tickets', confidence: 0.8 },
  date: { value: '2026-10-05', confidence: 0.95 },
  correspondent: { value: 'CINEMA CITY SDN BHD', confidence: 0.9 },
  document_type: { value: 'invoice', confidence: 0.7 },
  total: { value: { amount: '36.57', currency: 'MYR' }, confidence: 0.9 },
  tags: { value: ['Leisure', 'cinema'], confidence: 0.6 },
};

function respond(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const claudeWire = (answer: unknown) => ({
  content: [{ type: 'tool_use', name: 'record_fields', input: answer }],
  usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 1000 },
});
const ollamaWire = (answer: unknown) => ({
  message: { content: JSON.stringify(answer) },
  prompt_eval_count: 1900,
  eval_count: 140,
});

interface Provider {
  readonly name: string;
  readonly make: (fetch: FetchLike) => ReturnType<typeof heuristicExtractor>;
  readonly wire: (answer: unknown) => unknown;
}

const MODELS: readonly Provider[] = [
  {
    name: 'claude',
    make: (fetch) => claudeExtractor({ apiKey: 'sk-test-key-1234', fetch }),
    wire: claudeWire,
  },
  {
    name: 'ollama',
    make: (fetch) => ollamaExtractor({ url: 'http://ollama:11434', model: 'llama3.2:3b', fetch }),
    wire: ollamaWire,
  },
];

const answering =
  (status: number, body: unknown): FetchLike =>
  () =>
    Promise.resolve(respond(status, body));

suite.each(MODELS)('the $name extractor', ({ make, wire }) => {
  it('returns the fields normalised, in the archive’s own names', async () => {
    const result = await make(answering(200, wire(MODEL_ANSWER))).extract(input());
    expect(result.ok).toBe(true);
    const fields = result.ok ? result.value.fields : null;
    expect(fields).toEqual({
      title: { value: 'Cinema City tickets', confidence: 0.8 },
      date: { value: '2026-10-05', confidence: 0.95 },
      correspondent: { value: 'Cinema City', confidence: 0.9 },
      documentType: { value: 'Invoice', confidence: 0.7 },
      total: { value: { minor: 3657, currency: 'MYR' }, confidence: 0.9 },
      tags: { value: ['leisure', 'cinema'], confidence: 0.6 },
    });
  });

  it('leaves out what the model did not know, and dates it could not read', async () => {
    const answer = {
      ...MODEL_ANSWER,
      date: { value: 'sometime in autumn', confidence: 0.2 },
      tags: null,
    };
    const result = await make(answering(200, wire(answer))).extract(input());
    const fields = result.ok ? result.value.fields : null;
    expect(fields?.date).toBeUndefined();
    expect(fields?.tags).toBeUndefined();
    expect(fields?.total?.value).toEqual({ minor: 3657, currency: 'MYR' });
  });

  it.each([
    ['a confidence above one', { ...MODEL_ANSWER, title: { value: 'x', confidence: 3 } }],
    [
      'a number where text belongs',
      { ...MODEL_ANSWER, correspondent: { value: 42, confidence: 1 } },
    ],
    ['an array answer', [1, 2]],
    ['nothing', null],
  ])('refuses %s as a malformed answer', async (_, answer) => {
    const result = await make(answering(200, wire(answer))).extract(input());
    expect(result.ok ? null : result.reason.kind).toBe('rejected');
  });

  it.each([
    [429, 'rate_limited'],
    [503, 'server_error'],
    [401, 'auth'],
    [400, 'rejected'],
  ])('classifies an HTTP %i as %s', async (status, kind) => {
    const result = await make(answering(status, '{"error":"x"}')).extract(input());
    expect(result.ok ? null : result.reason.kind).toBe(kind);
  });

  it('reads a network failure as unreachable, so it is retried', async () => {
    const result = await make(() => Promise.reject(new Error('ECONNRESET'))).extract(input());
    expect(result).toEqual({ ok: false, reason: { kind: 'unreachable' } });
  });
});

suite('the claude extractor, specifically', () => {
  it('asks for one forced tool call, with the vocabulary in a cached system prompt', async () => {
    let sent: {
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    } | null = null;
    const fetch: FetchLike = (url, init) => {
      sent = {
        url,
        headers: init!.headers!,
        body: JSON.parse(init!.body as string) as Record<string, unknown>,
      };
      return Promise.resolve(respond(200, claudeWire(MODEL_ANSWER)));
    };
    await claudeExtractor({ apiKey: 'sk-test-key-1234', fetch }).extract(input());

    expect(sent!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent!.headers['anthropic-version']).toBe('2023-06-01');
    expect(sent!.body['tool_choice']).toEqual({ type: 'tool', name: 'record_fields' });
    expect(sent!.body['temperature']).toBe(0);
    const system = sent!.body['system'] as { text: string; cache_control: unknown }[];
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[0]!.text).toContain('Cinema City');
  });

  it('prices a known model, and admits not knowing the price of another', async () => {
    const known = await claudeExtractor({
      apiKey: 'k',
      fetch: answering(200, claudeWire(MODEL_ANSWER)),
    }).extract(input());
    // 900 fresh × $1 + 1000 cached × $0.10 + 120 out × $5, per million tokens.
    expect(known.ok && known.value.usage.costUsd).toBeCloseTo(0.0016, 6);
    const other = await claudeExtractor({
      apiKey: 'k',
      model: 'claude-some-future-model',
      fetch: answering(200, claudeWire(MODEL_ANSWER)),
    }).extract(input());
    expect(other.ok && other.value.usage.costUsd).toBeNull();
  });

  it('never lets the API key into an error', async () => {
    const result = await claudeExtractor({
      apiKey: 'sk-secret-abcdef',
      fetch: answering(400, 'invalid key sk-secret-abcdef'),
    }).extract(input());
    expect(JSON.stringify(result)).not.toContain('sk-secret-abcdef');
  });
});

suite('the heuristic extractor', () => {
  const extract = async (text: string, overrides: Partial<ExtractionInput> = {}) => {
    const result = await heuristicExtractor().extract(input(text, overrides));
    if (!result.ok) throw new Error('the heuristic extractor never fails');
    return result.value.fields;
  };

  it('reads the date, total, sender and type of a receipt', async () => {
    const fields = await extract(RECEIPT);
    expect(fields.date).toEqual({ value: '2026-10-05', confidence: 0.9 });
    expect(fields.total).toEqual({ value: { minor: 3657, currency: 'MYR' }, confidence: 0.85 });
    expect(fields.correspondent?.value).toBe('Cinema City');
    expect(fields.documentType?.value).toBe('Invoice');
    expect(fields.title?.value).toBe('Cinema City Invoice 2026-10-05');
  });

  it('takes the last total, and never a subtotal, tax or change line', async () => {
    const fields = await extract('Shop\nTotal 20.00\nDiscount -2.00\nTotal 18.00\nChange 2.00');
    expect(fields.total?.value.minor).toBe(1800);
    const noLabel = await extract('Shop\nSubtotal 30.00\nVAT 5.00');
    expect(noLabel.total).toEqual({ value: { minor: 3000, currency: 'MYR' }, confidence: 0.4 });
  });

  it('skips lines that say "total" but are not the total', async () => {
    const fields = await extract(
      'Shop\nSub Total 34.50\nGrand Total 36.57\nTotal Tax 2.07\nTotal Saving 3.00\nTotal Discount 1.00',
    );
    expect(fields.total?.value.minor).toBe(3657);
  });

  it('finds a total printed on the line under its label', async () => {
    const fields = await extract('Shop\nAmount due\nEUR 1.234,56', { defaultCurrency: 'EUR' });
    expect(fields.total?.value).toEqual({ minor: 123456, currency: 'EUR' });
  });

  it('ignores dates after today, which are due dates or misreadings', async () => {
    const fields = await extract('ACME\nPayable by 01/12/2026\nIssued 01/09/2026');
    expect(fields.date?.value).toBe('2026-09-01');
  });

  it('reads a German invoice', async () => {
    const fields = await extract(
      'Stadtwerke Musterstadt GmbH\nRechnung\nDatum: 30.09.2026\nGesamtbetrag\nSumme 84,20 EUR',
      {
        defaultCurrency: 'EUR',
      },
    );
    expect(fields.documentType?.value).toBe('Invoice');
    expect(fields.date?.value).toBe('2026-09-30');
    expect(fields.total?.value).toEqual({ minor: 8420, currency: 'EUR' });
  });

  it('returns nothing rather than inventing, for text with nothing in it', async () => {
    expect(await extract('')).toEqual({});
    expect(await extract('12 34')).toEqual({});
  });

  it('costs nothing and names its rule set', async () => {
    const result = await heuristicExtractor().extract(input());
    expect(result).toEqual(
      ok(
        expect.objectContaining({
          model: 'heuristic-1',
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        }),
      ),
    );
  });
});
