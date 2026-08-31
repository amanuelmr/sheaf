import { backoffMs, isRetryable } from '@sheaf/core';
import type { ApiResult } from '@sheaf/http';
import type { Suggestions } from '@sheaf/protocol';
import type { SuggestionCandidate, Storage } from './storage.ts';

/**
 * Where a document's suggestions come from, once the downstream system has had a
 * chance to classify it. Narrow on the same principle as `ForwardTarget`: this
 * knows about "what does the classifier say about this id", and nothing about
 * whoever is answering.
 */
export interface SuggestionSource {
  get(remoteId: string): Promise<ApiResult<Suggestions>>;
}

export interface SuggestionFetcherPorts {
  now(): number;
  /** In [0, 1). Keeps a backlog from retrying in lockstep. */
  jitter(): number;
}

export interface SuggestionFetcherResult {
  readonly examined: number;
  readonly fetched: number;
  readonly abandoned: number;
}

/**
 * Asks the downstream system what its classifier makes of each document it has,
 * once, and remembers the answer -- so the phone that captured it can show a
 * suggestion without ever talking to that system itself.
 *
 * The same "nobody is watching, the document is already safe" argument the
 * forwarder makes applies here too: a transient failure retries at the capped
 * backoff for as long as it takes, forever, because there is no user waiting on it
 * and no cost to being slow. Only a refusal that retrying cannot change --
 * classification not being available at all, say -- stops the loop for a document.
 *
 * What does *not* retry forever is a successful, empty answer. `get` returning
 * `ok({})` is treated exactly like `ok({correspondent: 'Amazon'})`: an answer,
 * final either way. There is no way to distinguish "nothing to suggest yet" from
 * "nothing to suggest, ever" in what the classifier returns, so this does not
 * pretend to -- the same choice the direct-to-Paperless adapter made before this
 * server existed to make it for.
 */
export class SuggestionFetcher {
  readonly #storage: Storage;
  readonly #source: SuggestionSource;
  readonly #ports: SuggestionFetcherPorts;

  constructor(storage: Storage, source: SuggestionSource, ports: SuggestionFetcherPorts) {
    this.#storage = storage;
    this.#source = source;
    this.#ports = ports;
  }

  /** One pass over everything currently due. */
  async tick(): Promise<SuggestionFetcherResult> {
    const due = await this.#storage.dueForSuggestions(this.#ports.now());
    const result = { examined: due.length, fetched: 0, abandoned: 0 };

    for (const candidate of due) {
      const outcome = await this.#fetch(candidate);
      if (outcome === 'fetched') result.fetched += 1;
      if (outcome === 'abandoned') result.abandoned += 1;
    }
    return result;
  }

  async #fetch(candidate: SuggestionCandidate): Promise<'fetched' | 'abandoned' | 'waiting'> {
    const result = await this.#source.get(candidate.remoteId);
    const attempts = candidate.attempts + 1;

    if (result.ok) {
      await this.#storage.recordSuggestionAttempt(candidate.sha256, {
        state: 'done',
        attempts,
        nextAt: null,
        suggestions: result.value,
      });
      return 'fetched';
    }

    if (!isRetryable(result.reason)) {
      await this.#storage.recordSuggestionAttempt(candidate.sha256, {
        state: 'abandoned',
        attempts,
        nextAt: null,
      });
      return 'abandoned';
    }

    await this.#storage.recordSuggestionAttempt(candidate.sha256, {
      state: 'pending',
      attempts,
      nextAt: this.#ports.now() + backoffMs(attempts, this.#ports.jitter()),
    });
    return 'waiting';
  }
}
