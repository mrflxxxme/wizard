// M1 operations of specs/platform/api.yaml around prod (M1-04): publish, rollback, listPublications,
// getRevisionDiff and setCompliance (operator data is a publish precondition).
import { type AppSpec, diffSpecs, type SpecChange } from "@wizard/appspec";
import { Hono } from "hono";
import type { Selectable } from "kysely";
import { z } from "zod";
import type { SystemsTable } from "../db/types.js";
import { ApiError, invalid, notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid, type OrgRole } from "../http/auth.js";
import { type Deps, jsonBody, parseQuery } from "../http/util.js";
import { BLOCKER_RU, prodSystemsCount, specPublishBlockers } from "../publish/blockers.js";
import { toPublication } from "../publish/prod.js";
import { isPublishable } from "../publish/workflows.js";
import { withTx } from "../runs/events.js";
import { insertRun } from "../runs/queue.js";
import { applyOpsRevision, loadManifest, loadRevision, loadSpec, lockSystem } from "../services/revisions.js";
import { toRevisionSummary, toRun } from "../services/serialize.js";

type System = Selectable<SystemsTable>;

/** File lines of the human diff: changed paths of the revision manifests (kind=file). */
function fileChanges(a: Record<string, string>, b: Record<string, string>): SpecChange[] {
  const out: SpecChange[] = [];
  for (const p of Object.keys(b).sort()) {
    if (a[p] === undefined) out.push({ kind: "file", text_ru: `Добавлен файл ${p}` });
    else if (a[p] !== b[p]) out.push({ kind: "file", text_ru: `Изменён файл ${p}` });
  }
  for (const p of Object.keys(a).sort())
    if (b[p] === undefined) out.push({ kind: "file", text_ru: `Удалён файл ${p}` });
  return out;
}

