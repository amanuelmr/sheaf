/** Scheduled workflows, and workflows that send email through a small SMTP server of our own. */
import { mkdtempSync } from 'node:fs';
import { createConnection, createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe as suite, beforeEach, expect, it } from 'vitest';
import { workflowProblem, type WorkflowBody } from '@sheaf/protocol';
import { nodeSqliteDriver } from '@sheaf/store/node';
import { parseMail } from '../src/mime';
import { message, sendMail, type OutgoingMail } from '../src/smtp';
import { Storage, sha256Hex } from '../src/storage';
import { Workflows } from '../src/workflows';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-01T12:00:00Z');

let server: Server;
let received: { commands: string[]; data: string }[];

function fakeSmtp(): Promise<number> {
  received = [];
  server = createServer((socket) => {
    const session = { commands: [] as string[], data: '' };
    received.push(session);
    let inData = false;
    let pending = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk: Buffer) => {
      pending += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = pending.indexOf('\r\n.\r\n');
          if (end === -1) return;
          session.data = pending.slice(0, end);
          pending = pending.slice(end + 5);
          inData = false;
          socket.write('250 queued\r\n');
          continue;
        }
        const end = pending.indexOf('\r\n');
        if (end === -1) return;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        session.commands.push(line);
        if (line.startsWith('EHLO')) socket.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('AUTH PLAIN')) {
          socket.write(
            line.includes(Buffer.from('\0me\0secret').toString('base64'))
              ? '235 ok\r\n'
              : '535 no\r\n',
          );
        } else if (line === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (line === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

afterEach(() => server.close());

const smtpOptions = (port: number, password = 'secret') => ({
  from: 'sheaf@example.com',
  user: 'me',
  password,
  hostname: 'test',
  connect: () => Promise.resolve(createConnection(port, '127.0.0.1')),
});

suite('sending email', () => {
  it('logs in, sends to each recipient, and the PDF arrives attached', async () => {
    const port = await fakeSmtp();
    const pdf = new Uint8Array(Buffer.from('%PDF-1.4\n.leading dot\n%%EOF\n'));
    await sendMail(smtpOptions(port), {
      to: ['a@example.com', 'b@example.com'],
      subject: 'Lease — signed',
      body: 'See attached.',
      attachment: { filename: 'lease.pdf', bytes: pdf },
    });
    const [session] = received;
    expect(session?.commands.filter((c) => c.startsWith('RCPT'))).toEqual([
      'RCPT TO:<a@example.com>',
      'RCPT TO:<b@example.com>',
    ]);
    const parsed = parseMail(
      new Uint8Array(Buffer.from(session!.data.replace(/\r\n\.\./g, '\r\n.'))),
    );
    expect(parsed.subject).toBe('Lease — signed');
    expect(Buffer.from(parsed.attachments[0]!.bytes)).toEqual(Buffer.from(pdf));
  });

  it('fails on a refused login, and refuses an address with a line break in it', async () => {
    const port = await fakeSmtp();
    await expect(
      sendMail(smtpOptions(port, 'wrong'), { to: ['a@example.com'], subject: 's', body: 'b' }),
    ).rejects.toThrow('AUTH was refused');
    await expect(
      sendMail(smtpOptions(port), {
        to: ['a@example.com\r\nRCPT TO:<x@y.z>'],
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow('not an email address');
  });

  it('sends nothing, password included, when STARTTLS was wanted and not offered', async () => {
    const port = await fakeSmtp();
    const upgrade = () => Promise.reject(new Error('never asked to upgrade'));
    await expect(
      sendMail(
        { ...smtpOptions(port), upgrade },
        { to: ['a@example.com'], subject: 's', body: 'b' },
      ),
    ).rejects.toThrow('did not offer STARTTLS');
    expect(received[0]?.commands.some((c) => c.startsWith('AUTH'))).toBe(false);
    expect(received[0]?.commands.some((c) => c.startsWith('MAIL'))).toBe(false);
  });

  it('keeps a subject on one line, whatever a title held', () => {
    const text = message('s@example.com', {
      to: ['a@example.com'],
      subject: 'a\r\nBcc: x@y.z',
      body: '',
    });
    expect(text).toContain('Subject: a Bcc: x@y.z');
    expect(text).not.toMatch(/^Bcc:/m);
  });
});

suite('scheduled workflows', () => {
  let storage: Storage;
  let workflows: Workflows;
  let sent: OutgoingMail[];
  const pdf = (s: string) => new Uint8Array(Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`));

  beforeEach(async () => {
    const driver = nodeSqliteDriver();
    storage = await Storage.open({ driver, objectsDir: mkdtempSync(join(tmpdir(), 'sheaf-sch-')) });
    sent = [];
    workflows = new Workflows(driver, storage, undefined, {
      fetch: () => Promise.resolve({ ok: true, status: 200 }),
      warn: () => undefined,
      sendMail: (mail) => {
        sent.push(mail);
        return Promise.resolve();
      },
    });
    for (const [name, at] of [
      ['old', NOW - 40 * DAY],
      ['new', NOW - 2 * DAY],
    ] as const) {
      await storage.put(sha256Hex(pdf(name)), pdf(name), at, 1);
      await storage.patch(sha256Hex(pdf(name)), { title: name, tags: ['unpaid'] }, at);
    }
  });

  const body = (overrides: Partial<WorkflowBody>): WorkflowBody => ({
    name: 'remind',
    enabled: true,
    trigger: 'scheduled',
    conditions: { olderThanDays: 30, tags: ['unpaid'] },
    actions: {
      addTags: ['overdue'],
      email: {
        to: ['me@example.com'],
        subject: 'Overdue: {{title}}',
        body: 'Since {{added}}',
        attach: false,
      },
    },
    ...overrides,
  });

  it('acts once on each document that reached its age, and never again', async () => {
    await workflows.create(body({}), NOW);
    expect(await workflows.runScheduled(NOW)).toBe(1);
    expect((await storage.record(sha256Hex(pdf('old'))))?.tags).toEqual(['unpaid', 'overdue']);
    expect(sent.map((m) => m.subject)).toEqual(['Overdue: old']);
    expect(await workflows.runScheduled(NOW + DAY)).toBe(0);
    expect(await workflows.runScheduled(NOW + 30 * DAY)).toBe(1);
    expect(sent.map((m) => m.subject)).toEqual(['Overdue: old', 'Overdue: new']);
  });

  it('can count from the date on the document instead', async () => {
    await storage.patch(sha256Hex(pdf('new')), { created: '2026-01-01' }, NOW);
    await workflows.create(body({ conditions: { olderThanDays: 100, dateField: 'created' } }), NOW);
    expect(await workflows.runScheduled(NOW)).toBe(1);
    expect(sent.map((m) => m.subject)).toEqual(['Overdue: new']);
  });

  it('needs an age, and only scheduled workflows take one', () => {
    expect(workflowProblem(body({ conditions: {} }))).toMatch(/olderThanDays/);
    expect(workflowProblem(body({ trigger: 'added' }))).toMatch(/for scheduled/);
    expect(
      workflowProblem(
        body({ actions: { email: { to: ['nope'], subject: 's', body: 'b', attach: false } } }),
      ),
    ).toMatch(/email addresses/);
  });
});
