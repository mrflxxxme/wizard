// Logo and reference screenshots of «Три направления» (V3-09): the uploaded file becomes dominant colours here and is
// dropped — nothing of it is stored but the principle line (GZ-03). PNG is decoded by pngjs (pure JS) after the header
// check of its size; SVG is read as text for its colours, never rendered or served back. Other formats are refused.
import { type ColorShare, colorsInText, dominantColors } from "@wizard/agents/builder";
import { PNG } from "pngjs";
import { ApiError } from "../errors.js";

/** Largest accepted logo or screenshot, bytes. */
export const REFERENCE_MAX_BYTES = 2 * 1024 * 1024;
/** Largest side of a PNG, px (≤ 16.7 MP decoded: ~67 MB RGBA at most). */
export const REFERENCE_MAX_SIDE = 4096;
export const REFERENCE_MIN_SIDE = 16;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type ReferenceImageKind = "png" | "svg";

/** The kind of an uploaded image by its bytes (not its name or declared type); null — unsupported. */
export function sniffReferenceImage(bytes: Uint8Array): ReferenceImageKind | null {
  if (bytes.length >= 8 && PNG_MAGIC.every((b, i) => bytes[i] === b)) return "png";
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 1024));
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head))
    return "svg";
  return null;
}

/** Width and height from the PNG header (IHDR), before any decoding. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

const unsupported = () =>
  new ApiError("UNSUPPORTED_MEDIA_TYPE", "Пришлите картинку в PNG (логотип — можно в SVG)");

/** Dominant colours of an uploaded logo or screenshot; limits and format errors are Russian ApiErrors. */
export function referenceImageColors(bytes: Uint8Array, opts: { allowSvg: boolean }): ColorShare[] {
  if (bytes.byteLength > REFERENCE_MAX_BYTES)
    throw new ApiError("PAYLOAD_TOO_LARGE", "Файл слишком большой: можно загрузить до 2 МБ");
  const kind = sniffReferenceImage(bytes);
  if (kind === "svg") {
    if (!opts.allowSvg) throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "Скриншот пришлите в PNG");
    return colorsInText(new TextDecoder().decode(bytes));
  }
  if (kind !== "png") throw unsupported();
  const size = pngSize(bytes);
  if (!size || size.width < REFERENCE_MIN_SIDE || size.height < REFERENCE_MIN_SIDE)
    throw new ApiError("VALIDATION_FAILED", "Картинка слишком маленькая: нужно хотя бы 16×16 точек");
  if (size.width > REFERENCE_MAX_SIDE || size.height > REFERENCE_MAX_SIDE)
    throw new ApiError(
      "PAYLOAD_TOO_LARGE",
      `Картинка слишком большая: до ${REFERENCE_MAX_SIDE} точек по стороне`,
    );
  let png: PNG;
  try {
    png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    throw new ApiError("VALIDATION_FAILED", "Не получилось прочитать картинку: файл повреждён");
  }
  return dominantColors(png.data, png.width, png.height);
}
