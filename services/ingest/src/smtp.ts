import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { EMAIL_PATTERN } from '@sheaf/protocol';

export interface OutgoingMail {
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly attachment?: { readonly filename: string; readonly bytes: Uint8Array };
}

export interface SmtpOptions {
  readonly from: string;
  readonly user: string | null;
  readonly password: string | null;
  /** The name this server gives itself in EHLO. */
  readonly hostname: string;
  /** Opens the connection: TLS already, or plain to be upgraded with STARTTLS. */
  connect(): Promise<Duplex>;
  /** Upgrade a plain connection after STARTTLS; absent means never upgrade. */
  upgrade?(socket: Duplex): Promise<Duplex>;
}

export { EMAIL_PATTERN } from '@sheaf/protocol';

/**
 * Sends one message over SMTP: EHLO, STARTTLS when offered and an upgrade is
 * given, AUTH PLAIN when there is a user, then the message. Every wait has a
 * deadline. Addresses and the subject are checked for line breaks, so nothing in a
 * document's title can add a header or a recipient.
 */
export async function sendMail(options: SmtpOptions, mail: OutgoingMail): Promise<void> {
  for (const address of [options.from, ...mail.to]) {
    if (!EMAIL_PATTERN.test(address)) throw new Error(`not an email address: ${address}`);
  }
  let socket = await options.connect();
  let reader = new Replies(socket);
  try {
    await reader.expect(220);
    let features = await command(socket, reader, `EHLO ${options.hostname}`, 250);
    if (options.upgrade !== undefined && /^STARTTLS$/im.test(features)) {
      await command(socket, reader, 'STARTTLS', 220);
      reader.detach();
      socket = await options.upgrade(socket);
      reader = new Replies(socket);
      features = await command(socket, reader, `EHLO ${options.hostname}`, 250);
    }
    if (options.user !== null && options.password !== null) {
      const token = Buffer.from(`\0${options.user}\0${options.password}`).toString('base64');
      await command(socket, reader, `AUTH PLAIN ${token}`, 235, 'AUTH');
    }
    await command(socket, reader, `MAIL FROM:<${options.from}>`, 250);
    for (const to of mail.to) await command(socket, reader, `RCPT TO:<${to}>`, [250, 251]);
    await command(socket, reader, 'DATA', 354);
    socket.write(dotStuff(message(options.from, mail)) + '\r\n.\r\n');
    await reader.expect(250);
    await command(socket, reader, 'QUIT', 221).catch(() => undefined);
  } finally {
    socket.end();
  }
}

async function command(
  socket: Duplex,
  reader: Replies,
  line: string,
  expected: number | number[],
  shown = line,
): Promise<string> {
  socket.write(`${line}\r\n`);
  return reader.expect(expected, shown);
}

/** The whole message: headers, then text, or text and a PDF in a multipart. */
export function message(from: string, mail: OutgoingMail): string {
  const subject = mail.subject.replace(/[\r\n]+/g, ' ');
  const encodedSubject = /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const headers = [
    `From: ${from}`,
    `To: ${mail.to.join(', ')}`,
    `Subject: ${encodedSubject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${from.split('@')[1] ?? 'sheaf'}>`,
    'MIME-Version: 1.0',
  ];
  const text = Buffer.from(mail.body)
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  if (mail.attachment === undefined) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      text,
    ].join('\r\n');
  }
  const boundary = `sheaf-${randomBytes(12).toString('hex')}`;
  const name = mail.attachment.filename.replace(/["\r\n\\]/g, '_');
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    text,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${name}"`,
    `Content-Disposition: attachment; filename="${name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(mail.attachment.bytes)
      .toString('base64')
      .replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}--`,
  ].join('\r\n');
}

/** A line starting with a dot gets another, so it cannot end the message early. */
function dotStuff(text: string): string {
  return text.replace(/(^|\r\n)\./g, '$1..');
}

/** Reads SMTP replies, which may span lines: `250-first`, `250 last`. */
class Replies {
  #buffer = '';
  #wake: (() => void) | null = null;
  #closed: Error | null = null;
  readonly #socket: Duplex;
  readonly #onData = (chunk: Buffer) => {
    this.#buffer += chunk.toString('latin1');
    this.#wake?.();
  };
  readonly #onClose = () => {
    this.#closed = new Error('the mail server closed the connection');
    this.#wake?.();
  };

  constructor(socket: Duplex) {
    this.#socket = socket;
    socket.on('data', this.#onData);
    socket.on('close', this.#onClose);
    socket.on('error', this.#onClose);
  }

  detach(): void {
    this.#socket.off('data', this.#onData);
    this.#socket.off('close', this.#onClose);
    this.#socket.off('error', this.#onClose);
  }

  async expect(expected: number | number[], shown?: string): Promise<string> {
    const codes = Array.isArray(expected) ? expected : [expected];
    const lines: string[] = [];
    for (;;) {
      const line = await this.#line();
      lines.push(line.slice(4));
      if (line[3] !== '-') {
        const code = Number(line.slice(0, 3));
        if (!codes.includes(code)) {
          throw new Error(`${shown ?? 'the mail server'} was refused: ${line}`);
        }
        return lines.join('\n');
      }
    }
  }

  async #line(): Promise<string> {
    for (;;) {
      const end = this.#buffer.indexOf('\r\n');
      if (end !== -1) {
        const line = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 2);
        return line;
      }
      if (this.#closed !== null) throw this.#closed;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('the mail server stopped answering')),
          30_000,
        );
        this.#wake = () => {
          clearTimeout(timer);
          this.#wake = null;
          resolve();
        };
      });
    }
  }
}
