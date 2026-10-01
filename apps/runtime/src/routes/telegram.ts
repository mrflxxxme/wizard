// Telegram endpoints (connectors/telegram.yaml#chat_linking, #webhooks, #bots.platform.webhook):
// POST /api/telegram/:integration/link, POST /_wizard/hooks/telegram/:integration/:hookToken (own bot) and the
// shared bot's /_wizard/hooks/telegram/_platform/:hookToken on the bare systems domain.
import { type Integration, quoteIdent, systemRoleName } from "@wizard/appspec";
import {
  createTelegramLink,
  handlePlatformUpdate,
  handleTelegramUpdate,
  isConnectorError,
  type PlatformHookDeps,
  parseTelegramUpdate,
  platformHookToken,
  secretMatches,
  TELEGRAM_SECRET_HEADER,
  type TelegramConfig,
  telegramBot,
  telegramHookToken,
  telegramWebhookSecret,
  WEBHOOK_BODY_MAX,
  type WebhookReply,
} from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import type postgres from "postgres";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { notFoundPage } from "../http/errors.js";
import { sessionOf } from "../http/subject.js";
import type { ConnectorHost } from "../preview/connectors.js";
import { connectorFailure } from "../preview/http.js";
import type { SystemCache } from "../system.js";

function telegramIntegration(c: RuntimeContext, host: ConnectorHost, name: string): Integration | null {
  return host.integrations(c.get("system").spec, "telegram").find((i) => i.name === name) ?? null;
}

const unauthorized = () => Response.json({ ok: false }, { status: 401 });

/** Body ≤ 256 KiB as JSON; null when too large or not JSON. */
async function readUpdate(req: Request): Promise<{ tooLarge: boolean; body: unknown }> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > WEBHOOK_BODY_MAX) return { tooLarge: true, body: null };
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > WEBHOOK_BODY_MAX) return { tooLarge: true, body: null };
  try {
    return { tooLarge: false, body: JSON.parse(new TextDecoder().decode(buf)) };
  } catch {
    return { tooLarge: false, body: null };
  }
}

/** Telegram accepts a method call in the webhook response: the reply needs no outbound request. */
const answer = (r: WebhookReply) => Response.json(r.reply ?? {}, { status: 200 });

/** /api/telegram (runtime.yaml#service_endpoints.api_extra). */
export function telegramApiRoutes(host: ConnectorHost): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.post("/:integration/link", async (c) => {
    const { subject } = await sessionOf(c);
    if (subject.id === null) throw new WizardError("UNAUTHENTICATED");
    const integ = telegramIntegration(c, host, c.req.param("integration"));
    if (!integ) throw new WizardError("NOT_FOUND", { message: "Интеграция Telegram не найдена" });
    try {
      const scheme = c.get("services").env.publicScheme;
      return c.json(
        await createTelegramLink(
          host.ctx(c.get("system"), integ, `${scheme}://${c.get("host")}`),
          subject.id,
        ),
        200,
        {
          "Cache-Control": "no-store",
        },
      );
    } catch (e) {
      return connectorFailure(c, e);
    }
  });
  return app;
}

/** /_wizard/hooks/telegram/:integration/:hookToken — the client's own bot; verification before parsing. */
export function telegramHookRoutes(host: ConnectorHost): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.post("/:integration/:hookToken", async (c) => {
    const integ = telegramIntegration(c, host, c.req.param("integration"));
    if (!integ || telegramBot((integ.config ?? {}) as TelegramConfig) !== "own") return notFoundPage();
    const ctx = host.ctx(c.get("system"), integ);
    let secret: string;
    let hookToken: string;
    try {
      secret = await telegramWebhookSecret(ctx);
      hookToken = await telegramHookToken(ctx);
    } catch (e) {
      if (isConnectorError(e)) return notFoundPage();
      throw e;
    }
    if (!secretMatches(c.req.param("hookToken"), hookToken)) return notFoundPage();
    if (!secretMatches(c.req.header(TELEGRAM_SECRET_HEADER), secret)) return unauthorized();
    const { tooLarge, body } = await readUpdate(c.req.raw);
    if (tooLarge) return new Response(null, { status: 413 });
    const update = parseTelegramUpdate(body);
    if (!update) return c.json({});
    return answer(await handleTelegramUpdate(ctx, update));
  });
  app.all("*", () => notFoundPage());
  return app;
}

