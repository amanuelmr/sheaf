/**
 * Decode a baseline JPEG far enough to see it, and no further.
 *
 * We need pixels to tell whether two photographs are of the same piece of paper,
 * and there is no image decoder to hand: `expo-image-manipulator` returns encoded
 * bytes whatever you ask it for, and Hermes has no canvas. Pulling in a full JPEG
 * decoder to look at a picture at 1/8 scale would be a lot of machinery for the
 * question being asked.
 *
 * So this decodes only the DC coefficient of each 8x8 block. The DC coefficient
 * *is* the block's average brightness -- an inverse DCT of a DC-only block is a
 * constant -- so entropy-decoding the scan and throwing away every AC coefficient
 * yields, for free, exactly the 1/8-scale greyscale image a perceptual hash wants.
 * There is no inverse DCT here, no upsampling, and no colour conversion.
 *
 * The AC coefficients still have to be *read*, because Huffman codes are
 * variable-length and there is no way to skip past them without decoding them. They
 * are read and discarded.
 *
 * Baseline sequential only. A progressive JPEG spreads one block's coefficients
 * across several scans and is a different algorithm; this returns null rather than
 * guess, and the caller treats that as "no opinion".
 */

export interface DcImage {
  /** Luma block averages, 0-255, row-major. One sample per 8x8 pixel block. */
  readonly luma: Uint8Array;
  readonly across: number;
  readonly down: number;
  /** The full-size dimensions these blocks came from. */
  readonly width: number;
  readonly height: number;
}

interface HuffTable {
  /** Smallest code of each length, indexed 1-16. */
  readonly minCode: Int32Array;
  /** Largest code of each length, or -1 when no code has that length. */
  readonly maxCode: Int32Array;
  /** Index into `values` of the first code of each length. */
  readonly valPtr: Int32Array;
  readonly values: Uint8Array;
}

interface Component {
  readonly id: number;
  readonly h: number;
  readonly v: number;
  readonly quantId: number;
  dcTable: number;
  acTable: number;
  pred: number;
}

const MARKER = {
  SOI: 0xd8,
  SOF0: 0xc0,
  SOF1: 0xc1,
  SOF2: 0xc2,
  DHT: 0xc4,
  DRI: 0xdd,
  SOS: 0xda,
  DQT: 0xdb,
  EOI: 0xd9,
} as const;

function buildHuffTable(counts: Uint8Array, values: Uint8Array): HuffTable {
  const minCode = new Int32Array(17);
  const maxCode = new Int32Array(17).fill(-1);
  const valPtr = new Int32Array(17);

  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    const n = counts[length - 1] ?? 0;
    valPtr[length] = k;
    minCode[length] = code;
    code += n;
    k += n;
    maxCode[length] = n > 0 ? code - 1 : -1;
    code <<= 1;
  }
  return { minCode, maxCode, valPtr, values };
}

/**
 * Reads bits out of entropy-coded data.
 *
 * Two JPEG-isms live here. A literal 0xFF in the data is written as `FF 00`, so the
 * stuffed zero is skipped. And any other `FF xx` is a marker, which means the scan
 * has ended -- from which point this feeds zeroes rather than reading past it.
 */
class BitReader {
  readonly #bytes: Uint8Array;
  #at: number;
  #bits = 0;
  #count = 0;
  #ended = false;

  constructor(bytes: Uint8Array, at: number) {
    this.#bytes = bytes;
    this.#at = at;
  }

  get position(): number {
    return this.#at;
  }

  get ended(): boolean {
    return this.#ended;
  }

  bit(): number {
    if (this.#count === 0) {
      if (this.#at >= this.#bytes.length) {
        this.#ended = true;
        return 0;
      }
      let byte = this.#bytes[this.#at++]!;
      if (byte === 0xff) {
        const next = this.#bytes[this.#at] ?? MARKER.EOI;
        if (next === 0x00) {
          this.#at += 1;
        } else {
          // A real marker. Back up so the caller can see it, and stop producing data.
          this.#at -= 1;
          this.#ended = true;
          byte = 0;
        }
      }
      this.#bits = byte;
      this.#count = 8;
    }
    this.#count -= 1;
    return (this.#bits >> this.#count) & 1;
  }

  receive(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) value = (value << 1) | this.bit();
    return value;
  }

