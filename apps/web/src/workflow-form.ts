import {
  customFieldValueProblem,
  type CustomField,
  type MatchingAlgorithm,
  type Workflow,
  type WorkflowBody,
  type WorkflowTrigger,
} from '@sheaf/protocol';
import { fromInput, toInput } from './custom-field-input';
import { t } from './i18n';

/** What to do with a correspondent or type: leave it, set it, or clear it. */
export type LabelMode = 'leave' | 'set' | 'clear';

/** A workflow as the form holds it: text as typed. */
export interface WorkflowForm {
  readonly name: string;
  readonly enabled: boolean;
  readonly trigger: WorkflowTrigger;
  readonly tags: string;
  readonly anyTags: string;
  readonly notTags: string;
  readonly correspondent: string;
  readonly documentType: string;
  readonly textAlgorithm: MatchingAlgorithm;
  readonly textPattern: string;
  readonly title: string;
  readonly addTags: string;
  readonly removeTags: string;
  readonly setCorrespondent: LabelMode;
  readonly correspondentValue: string;
  readonly setDocumentType: LabelMode;
  readonly documentTypeValue: string;
  /** A custom field id as text, or empty for none. */
  readonly field: string;
  readonly fieldValue: string;
  readonly webhook: string;
  /** Scheduled only: days, as typed. */
  readonly olderThanDays: string;
  readonly dateField: 'added' | 'created';
  /** Comma-separated addresses; empty for no email. */
  readonly emailTo: string;
  readonly emailSubject: string;
  readonly emailBody: string;
  readonly emailAttach: boolean;
}

export const EMPTY_FORM: WorkflowForm = {
  name: '',
  enabled: true,
  trigger: 'added',
  tags: '',
  anyTags: '',
  notTags: '',
  correspondent: '',
  documentType: '',
  textAlgorithm: 'none',
  textPattern: '',
  title: '',
  addTags: '',
  removeTags: '',
  setCorrespondent: 'leave',
  correspondentValue: '',
  setDocumentType: 'leave',
  documentTypeValue: '',
  field: '',
  fieldValue: '',
  webhook: '',
  olderThanDays: '30',
  dateField: 'added',
  emailTo: '',
  emailSubject: 'Sheaf: {{title}}',
  emailBody: '{{title}} from {{correspondent}}, dated {{created}}.',
  emailAttach: false,
};

const names = (text: string): string[] => [
  ...new Set(
    text
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== ''),
  ),
];

/** The body to send, or the reason the form is not ready. */
export function toBody(
  form: WorkflowForm,
  fields: readonly CustomField[],
): { ok: true; body: WorkflowBody } | { ok: false; problem: string } {
  const conditions: Record<string, unknown> = {};
  const actions: Record<string, unknown> = {};
  for (const key of ['tags', 'anyTags', 'notTags'] as const) {
    if (names(form[key]).length > 0) conditions[key] = names(form[key]);
  }
  if (form.correspondent.trim() !== '') conditions['correspondent'] = form.correspondent.trim();
  if (form.documentType.trim() !== '') conditions['documentType'] = form.documentType.trim();
  if (form.textAlgorithm !== 'none') {
    if (form.textPattern.trim() === '')
      return { ok: false, problem: t('Say which words to look for.') };
    conditions['text'] = {
      algorithm: form.textAlgorithm,
      pattern: form.textPattern,
      caseSensitive: false,
    };
  }

  if (form.title.trim() !== '') actions['title'] = form.title.trim();
  if (names(form.addTags).length > 0) actions['addTags'] = names(form.addTags);
  if (names(form.removeTags).length > 0) actions['removeTags'] = names(form.removeTags);
  for (const [mode, value, key] of [
    [form.setCorrespondent, form.correspondentValue, 'correspondent'],
    [form.setDocumentType, form.documentTypeValue, 'documentType'],
  ] as const) {
    if (mode === 'clear') actions[key] = null;
    if (mode === 'set') {
      if (value.trim() === '')
        return {
          ok: false,
          problem:
            key === 'correspondent'
              ? t('Say which correspondent to set.')
              : t('Say which type to set.'),
        };
      actions[key] = value.trim();
    }
  }
  if (form.field !== '') {
    const field = fields.find((f) => String(f.id) === form.field);
    if (field === undefined) return { ok: false, problem: t('That custom field is gone.') };
    const value = form.fieldValue.trim() === '' ? null : fromInput(field.type, form.fieldValue);
    const problem =
      value === undefined ? t('that is not a valid value') : customFieldValueProblem(field, value);
    if (problem !== null || value === undefined) {
      return {
        ok: false,
        problem: t('{field}: {problem}.', {
          field: field.name,
          problem: problem ?? t('that is not a valid value'),
        }),
      };
    }
    actions['customField'] = { field: field.id, value };
  }
  if (form.webhook.trim() !== '') actions['webhook'] = form.webhook.trim();
  const recipients = names(form.emailTo);
  if (recipients.length > 0) {
    actions['email'] = {
      to: recipients,
      subject: form.emailSubject,
      body: form.emailBody,
      attach: form.emailAttach,
    };
  }
  if (form.trigger === 'scheduled') {
    if (!/^\d{1,5}$/.test(form.olderThanDays.trim())) {
      return { ok: false, problem: t('Say after how many days it runs.') };
    }
    conditions['olderThanDays'] = Number(form.olderThanDays.trim());
    if (form.dateField === 'created') conditions['dateField'] = 'created';
  }

  if (form.name.trim() === '') return { ok: false, problem: t('Give it a name.') };
  if (Object.keys(actions).length === 0)
    return { ok: false, problem: t('Choose at least one thing to do.') };
  return {
    ok: true,
    body: {
      name: form.name.trim(),
      enabled: form.enabled,
      trigger: form.trigger,
      conditions,
      actions,
    },
  };
}