/** Recently handled update_ids of the shared bot (idempotency across systems within this process). */
function seenSet(limit = 10_000): (id: number) => boolean {
  const seen = new Set<number>();
  return (id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > limit) seen.delete(seen.values().next().value as number);
    return false;
  };
}

export interface PlatformHookOptions {
  host: ConnectorHost;
  systems: SystemCache;
  sql: postgres.Sql;
  /** Role every transaction switches to (as DataAccess); null — the connecting role. */
  dbRole: string | null;
  log?: (line: Record<string, unknown>) => void;
}

/** users.telegram_chat_id = NULL for `chatId` in every system schema the runtime role can update. */
async function clearEverywhere(o: PlatformHookOptions, chatId: string): Promise<void> {
  if (!/^-?\d{1,20}$/.test(chatId)) return;
  const role = o.dbRole ?? null;
  const rows = await o.sql`
    select n.nspname as schema from pg_catalog.pg_namespace n
    join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = 'users' and c.relkind = 'r'
    where n.nspname like 'app\\_%'
      and pg_catalog.has_table_privilege(coalesce(${role}::text, current_user), c.oid, 'UPDATE')`;
  for (const r of rows) {
    const schema = String(r.schema);
    const table = `${quoteIdent(schema)}.${quoteIdent("users")}`;
    // System access = the schema's system DB role (isolation.yaml#db_access, L3-20); a schema whose role is
    // missing (created before M2) is skipped rather than failing the whole webhook.
    await o.sql
      .begin(async (tx) => {
        await tx.unsafe("select pg_catalog.set_config('role', $1, true)", [systemRoleName(schema)]);
        await tx.unsafe(`update ${table} set telegram_chat_id = null where telegram_chat_id = $1`, [chatId]);
      })
      .catch(() => undefined);
  }
}

/** Handler of the shared bot's webhook (bare systems domain); null when the path is not that webhook. */
export function platformTelegramHook(o: PlatformHookOptions): (req: Request) => Promise<Response | null> {
  const seen = seenSet();
  const deps: PlatformHookDeps = {
    async locate({ systemId, env }) {
      const sys = await o.systems.byId(systemId, env);
      if (!sys || sys.entry.suspended) return null;
      const integ = o.host
        .integrations(sys.spec, "telegram")
        .find((i) => telegramBot((i.config ?? {}) as TelegramConfig) === "platform");
      return integ ? o.host.ctx(sys, integ) : null;
    },
    clearEverywhere: (chatId) => clearEverywhere(o, chatId),
    seen,
  };
  return async (req) => {
    const m = /^\/_wizard\/hooks\/telegram\/_platform\/([^/]+)$/.exec(new URL(req.url).pathname);
    if (!m) return null;
    if (req.method !== "POST") return notFoundPage();
    let expected: string;
    let secret: string;
    try {
      secret = await o.host.platform.secrets.get("telegram_webhook_secret");
      expected = await platformHookToken(o.host.platform);
    } catch (e) {
      if (isConnectorError(e)) return notFoundPage();
      throw e;
    }
    if (!secretMatches(m[1], expected)) return notFoundPage();
    if (!secretMatches(req.headers.get(TELEGRAM_SECRET_HEADER), secret)) return unauthorized();
    const { tooLarge, body } = await readUpdate(req);
    if (tooLarge) return new Response(null, { status: 413 });
    const update = parseTelegramUpdate(body);
    if (!update) return Response.json({});
    return answer(await handlePlatformUpdate(update, deps));
  };
}
