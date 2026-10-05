/**
 * Extraction by Claude, through the Messages API (ADR 0010). Opt-in: choosing it
 * sends document text to Anthropic, which is the operator's decision to make.
 *
 * Plain `fetch` rather than an SDK, so the server keeps no runtime dependencies.
 * Structured output comes from a single tool the model is required to call, whose
 * input schema is `MODEL_OUTPUT_SCHEMA`; the answer is then checked like any other.
 */
import { classifyResponse, classifyThrown, err, ok, type FetchLike } from '@sheaf/http';
import type { Extractor, Usage } from './extractor.ts';
import { MODEL_OUTPUT_SCHEMA, documentMessage, systemPrompt, toFields } from './model-output.ts';

const VERSION = 1;
export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const TOOL = 'record_fields';

/**
 * US dollars per million tokens: input, output, cache read, cache write. Only models
 * whose prices are known here; any other model reports its cost as unknown rather
 * than a wrong number. Checked against Anthropic's published pricing, October 2026.
 */
const PRICES: Readonly<Record<string, readonly [number, number, number, number]>> = {
  'claude-haiku-4-5-20251001': [1, 5, 0.1, 1.25],
};

export interface ClaudeOptions {
  readonly apiKey: string;
  readonly fetch: FetchLike;
  readonly model?: string;
}

interface MessagesResponse {
  content?: { type: string; name?: string; input?: unknown }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export function claudeExtractor(options: ClaudeOptions): Extractor {
  const model = options.model ?? DEFAULT_CLAUDE_MODEL;
  return {
    name: 'claude',
    version: VERSION,
    async extract(input) {
      const body = {
        model,
        max_tokens: 1024,
        temperature: 0,
        system: [
          {
            type: 'text',
            text: systemPrompt(input),
            // The instructions and the vocabulary are the same for every document,
            // so a backlog pays for them once.
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [
          {
            name: TOOL,
            description: "Record the document's details.",
            input_schema: MODEL_OUTPUT_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: TOOL },
        messages: [{ role: 'user', content: documentMessage(input.text) }],
      };

      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await options.fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        return err(classifyThrown(error));
      }
      const text = await response.text().catch(() => '');
      // Never let the key into an error that might be logged.
      if (!response.ok)
        return err(
          classifyResponse(
            response.status,
            text.split(options.apiKey).join('[redacted]'),
            response.headers.get('retry-after') ?? undefined,
          ),
        );

      let parsed: MessagesResponse;
      try {
        parsed = JSON.parse(text) as MessagesResponse;
      } catch {
        return err({ kind: 'rejected', status: 502, message: 'the answer was not JSON' });
      }
      const call = parsed.content?.find(
        (block) => block.type === 'tool_use' && block.name === TOOL,
      );
      const fields = call === undefined ? null : toFields(call.input, input);
      if (fields === null) {
        return err({
          kind: 'rejected',
          status: 502,
          message: 'the model did not return the requested fields',
        });
      }
      return ok({ fields, usage: usageOf(model, parsed.usage), model });
    },
  };
}

function usageOf(model: string, usage: MessagesResponse['usage']): Usage {
  const fresh = usage?.input_tokens ?? 0;
  const read = usage?.cache_read_input_tokens ?? 0;
  const written = usage?.cache_creation_input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const price = PRICES[model];
  const costUsd =
    price === undefined
      ? null
      : (fresh * price[0] + output * price[1] + read * price[2] + written * price[3]) / 1_000_000;
  return { inputTokens: fresh + read + written, outputTokens: output, costUsd };
}
