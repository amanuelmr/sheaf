/**
 * Logging. Text for a person running the server in a terminal; one JSON object per
 * line with SHEAF_LOG_FORMAT=json, for anything that collects and searches logs.
 *
 * Never pass a token or document text as a field: logs travel further than the data.
 */
type Fields = Readonly<Record<string, string | number | boolean | null>>;

export interface Logger {
  info(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

export function createLogger(
  format: 'text' | 'json',
  write: (line: string, isError: boolean) => void = (line, isError) =>
    (isError ? process.stderr : process.stdout).write(`${line}\n`),
  now: () => Date = () => new Date(),
): Logger {
  const emit = (level: 'info' | 'error', message: string, fields: Fields = {}) => {
    if (format === 'json') {
      write(
        JSON.stringify({ ts: now().toISOString(), level, msg: message, ...fields }),
        level === 'error',
      );
      return;
    }
    const extra = Object.entries(fields)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
    write(extra === '' ? message : `${message} ${extra}`, level === 'error');
  };
  return {
    info: (message, fields) => emit('info', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

export const log = createLogger(process.env['SHEAF_LOG_FORMAT'] === 'json' ? 'json' : 'text');
