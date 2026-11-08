/** The workflow editor: what is typed becomes a body, and a saved workflow comes back as typed. */
import { describe as suite, expect, it } from 'vitest';
import type { CustomField, Workflow } from '@sheaf/protocol';
import { EMPTY_FORM, describeWorkflow, toBody, toForm } from '../src/workflow-form';

const fields: CustomField[] = [
  { id: 4, name: 'Due', type: 'date', options: [], documentCount: 0, required: false },
];

suite('the workflow form', () => {
  it('makes a scheduled workflow that emails, and reads it back', () => {
    const made = toBody(
      {
        ...EMPTY_FORM,
        name: 'Overdue',
        trigger: 'scheduled',
        olderThanDays: '30',
        dateField: 'created',
        emailTo: 'me@example.com',
        emailAttach: true,
      },
      fields,
    );
    expect(made.ok && made.body.conditions).toEqual({ olderThanDays: 30, dateField: 'created' });
    expect(made.ok && made.body.actions.email?.attach).toBe(true);
    if (!made.ok) throw new Error('not made');
    const workflow = { ...made.body, id: 1, position: 1 } as Workflow;
    expect(toForm(workflow, fields)).toMatchObject({
      olderThanDays: '30',
      emailTo: 'me@example.com',
    });
    expect(describeWorkflow(workflow)).toMatch(
      /^Once a document is 30 days past its date: email me@example.com/,
    );
    expect(
      toBody(
        { ...EMPTY_FORM, name: 'x', trigger: 'scheduled', olderThanDays: '', addTags: 'a' },
        fields,
      ),
    ).toMatchObject({ ok: false });
  });

  it('makes a body from what was typed, leaving out what was left empty', () => {
    const made = toBody(
      {
        ...EMPTY_FORM,
        name: ' Power bills ',
        tags: 'bills, , home',
        textAlgorithm: 'any',
        textPattern: 'kilowatt',
        addTags: 'utilities',
        setCorrespondent: 'set',
        correspondentValue: 'City Power',
        setDocumentType: 'clear',
        field: '4',
        fieldValue: '2026-12-01',
      },
      fields,
    );
    expect(made).toEqual({
      ok: true,
      body: {
        name: 'Power bills',
        enabled: true,
        trigger: 'added',
        conditions: {
          tags: ['bills', 'home'],
          text: { algorithm: 'any', pattern: 'kilowatt', caseSensitive: false },
        },
        actions: {
          addTags: ['utilities'],
          correspondent: 'City Power',
          documentType: null,
          customField: { field: 4, value: '2026-12-01' },
        },
      },
    });
  });

  it('says what is missing', () => {
    expect(toBody({ ...EMPTY_FORM, name: 'x' }, fields)).toEqual({
      ok: false,
      problem: 'Choose at least one thing to do.',
    });
    expect(toBody({ ...EMPTY_FORM, addTags: 'a' }, fields)).toMatchObject({
      problem: 'Give it a name.',
    });
    expect(
      toBody({ ...EMPTY_FORM, name: 'x', addTags: 'a', field: '4', fieldValue: 'soon' }, fields),
    ).toMatchObject({
      ok: false,
    });
  });

  it('turns a saved workflow back into the form, and describes it', () => {
    const workflow: Workflow = {
      id: 1,
      name: 'Power bills',
      enabled: false,
      trigger: 'updated',
      conditions: { notTags: ['paid'] },
      actions: { removeTags: ['unread'], correspondent: null, title: '{{correspondent}}' },
      position: 1,
    };
    const form = toForm(workflow, fields);
    expect(form).toMatchObject({ enabled: false, notTags: 'paid', setCorrespondent: 'clear' });
    const back = toBody(form, fields);
    expect(back.ok && back.body.actions).toEqual(workflow.actions);
    expect(describeWorkflow(workflow)).toBe(
      'When a person edits a document, if not tagged paid: title it “{{correspondent}}”, remove unread, clear the correspondent.',
    );
  });
});
