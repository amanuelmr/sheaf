import { describe as suite, expect, it } from 'vitest';
import { interpretTask } from '../src/tasks';

suite('interpretTask', () => {
  it('waits while the consumer is still working', () => {
    expect(interpretTask({ task_id: 't', status: 'PENDING' })).toBe('pending');
    expect(interpretTask({ task_id: 't', status: 'STARTED' })).toBe('pending');
  });

  it('reads a stored document', () => {
    expect(interpretTask({ task_id: 't', status: 'SUCCESS', related_document: 4821 })).toEqual({
      kind: 'stored',
      remoteId: 4821,
    });
  });

  it('treats a duplicate as proof the server already has the document', () => {
    expect(
      interpretTask({
        task_id: 't',
        status: 'FAILURE',
        result: 'It is a duplicate of Amazon receipt (#4821)',
      }),
    ).toEqual({ kind: 'duplicate', remoteId: 4821 });
  });

  it('still reports a duplicate when it cannot name the document', () => {
    expect(
      interpretTask({ task_id: 't', status: 'FAILURE', result: 'duplicate detected' }),
    ).toEqual({ kind: 'duplicate', remoteId: null });
  });

  it('reports a genuine consumer refusal as a failure', () => {
    expect(
      interpretTask({ task_id: 't', status: 'FAILURE', result: 'unsupported file type' }),
    ).toEqual({ kind: 'consumer_failed', message: 'unsupported file type' });
  });
});
