import { PDFDocument, StandardFonts } from 'pdf-lib';

/** A PDF whose pages say their own names, so the order can be read back. */
export async function labelled(...names: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const name of names) {
    const page = doc.addPage([200, 200]);
    page.drawText(name, { x: 20, y: 100, font, size: 12 });
    doc.setTitle('x');
    page.node.set(page.node.context.obj('SheafName'), page.node.context.obj(name));
  }
  return doc.save();
}

export async function names(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc
    .getPages()
    .map((page) => String(page.node.get(page.node.context.obj('SheafName'))).slice(1));
}

export async function turns(bytes: Uint8Array): Promise<number[]> {
  return (await PDFDocument.load(bytes)).getPages().map((page) => page.getRotation().angle);
}
