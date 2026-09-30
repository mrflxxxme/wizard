// GET /orgs/{orgId}/settings (api.yaml, x-milestone M1) served read-only from M0 for the build model label
// of S1/S3 (M0-30, L4-20). PATCH (ruOnly toggle) stays M1.
import { buildModelLabel, createRegistry } from "@wizard/llm";
import { Hono } from "hono";
import { notFound } from "../errors.js";
import { type AppEnv, checkOrgAccess, isUuid } from "../http/auth.js";
import type { Deps } from "../http/util.js";

export function orgRoutes(d: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const registry = createRegistry({ buildDefaultTier: d.config.buildDefaultTier });

  r.get("/orgs/:orgId/settings", async (c) => {
    const orgId = c.req.param("orgId");
    if (!isUuid(orgId)) throw notFound("Организация");
    checkOrgAccess(c.get("user"), orgId, "viewer", "Организация");
    const org = await d.db
      .selectFrom("platform.orgs")
      .select(["ru_only", "t1_restricted", "region_code"])
      .where("id", "=", orgId)
      .executeTakeFirst();
    if (!org) throw notFound("Организация");
    // Same org policy as the run engine (runs/queue.ts): unknown region → T1 restricted (db.yaml#orgs.t1_restricted).
    const policy = { ruOnly: org.ru_only, t1Restricted: org.t1_restricted || org.region_code === null };
    return c.json({
      ruOnly: org.ru_only,
      buildModelLabel: buildModelLabel(registry, policy),
      t1Restricted: org.t1_restricted,
    });
  });

  return r;
}
