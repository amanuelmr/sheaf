import type {
  DocumentRecord,
  Workflow,
  WorkflowActions,
  WorkflowBody,
  WorkflowConditions,
  WorkflowTrigger,
} from '@sheaf/protocol';
import type { SqlDriver } from '@sheaf/store';
import type { CustomFields } from './custom-fields.ts';
import { fillTemplate } from './filename.ts';
import { matches } from './matching.ts';
import type { Storage } from './storage.ts';

interface WorkflowRow {
  id: number;
  name: string;
  enabled: number;
  trigger_kind: WorkflowTrigger;
  conditions_json: string;
  actions_json: string;
  position: number;
}

export interface WorkflowPorts {
  /** Only `fetch(url, init)` is used, for webhooks. */
  fetch(url: string, init: RequestInit): Promise<{ ok: boolean; status: number }>;
  /** Something a person running the server should hear about. */
  warn(message: string): void;
}

const MAX_TITLE = 300;
const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Workflows: "when a document is added (or a person edits one), and it is like
 * this, do that".
 *
 * They run in order, each seeing what the ones before it did. What they change is
 * the server's doing, not a person's choice, so it never stops extraction or rules
 * from filling a field in, and never sets off the "updated" trigger itself: a
 * workflow cannot start another in a loop. A webhook that fails is reported and
 * left; a document is never held up waiting on someone else's server.
 */
export class Workflows {
  readonly #driver: SqlDriver;
  readonly #storage: Storage;
  readonly #fields: CustomFields | undefined;
  readonly #ports: WorkflowPorts;

  constructor(
    driver: SqlDriver,
    storage: Storage,
    fields: CustomFields | undefined,
    ports: WorkflowPorts,
  ) {
    this.#driver = driver;
    this.#storage = storage;
    this.#fields = fields;
    this.#ports = ports;
  }

