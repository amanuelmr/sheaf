import { useCallback, useEffect, useState } from 'react';
import {
  MATCHING_ALGORITHMS,
  TEMPLATE_PLACEHOLDERS,
  type CustomField,
  type MatchingAlgorithm,
  type Workflow,
  type WorkflowTrigger,
} from '@sheaf/protocol';
import type { Api } from '../api';
import { ALGORITHM_NAMES } from '../label-rule';
import {
  EMPTY_FORM,
  describeWorkflow,
  toBody,
  toForm,
  type LabelMode,
  type WorkflowForm,
} from '../workflow-form';

/** Workflows: when a document is added or edited, and it is like this, do that. */
export function Workflows({ api }: { api: Api }) {
  const [workflows, setWorkflows] = useState<readonly Workflow[] | null>(null);
  const [fields, setFields] = useState<readonly CustomField[]>([]);
  const [editing, setEditing] = useState<{ id: number | null; form: WorkflowForm } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api.workflows();
    if (result.ok) setWorkflows(result.value.workflows);
    else setError(result.message);
  }, [api]);

  useEffect(() => {
    void load();
    void api.customFields().then((result) => {
      if (result.ok) setFields(result.value.fields);
    });
  }, [api, load]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (editing === null) return;
    const made = toBody(editing.form, fields);
    if (!made.ok) {
      setError(made.problem);
      return;
    }
    const result =
      editing.id === null
        ? await api.createWorkflow(made.body)
        : await api.replaceWorkflow(editing.id, made.body);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    setEditing(null);
    await load();
  };

  const toggle = async (workflow: Workflow) => {
    const made = toBody({ ...toForm(workflow, fields), enabled: !workflow.enabled }, fields);
    if (!made.ok) return;
    const result = await api.replaceWorkflow(workflow.id, made.body);
    if (!result.ok) setError(result.message);
    await load();
  };

  const remove = async (id: number) => {
    const result = await api.deleteWorkflow(id);
    if (!result.ok) setError(result.message);
    await load();
  };

  return (
    <div>
      <h1>Workflows</h1>
      <p className="subtitle">
        When a document is added, or you edit one, and it is like this, do that. They run in order,
        after the label rules.
      </p>
      {error === null ? null : <p className="error">{error}</p>}
      {workflows === null ? <p className="muted">Loading…</p> : null}
      {workflows !== null && workflows.length === 0 ? (
        <p className="muted">No workflows yet.</p>
      ) : null}
      <ul className="list">
        {(workflows ?? []).map((workflow) => (
          <li key={workflow.id}>
            <div>
              <strong>
                {workflow.name}
                {workflow.enabled ? null : <span className="badge neutral">off</span>}
              </strong>
              <span className="muted">{describeWorkflow(workflow)}</span>
            </div>
            <div className="actions">
              <button type="button" className="secondary" onClick={() => void toggle(workflow)}>
                {workflow.enabled ? 'Turn off' : 'Turn on'}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setEditing({ id: workflow.id, form: toForm(workflow, fields) })}
              >
                Edit
              </button>
              <button type="button" className="link" onClick={() => void remove(workflow.id)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      {editing === null ? (
        <p>
          <button type="button" onClick={() => setEditing({ id: null, form: EMPTY_FORM })}>
            New workflow
          </button>
        </p>
      ) : (
        <Editor
          form={editing.form}
          fields={fields}
          isNew={editing.id === null}
          onChange={(form) => setEditing({ ...editing, form })}
          onSubmit={(event) => void save(event)}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function Editor({
  form,
  fields,
  isNew,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: WorkflowForm;
  fields: readonly CustomField[];
  isNew: boolean;
  onChange: (form: WorkflowForm) => void;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: () => void;
}) {
  const set = (change: Partial<WorkflowForm>) => onChange({ ...form, ...change });
  const text = (key: keyof WorkflowForm, label: string, placeholder = '') => (
    <div>
      <label htmlFor={`wf-${key}`}>{label}</label>
      <input
        id={`wf-${key}`}
        placeholder={placeholder}
        value={form[key] as string}
        onChange={(event) => set({ [key]: event.target.value })}
      />
    </div>
  );
  const mode = (
    key: 'setCorrespondent' | 'setDocumentType',
    valueKey: 'correspondentValue' | 'documentTypeValue',
    label: string,
  ) => (
    <div>
      <label htmlFor={`wf-${key}`}>{label}</label>
      <span className="asn-input">
        <select
          id={`wf-${key}`}
          value={form[key]}
          onChange={(event) => set({ [key]: event.target.value as LabelMode })}
        >
          <option value="leave">Leave it</option>
          <option value="set">Set to…</option>
          <option value="clear">Clear it</option>
        </select>
        {form[key] === 'set' ? (
          <input
            aria-label={`${label}: name`}
            value={form[valueKey]}
            onChange={(event) => set({ [valueKey]: event.target.value })}
          />
        ) : null}
      </span>
    </div>
  );

  return (
    <form className="card workflow-editor" onSubmit={onSubmit}>
      <h2>{isNew ? 'New workflow' : 'Edit workflow'}</h2>
      <div className="filter-row">
        {text('name', 'Name')}
        <div>
          <label htmlFor="wf-trigger">When</label>
          <select
            id="wf-trigger"
            value={form.trigger}
            onChange={(event) => set({ trigger: event.target.value as WorkflowTrigger })}
          >
            <option value="added">A document is added</option>
            <option value="updated">A person edits a document</option>
          </select>
        </div>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => set({ enabled: event.target.checked })}
        />{' '}
        On
      </label>

      <h3>If the document…</h3>
      <div className="filter-row">
        {text('tags', 'Has every tag', 'bills, home')}
        {text('anyTags', 'Has any tag')}
        {text('notTags', 'Has none of these tags')}
      </div>
      <div className="filter-row">
        {text('correspondent', 'Is from')}
        {text('documentType', 'Is of type')}
      </div>
      <div className="filter-row">
        <div>
          <label htmlFor="wf-textAlgorithm">Its text has</label>
          <select
            id="wf-textAlgorithm"
            value={form.textAlgorithm}
            onChange={(event) => set({ textAlgorithm: event.target.value as MatchingAlgorithm })}
          >
            {MATCHING_ALGORITHMS.map((algorithm) => (
              <option key={algorithm} value={algorithm}>
                {algorithm === 'none' ? 'Anything' : ALGORITHM_NAMES[algorithm]}
              </option>
            ))}
          </select>
        </div>
        {form.textAlgorithm === 'none' ? null : text('textPattern', 'Words or pattern')}
      </div>

      <h3>Then</h3>
      {text(
        'title',
        'Set the title to',
        TEMPLATE_PLACEHOLDERS.slice(0, 3)
          .map((p) => `{{${p}}}`)
          .join(' '),
      )}
      <div className="filter-row">
        {text('addTags', 'Add tags')}
        {text('removeTags', 'Remove tags')}
      </div>
      <div className="filter-row">
        {mode('setCorrespondent', 'correspondentValue', 'Correspondent')}
        {mode('setDocumentType', 'documentTypeValue', 'Type')}
      </div>
      <div className="filter-row">
        <div>
          <label htmlFor="wf-field">Set a custom field</label>
          <select
            id="wf-field"
            value={form.field}
            onChange={(event) => set({ field: event.target.value })}
          >
            <option value="">No</option>
            {fields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
        </div>
        {form.field === '' ? null : text('fieldValue', 'To (empty: no value)')}
      </div>
      {text('webhook', 'Call a webhook', 'https://…')}
      <p className="actions">
        <button type="submit">{isNew ? 'Add workflow' : 'Save workflow'}</button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </p>
    </form>
  );
}
