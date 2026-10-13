// V4-16 routes of the photos of a system (the owner's session): GET /systems/:id/photos?ref=&q= — the choice for a photo
// slot of the draft (the owner's photos, then the library by the slot's meaning or the owner's words; viewer);
// GET /systems/:id/photos/:photo/thumb — its 480 px preview; POST /systems/:id/photos — an owner photo into the
// system's own library (editor). The swap of the slot is the instant edit of V4-15 (POST /edit/literals).

import type { FileStorage } from "@wizard/runtime";
import { Hono } from "hono";
import { getLatestBrief } from "../../briefs/store.js";
import { ApiError, invalid, notFound } from "../../errors.js";
import { type AppEnv, checkOrgAccess, isUuid } from "../../http/auth.js";
import { draftLiterals, type EditDeps } from "../edit/literals.js";
import {
  OWNER_PHOTO_MAX_BYTES,
  type PhotoSearch,
  photoChoices,
  photoThumb,
  slotQuery,
  storeOwnerPhoto,
} from "./service.js";

const REF_RE = /^[0-9a-f]{8}:\d{1,7}$/;

export interface PhotoRoutesDeps extends Pick<EditDeps, "db" | "blobs"> {
  /** The shared file storage of systems (wz_photos/: the library copies and the owners' photos). */
  files(): FileStorage;
  /** The semantic library (V4-10 public search); null — not available in this process. */
  search(): PhotoSearch | null;
}

export function photoRoutes(d: PhotoRoutesDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const system = async (id: string) => {
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .select(["id", "org_id", "name", "draft_revision"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    return s;
  };

  r.get("/systems/:id/photos", async (c) => {
    const s = await system(c.req.param("id"));
    checkOrgAccess(c.get("user"), s.org_id, "viewer", "Система");
    const ref = c.req.query("ref") ?? null;
    if (ref !== null && !REF_RE.test(ref)) throw invalid("Неверная ссылка на фото");
    const words = (c.req.query("q") ?? "").slice(0, 200);
    const [literals, brief] = await Promise.all([
      ref && !words.trim() && s.draft_revision > 0
        ? draftLiterals(d, s, s.draft_revision).catch(() => [])
        : Promise.resolve([]),
      words.trim() ? Promise.resolve(null) : getLatestBrief(d.db, s.id),
    ]);
    const query = slotQuery({ ref, literals, brief: brief?.brief ?? null, name: s.name, words });
    const out = await photoChoices({
      systemId: s.id,
      files: d.files(),
      search: d.search(),
      query,
      thumb: (id) => `/api/v1/systems/${s.id}/photos/${id}/thumb`,
    });
    return c.json(out);
  });

  r.get("/systems/:id/photos/:photo/thumb", async (c) => {
    const s = await system(c.req.param("id"));
    checkOrgAccess(c.get("user"), s.org_id, "viewer", "Система");
    const body = await photoThumb(d.files(), c.req.param("photo"));
    if (!body) throw notFound("Фото");
    return new Response(body as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(body.byteLength),
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  r.post("/systems/:id/photos", async (c) => {
    const s = await system(c.req.param("id"));
    checkOrgAccess(c.get("user"), s.org_id, "editor", "Система");
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > OWNER_PHOTO_MAX_BYTES + 64 * 1024)
      throw new ApiError("PAYLOAD_TOO_LARGE", "Фото больше 15 МБ — уменьшите его и загрузите снова");
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      throw invalid("Ожидается multipart/form-data");
    }
    const file = form.file;
    if (!(file instanceof File)) throw invalid("Нет файла фото");
    const photo = await storeOwnerPhoto(d.files(), s.id, new Uint8Array(await file.arrayBuffer()));
    return c.json(
      { photo: { ...photo, source: "owner", thumb: `/api/v1/systems/${s.id}/photos/${photo.id}/thumb` } },
      201,
    );
  });

  return r;
}
