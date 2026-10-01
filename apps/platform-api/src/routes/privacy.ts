// 152-ФЗ operations of the owner (M2-05): listDeletionLog (api.yaml /systems/{id}/deletion-log) and the soft delete of a
// system (workflows.yaml#delete_system: purge 30 days after deleted_at by retention_cron).
import { Hono } from "hono";
import { z } from "zod";
import { ApiError, invalid, notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid } from "../http/auth.js";
import { type Deps, parseQuery } from "../http/util.js";
import { SYSTEM_PURGE_DAYS } from "../privacy/delete-system.js";
import { withTx } from "../runs/events.js";
import { ACTIVE_STATUSES } from "../runs/queue.js";
import { lockSystem } from "../services/revisions.js";

const DAY_MS = 86_400_000;

const encodeCursor = (at: Date, id: string) =>
  Buffer.from(`${new Date(at).toISOString()}|${id}`).toString("base64url");

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [ts, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const at = new Date(ts ?? "");
  if (!id || !/^\d+$/.test(id) || Number.isNaN(at.getTime())) throw invalid("Некорректный курсор");
  return { at, id };
}

export function privacyRoutes(d: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /** Owner-only; a soft-deleted system keeps its journal readable (proof of the purge, L3-36). */
  async function ownSystem(user: AuthUser, id: string | undefined, withDeleted: boolean) {
    if (!isUuid(id)) throw notFound("Система");
    let q = d.db.selectFrom("platform.systems").selectAll().where("id", "=", id);
    if (!withDeleted) q = q.where("deleted_at", "is", null);
    const s = await q.executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(user, s.org_id, "owner", "Система");
    return s;
  }

  // listDeletionLog
  r.get("/systems/:id/deletion-log", async (c) => {
    const s = await ownSystem(c.get("user"), c.req.param("id"), true);
    const q = parseQuery(
      c,
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().max(200).optional(),
      }),
    );
    let query = d.db.selectFrom("platform.deletion_log").selectAll().where("system_id", "=", s.id);
    if (q.cursor) {
      const { at, id } = decodeCursor(q.cursor);
      query = query.where((eb) =>
        eb.or([eb("created_at", "<", at), eb.and([eb("created_at", "=", at), eb("id", "<", id)])]),
      );
    }
    const rows = await query
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({
      items: page.map((x) => ({
        env: x.env,
        entity: x.entity,
        mode: x.mode,
        cutoff: x.cutoff ? new Date(x.cutoff).toISOString() : null,
        rowsAffected: x.rows_affected,
        createdAt: new Date(x.created_at).toISOString(),
      })),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null,
    });
  });

  // deleteSystem (not in api.yaml yet — docs/reviews/impl-notes/M2-05.md): soft delete by the owner.
  r.delete("/systems/:id", async (c) => {
    const s0 = await ownSystem(c.get("user"), c.req.param("id"), false);
    const s = await withTx(d.db, d.bus, async (t) => {
      const cur = await lockSystem(t, s0.id);
      if (cur.deleted_at) throw notFound("Система");
      const active = await t.trx
        .selectFrom("platform.runs")
        .select("id")
        .where("system_id", "=", cur.id)
        .where("status", "in", [...ACTIVE_STATUSES])
        .executeTakeFirst();
      if (active)
        throw new ApiError("SYSTEM_LOCKED", "Идёт прогон — дождитесь его окончания или отмените его");
      return t.trx
        .updateTable("platform.systems")
        .set({ deleted_at: new Date(), updated_at: new Date() })
        .where("id", "=", cur.id)
        .returning(["id", "deleted_at"])
        .executeTakeFirstOrThrow();
    });
    const deletedAt = new Date(s.deleted_at as Date);
    return c.json({
      id: s.id,
      deletedAt: deletedAt.toISOString(),
      purgeAfter: new Date(deletedAt.getTime() + SYSTEM_PURGE_DAYS * DAY_MS).toISOString(),
    });
  });

  return r;
}
