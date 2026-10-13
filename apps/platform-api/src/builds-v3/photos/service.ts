// V4-16 photos of a system: the replacement for a photo slot of the draft from the semantic library (V4-10, only through
// its public search) by the meaning of the slot — the texts next to it on its page and the brief — or by the owner's
// words, plus the owner's own photos. An owner photo goes through the image pipeline of the library (WebP 480/960/1600,
// no EXIF) into the system's file storage (Cloud.ru, РФ) under a random id; it is listed only in this system's own
// index and never enters the shared library manifest the search reads. The swap itself is an instant edit of V4-15
// (POST /edit/literals): the CSS grade of the direction covers every /_wizard/photos/ image of the site.
import { randomUUID } from "node:crypto";
import type { Candidate } from "@wizard/agents/stock";
import {
  type FileStorage,
  libraryPhotoFile,
  libraryPhotoId,
  PhotoLibraryError,
  storeLibraryPhoto,
} from "@wizard/runtime";
import { ApiError } from "../../errors.js";
import type { LiteralView } from "../edit/literals.js";

/** Photos offered for one slot (acceptance: 12–20). */
export const PHOTO_CHOICES = 20;
/** An owner upload is at most this large (before re-encoding). */
export const OWNER_PHOTO_MAX_BYTES = 15 * 1024 * 1024;
/** The owner photos a system keeps in its own library (oldest dropped from the list beyond it). */
const OWNER_PHOTOS_MAX = 60;
const PREFIX = "wz_photos";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PhotoChoice {
  /** Library id (uuid) of the photo: the path of the slot keeps its width, the id changes. */
  id: string;
  source: "owner" | "library";
  /** 480 px preview for the panel (platform origin). */
  thumb: string;
  author?: string;
  pageUrl?: string;
  provider?: string;
}

export interface OwnerPhoto {
  id: string;
  width: number;
  height: number;
  uploadedAt: string;
}

export interface PhotoSearch {
  search(text: string, o: { limit?: number }): Promise<Candidate[]>;
}

const indexKey = (systemId: string) => `${PREFIX}/${libraryPhotoId(`owner-index:${systemId}`)}`;

/** The owner photos of a system, newest first (its own index in the file storage). */
export async function ownerPhotos(files: FileStorage, systemId: string): Promise<OwnerPhoto[]> {
  const obj = await files.get(indexKey(systemId));
  if (!obj) return [];
  try {
    const list = JSON.parse(new TextDecoder().decode(obj.data)) as OwnerPhoto[];
    return Array.isArray(list) ? list.filter((p) => UUID_RE.test(p.id)) : [];
  } catch {
    return [];
  }
}

/**
 * The search text of a photo slot: the owner's words when given; else the texts just before the photo on its page
 * (nearest first, the same file of the draft) and the brief's first goal and audience.
 */
export function slotQuery(o: {
  ref: string | null;
  literals: readonly LiteralView[];
  brief: { goals: { text: string }[]; audience: string } | null;
  name: string;
  words?: string;
}): string {
  const words = o.words?.trim();
  if (words) return words.slice(0, 200);
  const parts: string[] = [];
  const at = o.ref ? o.literals.find((l) => l.ref === o.ref) : undefined;
  if (at) {
    const ordinal = (r: string) => Number(r.split(":")[1] ?? 0);
    const key = at.ref.split(":")[0];
    const near = o.literals
      .filter((l) => l.kind === "text" && l.ref.startsWith(`${key}:`) && ordinal(l.ref) < ordinal(at.ref))
      .sort((a, b) => ordinal(b.ref) - ordinal(a.ref))
      .slice(0, 2)
      .map((l) => l.value);
    parts.push(...near);
  }
  if (o.brief?.goals[0]?.text) parts.push(o.brief.goals[0].text);
  if (o.brief?.audience) parts.push(o.brief.audience);
  if (!parts.length) parts.push(o.name);
  return parts.join(". ").replace(/\s+/g, " ").slice(0, 300);
}