export function publishRoutes(d: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const tx = <T>(fn: Parameters<typeof withTx<T>>[2]) => withTx(d.db, d.bus, fn);

  /** Owner-only operations answer NOT_OWNER to other members (api.yaml x-roles, D11). */
  async function loadSystem(user: AuthUser, id: string | undefined, min: OrgRole): Promise<System> {
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .selectAll()
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(user, s.org_id, min, "Система", min === "owner" ? "NOT_OWNER" : "FORBIDDEN");
    return s;
  }
  const orgPlan = async (orgId: string) =>
    (await d.db.selectFrom("platform.orgs").select("plan").where("id", "=", orgId).executeTakeFirstOrThrow())
      .plan;

  // publish
  r.post("/systems/:id/publish", async (c) => {
    const user = c.get("user");
    const s = await loadSystem(user, c.req.param("id"), "owner");
    const b = await jsonBody(
      c,
      z.strictObject({ revision: z.number().int().min(1), confirmDiff: z.literal(true).optional() }),
    );
    if (s.suspended_at) throw new ApiError("SYSTEM_SUSPENDED", "Публикация системы приостановлена");
    const rev = await loadRevision(d.db, s.id, b.revision);
    if (!rev) throw notFound("Ревизия");
    if (!isPublishable(rev, s.draft_revision))
      throw new ApiError("GATES_FAILED", "Эта ревизия не прошла проверки — опубликовать её нельзя");
    const blockers = specPublishBlockers(rev.spec as unknown as AppSpec, await orgPlan(s.org_id));
    const first = blockers[0];
    if (first) throw new ApiError(first, BLOCKER_RU[first] ?? "Публикация пока недоступна", { blockers });
    const run = await tx(async (t) => {
      // billing.yaml#plans: prod_systems counts other systems in prod or being published (prodSystemsCount) under
      // the org lock, so parallel first publications of two systems cannot both pass; republishing is free.
      if (s.prod_revision === null) {
        await d.billing.lock(t.trx, s.org_id);
        await d.billing.assertLimit(t.trx, s.org_id, "prod_systems", await prodSystemsCount(t.trx, s.org_id, s.id));
      }
      // publish/rollback cost no credits (billing.yaml#run_charging.style_and_compliance): insertRun without billing.
      return insertRun(t, {
        orgId: s.org_id,
        systemId: s.id,
        kind: "publish",
        input: { revision: b.revision },
        startedBy: user.id,
      });
    });
    d.engine.enqueue(run);
    return c.json({ run: toRun(run, 0) }, 202);
  });

  // rollback
  r.post("/systems/:id/rollback", async (c) => {
    const user = c.get("user");
    const s = await loadSystem(user, c.req.param("id"), "editor");
    const b = await jsonBody(
      c,
      z.strictObject({ env: z.enum(["draft", "prod"]), toRevision: z.number().int().min(1) }),
    );
    if (b.env === "prod") checkOrgAccess(user, s.org_id, "owner", "Система", "NOT_OWNER");
    const target = await loadRevision(d.db, s.id, b.toRevision);
    if (!target || b.toRevision > s.draft_revision)
      throw new ApiError("ROLLBACK_TARGET_INVALID", "Такой ревизии нет");
    if (b.env === "draft" && b.toRevision === s.draft_revision)
      throw new ApiError("ROLLBACK_TARGET_INVALID", "Черновик уже на этой ревизии");
    if (b.env === "prod") {
      const wasLive = await d.db
        .selectFrom("platform.publications")
        .select("id")
        .where("system_id", "=", s.id)
        .where("revision", "=", b.toRevision)
        .where("live_at", "is not", null)
        .executeTakeFirst();
      if (!wasLive)
        throw new ApiError(
          "ROLLBACK_TARGET_INVALID",
          "Откатить prod можно только к ревизии, которая уже была опубликована",
        );
    }
    const run = await tx((t) =>
      insertRun(t, {
        orgId: s.org_id,
        systemId: s.id,
        kind: "rollback",
        input: { env: b.env, toRevision: b.toRevision },
        startedBy: user.id,
      }),
    );
    d.engine.enqueue(run);
    return c.json({ run: toRun(run, 0) }, 202);
  });

  // listPublications
  r.get("/systems/:id/publications", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const rows = await d.db
      .selectFrom("platform.publications")
      .selectAll()
      .where("system_id", "=", s.id)
      .orderBy("created_at", "desc")
      .limit(100)
      .execute();
    return c.json({ items: rows.map(toPublication) });
  });

  // getRevisionDiff
  r.get("/systems/:id/revisions/:v/diff", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const v = Number(c.req.param("v"));
    const rev = Number.isInteger(v) && v >= 1 ? await loadRevision(d.db, s.id, v) : undefined;
    if (!rev) throw notFound("Ревизия");
    const q = parseQuery(c, z.object({ from: z.coerce.number().int().min(0).optional() }));
    const from = q.from ?? rev.parent_version ?? 0;
    if (from > 0 && !(await loadRevision(d.db, s.id, from))) throw invalid("Ревизии from нет");
    const prev = from === 0 ? null : await loadSpec(d.db, s, from);
    const next = rev.spec as unknown as AppSpec;
    const changes = [
      ...diffSpecs(prev, next),
      ...fileChanges(
        await loadManifest(d.db, d.blobs, s.id, from),
        await loadManifest(d.db, d.blobs, s.id, v),
      ),
    ];
    return c.json({ changes });
  });

  // setCompliance
  r.put("/systems/:id/compliance", async (c) => {
    const user = c.get("user");
    const s0 = await loadSystem(user, c.req.param("id"), "owner");
    const b = await jsonBody(
      c,
      z.strictObject({
        expectedVersion: z.number().int(),
        operatorName: z.string().min(3).max(300),
        operatorContact: z.email(),
        operatorAddress: z.string().max(300).optional(),
        operatorInn: z
          .string()
          .regex(/^[0-9]{10}([0-9]{2})?$/)
          .optional(),
        policyPage: z
          .string()
          .regex(/^\/[a-z0-9/-]*$/)
          .optional(),
        consentTemplateId: z.string().optional(),
        consentText: z.string().max(4000).optional(),
        retentionWaiver: z
          .strictObject({ reason: z.string().min(10).max(500) })
          .nullable()
          .optional(),
      }),
    );
    const { expectedVersion, retentionWaiver, ...fields } = b;
    const res = await tx(async (t) => {
      const s = await lockSystem(t, s0.id);
      if (expectedVersion !== s.draft_revision)
        throw new ApiError("VERSION_CONFLICT", "Система изменилась — обновите страницу", {
          currentVersion: s.draft_revision,
        });
      const op: Record<string, unknown> = { op: "set_compliance", ...fields };
      if (retentionWaiver) op.retentionWaiver = retentionWaiver;
      const r2 = await applyOpsRevision(t, d.blobs, {
        systemId: s.id,
        ops: [op],
        expectedVersion,
        kind: "compliance",
        author: "user",
        authorUserId: user.id,
      });
      if (!r2.ok)
        throw new ApiError("OPS_INVALID", "Сведения об операторе не сохранены", { errors: r2.errors });
      return loadRevision(t.trx, s.id, r2.version);
    });
    if (!res) throw new ApiError("INTERNAL", "Ревизия не сохранена");
    return c.json({ revision: toRevisionSummary(res) });
  });

  return r;
}
