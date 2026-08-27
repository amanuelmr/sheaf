import type { PaperlessTask } from '@sheaf/paperless';

/**
 * An in-memory Paperless-ngx, modelling what a real one was *observed* to do
 * rather than what its documentation suggests:
 *
 *  - POST returns a task id immediately; consumption finishes later.
 *  - Re-sending the same bytes produces a SECOND document. It does not refuse
 *    them.
 *  - A task's status is lowercase (`success`, not `SUCCESS`).
 *
 * The second point is the one that matters, and it is a correction. This fake used
 * to refuse content it already held and report that refusal through the task -- and
 * a real Paperless-ngx, sent the same PDF twice, cheerfully made two documents.
 * The fake was more forgiving than reality, which is the worst way for a simulator
 * to be wrong: it makes the double-send path pass by assumption.
 *
 * So the forwarder cannot lean on the target for deduplication, and does not: it
 * asks by content hash before sending. This fake exists to keep it honest.
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
  /** Documents actually persisted. More than one per hash means a document leaked. */
  stored: number;
  /** Documents stored whose content was already present. Should be zero. */
  duplicateDocuments: number;
  hashLookups: number;
  taskLookups: number;
  patches: number;
}

function taskOrder(taskId: string): number {
  return Number(taskId.replace('task-', ''));
}

export class FakePaperless {
  /** Keyed by document id: a hash can, regrettably, map to several. */
  private readonly documents = new Map<number, StoredDocument>();
  private readonly tasks = new Map<string, PendingTask>();
  private nextDocumentId = 1;
  private nextTaskId = 1;

  readonly counters: ServerCounters = {
    posts: 0,
    stored: 0,
    duplicateDocuments: 0,
    hashLookups: 0,
    taskLookups: 0,
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
   * look. That matters: a document whose POST response was lost still gets consumed,
   * so a client that re-sends is racing a document that is already on its way in.
   * Resolving lazily on read would quietly make that path unreachable.
   */
  advanceTo(now: number): void {
    const due = [...this.tasks.values()]
      .filter((t) => t.outcome === null && t.completeAt <= now)
      .sort((a, b) => a.completeAt - b.completeAt || taskOrder(a.taskId) - taskOrder(b.taskId));

    for (const pending of due) {
      if (this.findByHash(pending.hash) !== null) this.counters.duplicateDocuments += 1;
      const document: StoredDocument = {
        id: this.nextDocumentId++,
        hash: pending.hash,
        title: null,
        correspondentId: null,
        documentTypeId: null,
        tagIds: [],
      };
      this.documents.set(document.id, document);
      this.counters.stored += 1;
      pending.outcome = {
        task_id: pending.taskId,
        // Lowercase, as the real server sends it. An earlier version of this fake
        // shouted, so every success read as a refusal on the device and nowhere else.
        status: 'success',
        result: 'Success. New document id created',
        related_document: document.id,
      };
    }
  }

  /** Read a task. Consumption state is whatever `advanceTo` has established. */
  task(taskId: string): PaperlessTask | null {
    const pending = this.tasks.get(taskId);
    if (!pending) return null;
    return pending.outcome ?? { task_id: taskId, status: 'pending' };
  }

  /** How a client asks "do you already hold this?", by the name we uploaded under. */
  findByHash(hash: string): StoredDocument | null {
    this.counters.hashLookups += 1;
    for (const document of this.documents.values()) {
      if (document.hash === hash) return document;
    }
    return null;
  }

  /**
   * Find an accepted-but-unfinished hand-off by the content it carried.
   *
   * The task row exists from the moment the POST is accepted, which is earlier than
   * the document exists -- so this answers during the window when `findByHash`
   * still says no and sending again would make a second document.
   */
  findTaskByHash(hash: string): string | null {
    this.counters.taskLookups += 1;
    const candidates = [...this.tasks.values()]
      .filter((t) => t.hash === hash)
      .sort((a, b) => taskOrder(b.taskId) - taskOrder(a.taskId));
    return candidates[0]?.taskId ?? null;
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
    const document = this.documents.get(id);
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

  /** How many distinct documents hold this content. One is right; two is a leak. */
  copiesOf(hash: string): number {
    let n = 0;
    for (const document of this.documents.values()) if (document.hash === hash) n += 1;
    return n;
  }

  has(hash: string): boolean {
    for (const document of this.documents.values()) if (document.hash === hash) return true;
    return false;
  }

  snapshot(): readonly StoredDocument[] {
    return [...this.documents.values()].sort((a, b) => a.id - b.id);
  }
}