  /** Discard part-used bits and step over a restart marker, if one is there. */
  restart(): boolean {
    this.#count = 0;
    this.#ended = false;
    while (this.#at + 1 < this.#bytes.length) {
      if (this.#bytes[this.#at] !== 0xff) {
        this.#at += 1;
        continue;
      }
      const marker = this.#bytes[this.#at + 1]!;
      if (marker >= 0xd0 && marker <= 0xd7) {
        this.#at += 2;
        return true;
      }
      return false;
    }
    return false;
  }

  decode(table: HuffTable): number {
    let code = this.bit();
    for (let length = 1; length <= 16; length++) {
      if (table.maxCode[length]! >= 0 && code <= table.maxCode[length]!) {
        const index = table.valPtr[length]! + code - table.minCode[length]!;
        return table.values[index] ?? 0;
      }
      code = (code << 1) | this.bit();
    }
    return 0;
  }
}

/** Sign-extend an n-bit value the way JPEG's difference coding requires. */
function extend(value: number, n: number): number {
  if (n === 0) return 0;
  return value < 1 << (n - 1) ? value - (1 << n) + 1 : value;
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

export function decodeDc(bytes: Uint8Array): DcImage | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== MARKER.SOI) return null;

  const quant = new Map<number, Int32Array>();
  const dcTables = new Map<number, HuffTable>();
  const acTables = new Map<number, HuffTable>();
  let components: Component[] = [];
  let width = 0;
  let height = 0;
  let restartInterval = 0;

  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === MARKER.EOI) return null;

    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (length < 2) return null;
    const body = i + 4;
    const end = i + 2 + length;
    if (end > bytes.length) return null;

    switch (marker) {
      case MARKER.SOF2:
        return null; // progressive: a different algorithm, and not worth guessing at
      case MARKER.SOF0:
      case MARKER.SOF1: {
        height = (bytes[body + 1]! << 8) | bytes[body + 2]!;
        width = (bytes[body + 3]! << 8) | bytes[body + 4]!;
        const count = bytes[body + 5]!;
        components = [];
        for (let c = 0; c < count; c++) {
          const at = body + 6 + c * 3;
          components.push({
            id: bytes[at]!,
            h: bytes[at + 1]! >> 4,
            v: bytes[at + 1]! & 15,
            quantId: bytes[at + 2]!,
            dcTable: 0,
            acTable: 0,
            pred: 0,
          });
        }
        break;
      }
      case MARKER.DQT: {
        let at = body;
        while (at < end) {
          const precision = bytes[at]! >> 4;
          const id = bytes[at]! & 15;
          at += 1;
          const table = new Int32Array(64);
          for (let k = 0; k < 64; k++) {
            table[k] =
              precision === 0 ? bytes[at + k]! : (bytes[at + 2 * k]! << 8) | bytes[at + 2 * k + 1]!;
          }
          at += precision === 0 ? 64 : 128;
          quant.set(id, table);
        }
        break;
      }
      case MARKER.DHT: {
        let at = body;
        while (at < end) {
          const kind = bytes[at]! >> 4;
          const id = bytes[at]! & 15;
          at += 1;
          const counts = bytes.subarray(at, at + 16);
          at += 16;
          let total = 0;
          for (const n of counts) total += n;
          const values = bytes.slice(at, at + total);
          at += total;
          const table = buildHuffTable(counts, values);
          if (kind === 0) dcTables.set(id, table);
          else acTables.set(id, table);
        }
        break;
      }
      case MARKER.DRI:
        restartInterval = (bytes[body]! << 8) | bytes[body + 1]!;
        break;
      case MARKER.SOS: {
        const count = bytes[body]!;
        for (let c = 0; c < count; c++) {
          const id = bytes[body + 1 + c * 2]!;
          const tables = bytes[body + 2 + c * 2]!;
          const component = components.find((comp) => comp.id === id);
          if (component === undefined) return null;
          component.dcTable = tables >> 4;
          component.acTable = tables & 15;
        }
        return scan(bytes, end, {
          components,
          width,
          height,
          quant,
          dcTables,
          acTables,
          restartInterval,
        });
      }
      default:
        break;
    }
    i = end;
  }
  return null;
}

