/**
 * Extraction by a model running on your own machine through Ollama (ADR 0010):
 * nothing leaves the network. The answer is constrained by the same JSON Schema the
 * Claude extractor uses, through Ollama's structured outputs, and checked the same way.
 */
import { classifyResponse, classifyThrown, err, ok, type FetchLike } from '@sheaf/http';
import type { Extractor } from './extractor.ts';
import { MODEL_OUTPUT_SCHEMA, documentMessage, systemPrompt, toFields } from './model-output.ts';

const VERSION = 1;

export interface OllamaOptions {
  /** e.g. `http://ollama:11434`. */
  readonly url: string;
  readonly model: string;
  readonly fetch: FetchLike;
}

interface ChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

export function ollamaExtractor(options: OllamaOptions): Extractor {
  return {
    name: 'ollama',
    version: VERSION,
    async extract(input) {
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await options.fetch(`${options.url.replace(/\/+$/, '')}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: options.model,
            stream: false,
            format: MODEL_OUTPUT_SCHEMA,
            options: { temperature: 0 },
            messages: [
              { role: 'system', content: systemPrompt(input) },
              { role: 'user', content: documentMessage(input.text) },
            ],
          }),
        });
      } catch (error) {
        return err(classifyThrown(error));
      }
      const text = await response.text().catch(() => '');
      if (!response.ok) return err(classifyResponse(response.status, text));

      let fields = null;
      let parsed: ChatResponse = {};
      try {
        parsed = JSON.parse(text) as ChatResponse;
        fields = toFields(JSON.parse(parsed.message?.content ?? 'null'), input);
      } catch {
        fields = null;
      }
      if (fields === null) {
        return err({
          kind: 'rejected',
          status: 502,
          message: 'the model did not return the requested fields',
        });
      }
      return ok({
        fields,
        usage: {
          inputTokens: parsed.prompt_eval_count ?? 0,
          outputTokens: parsed.eval_count ?? 0,
          // Your own hardware: no bill per document.
          costUsd: 0,
        },
        model: options.model,
      });
    },
  };
}
