/** Finding the PDFs in an email, and nothing else. */
import { describe as suite, expect, it } from 'vitest';
import { decodeWords, parseMail } from '../src/mime';

const PDF = '%PDF-1.4\nhello\n%%EOF\n';
const b64 = (s: string) =>
  Buffer.from(s)
    .toString('base64')
    .replace(/(.{20})/g, '$1\r\n');
const mail = (lines: string[]) => new Uint8Array(Buffer.from(lines.join('\r\n')));

suite('reading an email', () => {
  it('finds a base64 PDF in a multipart message, with its subject and filename', () => {
    const parsed = parseMail(
      mail([
        'From: Billing <bills@power.example>',
        'Subject: =?utf-8?B?Q2l0eSBQb3dlciDigJM=?= =?utf-8?Q?_March?=',
        'Content-Type: multipart/mixed;',
        '  boundary="XYZ"',
        '',
        '--XYZ',
        'Content-Type: text/plain',
        '',
        'Your bill is attached.',
        '--XYZ',
        'Content-Type: application/pdf; name="bill.pdf"',
        'Content-Disposition: attachment; filename="bill.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        b64(PDF),
        '--XYZ--',
        '',
      ]),
    );
    expect(parsed.subject).toBe('City Power – March');
    expect(parsed.from).toBe('Billing <bills@power.example>');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe('bill.pdf');
    expect(Buffer.from(parsed.attachments[0]!.bytes).toString()).toBe(PDF);
  });

  it('looks inside nested parts and forwarded mail, and takes octet-stream named .pdf', () => {
    const parsed = parseMail(
      mail([
        'Subject: Fwd',
        'Content-Type: multipart/mixed; boundary=outer',
        '',
        '--outer',
        'Content-Type: multipart/alternative; boundary=inner',
        '',
        '--inner',
        'Content-Type: text/html',
        '',
        '<p>hi</p>',
        '--inner--',
        '--outer',
        'Content-Type: message/rfc822',
        '',
        'Subject: original',
        "Content-Type: application/octet-stream; name*=utf-8''r%C3%A9sum%C3%A9.pdf",
        'Content-Transfer-Encoding: quoted-printable',
        '',
        '%PDF-1.4=0Aqp=3Dyes=',
        '',
        '--outer--',
      ]),
    );
    expect(parsed.attachments.map((a) => [a.filename, Buffer.from(a.bytes).toString()])).toEqual([
      ['résumé.pdf', '%PDF-1.4\nqp=yes'],
    ]);
  });

  it('skips what only claims to be a PDF, and everything else', () => {
    const parsed = parseMail(
      mail([
        'Content-Type: multipart/mixed; boundary=b',
        '',
        '--b',
        'Content-Type: application/pdf',
        'Content-Transfer-Encoding: base64',
        '',
        b64('MZ not a pdf'),
        '--b',
        'Content-Type: image/png; name="scan.pdf.png"',
        '',
        'png',
        '--b--',
      ]),
    );
    expect(parsed.attachments).toEqual([]);
  });

  it('leaves an encoded word in an unknown charset as it was', () => {
    expect(decodeWords('=?x-nope?B?aGk=?=')).toBe('=?x-nope?B?aGk=?=');
  });
});
