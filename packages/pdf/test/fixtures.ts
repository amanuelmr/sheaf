/** Synthetic JPEGs. We only ever read the frame header, so a real image is not needed. */
export function jpeg(options: {
  width: number;
  height: number;
  components?: number;
  progressive?: boolean;
  /** Extra APPn segment, to prove marker skipping works. */
  withApp0?: boolean;
  /** Fill byte for the entropy-coded payload, so two fixtures can differ. */
  fill?: number;
}): Uint8Array {
  const {
    width,
    height,
    components = 3,
    progressive = false,
    withApp0 = true,
    fill = 0x11,
  } = options;
  const bytes: number[] = [0xff, 0xd8];

  if (withApp0) {
    const payload = [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0, 0];
    bytes.push(0xff, 0xe0, 0x00, payload.length + 2, ...payload);
  }

  const sofLength = 8 + 3 * components;
  bytes.push(0xff, progressive ? 0xc2 : 0xc0, (sofLength >> 8) & 0xff, sofLength & 0xff);
  bytes.push(8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, components);
  for (let c = 1; c <= components; c++) bytes.push(c, 0x11, 0);

  bytes.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);
  for (let i = 0; i < 24; i++) bytes.push(fill);
  bytes.push(0xff, 0xd9);

  return new Uint8Array(bytes);
}

export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export const text = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => String.fromCharCode(b)).join('');
