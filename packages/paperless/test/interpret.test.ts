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

suite('status casing, as real servers actually send it', () => {
  /**
   * A live Paperless-ngx answers with lowercase. Comparing against 'SUCCESS' meant
   * every successful upload was read as a refusal — documents were safely stored
   * while we reported they had been declined. The eleven tests above all passed,
   * because their fixtures came from the same wrong belief as the code.
   */
  it('accepts lowercase, which is what a live server sends', () => {
    expect(interpretTask({ task_id: 't', status: 'success', related_document: 4821 })).toEqual({
      kind: 'stored',
      remoteId: 4821,
    });
    expect(interpretTask({ task_id: 't', status: 'pending' })).toBe('pending');
    expect(interpretTask({ task_id: 't', status: 'started' })).toBe('pending');
    expect(interpretTask({ task_id: 't', status: 'failure', result: 'bad file' })).toEqual({
      kind: 'consumer_failed',
      message: 'bad file',
    });
  });

  it('still accepts uppercase, which the documentation uses', () => {
    expect(interpretTask({ task_id: 't', status: 'SUCCESS', related_document: 1 })).toEqual({
      kind: 'stored',
      remoteId: 1,
    });
    expect(interpretTask({ task_id: 't', status: 'PENDING' })).toBe('pending');
  });

  it('reports a success whose document id the server withheld', () => {
    // Observed on a real server: status success, related_document null. The upload
    // worked; the id has to be resolved separately rather than invented.
    expect(interpretTask({ task_id: 't', status: 'success', related_document: null })).toEqual({
      kind: 'stored',
      remoteId: null,
    });
  });
});
