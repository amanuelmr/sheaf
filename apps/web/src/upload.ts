import { assemble, sha256Hex } from '@sheaf/pdf';

/** What a person picked, as the browser hands it over. */
export interface PickedFile {
  readonly name: string;
  readonly type: string;
  bytes(): Promise<Uint8Array>;
}

/** One document to send: a PDF as it is, or photos made into one. */
export type UploadPart =
  | { readonly kind: 'pdf'; readonly name: string; readonly file: PickedFile }
  | { readonly kind: 'photos'; readonly name: string; readonly files: readonly PickedFile[] };

export const isPdf = (file: PickedFile): boolean =>
  file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

export const isImage = (file: PickedFile): boolean =>
  file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|heic)$/i.test(file.name);

/**
 * Each PDF is a document of its own; photos picked together are the pages of one,
 * in the order picked, as a phone's scanner would make them. Anything else is
 * left out and named, so nothing goes missing without a word.
 */
export function plan(files: readonly PickedFile[]): {
  readonly parts: readonly UploadPart[];
  readonly skipped: readonly string[];
} {
  const parts: UploadPart[] = [];
  const photos: PickedFile[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (isPdf(file)) parts.push({ kind: 'pdf', name: file.name, file });
    else if (isImage(file)) photos.push(file);
    else skipped.push(file.name);
  }
  if (photos.length > 0) {
    const name = photos.length === 1 ? photos[0]!.name : `${String(photos.length)} photos`;
    parts.push({ kind: 'photos', name, files: photos });
  }
  return { parts, skipped };
}

/** A document ready to send: its bytes, the address they hash to and its pages. */
export interface Prepared {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly pageCount: number | null;
}

/**
 * Turns a part into a PDF. Photos go through `toJpeg` (a canvas in the browser)
 * and the same byte-for-byte assembly the phone uses, so the same photos always
 * make the same document.
 */
export async function prepare(
  part: UploadPart,
  toJpeg: (file: PickedFile) => Promise<Uint8Array>,
): Promise<Prepared | { readonly problem: string }> {
  if (part.kind === 'pdf') {
    const bytes = await part.file.bytes();
    if (new TextDecoder('latin1').decode(bytes.subarray(0, 5)) !== '%PDF-') {
      return { problem: `${part.name} is not a PDF inside` };
    }
    return { bytes, sha256: sha256Hex(bytes), pageCount: null };
  }
  const pages: Uint8Array[] = [];
  for (const file of part.files) pages.push(await toJpeg(file));
  const assembled = assemble(pages);
  if (!assembled.ok) {
    return {
      problem:
        assembled.error.kind === 'no_pages'
          ? 'no photos to make a document of'
          : `${part.files[assembled.error.index]?.name ?? 'a photo'} could not be read`,
    };
  }
  return { bytes: assembled.bytes, sha256: assembled.sha256, pageCount: assembled.pageCount };
}

/** The longest side a photo keeps: a page at about 200 dpi, small enough to send. */
export const MAX_PHOTO_SIDE = 2400;

/** How big to draw a photo of this size so that its longest side fits. */
export function fitWithin(width: number, height: number, max = MAX_PHOTO_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Draws any image the browser can show onto a canvas and reads it back as a JPEG. */
export async function browserJpeg(file: PickedFile & { readonly blob: Blob }): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file.blob, { imageOrientation: 'from-image' });
  const size = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('this browser cannot draw images');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.85),
  );
  if (blob === null) throw new Error(`${file.name} could not be turned into a page`);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Wraps a browser `File`. */
export function picked(file: File): PickedFile & { readonly blob: Blob } {
  return {
    name: file.name,
    type: file.type,
    blob: file,
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
  };
}
