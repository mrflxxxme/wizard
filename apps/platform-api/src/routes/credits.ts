// getCredits / listLedger of specs/platform/api.yaml (x-milestone M1, x-roles viewer); billing.yaml#ledger.
import { Hono } from "hono";
import { z } from "zod";
import { notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid } from "../http/auth.js";
import { type Deps, parseQuery } from "../http/util.js";

const credits = (milli: number | string) => Number(milli) / 1000;

export function creditRoutes(d: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  function orgParam(user: AuthUser, id: string | undefined): string {
    if (!isUuid(id)) throw notFound("Организация");
    checkOrgAccess(user, id, "viewer", "Организация");
    return id;
  }

  // getCredits
  r.get("/orgs/:orgId/credits", async (c) => {
    const orgId = orgParam(c.get("user"), c.req.param("orgId"));
    const b = await d.billing.readBalance(d.db, orgId);
    return c.json({
      balance: credits(b.balance),
      held: credits(b.held),
      available: credits(b.available),
      buckets: b.buckets.map((x) => ({
        source: x.bucket,
        remaining: credits(x.remaining),
        expiresAt: x.expiresAt?.toISOString() ?? null,
      })),
    });
  });

  // listLedger: newest first; the cursor is the last id of the previous page.
  r.get("/orgs/:orgId/credits/ledger", async (c) => {
    const orgId = orgParam(c.get("user"), c.req.param("orgId"));
    const q = parseQuery(
      c,
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z
          .string()
          .regex(/^[0-9]{1,19}$/)
          .optional(),
      }),
    );
    // Materialize due grants and expiry so that the journal matches getCredits.
    await d.db.transaction().execute((trx) => d.billing.settleOrg(trx, orgId));
    let query = d.db.selectFrom("platform.credit_ledger").selectAll().where("org_id", "=", orgId);
    if (q.cursor) query = query.where("id", "<", q.cursor as never);
    const rows = await query.orderBy("id", "desc").limit(q.limit).execute();
    return c.json({
      items: rows.map((x) => ({
        id: String(x.id),
        kind: x.kind,
        amount: credits(x.amount_milli),
        source: x.bucket ?? "adjustment",
        runId: x.run_id,
        systemId: x.system_id,
        note_ru: x.note_ru ?? "",
        createdAt: new Date(x.created_at).toISOString(),
      })),
      nextCursor: rows.length === q.limit ? String(rows[rows.length - 1]?.id) : null,
    });
  });

  return r;
}
