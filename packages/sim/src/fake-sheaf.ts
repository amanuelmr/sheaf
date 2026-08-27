import type { DocumentPatch, PutOutcome } from '@sheaf/protocol';

/**
 * An in-memory Sheaf ingestion server, modelling the semantics the sync engine
 * actually depends on:
 *
 *  - `PUT /v1/documents/{sha256}` is authoritative and answers immediately.
 *  - Re-sending the same bytes to the same address cannot create a second
 *    document; it reports `already-stored` instead.
 *  - `HEAD` on that address answers "do you hold this?" with a status code.
 *
 * It replaces a fake Paperless-ngx, which modelled a server that consumes
 * asynchronously, reports duplicates through a task, and phrases that report as
 * English prose. All three were real constraints when we were a client of somebody
 * else's design, and none of them survive here -- so a simulator that kept
 * modelling them would have been proving the engine correct against a protocol the
 * app no longer speaks.
 *
 * Notice what got *shorter*. There is no task table and no consumption timeline,
 * because there is nothing to poll. That absence is the protocol's whole argument,
 * and this file is where it shows up as less code rather than as an assertion.
 */

export interface StoredDocument {
  /** Content-addressed: the document's name is the hash of its bytes. */
  readonly sha256: string;
  title: string | null;
  correspondent: string | null;
  documentType: string | null;
  tags: readonly string[];
}

export interface ServerCounters {
  /** Every accepted PUT, including ones whose response the client never saw. */
  puts: number;
  /** PUTs that created a document. Must end equal to the number of distinct hashes. */
  stored: number;
  /** PUTs of bytes already held. The exactly-once path, counted. */
  duplicates: number;
  /** HEAD requests: the client re-establishing ground truth after losing track. */
  headLookups: number;
  patches: number;
}

export class FakeSheaf {
  private readonly documents = new Map<string, StoredDocument>();

  readonly counters: ServerCounters = {
    puts: 0,
    stored: 0,
    duplicates: 0,
    headLookups: 0,
    patches: 0,
  };

  /**
   * Store bytes at the address of their own hash.
   *
   * There is no `now`, because there is nothing that happens later. The document is
   * durable when this returns, which is exactly why the client needs no task id.
   */
  put(sha256: string): PutOutcome {
    this.counters.puts += 1;
    if (this.documents.has(sha256)) {
      this.counters.duplicates += 1;
      return 'already-stored';
    }
    this.documents.set(sha256, {
      sha256,
      title: null,
      correspondent: null,
      documentType: null,
      tags: [],
    });
    this.counters.stored += 1;
    return 'stored';
  }

  /**
   * `HEAD /v1/documents/{sha256}`: how a client recovers after losing track of an
   * upload. It cannot false-positive, because the question is about these exact
   * bytes rather than about a filename that might collide.
   */
  head(sha256: string): boolean {
    this.counters.headLookups += 1;
    return this.documents.has(sha256);
  }

  patch(sha256: string, patch: DocumentPatch): boolean {
    const document = this.documents.get(sha256);
    if (!document) return false;
    this.counters.patches += 1;
    // Names, not ids. Nothing to look up, so nothing can be dropped on the way.
    if (patch.title !== undefined) document.title = patch.title;
    if (patch.correspondent !== undefined) document.correspondent = patch.correspondent;
    if (patch.documentType !== undefined) document.documentType = patch.documentType;
    if (patch.tags !== undefined) document.tags = patch.tags;
    return true;
  }

  get storedCount(): number {
    return this.documents.size;
  }

  has(sha256: string): boolean {
    return this.documents.has(sha256);
  }

  snapshot(): readonly StoredDocument[] {
    return [...this.documents.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
  }
}
