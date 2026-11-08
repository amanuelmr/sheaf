/** Taking in PDFs from unread mail, against a small IMAP server of our own. */
import { mkdtempSync } from 'node:fs';
import { createConnection, createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe as suite, beforeEach, expect, it } from 'vitest';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { MailFetcher, type MailOptions } from '../src/mail';
import { Storage, sha256Hex } from '../src/storage';

const NOW = 1_700_000_000_000;
const pdf = (s: string) => `%PDF-1.4\n${s}\n%%EOF\n`;
const withPdf = (subject: string, body: string) =>
  [
    `Subject: ${subject}`,
    'Content-Type: multipart/mixed; boundary=b',
    '',
    '--b',
    'Content-Type: application/pdf; name="a.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(pdf(body)).toString('base64'),
    '--b--',
    '',
  ].join('\r\n');

interface Message {
  raw: string;
  flags: Set<string>;
}

let server: Server;
let mailbox: Map<number, Message>;
let logins: string[];
let storage: Storage;

/** Answers just the commands the fetcher sends, the way a real server would. */
function fakeImap(): Promise<number> {
  server = createServer((socket) => {
    socket.write('* OK fake ready\r\n');
    let pending = '';
    socket.on('data', (chunk: Buffer) => {
      pending += chunk.toString('latin1');
      let end;
      while ((end = pending.indexOf('\r\n')) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const [tag, ...rest] = line.split(' ');
        const command = rest.join(' ');
        const ok = (text = 'done') => socket.write(`${tag!} OK ${text}\r\n`);
        if (command.startsWith('LOGIN')) {
          logins.push(command);
          if (command.includes('"wrong"')) socket.write(`${tag!} NO bad password\r\n`);
          else ok();
        } else if (command.startsWith('SELECT')) {
          ok();
        } else if (command === 'UID SEARCH UNSEEN') {
          const unseen = [...mailbox].filter(([, m]) => !m.flags.has('\\Seen')).map(([uid]) => uid);
          socket.write(`* SEARCH ${unseen.join(' ')}\r\n`);
          ok();
        } else if (command.startsWith('UID FETCH')) {
          const uid = Number(command.split(' ')[2]);
          const raw = Buffer.from(mailbox.get(uid)!.raw, 'latin1');
          socket.write(`* 1 FETCH (UID ${String(uid)} BODY[] {${String(raw.length)}}\r\n`);
          socket.write(raw);
          socket.write(')\r\n');
          ok();
        } else if (command.startsWith('UID STORE')) {
          const uid = Number(command.split(' ')[2]);
          mailbox.get(uid)!.flags.add(command.includes('Deleted') ? '\\Deleted' : '\\Seen');
          ok();
        } else if (command === 'EXPUNGE') {
          for (const [uid, m] of mailbox) if (m.flags.has('\\Deleted')) mailbox.delete(uid);
          ok();
        } else if (command === 'LOGOUT') {
          socket.write('* BYE\r\n');
          ok();
          socket.end();
        } else {
          socket.write(`${tag!} BAD unknown\r\n`);
        }
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

let port: number;

beforeEach(async () => {
  mailbox = new Map();
  logins = [];
  port = await fakeImap();
  storage = await Storage.open({
    driver: nodeSqliteDriver(),
    objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-mail-')),
  });
});

afterEach(() => {
  server.close();
});

const fetcher = (overrides: Partial<MailOptions> = {}) =>
  new MailFetcher(storage, {
    user: 'me@example.com',
    password: 'p"ss\\word',
    folder: 'INBOX',
    after: 'seen',
    tag: 'mail',
    connect: () => Promise.resolve(createConnection(port, '127.0.0.1')),
    now: () => NOW,
    ...overrides,
  });

suite('mail', () => {
  it('stores each PDF in unread mail, tags it, titles it by subject and marks the mail read', async () => {
    mailbox.set(7, { raw: withPdf('Power bill March', 'power'), flags: new Set() });
    mailbox.set(8, { raw: 'Subject: hello\r\n\r\njust text\r\n', flags: new Set() });
    mailbox.set(9, { raw: withPdf('old', 'old'), flags: new Set(['\\Seen']) });

    expect(await fetcher().tick()).toEqual({ messages: 2, stored: 1, duplicates: 0, failed: 0 });
    const sha = sha256Hex(new Uint8Array(Buffer.from(pdf('power'))));
    expect(await storage.record(sha)).toMatchObject({ title: 'Power bill March', tags: ['mail'] });
    expect(mailbox.get(7)?.flags.has('\\Seen')).toBe(true);
    expect(mailbox.get(8)?.flags.has('\\Seen')).toBe(true);
    expect(await storage.count()).toBe(1);
    // The password is quoted, never sent bare.
    expect(logins).toEqual(['LOGIN "me@example.com" "p\\"ss\\\\word"']);

    expect(await fetcher().tick()).toEqual({ messages: 0, stored: 0, duplicates: 0, failed: 0 });
  });

  it('deletes mail once taken in, when asked to', async () => {
    mailbox.set(1, { raw: withPdf('a', 'a'), flags: new Set() });
    mailbox.set(2, { raw: withPdf('b', 'a'), flags: new Set() });
    expect(await fetcher({ after: 'delete', tag: null }).tick()).toEqual({
      messages: 2,
      stored: 1,
      duplicates: 1,
      failed: 0,
    });
    expect(mailbox.size).toBe(0);
  });

  it('fails the pass on a wrong password, without saying what it was', async () => {
    await expect(fetcher({ password: 'wrong' }).tick()).rejects.toThrow(
      'LOGIN failed: NO bad password',
    );
  });
});