/** Owner photos first, then the library by meaning, without repeats; at most PHOTO_CHOICES. */
export async function photoChoices(o: {
  systemId: string;
  files: FileStorage;
  search: PhotoSearch | null;
  query: string;
  thumb(id: string): string;
}): Promise<{ query: string; photos: PhotoChoice[]; searched: boolean }> {
  const own = await ownerPhotos(o.files, o.systemId);
  const out: PhotoChoice[] = own.map((p) => ({ id: p.id, source: "owner", thumb: o.thumb(p.id) }));
  let searched = false;
  if (o.search) {
    try {
      const found = await o.search.search(o.query, { limit: PHOTO_CHOICES });
      searched = true;
      for (const c of found) {
        if (out.length >= PHOTO_CHOICES) break;
        if (out.some((x) => x.id === c.entry.file)) continue;
        out.push({
          id: c.entry.file,
          source: "library",
          thumb: o.thumb(c.entry.file),
          author: c.entry.author,
          pageUrl: c.entry.pageUrl,
          provider: c.entry.provider,
        });
      }
    } catch {
      // The library is not loaded here yet (the SigLIP tower, CI shards): the owner's own photos are still offered.
    }
  }
  return { query: o.query, photos: out.slice(0, PHOTO_CHOICES), searched };
}

/** The 480 px preview of a library or owner photo (null — none). */
export async function photoThumb(files: FileStorage, id: string): Promise<Uint8Array | null> {
  if (!UUID_RE.test(id)) return null;
  return (await libraryPhotoFile(files, id, 480))?.body ?? null;
}

/** An owner photo: into the system's library (re-encoded, no EXIF), listed first in its own index. */
export async function storeOwnerPhoto(
  files: FileStorage,
  systemId: string,
  bytes: Uint8Array,
  o: { now?: Date; process?: Parameters<typeof storeLibraryPhoto>[2]["process"] } = {},
): Promise<OwnerPhoto> {
  if (bytes.byteLength > OWNER_PHOTO_MAX_BYTES)
    throw new ApiError("PAYLOAD_TOO_LARGE", "Фото больше 15 МБ — уменьшите его и загрузите снова");
  let stored: Awaited<ReturnType<typeof storeLibraryPhoto>>;
  try {
    stored = await storeLibraryPhoto(files, bytes, {
      // A random source: the id is never shared with another system or the stock library.
      source: `owner:${systemId}:${randomUUID()}`,
      ...(o.now ? { now: o.now } : {}),
      ...(o.process ? { process: o.process } : {}),
    });
  } catch (e) {
    if (e instanceof PhotoLibraryError) {
      if (e.code === "UNSUPPORTED")
        throw new ApiError(
          "UNSUPPORTED_MEDIA_TYPE",
          "Подойдёт фото JPEG или PNG (HEIC с iPhone браузер обычно переводит в JPEG сам)",
        );
      if (e.code === "TOO_LARGE")
        throw new ApiError("PAYLOAD_TOO_LARGE", "Фото слишком большое по размеру в пикселях — уменьшите его");
      if (e.code === "UNREADABLE")
        throw new ApiError("VALIDATION_FAILED", "Фото не читается — попробуйте другое");
      throw new ApiError("LLM_UNAVAILABLE", "Обработка фото занята — попробуйте через минуту");
    }
    throw e;
  }
  const photo: OwnerPhoto = {
    id: stored.id,
    width: stored.width,
    height: stored.height,
    uploadedAt: (o.now ?? new Date()).toISOString(),
  };
  const list = [photo, ...(await ownerPhotos(files, systemId))].slice(0, OWNER_PHOTOS_MAX);
  const data = new TextEncoder().encode(JSON.stringify(list));
  await files.put(indexKey(systemId), data, {
    name: "owner-photos.json",
    mime: "application/json",
    size: data.byteLength,
    entity: "_owner_photos",
    field: "index",
    uploadedBy: null,
    uploadedAt: photo.uploadedAt,
  });
  return photo;
}
