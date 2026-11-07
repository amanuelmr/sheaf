import type { Duplex } from 'node:stream';

/** One response from the server: its text, with each literal's bytes alongside. */
interface Response {
  readonly text: string;
  readonly literals: readonly Buffer[];
}

const MAX_LITERAL = 64 * 1024 * 1024;

/**
 * The few IMAP commands a mailbox poller needs, over a connection someone else
 * opened (TLS in use, a plain socket in tests). One command at a time; every
 * wait has a deadline, so a server that stops answering cannot hang the poller.
 */
export class ImapSession {
  readonly #socket: Duplex;
  readonly #timeoutMs: number;
  #buffer = Buffer.alloc(0);
  #wake: (() => void) | null = null;
  #closed: Error | null = null;
  #tag = 0;

  constructor(socket: Duplex, timeoutMs = 30_000) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    socket.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#wake?.();
    });
    const close = (error?: Error) => {
      this.#closed = error ?? new Error('the mail server closed the connection');
      this.#wake?.();
    };
    socket.on('error', close);
    socket.on('close', () => close());
  }

  async greeting(): Promise<void> {
    const response = await this.#read();
    if (!/^\* (OK|PREAUTH)/i.test(response.text))
      throw new Error(`unexpected greeting: ${response.text}`);
  }

  async login(user: string, password: string): Promise<void> {
    await this.#command(`LOGIN ${quote(user)} ${quote(password)}`, 'LOGIN');
  }

  async select(folder: string): Promise<void> {
    await this.#command(`SELECT ${quote(folder)}`);
  }

  async unseen(): Promise<number[]> {
    const responses = await this.#command('UID SEARCH UNSEEN');
    const line = responses.find((r) => /^\* SEARCH\b/i.test(r.text));
    return (
      line?.text
        .replace(/^\* SEARCH/i, '')
        .trim()
        .split(/\s+/) ?? []
    )
      .filter((n) => /^\d+$/.test(n))
      .map(Number);
  }

  /** The whole message, without marking it read. */
  async fetch(uid: number): Promise<Buffer> {
    const responses = await this.#command(`UID FETCH ${String(uid)} (BODY.PEEK[])`);
    const message = responses.find((r) => /FETCH/i.test(r.text) && r.literals.length > 0);
    if (message === undefined) throw new Error(`message ${String(uid)} came back empty`);
    return message.literals[0]!;
  }

  async flag(uid: number, flag: '\\Seen' | '\\Deleted'): Promise<void> {
    await this.#command(`UID STORE ${String(uid)} +FLAGS.SILENT (${flag})`);
  }

  async expunge(): Promise<void> {
    await this.#command('EXPUNGE');
  }

  async logout(): Promise<void> {
    try {
      await this.#command('LOGOUT');
    } catch {
      // Leaving anyway.
    }
    this.#socket.end();
  }

  async #command(command: string, shown = command): Promise<Response[]> {
    const tag = `a${String(++this.#tag)}`;
    this.#socket.write(`${tag} ${command}\r\n`);
    const untagged: Response[] = [];
    for (;;) {
      const response = await this.#read();
      if (!response.text.startsWith(`${tag} `)) {
        untagged.push(response);
        continue;
      }
      const status = response.text.slice(tag.length + 1);
      // The command is not repeated back: LOGIN carries the password.
      if (!/^OK\b/i.test(status)) throw new Error(`${shown} failed: ${status}`);
      return untagged;
    }
  }

  /** One response: a line, and any literals it announces with `{n}`, read whole. */
  async #read(): Promise<Response> {
    let text = '';
    const literals: Buffer[] = [];
    for (;;) {
      const line = await this.#line();
      const literal = /\{(\d+)\}$/.exec(line);
      if (literal === null) return { text: text + line, literals };
      const size = Number(literal[1]);
      if (size > MAX_LITERAL) throw new Error('the mail server sent more than a message can be');
      literals.push(await this.#bytes(size));
      text += line;
    }
  }

  async #line(): Promise<string> {
    for (;;) {
      const end = this.#buffer.indexOf('\r\n');
      if (end !== -1) {
        const line = this.#buffer.subarray(0, end).toString('latin1');
        this.#buffer = this.#buffer.subarray(end + 2);
        return line;
      }
      await this.#more();
    }
  }

  async #bytes(size: number): Promise<Buffer> {
    while (this.#buffer.length < size) await this.#more();
    const bytes = Buffer.from(this.#buffer.subarray(0, size));
    this.#buffer = this.#buffer.subarray(size);
    return bytes;
  }

  #more(): Promise<void> {
    if (this.#closed !== null) return Promise.reject(this.#closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#wake = null;
        reject(new Error('the mail server stopped answering'));
      }, this.#timeoutMs);
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = null;
        if (this.#closed !== null) reject(this.#closed);
        else resolve();
      };
    });
  }
}

/** An IMAP quoted string. Line breaks cannot be quoted, so they are refused. */
function quote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('mail settings cannot contain line breaks');
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}