/** A saved workflow back in the form, to edit. */
export function toForm(workflow: Workflow, fields: readonly CustomField[]): WorkflowForm {
  const { conditions: c, actions: a } = workflow;
  const field = fields.find((f) => f.id === a.customField?.field);
  return {
    ...EMPTY_FORM,
    name: workflow.name,
    enabled: workflow.enabled,
    trigger: workflow.trigger,
    tags: (c.tags ?? []).join(', '),
    anyTags: (c.anyTags ?? []).join(', '),
    notTags: (c.notTags ?? []).join(', '),
    correspondent: c.correspondent ?? '',
    documentType: c.documentType ?? '',
    textAlgorithm: c.text?.algorithm ?? 'none',
    textPattern: c.text?.pattern ?? '',
    title: a.title ?? '',
    addTags: (a.addTags ?? []).join(', '),
    removeTags: (a.removeTags ?? []).join(', '),
    setCorrespondent:
      a.correspondent === undefined ? 'leave' : a.correspondent === null ? 'clear' : 'set',
    correspondentValue: a.correspondent ?? '',
    setDocumentType:
      a.documentType === undefined ? 'leave' : a.documentType === null ? 'clear' : 'set',
    documentTypeValue: a.documentType ?? '',
    field: field === undefined ? '' : String(field.id),
    fieldValue:
      field === undefined || a.customField === undefined
        ? ''
        : toInput(field.type, a.customField.value),
    webhook: a.webhook ?? '',
    olderThanDays:
      c.olderThanDays === undefined ? EMPTY_FORM.olderThanDays : String(c.olderThanDays),
    dateField: c.dateField ?? 'added',
    emailTo: (a.email?.to ?? []).join(', '),
    emailSubject: a.email?.subject ?? EMPTY_FORM.emailSubject,
    emailBody: a.email?.body ?? EMPTY_FORM.emailBody,
    emailAttach: a.email?.attach ?? false,
  };
}

/** A workflow in one line, for the list. */
export function describeWorkflow(workflow: Workflow): string {
  const c = workflow.conditions;
  const days = c.olderThanDays ?? 0;
  const when =
    workflow.trigger === 'added'
      ? t('When a document is added')
      : workflow.trigger === 'updated'
        ? t('When a person edits a document')
        : c.dateField === 'created'
          ? t('Once a document is {days} days past its date', { days })
          : t('Once a document is {days} days past its arrival', { days });
  const ifs = [
    ...(c.tags ?? []).map((tag) => t('tagged {tag}', { tag })),
    c.anyTags === undefined ? null : t('tagged any of {tags}', { tags: c.anyTags.join(', ') }),
    ...(c.notTags ?? []).map((tag) => t('not tagged {tag}', { tag })),
    c.correspondent === undefined ? null : t('from {name}', { name: c.correspondent }),
    c.documentType === undefined ? null : t('a {type}', { type: c.documentType }),
    c.text === undefined ? null : t('mentioning “{text}”', { text: c.text.pattern }),
  ].filter((part): part is string => part !== null);
  const a = workflow.actions;
  const dos = [
    a.title === undefined ? null : t('title it “{title}”', { title: a.title }),
    a.addTags === undefined ? null : t('add {tags}', { tags: a.addTags.join(', ') }),
    a.removeTags === undefined ? null : t('remove {tags}', { tags: a.removeTags.join(', ') }),
    a.correspondent === undefined
      ? null
      : a.correspondent === null
        ? t('clear the correspondent')
        : t('set from {name}', { name: a.correspondent }),
    a.documentType === undefined
      ? null
      : a.documentType === null
        ? t('clear the type')
        : t('set type {type}', { type: a.documentType }),
    a.customField === undefined ? null : t('set a custom field'),
    a.webhook === undefined ? null : t('call a webhook'),
    a.email === undefined ? null : t('email {to}', { to: a.email.to.join(', ') }),
  ].filter((part): part is string => part !== null);
  const actions = dos.join(', ');
  return ifs.length === 0
    ? t('{when}: {actions}.', { when, actions })
    : t('{when}, if {conditions}: {actions}.', {
        when,
        conditions: ifs.join(t(' and ')),
        actions,
      });
}