interface ScanContext {
  readonly components: readonly Component[];
  readonly width: number;
  readonly height: number;
  readonly quant: Map<number, Int32Array>;
  readonly dcTables: Map<number, HuffTable>;
  readonly acTables: Map<number, HuffTable>;
  readonly restartInterval: number;
}

function scan(bytes: Uint8Array, at: number, ctx: ScanContext): DcImage | null {
  const luma = ctx.components[0];
  if (luma === undefined || ctx.width === 0 || ctx.height === 0) return null;

  const hMax = Math.max(...ctx.components.map((c) => c.h));
  const vMax = Math.max(...ctx.components.map((c) => c.v));
  if (hMax === 0 || vMax === 0) return null;

  const mcusAcross = Math.ceil(ctx.width / (8 * hMax));
  const mcusDown = Math.ceil(ctx.height / (8 * vMax));
  const across = mcusAcross * luma.h;
  const down = mcusDown * luma.v;
  if (across * down > 4_000_000) return null; // absurd; refuse rather than churn

  const lumaQuant = ctx.quant.get(luma.quantId);
  if (lumaQuant === undefined) return null;
  const dcQuant = lumaQuant[0] ?? 1;

  const out = new Uint8Array(across * down);
  const reader = new BitReader(bytes, at);
  for (const component of ctx.components) component.pred = 0;

  let sinceRestart = 0;
  for (let my = 0; my < mcusDown; my++) {
    for (let mx = 0; mx < mcusAcross; mx++) {
      if (ctx.restartInterval > 0 && sinceRestart === ctx.restartInterval) {
        if (!reader.restart()) return null;
        for (const component of ctx.components) component.pred = 0;
        sinceRestart = 0;
      }
      sinceRestart += 1;

      for (const component of ctx.components) {
        const dcTable = ctx.dcTables.get(component.dcTable);
        const acTable = ctx.acTables.get(component.acTable);
        if (dcTable === undefined || acTable === undefined) return null;

        for (let by = 0; by < component.v; by++) {
          for (let bx = 0; bx < component.h; bx++) {
            const size = reader.decode(dcTable);
            component.pred += extend(reader.receive(size), size);

            // Read the AC coefficients only to get past them.
            for (let k = 1; k < 64;) {
              const rs = reader.decode(acTable);
              const bits = rs & 15;
              const run = rs >> 4;
              if (bits === 0) {
                if (run !== 15) break; // end of block
                k += 16;
                continue;
              }
              k += run + 1;
              reader.receive(bits);
            }

            if (component === luma) {
              // An inverse DCT of a DC-only block is flat, at DC/8 above the level
              // shift. That constant is the block's average brightness, which is the
              // whole reason this decoder can stop here.
              const value = (component.pred * dcQuant) / 8 + 128;
              const x = mx * luma.h + bx;
              const y = my * luma.v + by;
              out[y * across + x] = clamp(Math.round(value));
            }
          }
        }
      }
    }
    if (reader.ended && my < mcusDown - 1 && ctx.restartInterval === 0) {
      // Truncated file. What was decoded is still a picture, but a partial one, and
      // a hash of half an image would compare as a different document.
      return null;
    }
  }

  // The block grid is padded out to whole MCUs; trim to what the image covers.
  const usedAcross = Math.min(across, Math.ceil(ctx.width / 8));
  const usedDown = Math.min(down, Math.ceil(ctx.height / 8));
  if (usedAcross === across && usedDown === down) {
    return { luma: out, across, down, width: ctx.width, height: ctx.height };
  }
  const trimmed = new Uint8Array(usedAcross * usedDown);
  for (let y = 0; y < usedDown; y++) {
    trimmed.set(out.subarray(y * across, y * across + usedAcross), y * usedAcross);
  }
  return {
    luma: trimmed,
    across: usedAcross,
    down: usedDown,
    width: ctx.width,
    height: ctx.height,
  };
}
