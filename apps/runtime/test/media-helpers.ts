// Generated test images for the image pipeline (M2-47): photo-like RGBA, JPEG with an EXIF block (orientation and a
// GPS marker), PNG headers of decompression bombs. Encoded with the same WASM codecs the runtime uses.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);

/** A deterministic photo-like picture: smooth gradients plus a soft pattern (compresses like a photo, not like noise). */
export function photo(width: number, height: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const wave = Math.sin(x / 37) * Math.cos(y / 53) * 40;
      d[i] = 120 + (x / width) * 100 + wave;
      d[i + 1] = 90 + (y / height) * 120 - wave;
      d[i + 2] = 160 - (x / width) * 80 + wave / 2;
      d[i + 3] = 255;
    }
  }
  return d;
}

let jpegEnc: Promise<typeof import("@jsquash/jpeg/encode.js")> | undefined;

export async function encodeJpeg(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Uint8Array> {
  jpegEnc ??= (async () => {
    const m = await import("@jsquash/jpeg/encode.js");
    await m.init(
      await WebAssembly.compile(readFileSync(req.resolve("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm"))),
    );
    return m;
  })();
  const enc = await jpegEnc;
  return new Uint8Array(
    await enc.default({ data, width, height, colorSpace: "srgb" } as never, { quality: 85 }),
  );
}

/** Marker text written into the EXIF GPS block; must not survive processing. */
export const GPS_MARKER = "WZGPS-55.7558N-37.6173E";

/** APP1 Exif segment (big-endian TIFF): IFD0 {Orientation, GPSInfo → GPS IFD {GPSMapDatum = marker}}. */
function exifSegment(orientation: number): Uint8Array {
  const text = new TextEncoder().encode(`${GPS_MARKER}\0`);
  const tiff: number[] = [];
  const u16 = (v: number) => tiff.push((v >> 8) & 255, v & 255);
  const u32 = (v: number) => tiff.push((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
  // Header: MM, 42, IFD0 at 8.
  tiff.push(0x4d, 0x4d);
  u16(42);
  u32(8);
  // IFD0 at 8: 2 entries (8 + 2 + 24 + 4 = 38).
  u16(2);
  u16(0x0112); // Orientation, SHORT, 1
  u16(3);
  u32(1);
  u16(orientation);
  u16(0);
  u16(0x8825); // GPSInfo IFD pointer, LONG, 1 → 38
  u16(4);
  u32(1);
  u32(38);
  u32(0);
  // GPS IFD at 38: 1 entry (38 + 2 + 12 + 4 = 56), GPSMapDatum ASCII at 56.
  u16(1);
  u16(0x0012);
  u16(2);
  u32(text.length);
  u32(56);
  u32(0);
  tiff.push(...text);
  const body = [..."Exif\0\0"].map((c) => c.charCodeAt(0)).concat(tiff);
  const len = body.length + 2;
  return Uint8Array.from([0xff, 0xe1, (len >> 8) & 255, len & 255, ...body]);
}

/** JPEG bytes with an EXIF segment right after SOI. */
export function withExif(jpeg: Uint8Array, orientation = 1): Uint8Array {
  const seg = exifSegment(orientation);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(seg, 2);
  out.set(jpeg.subarray(2), 2 + seg.length);
  return out;
}

/** A PNG that declares width × height (signature + IHDR + a tiny IDAT + IEND; CRCs are not checked by the header). */
export function pngBomb(width: number, height: number): Uint8Array {
  const b = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const u32 = (v: number) => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
  b.push(
    ...u32(13),
    ..."IHDR".split("").map((c) => c.charCodeAt(0)),
    ...u32(width),
    ...u32(height),
    8,
    6,
    0,
    0,
    0,
  );
  b.push(...u32(0));
  b.push(...u32(2), ..."IDAT".split("").map((c) => c.charCodeAt(0)), 0x78, 0x9c, ...u32(0));
  b.push(...u32(0), ..."IEND".split("").map((c) => c.charCodeAt(0)), ...u32(0));
  return Uint8Array.from(b);
}

/** Width and height of a WebP (VP8, VP8L or VP8X header). */
export function webpSize(b: Uint8Array): { width: number; height: number } {
  const at = (i: number) => b[i] ?? 0;
  const tag = String.fromCharCode(...b.subarray(12, 16));
  if (tag === "VP8X")
    return {
      width: (at(24) | (at(25) << 8) | (at(26) << 16)) + 1,
      height: (at(27) | (at(28) << 8) | (at(29) << 16)) + 1,
    };
  if (tag === "VP8 ")
    return { width: (at(26) | (at(27) << 8)) & 0x3fff, height: (at(28) | (at(29) << 8)) & 0x3fff };
  const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

export const ascii = (b: Uint8Array) => Buffer.from(b).toString("latin1");
