// Upload pipeline of an image field (runtime.yaml#files.image, M2-47): decode → upright by EXIF orientation → WebP
// variants 480/960/1600 (never upscaled). Re-encoding drops EXIF (geotag) and any other metadata. Runs in a worker
// thread (media/worker.ts) with codecs injected, so it is testable without one.
import { IMAGE_WIDTHS, type ImageMime, jpegOrientation } from "./header.js";
import { downscale, orient, type Rgba } from "./pixels.js";

export interface Codecs {
  decode(bytes: Uint8Array, mime: ImageMime): Promise<Rgba>;
  encodeWebp(img: Rgba, quality: number): Promise<Uint8Array>;
}

export interface ImageVariant {
  /** Slot of IMAGE_WIDTHS the variant serves; the largest variant has slot 1600. */
  slot: number;
  width: number;
  height: number;
  data: Uint8Array;
}

export interface ProcessedImage {
  /** Upright size of the largest variant. */
  width: number;
  height: number;
  /** Largest first; at most one per slot, none wider than the source. */
  variants: ImageVariant[];
}

/** Largest variant budget (M2-47 acceptance: ≤ 400 КБ); quality steps down until it fits. */
export const LARGEST_MAX_BYTES = 400 * 1024;
const QUALITIES = [78, 68, 58, 48, 38];

export async function processImage(
  bytes: Uint8Array,
  mime: ImageMime,
  codecs: Codecs,
): Promise<ProcessedImage> {
  const decoded = await codecs.decode(bytes, mime);
  const upright = orient(decoded, mime === "image/jpeg" ? jpegOrientation(bytes) : 1);
  const largestSlot = IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1] as number;
  const fit = (w: number) => {
    const width = Math.min(w, upright.width);
    return { width, height: Math.max(1, Math.round((upright.height * width) / upright.width)) };
  };
  const variants: ImageVariant[] = [];
  // Largest first, then smaller from the previous result (cheaper, same quality for area averaging).
  let prev: Rgba = upright;
  const top = fit(largestSlot);
  prev = downscale(prev, top.width, top.height);
  let data: Uint8Array = new Uint8Array();
  for (const q of QUALITIES) {
    data = await codecs.encodeWebp(prev, q);
    if (data.byteLength <= LARGEST_MAX_BYTES) break;
  }
  variants.push({ slot: largestSlot, width: top.width, height: top.height, data });
  for (const slot of [...IMAGE_WIDTHS].reverse().slice(1)) {
    if (slot >= upright.width) continue;
    const s = fit(slot);
    prev = downscale(prev, s.width, s.height);
    variants.push({
      slot,
      width: s.width,
      height: s.height,
      data: await codecs.encodeWebp(prev, QUALITIES[0] as number),
    });
  }
  return { width: top.width, height: top.height, variants };
}
