// GET /systems/:id/webhooks (M2-53, D71): secret addresses of the system's incoming webhooks for the owner's cabinet —
// the URL to paste into the sending service (Tilda, CRM, form builders). Only org owners and editors see them (the
// address is a credential). The token is derived from WIZARD_SECRETS_KEY exactly as the runtime checks it
// (@wizard/connectors webhookHookToken); prod — the published spec, draft — the preview revision.
import type { AppSpec } from "@wizard/appspec";
import { webhookConfigSchema, webhookHookToken, webhookKeyFromEnv, webhookUrl } from "@wizard/connectors";
import { Hono } from "hono";
import { notFound } from "../errors.js";
import { type AppEnv, checkOrgAccess, isUuid } from "../http/auth.js";
import type { Deps } from "../http/util.js";
import { systemOrigin } from "../publish/prod.js";
import { loadSpec } from "../services/revisions.js";

export interface WebhookAddress {
  integration: string;
  env: "draft" | "prod";
  url: string;
  /** hmac | shared_secret */
  verify: string;
  /** Where the records go. */
  entity: string;
}

/** Addresses of the webhook integrations of `spec` for one deployment. */
export function webhookAddresses(
  spec: AppSpec,
  a: { origin: string; systemKey: string; env: "draft" | "prod"; key: string },
): WebhookAddress[] {
  const out: WebhookAddress[] = [];
  for (const i of spec.integrations ?? []) {
    if (i.connector !== "webhook") continue;
    const c = webhookConfigSchema.safeParse(i.config ?? {});
    if (!c.success) continue;
    const token = webhookHookToken(a.key, {
      systemId: a.systemKey,
      env: a.env,
      integration: i.name,
      ...(c.data.tokenVersion ? { version: c.data.tokenVersion } : {}),
    });
    out.push({
      integration: i.name,
      env: a.env,
      url: webhookUrl(a.origin, i.name, token),
      verify: c.data.verify,
      entity: c.data.entity,
    });
  }
  return out;
}

export function webhookRoutes(d: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/systems/:id/webhooks", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .selectAll()
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(c.get("user"), s.org_id, "editor", "Система");
    const key = webhookKeyFromEnv(process.env);
    const items: WebhookAddress[] = [];
    for (const [env, revision] of [
      ["prod", s.prod_revision],
      ["draft", s.preview_revision],
    ] as const) {
      if (revision === null) continue;
      const spec = await loadSpec(d.db, s, revision);
      items.push(
        ...webhookAddresses(spec, {
          origin: systemOrigin(d.config, s.slug, env),
          systemKey: s.schema_key,
          env,
          key,
        }),
      );
    }
    return c.json({ items });
  });
  return r;
}