  async list(): Promise<readonly Workflow[]> {
    const rows = await this.#driver.all<WorkflowRow>(
      'SELECT * FROM workflows ORDER BY position, id',
    );
    return rows.map(toWorkflow);
  }

  async get(id: number): Promise<Workflow | null> {
    const rows = await this.#driver.all<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', [id]);
    return rows[0] === undefined ? null : toWorkflow(rows[0]);
  }

  async create(body: WorkflowBody, now: number): Promise<Workflow> {
    const last = await this.#driver.all<{ n: number | null }>(
      'SELECT MAX(position) AS n FROM workflows',
    );
    await this.#driver.run(
      `INSERT INTO workflows (name, enabled, trigger_kind, conditions_json, actions_json, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        body.name,
        body.enabled ? 1 : 0,
        body.trigger,
        JSON.stringify(body.conditions),
        JSON.stringify(body.actions),
        body.position ?? (last[0]?.n ?? 0) + 1,
        now,
      ],
    );
    const rows = await this.#driver.all<WorkflowRow>(
      'SELECT * FROM workflows ORDER BY id DESC LIMIT 1',
    );
    return toWorkflow(rows[0]!);
  }

  async replace(id: number, body: WorkflowBody): Promise<Workflow | null> {
    const current = await this.get(id);
    if (current === null) return null;
    await this.#driver.run(
      `UPDATE workflows SET name = ?, enabled = ?, trigger_kind = ?, conditions_json = ?,
                            actions_json = ?, position = ?
        WHERE id = ?`,
      [
        body.name,
        body.enabled ? 1 : 0,
        body.trigger,
        JSON.stringify(body.conditions),
        JSON.stringify(body.actions),
        body.position ?? current.position,
        id,
      ],
    );
    return this.get(id);
  }

  async remove(id: number): Promise<boolean> {
    if ((await this.get(id)) === null) return false;
    await this.#driver.run('DELETE FROM workflows WHERE id = ?', [id]);
    return true;
  }

  /**
   * Run every enabled workflow for this trigger on one document. Answers the names
   * of those that applied. Never throws: a workflow going wrong is reported and the
   * rest still run.
   */
  async run(trigger: WorkflowTrigger, sha256: string, now: number): Promise<readonly string[]> {
    const ran: string[] = [];
    let workflows: readonly Workflow[];
    try {
      workflows = (await this.list()).filter((w) => w.enabled && w.trigger === trigger);
    } catch (error) {
      this.#ports.warn(`workflows could not be read: ${String(error)}`);
      return ran;
    }
    if (workflows.length === 0) return ran;
    let text: string | null = null;
    for (const workflow of workflows) {
      try {
        const record = await this.#storage.record(sha256);
        if (record === null || record.trashedAt !== undefined) return ran;
        if (workflow.conditions.text !== undefined && text === null) {
          text = (await this.#storage.texts(sha256)).map((t) => t.text).join('\n\n');
        }
        if (!applies(workflow.conditions, record, text ?? '')) continue;
        await this.#act(workflow, record, now);
        ran.push(workflow.name);
      } catch (error) {
        this.#ports.warn(`workflow "${workflow.name}" failed on ${sha256}: ${String(error)}`);
      }
    }
    return ran;
  }

  async #act(workflow: Workflow, record: DocumentRecord, now: number): Promise<void> {
    const actions: WorkflowActions = workflow.actions;
    const tags =
      actions.addTags === undefined && actions.removeTags === undefined
        ? undefined
        : [
            ...new Set([
              ...record.tags.filter((tag) => !(actions.removeTags ?? []).includes(tag)),
              ...(actions.addTags ?? []),
            ]),
          ];
    const title =
      actions.title === undefined
        ? undefined
        : fillTemplate(actions.title, record).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) ||
          null;
    await this.#storage.fileByMachine(record.sha256, {
      ...(title === undefined ? {} : { title }),
      ...(actions.correspondent === undefined ? {} : { correspondent: actions.correspondent }),
      ...(actions.documentType === undefined ? {} : { documentType: actions.documentType }),
      ...(tags === undefined ? {} : { tags }),
    });

    if (actions.customField !== undefined && this.#fields !== undefined) {
      const { field, value } = actions.customField;
      const current = (await this.#fields.valuesOf(record.sha256))
        .filter((v) => v.field !== field)
        .map((v) => ({ field: v.field, value: v.value }));
      const result = await this.#fields.setValues(
        record.sha256,
        [...current, { field, value }],
        now,
      );
      if (!result.ok) {
        this.#ports.warn(
          `workflow "${workflow.name}": custom field not set (${result.kind === 'not_found' ? 'missing' : result.message})`,
        );
      }
    }

    if (actions.webhook !== undefined) {
      const after = await this.#storage.record(record.sha256);
      try {
        const response = await this.#ports.fetch(actions.webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workflow: workflow.name, document: after }),
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });
        if (!response.ok) {
          this.#ports.warn(
            `workflow "${workflow.name}": webhook answered ${String(response.status)}`,
          );
        }
      } catch (error) {
        this.#ports.warn(`workflow "${workflow.name}": webhook failed: ${String(error)}`);
      }
    }
  }
}

/** Whether every condition given holds for this document. */
export function applies(
  conditions: WorkflowConditions,
  record: DocumentRecord,
  text: string,
): boolean {
  if (conditions.tags !== undefined && !conditions.tags.every((tag) => record.tags.includes(tag))) {
    return false;
  }
  if (
    conditions.anyTags !== undefined &&
    conditions.anyTags.length > 0 &&
    !conditions.anyTags.some((tag) => record.tags.includes(tag))
  ) {
    return false;
  }
  if (conditions.notTags?.some((tag) => record.tags.includes(tag)) === true) return false;
  if (conditions.correspondent !== undefined && record.correspondent !== conditions.correspondent) {
    return false;
  }
  if (conditions.documentType !== undefined && record.documentType !== conditions.documentType) {
    return false;
  }
  return conditions.text === undefined || matches(conditions.text, text);
}

function toWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    trigger: row.trigger_kind,
    conditions: JSON.parse(row.conditions_json) as WorkflowConditions,
    actions: JSON.parse(row.actions_json) as WorkflowActions,
    position: row.position,
  };
}
