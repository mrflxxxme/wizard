// /orgs/{orgId}/byok* of specs/platform/api.yaml (V3-33): own model keys of an org. Reading — any member (viewer);
// consent, adding, checking, pausing and revoking — the owner. Validation errors name the field only: the body (with the
// key) is never echoed, logged or put into details.
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { OrgRole } from "../auth/accounts.js";
import { ApiError, invalid, notFound } from "../errors.js";
import { type AppEnv, checkOrgAccess, isUuid } from "../http/auth.js";
import { BYOK_UNAVAILABLE_RU, type ByokService } from "./service.js";

const addSchema = z.strictObject({
  provider: z.string().min(1).max(32),
  model: z.string().min(1).max(128),
  key: z.string().min(1).max(512),
  gatewayUrl: z.string().max(512).nullish(),
  callTypes: z.array(z.string().max(40)).max(20).optional(),
});
const consentSchema = z.strictObject({ version: z.string().min(1).max(32) });
const statusSchema = z.strictObject({ status: z.enum(["active", "paused"]) });

/** JSON body by the schema; on failure only the paths of the bad fields (never their values or zod messages). */
async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw invalid("Тело запроса должно быть JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success)
    throw invalid("Некорректные параметры запроса", {
      fields: [...new Set(r.error.issues.map((i) => i.path.join(".") || "(body)"))],
    });
  return r.data;
}

export function byokRoutes(svc: ByokService): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const org = (c: Context<AppEnv>, min: OrgRole): string => {
    const id = c.req.param("orgId");
    if (!isUuid(id)) throw notFound("Организация");
    checkOrgAccess(c.get("user"), id, min, "Организация", min === "owner" ? "NOT_OWNER" : "FORBIDDEN");
    return id;
  };
  const keyId = (c: Context<AppEnv>): string => {
    const id = c.req.param("keyId");
    if (!isUuid(id)) throw notFound("Ключ");
    return id;
  };

  // getByok
  r.get("/orgs/:orgId/byok", async (c) => c.json(await svc.state(org(c, "viewer"))));

  // acceptByokConsent
  r.post("/orgs/:orgId/byok/consent", async (c) => {
    const orgId = org(c, "owner");
    const b = await body(c, consentSchema);
    return c.json(await svc.acceptConsent(orgId, c.get("user").id, b.version));
  });

  // addByokKey: sealed at once, then the check call; 201 with the key view (last 4 only).
  r.post("/orgs/:orgId/byok/keys", async (c) => {
    const orgId = org(c, "owner");
    if (!svc.available(orgId)) throw new ApiError("FORBIDDEN", BYOK_UNAVAILABLE_RU);
    const b = await body(c, addSchema);
    const key = await svc.addKey(orgId, c.get("user").id, {
      provider: b.provider,
      model: b.model,
      key: b.key,
      ...(b.gatewayUrl ? { gatewayUrl: b.gatewayUrl } : {}),
      ...(b.callTypes ? { callTypes: b.callTypes } : {}),
    });
    return c.json({ key }, 201);
  });

  // checkByokKey
  r.post("/orgs/:orgId/byok/keys/:keyId/check", async (c) => {
    const orgId = org(c, "owner");
    return c.json({ key: await svc.check(orgId, keyId(c)) });
  });

  // updateByokKey: use in builds on/off.
  r.patch("/orgs/:orgId/byok/keys/:keyId", async (c) => {
    const orgId = org(c, "owner");
    const id = keyId(c);
    const b = await body(c, statusSchema);
    return c.json({ key: await svc.setStatus(orgId, id, b.status) });
  });

  // revokeByokKey
  r.delete("/orgs/:orgId/byok/keys/:keyId", async (c) => {
    const orgId = org(c, "owner");
    return c.json({ key: await svc.revoke(orgId, keyId(c), c.get("user").id) });
  });

  return r;
}
