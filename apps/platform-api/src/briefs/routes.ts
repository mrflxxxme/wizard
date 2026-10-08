// /systems/:id/brief* (V3-02, builder-v3.md §3 C1): the latest brief (or a given version) with its three diagrams, the
// version history with diffs, and the owner's edit — the whole brief becomes a new version (no model, no credits; the
// diff is computed here). Reading needs viewer, editing editor (as editSystemPlan); another org's system is 404.
import { BRIEF_LIMITS, type BriefVersion, briefDiagrams } from "@wizard/appspec";
import { Hono } from "hono";
import { z } from "zod";
import { ApiError, invalid, notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid, type OrgRole } from "../http/auth.js";
import { type Deps, parseQuery } from "../http/util.js";
import {
  BriefConflictError,
  BriefInvalidError,
  getBriefVersion,
  getLatestBrief,
  listBriefVersions,
  saveBriefVersion,
} from "./store.js";

/** Largest accepted body of an edit: the brief limit with room for escapes and whitespace of the JSON text. */
export const MAX_BRIEF_BODY_BYTES = BRIEF_LIMITS.bytes * 2;

const versionQ = z.object({ version: z.coerce.number().int().min(1).optional() });
const listQ = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.number().int().min(2).optional(),
});
const editBody = z.strictObject({
  /** The version the owner edited (0 — there was no brief yet). */
  baseVersion: z.number().int().min(0),
  brief: z.unknown(),
});

const withDiagrams = (v: BriefVersion | null) => ({ brief: v, diagrams: v ? briefDiagrams(v.brief) : null });

export function briefRoutes(d: Pick<Deps, "db">): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  async function loadSystem(user: AuthUser, id: string | undefined, min: OrgRole): Promise<{ id: string }> {
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .select(["id", "org_id"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(user, s.org_id, min, "Система");
    return s;
  }

  // The latest brief (null before the interview wrote one) or ?version=N, with the three diagrams.
  r.get("/systems/:id/brief", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const q = parseQuery(c, versionQ);
    if (q.version === undefined) return c.json(withDiagrams(await getLatestBrief(d.db, s.id)));
    const v = await getBriefVersion(d.db, s.id, q.version);
    if (!v) throw notFound("Версия брифа");
    return c.json(withDiagrams(v));
  });

  // History: versions newest first with their diffs; ?before=N — the next page.
  r.get("/systems/:id/brief/versions", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const q = parseQuery(c, listQ);
    const versions = await listBriefVersions(d.db, s.id, q);
    const last = versions.at(-1);
    return c.json({
      versions,
      nextBefore: versions.length === q.limit && last && last.version > 1 ? last.version : null,
    });
  });

  // The owner's edit: the whole brief and the version it was made on; equal to the latest — no new version.
  r.put("/systems/:id/brief", async (c) => {
    const user = c.get("user");
    const s = await loadSystem(user, c.req.param("id"), "editor");
    const tooLarge = () =>
      new ApiError("PAYLOAD_TOO_LARGE", "Бриф слишком большой — сократите тексты или списки");
    if (Number(c.req.header("content-length") ?? 0) > MAX_BRIEF_BODY_BYTES) throw tooLarge();
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_BRIEF_BODY_BYTES) throw tooLarge();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw invalid("Тело запроса должно быть JSON");
    }
    const parsed = editBody.safeParse(raw);
    if (!parsed.success || parsed.data.brief === undefined)
      throw invalid("Нужны поля baseVersion (версия, которую вы правили; 0 — брифа ещё не было) и brief");
    try {
      const saved = await saveBriefVersion(d.db, {
        systemId: s.id,
        brief: parsed.data.brief,
        author: "owner",
        authorUserId: user.id,
        baseVersion: parsed.data.baseVersion,
      });
      return c.json({ ...withDiagrams(saved.version), changed: saved.changed });
    } catch (e) {
      if (e instanceof BriefInvalidError)
        throw new ApiError("VALIDATION_FAILED", e.errors[0]?.message_ru ?? "Бриф не прошёл проверку", {
          errors: e.errors,
        });
      if (e instanceof BriefConflictError)
        throw new ApiError("VERSION_CONFLICT", "Бриф изменился — посмотрите новую версию", {
          version: e.latest,
        });
      throw e;
    }
  });

  return r;
}
