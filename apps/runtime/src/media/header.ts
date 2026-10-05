// Image size from the header, before any decoding (runtime.yaml#files.image.limits, executability MP-29): a
// decompression bomb is refused by its declared dimensions, so the codec never allocates its pixels.
import type { FileMime } from "../files/sniff.js";

export type ImageMime = Extract<FileMime, "image/jpeg" | "image/png" | "image/webp">;
export const IMAGE_MIMES: readonly ImageMime[] = ["image/jpeg", "image/png", "image/webp"];
export const isImageMime = (m: string | null): m is ImageMime => IMAGE_MIMES.includes(m as ImageMime);

/** Widths of the stored WebP variants; the largest variant is min(width, 1600). */
export const IMAGE_WIDTHS = [480, 960, 1600] as const;
/** Limits of an upload: ≤ 8000 px on a side and ≤ 40 Mpx (else 413). */
export const MAX_IMAGE_SIDE = 8000;
export const MAX_IMAGE_PIXELS = 40_000_000;

export interface ImageSize {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => ((b[i] as number) << 8) | (b[i + 1] as number);
const u16le = (b: Uint8Array, i: number) => (b[i] as number) | ((b[i + 1] as number) << 8);
const u24le = (b: Uint8Array, i: number) => u16le(b, i) | ((b[i + 2] as number) << 16);
const u32be = (b: Uint8Array, i: number) =>
  (((b[i] as number) << 24) >>> 0) +
  (((b[i + 1] as number) << 16) | ((b[i + 2] as number) << 8) | (b[i + 3] as number));
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

function jpegSize(b: Uint8Array): ImageSize | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1] as number;
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    if (m === 0xd9 || m === 0xda) return null;
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function pngSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || ascii(b, 12, 16) !== "IHDR") return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function webpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 16);
  if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits =
      (b[21] as number) | ((b[22] as number) << 8) | ((b[23] as number) << 16) | ((b[24] as number) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** Declared size of a JPEG, PNG or WebP; null when the header cannot be read. */
export function imageSize(b: Uint8Array, mime: ImageMime): ImageSize | null {
  const s = mime === "image/jpeg" ? jpegSize(b) : mime === "image/png" ? pngSize(b) : webpSize(b);
  return s && s.width > 0 && s.height > 0 ? s : null;
}

/** true when the declared size is within MAX_IMAGE_SIDE and MAX_IMAGE_PIXELS. */
export const withinLimits = (s: ImageSize) =>
  s.width <= MAX_IMAGE_SIDE && s.height <= MAX_IMAGE_SIDE && s.width * s.height <= MAX_IMAGE_PIXELS;

/** EXIF orientation (1–8) of a JPEG; 1 when absent. Pixels are turned upright before EXIF is dropped. */
export function jpegOrientation(b: Uint8Array): number {
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const m = b[i + 1] as number;
    if (m === 0xda || m === 0xd9) break;
    const len = u16be(b, i + 2);
    if (m === 0xe1 && ascii(b, i + 4, i + 10) === "Exif\0\0") {
      const t = i + 10;
      const le = ascii(b, t, t + 2) === "II";
      const r16 = (k: number) => (le ? u16le(b, k) : u16be(b, k));
      const r32 = (k: number) => (le ? (u16le(b, k) | (u16le(b, k + 2) << 16)) >>> 0 : u32be(b, k));
      const ifd = t + r32(t + 4);
      if (ifd + 2 > b.length) return 1;
      const n = r16(ifd);
      for (let e = 0; e < n; e++) {
        const at = ifd + 2 + e * 12;
        if (at + 12 > b.length) break;
        if (r16(at) === 0x0112) {
          const v = r16(at + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}
