import type { PaperlessTask } from '@sheaf/paperless';

/**
 * An in-memory Paperless-ngx that models the semantics the sync engine depends on:
 *
 *  - POST returns a task id immediately; consumption finishes later.
 *  - The server hashes content itself and refuses documents it already holds.
 *  - A duplicate is reported through the task, not the POST.
 *
 * That third point is the one that matters. A real client cannot distinguish
 * "the server never got it" from "the server got it and the response was lost",
 * so the recovery path has to work against a server that behaves like this one.
 */

export interface StoredDocument {
  readonly id: number;
  readonly hash: string;
  title: string | null;
  correspondentId: number | null;
  documentTypeId: number | null;
  tagIds: readonly number[];
}

interface PendingTask {
  readonly taskId: string;
  readonly hash: string;
  readonly completeAt: number;
  outcome: PaperlessTask | null;
}

export interface ServerCounters {
  /** Every accepted POST, including ones whose response the client never saw. */
  posts: number;
  /** Documents actually persisted. */
  stored: number;
  /** Consumptions refused because the content was already present. */
  duplicatesReported: number;
  hashLookups: number;
  patches: number;
}

function taskOrder(taskId: string): number {
  return Number(taskId.replace('task-', ''));
}

export class FakePaperless {
  private readonly documents = new Map<string, StoredDocument>();
  private readonly tasks = new Map<string, PendingTask>();
  private nextDocumentId = 1;
  private nextTaskId = 1;

  readonly counters: ServerCounters = {
    posts: 0,
    stored: 0,
    duplicatesReported: 0,
    hashLookups: 0,
    patches: 0,
  };

  constructor(private readonly consumeDelayMs = 500) {}

  /** Accept bytes for consumption. Returns the task id, as Paperless does. */
  post(hash: string, now: number): string {
    this.counters.posts += 1;
    const taskId = `task-${this.nextTaskId++}`;
    this.tasks.set(taskId, {
      taskId,
      hash,
      completeAt: now + this.consumeDelayMs,
      outcome: null,
    });
    return taskId;
  }

  /**
   * Advance server-side consumption to `now`.
   *
   * Consumption happens on the server's own timeline, not when a client bothers to
   * look. This matters: a document whose POST response was lost still gets
   * consumed, so the client's later retry is the one that gets told "duplicate".
   * Resolving lazily on read would quietly make that path unreachable.
   */
  advanceTo(now: number): void {
    const due = [...this.tasks.values()]
      .filter((t) => t.outcome === null && t.completeAt <= now)
      .sort((a, b) => a.completeAt - b.completeAt || taskOrder(a.taskId) - taskOrder(b.taskId));

    for (const pending of due) {
      const existing = this.documents.get(pending.hash);
      if (existing) {
        this.counters.duplicatesReported += 1;
        pending.outcome = {
          task_id: pending.taskId,
          status: 'FAILURE',
          result: `It is a duplicate of an existing document (#${existing.id})`,
        };
        continue;
      }
      const document: StoredDocument = {
        id: this.nextDocumentId++,
        hash: pending.hash,
        title: null,
        correspondentId: null,
        documentTypeId: null,
        tagIds: [],
      };
      this.documents.set(pending.hash, document);
      this.counters.stored += 1;
      pending.outcome = {
        task_id: pending.taskId,
        status: 'SUCCESS',
        result: 'Success. New document id created',
        related_document: document.id,
      };
    }
  }

  /** Read a task. Consumption state is whatever `advanceTo` has established. */
  task(taskId: string): PaperlessTask {
    const pending = this.tasks.get(taskId);
    if (!pending) return { task_id: taskId, status: 'FAILURE', result: 'unknown task' };
    return pending.outcome ?? { task_id: taskId, status: 'PENDING' };
  }

  /** How a client re-establishes ground truth after losing track of an upload. */
  findByHash(hash: string): StoredDocument | null {
    this.counters.hashLookups += 1;
    return this.documents.get(hash) ?? null;
  }

  patch(
    id: number,
    patch: {
      title?: string | undefined;
      correspondentId?: number | undefined;
      documentTypeId?: number | undefined;
      tagIds?: readonly number[] | undefined;
    },
  ): boolean {
    const document = [...this.documents.values()].find((d) => d.id === id);
    if (!document) return false;
    this.counters.patches += 1;
    if (patch.title !== undefined) document.title = patch.title;
    if (patch.correspondentId !== undefined) document.correspondentId = patch.correspondentId;
    if (patch.documentTypeId !== undefined) document.documentTypeId = patch.documentTypeId;
    if (patch.tagIds !== undefined) document.tagIds = patch.tagIds;
    return true;
  }

  get storedCount(): number {
    return this.documents.size;
  }

  has(hash: string): boolean {
    return this.documents.has(hash);
  }

  snapshot(): readonly StoredDocument[] {
    return [...this.documents.values()];
  }
}
