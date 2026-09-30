// /systems/{id}/lock of specs/platform/api.yaml (x-milestone M1): «кто меняет» and forced release (D11: one build per
// system; the queue itself is the run engine's, db.yaml#locks).
import { Hono } from "hono";
import { ApiError, notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid, type OrgRole } from "../http/auth.js";
import type { Deps } from "../http/util.js";
import { TERMINAL_STATUSES } from "../runs/queue.js";

export function lockRoutes(d: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  async function system(user: AuthUser, id: string | undefined, min: OrgRole): Promise<string> {
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .select(["id", "org_id"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(user, s.org_id, min, "Система");
    return s.id;
  }

  // getLock
  r.get("/systems/:id/lock", async (c) => {
    const systemId = await system(c.get("user"), c.req.param("id"), "viewer");
    const lock = await d.db
      .selectFrom("platform.locks as l")
      .leftJoin("platform.users as u", "u.id", "l.holder_user_id")
      .select(["l.run_id", "l.holder_user_id", "l.acquired_at", "l.lease_until", "u.name", "u.email"])
      .where("l.system_id", "=", systemId)
      .where("l.lease_until", ">", new Date())
      .executeTakeFirst();
    const queue = await d.db
      .selectFrom("platform.runs")
      .select("id")
      .where("system_id", "=", systemId)
      .where("status", "=", "waiting_lock")
      .orderBy("created_at")
      .execute();
    return c.json({
      held: !!lock,
      runId: lock?.run_id ?? null,
      holder: lock?.holder_user_id
        ? { userId: lock.holder_user_id, name: lock.name ?? lock.email ?? "Участник" }
        : null,
      since: lock?.acquired_at.toISOString() ?? null,
      queue: queue.map((q) => q.id),
    });
  });

  // forceReleaseLock: cancels the holding run; a stale lock of a finished run is dropped.
  r.delete("/systems/:id/lock", async (c) => {
    const systemId = await system(c.get("user"), c.req.param("id"), "owner");
    const lock = await d.db
      .selectFrom("platform.locks as l")
      .innerJoin("platform.runs as r", "r.id", "l.run_id")
      .select(["l.run_id", "r.status"])
      .where("l.system_id", "=", systemId)
      .executeTakeFirst();
    if (!lock) return c.body(null, 204);
    if (!TERMINAL_STATUSES.has(lock.status)) {
      try {
        await d.engine.cancel(lock.run_id);
        return c.body(null, 204);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "RUN_NOT_CANCELLABLE")) throw e;
      }
    }
    await d.db.deleteFrom("platform.locks").where("run_id", "=", lock.run_id).execute();
    return c.body(null, 204);
  });

  return r;
}
