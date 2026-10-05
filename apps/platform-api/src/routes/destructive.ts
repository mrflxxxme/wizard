// M2-72 (api.yaml getDestructiveConsequences, confirmDestructive, listDestructiveChanges, undoDestructiveChange):
// what a prod change removes, the owner's confirmation and «Отменить правку». Confirming and undoing — owner only (D11).
import { Hono } from "hono";
import type { Selectable } from "kysely";
import { z } from "zod";
import type { SystemsTable } from "../db/types.js";
import {
  computeConsequences,
  confirmDestructive,
  DESTRUCTIVE_RU,
  listChanges,
  pendingConfirmation,
  revisionSpec,
  toRecord,
  undoTarget,
} from "../destructive/service.js";
import { ApiError, notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid, type OrgRole } from "../http/auth.js";
import { type Deps, jsonBody, parseQuery } from "../http/util.js";
import { withTx } from "../runs/events.js";
import { insertRun } from "../runs/queue.js";
import { toRun } from "../services/serialize.js";

type System = Selectable<SystemsTable>;

export function destructiveRoutes(d: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  async function loadSystem(user: AuthUser, id: string | undefined, min: OrgRole) {
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .selectAll()
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    const role = checkOrgAccess(user, s.org_id, min, "Система", min === "owner" ? "NOT_OWNER" : "FORBIDDEN");
    return { s, role };
  }

  async function specOf(s: System, revision: number) {
    const spec = revision >= 1 ? await revisionSpec(d.db, s, revision) : undefined;
    if (!spec) throw notFound("Ревизия");
    return spec;
  }

  // getDestructiveConsequences
  r.get("/systems/:id/destructive", async (c) => {
    const { s, role } = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const q = parseQuery(c, z.object({ revision: z.coerce.number().int().min(1).optional() }));
    const revision = q.revision ?? s.draft_revision;
    const consequences = await computeConsequences(d.db, d.pg, s, revision, await specOf(s, revision));
    const row = consequences.required ? await pendingConfirmation(d.db, s.id, revision) : undefined;
    const confirmation = row
      ? {
          status: row.consequences_hash === consequences.hash ? "confirmed" : "stale",
          confirmedAt: new Date(row.confirmed_at).toISOString(),
        }
      : null;
    return c.json({ ...consequences, confirmation, canConfirm: role === "owner" });
  });

  // confirmDestructive
  r.post("/systems/:id/destructive/confirm", async (c) => {
    const user = c.get("user");
    const { s } = await loadSystem(user, c.req.param("id"), "owner");
    const b = await jsonBody(
      c,
      z.strictObject({ revision: z.number().int().min(1), hash: z.string().regex(/^[0-9a-f]{64}$/) }),
    );
    const { row, consequences } = await confirmDestructive(d.db, d.pg, s, {
      userId: user.id,
      revision: b.revision,
      hash: b.hash,
      spec: await specOf(s, b.revision),
    });
    return c.json({ change: toRecord(row, null), consequences }, 201);
  });

  // listDestructiveChanges (journal)
  r.get("/systems/:id/destructive/changes", async (c) => {
    const { s, role } = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const undo = await undoTarget(d.db, s);
    const rows = await listChanges(d.db, s.id);
    return c.json({
      items: rows.map((x) => toRecord(x, undo?.row.id ?? null)),
      undo: undo ? { changeId: undo.row.id, toRevision: undo.toRevision } : null,
      canUndo: role === "owner",
    });
  });

  // undoDestructiveChange
  r.post("/systems/:id/destructive/changes/:changeId/undo", async (c) => {
    const user = c.get("user");
    const { s } = await loadSystem(user, c.req.param("id"), "owner");
    const changeId = c.req.param("changeId");
    const undo = await undoTarget(d.db, s);
    if (!undo || undo.row.id !== changeId)
      throw new ApiError("DESTRUCTIVE_UNDO_UNAVAILABLE", DESTRUCTIVE_RU.undoUnavailable);
    const run = await withTx(d.db, d.bus, (t) =>
      insertRun(t, {
        orgId: s.org_id,
        systemId: s.id,
        kind: "rollback",
        input: { env: "prod", toRevision: undo.toRevision, undoChangeId: changeId },
        startedBy: user.id,
      }),
    );
    d.engine.enqueue(run);
    return c.json({ run: toRun(run, 0) }, 202);
  });

  return r;
}
