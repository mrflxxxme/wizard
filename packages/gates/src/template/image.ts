// Perceptual hashes of page screenshots for the template gate (V3-14, D77_v3 (6)): pHash (DCT of a 32×32 grayscale
// thumbnail, 8×8 low frequencies against their median) and dHash (horizontal gradients of a 9×8 thumbnail). Pure code
// over a decoded RGBA raster — no image library and no model; the caller decodes the PNG (platform-api: pngjs).

/** An 8-bit RGBA raster: width × height × 4 bytes, row-major (a decoded screenshot). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Bits of a hash (both hashes are 64-bit, written as 16 hex digits). */
export const HASH_BITS = 64;

/** Source spans of each target cell of a box (area-average) resample along one axis; weights sum to 1. */
function axisWeights(n: number, t: number): { from: number; w: Float64Array }[] {
  const out: { from: number; w: Float64Array }[] = [];
  const step = n / t;
  for (let i = 0; i < t; i++) {
    const start = i * step;
    const end = (i + 1) * step;
    const from = Math.floor(start);
    const to = Math.min(n, Math.ceil(end));
    const w = new Float64Array(Math.max(1, to - from));
    for (let s = from; s < to; s++) w[s - from] = (Math.min(end, s + 1) - Math.max(start, s)) / step;
    out.push({ from, w });
  }
  return out;
}

/**
 * Grayscale thumbnail tw × th of an image: Rec. 601 luminance composited over white, box-filtered (each cell is the
 * mean of the source area it covers). Rows are reduced first, so a tall full-page screenshot never needs a full-size
 * float copy.
 */
export function grayThumb(img: RgbaImage, tw: number, th: number): Float64Array {
  const { width, height, data } = img;
  if (width < 1 || height < 1) throw new Error("grayThumb: empty image");
  if (data.length < width * height * 4) throw new Error("grayThumb: data shorter than width × height × 4");
  const xw = axisWeights(width, tw);
  const yw = axisWeights(height, th);
  const rows = new Float64Array(height * tw);
  for (let y = 0; y < height; y++) {
    const base = y * width * 4;
    for (let tx = 0; tx < tw; tx++) {
      const { from, w } = xw[tx] as { from: number; w: Float64Array };
      let sum = 0;
      for (let k = 0; k < w.length; k++) {
        const i = base + (from + k) * 4;
        const a = (data[i + 3] as number) / 255;
        const lum =
          0.299 * (data[i] as number) + 0.587 * (data[i + 1] as number) + 0.114 * (data[i + 2] as number);
        sum += (w[k] as number) * (lum * a + 255 * (1 - a));
      }
      rows[y * tw + tx] = sum;
    }
  }
  const out = new Float64Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const { from, w } = yw[ty] as { from: number; w: Float64Array };
    for (let tx = 0; tx < tw; tx++) {
      let sum = 0;
      for (let k = 0; k < w.length; k++) sum += (w[k] as number) * (rows[(from + k) * tw + tx] as number);
      out[ty * tw + tx] = sum;
    }
  }
  return out;
}

const PHASH_SIZE = 32;
const PHASH_LOW = 8;
/** cos(π/N · (n + ½) · k) for the low frequencies k < 8 of a 32-point DCT-II. */
const COS = (() => {
  const t = new Float64Array(PHASH_LOW * PHASH_SIZE);
  for (let k = 0; k < PHASH_LOW; k++)
    for (let n = 0; n < PHASH_SIZE; n++)
      t[k * PHASH_SIZE + n] = Math.cos((Math.PI / PHASH_SIZE) * (n + 0.5) * k);
  return t;
})();

/** 64 bits (row-major, most significant first) as 16 hex digits. */
function toHex(bits: readonly boolean[]): string {
  let out = "";
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = (bits[i] ? 8 : 0) | (bits[i + 1] ? 4 : 0) | (bits[i + 2] ? 2 : 0) | (bits[i + 3] ? 1 : 0);
    out += nibble.toString(16);
  }
  return out;
}

/** The 8×8 low-frequency block of the 2-D DCT-II of a 32×32 thumbnail (row-major, DC first). */
export function lowDct(thumb: Float64Array): Float64Array {
  // Rows: 32 rows × 8 coefficients; then columns: 8 × 8.
  const rows = new Float64Array(PHASH_SIZE * PHASH_LOW);
  for (let y = 0; y < PHASH_SIZE; y++)
    for (let k = 0; k < PHASH_LOW; k++) {
      let s = 0;
      for (let n = 0; n < PHASH_SIZE; n++)
        s += (thumb[y * PHASH_SIZE + n] as number) * (COS[k * PHASH_SIZE + n] as number);
      rows[y * PHASH_LOW + k] = s;
    }
  const out = new Float64Array(PHASH_LOW * PHASH_LOW);
  for (let ky = 0; ky < PHASH_LOW; ky++)
    for (let kx = 0; kx < PHASH_LOW; kx++) {
      let s = 0;
      for (let n = 0; n < PHASH_SIZE; n++)
        s += (rows[n * PHASH_LOW + kx] as number) * (COS[ky * PHASH_SIZE + n] as number);
      out[ky * PHASH_LOW + kx] = s;
    }
  return out;
}

/**
 * pHash: the 64 low DCT frequencies of a 32×32 grayscale thumbnail, each bit «above the median of the block» (the
 * classic phash of pHash.org / imagehash). Robust to text and colour changes that keep the composition.
 */
export function pHash(img: RgbaImage): string {
  const low = lowDct(grayThumb(img, PHASH_SIZE, PHASH_SIZE));
  const sorted = [...low].sort((a, b) => a - b);
  const median = ((sorted[31] as number) + (sorted[32] as number)) / 2;
  return toHex([...low].map((v) => v > median));
}

/** dHash: a 9×8 grayscale thumbnail, each bit «the right neighbour is brighter» (64 horizontal gradients). */
export function dHash(img: RgbaImage): string {
  const g = grayThumb(img, 9, 8);
  const bits: boolean[] = [];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) bits.push((g[y * 9 + x + 1] as number) > (g[y * 9 + x] as number) + 0.5);
  return toHex(bits);
}

/** Number of differing bits of two hex hashes of the same length. */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) throw new Error("hamming: hashes of different length");
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = Number.parseInt(a[i] as string, 16) ^ Number.parseInt(b[i] as string, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/**
 * Similarity of two 64-bit hashes, 0…1: 1 − distance / 32, so unrelated images (≈ 32 bits apart) score ≈ 0.
 * `polarity` (pHash): a colour-inverted copy flips every AC bit, so the distance is min(d, 64 − d) — a dark clone of
 * a light layout is still the same layout.
 */
export function hashSimilarity(a: string, b: string, polarity = false): number {
  const d = hamming(a, b);
  const dist = polarity ? Math.min(d, HASH_BITS - d) : d;
  return Math.max(0, 1 - dist / (HASH_BITS / 2));
}
