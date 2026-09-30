// PATCH /orgs/{orgId}/settings (api.yaml#updateOrgSettings, owner): the «только РФ» switch (data-boundary.yaml#ru_only).
// The change is published on the process policy bus: policy caches drop the org and routers abort its in-flight
// T1 calls, which are repeated on T0 (L3-42). The run engine reads the policy from the DB on every LLM call.
import { buildModelLabel, createRegistry, orgPolicyBus, type PolicyBus } from "@wizard/llm";
import { Hono } from "hono";
import { z } from "zod";
import { notFound } from "../errors.js";
import { type AppEnv, checkOrgAccess, isUuid } from "../http/auth.js";
import { type Deps, jsonBody } from "../http/util.js";
import { orgPolicyOf } from "../runs/queue.js";

// OrgSettings: buildModelLabel and t1Restricted are readOnly — accepted in the body and ignored.
const Body = z
  .object({
    ruOnly: z.boolean().optional(),
    buildModelLabel: z.string().optional(),
    t1Restricted: z.boolean().optional(),
  })
  .strict();

export function orgSettingsRoutes(d: Deps, bus: PolicyBus = orgPolicyBus): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const registry = createRegistry({ buildDefaultTier: d.config.buildDefaultTier });

  r.patch("/orgs/:orgId/settings", async (c) => {
    const orgId = c.req.param("orgId");
    if (!isUuid(orgId)) throw notFound("Организация");
    checkOrgAccess(c.get("user"), orgId, "owner", "Организация");
    const body = await jsonBody(c, Body);
    let q = d.db.updateTable("platform.orgs").where("id", "=", orgId);
    if (body.ruOnly !== undefined) q = q.set({ ru_only: body.ruOnly });
    const org =
      body.ruOnly !== undefined
        ? await q.returning(["ru_only", "t1_restricted", "region_code"]).executeTakeFirst()
        : await d.db
            .selectFrom("platform.orgs")
            .select(["ru_only", "t1_restricted", "region_code"])
            .where("id", "=", orgId)
            .executeTakeFirst();
    if (!org) throw notFound("Организация");
    const policy = orgPolicyOf(org);
    bus.publish({ orgId, policy });
    return c.json({
      ruOnly: org.ru_only,
      buildModelLabel: buildModelLabel(registry, policy),
      t1Restricted: org.t1_restricted,
    });
  });

  return r;
}
