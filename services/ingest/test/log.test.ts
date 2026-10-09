import { describe as suite, expect, it } from 'vitest';
import { createLogger } from '../src/log';

const capture = (format: 'text' | 'json') => {
  const lines: { line: string; isError: boolean }[] = [];
  const logger = createLogger(
    format,
    (line, isError) => lines.push({ line, isError }),
    () => new Date(0),
  );
  return { logger, lines };
};

suite('logging', () => {
  it('writes one JSON object per line, errors to stderr', () => {
    const { logger, lines } = capture('json');
    logger.info('listening', { port: 8787 });
    logger.error('a job crashed', { step: 'ocr' });
    expect(lines.map((l) => JSON.parse(l.line) as unknown)).toEqual([
      { ts: '1970-01-01T00:00:00.000Z', level: 'info', msg: 'listening', port: 8787 },
      { ts: '1970-01-01T00:00:00.000Z', level: 'error', msg: 'a job crashed', step: 'ocr' },
    ]);
    expect(lines.map((l) => l.isError)).toEqual([false, true]);
  });

  it('writes plain text for a terminal', () => {
    const { logger, lines } = capture('text');
    logger.info('jobs', { steps: 'extract, ocr' });
    expect(lines[0]!.line).toBe('jobs steps=extract, ocr');
  });
});
