/** Turning what a person picks into documents to send. */
import { describe as suite, expect, it } from 'vitest';
import { sha256Hex } from '@sheaf/pdf';
import { jpeg } from '../../../packages/pdf/test/fixtures';
import { fitWithin, plan, prepare, type PickedFile } from '../src/upload';

const file = (name: string, type: string, bytes = new Uint8Array()): PickedFile => ({
  name,
  type,
  bytes: () => Promise.resolve(bytes),
});

suite('uploading from the web app', () => {
  it('sends each PDF alone, the photos together as one document, and names the rest', () => {
    const picked = [
      file('a.pdf', 'application/pdf'),
      file('front.jpg', 'image/jpeg'),
      file('notes.txt', 'text/plain'),
      file('B.PDF', ''),
      file('back.png', 'image/png'),
      file('handbook.epub', ''),
    ];
    const { parts, skipped } = plan(picked);
    expect(parts.map((p) => [p.kind, p.name])).toEqual([
      ['pdf', 'a.pdf'],
      ['pdf', 'B.PDF'],
      ['book', 'handbook.epub'],
      ['photos', '2 photos'],
    ]);
    expect(skipped).toEqual(['notes.txt']);
  });

  it('keeps a PDF byte for byte and refuses a file that only claims to be one', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 tiny');
    const ready = await prepare(
      { kind: 'pdf', name: 'a.pdf', file: file('a.pdf', '', bytes) },
      () => Promise.reject(new Error('unused')),
    );
    expect(ready).toEqual({ bytes, sha256: sha256Hex(bytes), pageCount: null });
    const fake = await prepare(
      { kind: 'pdf', name: 'x.pdf', file: file('x.pdf', '', new Uint8Array([1, 2])) },
      () => Promise.reject(new Error('unused')),
    );
    expect(fake).toEqual({ problem: 'x.pdf is not a PDF inside' });
  });

  it('makes photos into the same document every time', async () => {
    const pages = [file('1.jpg', 'image/jpeg'), file('2.jpg', 'image/jpeg')];
    const toJpeg = (f: PickedFile) =>
      Promise.resolve(jpeg({ width: 40, height: 60, fill: f.name === '1.jpg' ? 1 : 2 }));
    const first = await prepare({ kind: 'photos', name: '2 photos', files: pages }, toJpeg);
    const again = await prepare({ kind: 'photos', name: '2 photos', files: pages }, toJpeg);
    expect('sha256' in first && first.pageCount).toBe(2);
    expect('sha256' in first && 'sha256' in again && first.sha256 === again.sha256).toBe(true);
  });

  it('shrinks big photos to a sendable page and leaves small ones', () => {
    expect(fitWithin(4800, 3600)).toEqual({ width: 2400, height: 1800 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
});
