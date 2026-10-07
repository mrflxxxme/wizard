// Platform photo library (B2-38, product.yaml#decisions.D61_stock_photos): copies of stock photos (Pexels, Pixabay) the
// builder picked for landings, kept in the same object storage as file fields under the reserved prefix wz_photos/
// (never a system schema app_<key>_<env>, so a system purge or the upload sweep does not touch it). A copy is decoded and
// re-encoded by the image pipeline (WebP 480/960/1600, no EXIF) and shared by every system that uses the same photo.
// The runtime serves it publicly from the system's own origin: GET /_wizard/photos/:id/:width — the visitor's browser
// never talks to a stock (152-ФЗ: no foreign hosts on the page).
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { RuntimeHonoEnv } from "../http/context.js";
import { notFoundPage } from "../http/errors.js";
import { IMAGE_WIDTHS, isImageMime } from "../media/header.js";
import type { ProcessedImage } from "../media/pipeline.js";
import { ImageError, imageProcessor } from "../media/processor.js";
import { IMMUTABLE } from "../preview/headers.js";
import { sniffMime } from "./sniff.js";
import type { FileMeta, FileStorage } from "./storage.js";

/** Key prefix of the library in the file storage (shape <prefix>/<uuid>[.w<slot>] of FILE_KEY_RE). */
export const PHOTO_LIBRARY_PREFIX = "wz_photos";
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Stable library id of a stock photo («pexels:12345»): the same photo is stored once for all systems. */
export function libraryPhotoId(source: string): string {
  const h = createHash("sha256").update(`wz-photo:${source}`).digest("hex");
  // UUID shape (version nibble 5, RFC 4122 variant) so the key fits the storage key format.
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const keyOf = (id: string) => `${PHOTO_LIBRARY_PREFIX}/${id}`;
const variantKey = (id: string, slot: number) => `${keyOf(id)}.w${slot}`;

export interface LibraryPhoto {
  id: string;
  width: number;
  height: number;
  /** false — the copy was already in the library. */
  stored: boolean;
}

export type LibraryPhotoError = "UNSUPPORTED" | "TOO_LARGE" | "UNREADABLE" | "BUSY" | "TIMEOUT";

export class PhotoLibraryError extends Error {
  override name = "PhotoLibraryError";
  constructor(readonly code: LibraryPhotoError) {
    super(code);
  }
}

/**
 * Puts a downloaded stock photo into the library: JPEG, PNG or WebP by signature, decoded and re-encoded into WebP
 * variants (EXIF and other metadata dropped). Idempotent by `source`.
 */
export async function storeLibraryPhoto(
  storage: FileStorage,
  bytes: Uint8Array,
  o: {
    source: string;
    now?: Date;
    process?: (b: Uint8Array, mime: "image/jpeg" | "image/png" | "image/webp") => Promise<ProcessedImage>;
  },
): Promise<LibraryPhoto> {
  const id = libraryPhotoId(o.source);
  const have = await storage.head(keyOf(id));
  if (have?.image) return { id, width: have.image.width, height: have.image.height, stored: false };
  const mime = sniffMime(bytes);
  if (!isImageMime(mime)) throw new PhotoLibraryError("UNSUPPORTED");
  let img: ProcessedImage;
  try {
    img = await (o.process ?? ((b, m) => imageProcessor().process(b, m)))(bytes, mime);
  } catch (e) {
    if (e instanceof ImageError) throw new PhotoLibraryError(e.code);
    throw e;
  }
  const [largest, ...smaller] = img.variants;
  if (!largest) throw new PhotoLibraryError("UNREADABLE");
  const common = {
    mime: "image/webp" as const,
    entity: "_photo_library",
    field: "photo",
    uploadedBy: null,
    uploadedAt: (o.now ?? new Date()).toISOString(),
  };
  for (const v of smaller)
    await storage.put(variantKey(id, v.slot), v.data, {
      ...common,
      name: `${id}-${v.width}.webp`,
      size: v.data.byteLength,
    });
  const meta: FileMeta = {
    ...common,
    name: `${id}.webp`,
    size: largest.data.byteLength,
    image: { width: img.width, height: img.height, variants: smaller.map((v) => v.slot) },
  };
  // The largest variant goes last: its metadata marks a complete copy (head above).
  await storage.put(keyOf(id), largest.data, meta);
  return { id, width: img.width, height: img.height, stored: true };
}

/** Id and size of a library copy; null — no complete copy. */
export async function libraryPhoto(
  storage: FileStorage,
  id: string,
): Promise<{ id: string; width: number; height: number } | null> {
  if (!ID_RE.test(id)) return null;
  const meta = await storage.head(keyOf(id));
  return meta?.image ? { id, width: meta.image.width, height: meta.image.height } : null;
}

/**
 * Index of the photo library filled from CI (B2-43; format and merging: @wizard/agents stock/library.ts): a JSON
 * object next to the copies under a fixed id. It has no image metadata, so the public photo route never serves it.
 */
export const PHOTO_LIBRARY_INDEX_ID = libraryPhotoId("library-index:v1");

/** Bytes of the library index; null — not written yet. */
export async function readLibraryIndex(storage: FileStorage): Promise<Uint8Array | null> {
  return (await storage.get(keyOf(PHOTO_LIBRARY_INDEX_ID)))?.data ?? null;
}

/** Writes the library index (whole, replacing the previous one). */
export async function writeLibraryIndex(storage: FileStorage, json: string, now = new Date()): Promise<void> {
  const data = new TextEncoder().encode(json);
  await storage.put(keyOf(PHOTO_LIBRARY_INDEX_ID), data, {
    name: "photo-library-index.json",
    mime: "application/json",
    size: data.byteLength,
    entity: "_photo_library",
    field: "index",
    uploadedBy: null,
    uploadedAt: now.toISOString(),
  });
}

/** GET /_wizard/photos/:id/:width — a library photo, public and immutable (the bytes of an id never change). */
export function photoLibraryRoutes(storage: FileStorage | null): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.get("/:id/:width", async (c) => {
    const id = c.req.param("id");
    const width = Number(c.req.param("width"));
    if (!storage || !ID_RE.test(id) || !IMAGE_WIDTHS.includes(width as never)) return notFoundPage();
    const meta = await storage.head(keyOf(id));
    if (!meta?.image) return notFoundPage();
    const obj = await storage.get(meta.image.variants.includes(width) ? variantKey(id, width) : keyOf(id));
    if (obj?.meta.mime !== "image/webp") return notFoundPage();
    return new Response(obj.data as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(obj.data.byteLength),
        "Content-Disposition": "inline",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": IMMUTABLE,
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  });
  return app;
}
