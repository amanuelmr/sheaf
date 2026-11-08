/** Turning the bulk bar's choice and typed name into the action the server takes. */
import { describe as suite, expect, it } from 'vitest';
import { bulkAction } from '../src/pages/BulkBar';

suite('bulk actions from the bar', () => {
  it('needs a tag name to add or remove one', () => {
    expect(bulkAction('addTag', '  ')).toBeNull();
    expect(bulkAction('addTag', ' bills ')).toEqual({
      kind: 'modifyTags',
      add: ['bills'],
      remove: [],
    });
    expect(bulkAction('removeTag', 'unread')).toEqual({
      kind: 'modifyTags',
      add: [],
      remove: ['unread'],
    });
  });

  it('clears a correspondent or type when left empty', () => {
    expect(bulkAction('setCorrespondent', '')).toEqual({ kind: 'setCorrespondent', value: null });
    expect(bulkAction('setDocumentType', 'Invoice')).toEqual({
      kind: 'setDocumentType',
      value: 'Invoice',
    });
  });

  it('takes no value to file by rules or trash', () => {
    expect(bulkAction('applyRules', 'ignored')).toEqual({ kind: 'applyRules' });
    expect(bulkAction('trash', '')).toEqual({ kind: 'trash' });
  });
});
