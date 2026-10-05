// Incoming webhooks (M2-53, D71; connectors/webhook.yaml): POST /_wizard/hooks/webhook/:integration/:hookToken — a
// route of its own, without the payment dispatcher. Order: secret address (constant time, 404) → rate limit (429) →
// body cap (413) → signature / shared secret and time window (401) → replay (event id or body hash in
// _w_webhook_events: 200 without a second record) → allowlisted fields → insert as __system and webhook-trigger
// workflows queued in the same transaction. Logs carry codes only: no body, signature or token (the path segment is
// masked by app.ts).
import type { Entity, Integration } from "@wizard/appspec";
import { quoteIdent } from "@wizard/appspec";
import {
  INCOMING_WEBHOOK_BODY_MAX,
  INCOMING_WEBHOOK_RATE_PER_MINUTE,
  isConnectorError,
  mapWebhookFields,
  secretMatches,
  verifyWebhook,
  type WebhookConfig,
  webhookConfigSchema,
  webhookHookToken,
  webhookWorkflows,
} from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import { SYSTEM_SUBJECT } from "../data/access.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import type { ConnectorHost } from "../preview/connectors.js";

const json = (status: number, body: Record<string, unknown> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const notFound = () => json(404, { ok: false });

/** Fixed one-minute windows per system and integration (per runtime process). */
class MinuteLimiter {
  private readonly windows = new Map<string, { window: number; used: number }>();
  take(key: string, limit: number, now: number): boolean {
    const window = Math.floor(now / 60_000);
    const hit = this.windows.get(key);
    if (!hit || hit.window !== window) {
      if (this.windows.size > 10_000) this.windows.clear();
      this.windows.set(key, { window, used: 1 });
      return true;
    }
    hit.used += 1;
    return hit.used <= limit;
  }
}

async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") ?? "0") > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export interface WebhookRouteOptions {
  host: ConnectorHost;
  /** Key material of hook tokens (WIZARD_SECRETS_KEY or the dev fallback; connectors webhookKeyFromEnv). */
  key: string;
}

export function webhookHookRoutes(o: WebhookRouteOptions): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  const limiter = new MinuteLimiter();

  const log = (c: RuntimeContext, msg: string, extra: Record<string, unknown>) =>
    c.get("services").log?.({
      ts: new Date().toISOString(),
      level: "warn",
      requestId: c.get("requestId"),
      msg,
      system: c.get("system").entry.slug,
      ...extra,
    });

  app.post("/:integration/:hookToken", async (c) => {
    const sys = c.get("system");
    const name = c.req.param("integration");
    const integ: Integration | undefined = (sys.spec.integrations ?? []).find(
      (i) => i.name === name && i.connector === "webhook",
    );
    const parsed = integ ? webhookConfigSchema.safeParse(integ.config ?? {}) : null;
    const config: WebhookConfig | null = parsed?.success ? parsed.data : null;
    // The expected token is always computed, so an unknown integration costs the same as a wrong token.
    const expected = webhookHookToken(o.key, {
      systemId: sys.entry.systemId,
      env: sys.entry.env,
      integration: name,
      ...(config?.tokenVersion ? { version: config.tokenVersion } : {}),
    });
    const tokenOk = secretMatches(c.req.param("hookToken"), expected);
    if (!integ || !config || !tokenOk) return notFound();
    const entity = sys.spec.entities.find((e: Entity) => e.name === config.entity);
    if (!entity) return notFound();
    const services = c.get("services");
    const now = services.clock().getTime();
    if (
      !limiter.take(`${sys.entry.systemId}:${sys.entry.env}:${name}`, INCOMING_WEBHOOK_RATE_PER_MINUTE, now)
    ) {
      log(c, "webhook_rejected", { integration: name, reason: "rate_limited" });
      return new Response(JSON.stringify({ ok: false }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(60 - Math.floor((now / 1000) % 60)),
        },
      });
    }
    const body = await readCapped(c.req.raw, INCOMING_WEBHOOK_BODY_MAX);
    if (!body) return json(413, { ok: false });
    let verdict: Awaited<ReturnType<typeof verifyWebhook>>;
    try {
      verdict = await verifyWebhook(config, o.host.ctx(sys, integ).secrets, {
        headers: c.req.raw.headers,
        body,
        now,
      });
    } catch (e) {
      // The secret is not set yet: the integration cannot verify anything.
      log(c, "webhook_rejected", {
        integration: name,
        reason: isConnectorError(e) ? e.code : "verify_error",
      });
      return json(503, { ok: false });
    }
    if (!verdict.ok) {
      log(c, "webhook_rejected", { integration: name, reason: verdict.reason });
      return json(verdict.status, { ok: false });
    }
    const doc = mapWebhookFields(config, entity, verdict.payload);
    if (Object.keys(doc).length === 0) {
      log(c, "webhook_rejected", { integration: name, reason: "no_fields" });
      return json(422, { ok: false });
    }
    const T = (t: string) => `${quoteIdent(sys.schema)}.${quoteIdent(t)}`;
    const workflows = webhookWorkflows(sys.spec, name);
    try {
      const out = await sys.data.transaction("write", SYSTEM_SUBJECT, async (d) => {
        const ev = await d.sql.unsafe(
          `insert into ${T("_w_webhook_events")} (integration, event_key, body_hash, status)
           values ($1, $2, $3, 'accepted') on conflict (integration, event_key) do nothing returning id::text as id`,
          [name, verdict.eventKey.slice(0, 300), verdict.bodyHash],
        );
        const eventId = ev[0]?.id as string | undefined;
        if (!eventId) return { duplicate: true as const };
        const id = await d.system.insert(entity.name, doc);
        await d.sql.unsafe(
          `update ${T("_w_webhook_events")} set record_id = $2::uuid where id = $1::bigint`,
          [eventId, id],
        );
        for (const w of workflows) {
          await d.sql.unsafe(
            `insert into ${T("_w_jobs")} (kind, payload, run_at, idempotency_key)
             values ('workflow_step', cast($1::text as jsonb), now(), $2) on conflict (idempotency_key) do nothing`,
            [
              JSON.stringify({ workflow: w.name, entity: entity.name, recordId: id, step: 0 }),
              `wf:${w.name}:hook:${eventId}`,
            ],
          );
        }
        return { duplicate: false as const, id };
      });
      if (out.duplicate) return json(200, { ok: true, duplicate: true });
      return json(200, { ok: true });
    } catch (e) {
      if (e instanceof WizardError && (e.code === "VALIDATION_FAILED" || e.code === "CONFLICT")) {
        log(c, "webhook_rejected", { integration: name, reason: e.code });
        return json(422, { ok: false });
      }
      log(c, "webhook_failed", { integration: name, sqlstate: (e as { code?: unknown }).code ?? null });
      return json(500, { ok: false });
    }
  });
  app.all("*", () => notFound());
  return app;
}
