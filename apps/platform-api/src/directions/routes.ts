// Routes of «Три направления» (V3-09; api.yaml): /systems/:id/directions* for the owner's card — reading needs viewer,
// everything that calls a model, builds previews or writes the brief needs editor (another org's system is 404, the
// system is checked before the body); /direction-previews/* serve the preview files to the sandboxed srcdoc frames
// without a session — the proposal id (sha256 of the stored proposal with a random nonce) is the capability.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { previewPhotoSvg } from "@wizard/agents/builder";
import { fontFiles } from "@wizard/ui-kit/fonts";
import { Hono } from "hono";
import { z } from "zod";
import { ApiError, invalid, notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid, type OrgRole } from "../http/auth.js";
import { jsonBody } from "../http/util.js";
import { REFERENCE_MAX_BYTES } from "./images.js";
import type { DirectionsService, SystemRef } from "./service.js";

const proposalId = z.string().regex(/^[0-9a-f]{64}$/, "неизвестный набор направлений");
const proposeBody = z.strictObject({ reroll: z.boolean().optional() });
const refineBody = z.strictObject({ proposalId, text: z.string().trim().min(1).max(500) });
const pickBody = z.union([
  z.strictObject({ proposalId, n: z.number().int().min(1).max(3) }),
  z.strictObject({ proposalId, skip: z.literal(true) }),
]);
const urlBody = z.strictObject({ url: z.string().trim().min(8).max(500) });

export function directionRoutes(svc: DirectionsService): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  async function loadSystem(user: AuthUser, id: string | undefined, min: OrgRole): Promise<SystemRef> {
    if (!isUuid(id)) throw notFound("Система");
    const s = await svc.d.db
      .selectFrom("platform.systems")
      .select(["id", "org_id", "name"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(user, s.org_id, min, "Система");
    return s;
  }

  // The latest proposal with its live previews (null before the first one).
  r.get("/systems/:id/directions", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    return c.json({ proposal: await svc.latest(s) });
  });

  // Three directions from the current brief (one model call for the texts at most, ≤ 40 ₽).
  r.post("/systems/:id/directions", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "editor");
    svc.limit(s.id);
    const text = await c.req.text();
    let body: z.output<typeof proposeBody> = {};
    if (text.trim()) {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw invalid("Тело запроса должно быть JSON");
      }
      const parsed = proposeBody.safeParse(raw);
      if (!parsed.success) throw invalid("Некорректные параметры запроса");
      body = parsed.data;
    }
    const proposal = await svc.propose(s, { ...body, signal: c.req.raw.signal });
    return c.json({ proposal }, 201);
  });

  // «Что поменять?»: the owner's words → new directions, a pick or a hint.
  r.post("/systems/:id/directions/refine", async (c) => {
    const user = c.get("user");
    const s = await loadSystem(user, c.req.param("id"), "editor");
    svc.limit(s.id);
    const b = await jsonBody(c, refineBody);
    return c.json(await svc.refine(s, user, b.proposalId, b.text));
  });

  // «Выбрать» or «Решите за меня»: a new brief version (design.archetype, pinned, the owner's words).
  r.post("/systems/:id/directions/pick", async (c) => {
    const user = c.get("user");
    const s = await loadSystem(user, c.req.param("id"), "editor");
    const b = await jsonBody(c, pickBody);
    return c.json(await svc.pick(s, user, b.proposalId, "n" in b ? b.n : null));
  });

  // A reference link → principles in the brief.
  r.post("/systems/:id/directions/references", async (c) => {
    const user = c.get("user");
    const s = await loadSystem(user, c.req.param("id"), "editor");
    svc.limit(s.id);
    const b = await jsonBody(c, urlBody);
    return c.json(await svc.addUrl(s, user, b.url), 201);
  });

  // A logo (PNG or SVG) or a screenshot (PNG) → principles in the brief; the file is not kept.
  r.post("/systems/:id/directions/references/upload", async (c) => {
    const user = c.get("user");
    const s = await loadSystem(user, c.req.param("id"), "editor");
    svc.limit(s.id);
    const tooLarge = () => new ApiError("PAYLOAD_TOO_LARGE", "Файл слишком большой: можно загрузить до 2 МБ");
    if (Number(c.req.header("content-length") ?? 0) > REFERENCE_MAX_BYTES + 65_536) throw tooLarge();
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      throw invalid("Ожидается multipart/form-data с картинкой");
    }
    const file = form.file;
    const kind = form.kind;
    if (!(file instanceof File)) throw invalid("Нет картинки: поле file");
    if (kind !== "logo" && kind !== "screenshot") throw invalid("Поле kind: logo или screenshot");
    if (file.size > REFERENCE_MAX_BYTES) throw tooLarge();
    return c.json(await svc.addImage(s, user, kind, new Uint8Array(await file.arrayBuffer())), 201);
  });

  return r;
}

/** packages/ui-kit/fonts (next to src/tokens/fonts.ts of the package), like the runtime's /_wizard/fonts. */
const FONTS_DIR = join(
  dirname(createRequire(import.meta.url).resolve("@wizard/ui-kit/fonts")),
  "../../fonts",
);
const FONT_NAMES = new Set(fontFiles());
const fontCache = new Map<string, Uint8Array>();

/** Headers of every preview file: the srcdoc frame has an opaque origin, its module script and fonts load with CORS. */
const PUBLIC = {
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, max-age=3600",
} as const;

export function directionPreviewRoutes(svc: DirectionsService): Hono {
  const r = new Hono();
  const missing = () => new Response("", { status: 404, headers: PUBLIC });

  r.get("/direction-previews/fonts/:file", async (c) => {
    const file = c.req.param("file");
    if (!FONT_NAMES.has(file)) return missing();
    let data = fontCache.get(file);
    if (!data) {
      try {
        data = new Uint8Array(await readFile(join(FONTS_DIR, file)));
      } catch {
        return missing();
      }
      fontCache.set(file, data);
    }
    return c.body(data as Uint8Array<ArrayBuffer>, 200, {
      ...PUBLIC,
      "Content-Type": "font/woff2",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  });

  r.get("/direction-previews/photos/:name", (c) => {
    const name = c.req.param("name");
    if (!/^[a-z0-9-]{1,80}\.svg$/.test(name)) return missing();
    return c.body(previewPhotoSvg(name), 200, {
      ...PUBLIC,
      "Content-Type": "image/svg+xml",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
  });

  r.get("/direction-previews/:proposalId/:n/:file{.+}", async (c) => {
    const id = c.req.param("proposalId");
    const n = Number(c.req.param("n"));
    const path = c.req.param("file");
    if (!/^[0-9a-f]{64}$/.test(id) || ![1, 2, 3].includes(n)) return missing();
    let built = svc.previews.cached(id, n);
    if (!built) {
      const p = await svc.load(id);
      const d = p?.directions[n - 1];
      if (!p || !d) return missing();
      built = svc.previews.build(id, p, d);
    }
    let file: { body: Uint8Array; type: string } | undefined;
    try {
      file = (await built).files.get(path);
    } catch (e) {
      svc.d.log?.("direction preview build failed", e);
      return missing();
    }
    if (!file) return missing();
    return c.body(file.body as Uint8Array<ArrayBuffer>, 200, { ...PUBLIC, "Content-Type": file.type });
  });

  return r;
}
