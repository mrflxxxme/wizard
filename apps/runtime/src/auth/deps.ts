// Services of end-user login (runtime.yaml#auth.methods_M1, M1-05), built once per runtime app.
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WizardError } from "@wizard/sdk";
import type postgres from "postgres";
import { isLocalMode, type RuntimeEnv } from "../env.js";
import type { OutboxMessage } from "../http/context.js";
import type { ConnectorHost } from "../preview/connectors.js";
import type { RegistryEntry } from "../registry.js";
import type { LoadedSystem } from "../system.js";
import { type AuthKeys, authKeys } from "./keys.js";
import { type OtpLimiter, pgOtpLimiter } from "./limits.js";

export type Plan = "free" | "start" | "business";

export interface OrgInfo {
  orgId: string;
  plan: Plan;
}

export interface SmsMessage {
  to: string;
  text: string;
  systemId: string;
  env: string;
}

/** SMS provider of the platform (E-ACCESS: not chosen yet). */
export type SmsSender = (m: SmsMessage) => Promise<void>;

export interface RuntimeAuthOptions {
  /** Master key of OTP pepper and sealing (default: WIZARD_SECRETS_KEY). */
  secretsKey?: string;
  /** Real SMS provider for prod phone OTP; without it prod phone OTP works only in local modes (dev-sender). */
  smsSender?: SmsSender;
  /** Org and plan of a deployment (SMS budget); default: platform.systems ⋈ platform.orgs when readable. */
  orgOf?: (entry: RegistryEntry) => Promise<OrgInfo | null>;
  /** Telegram OIDC base (tests: a local stub); default WIZARD_TELEGRAM_OAUTH_BASE or https://oauth.telegram.org. */
  telegramOAuthBase?: string;
  /** fetch for the OIDC token and JWKS requests. */
  fetch?: typeof fetch;
  /** Cross-system OTP counters; default wz_runtime.otp_sends over the runtime connection. */
  limiter?: OtpLimiter;
}

export interface AuthDeps {
  env: RuntimeEnv;
  clock: () => Date;
  keys: AuthKeys;
  limiter: OtpLimiter;
  connectors: ConnectorHost;
  outbox: OutboxMessage[];
  outboxDir: string | null;
  smsSender: SmsSender | null;
  orgOf: (entry: RegistryEntry) => Promise<OrgInfo | null>;
  oauthBase: string;
  fetch: typeof fetch;
  log?: (line: Record<string, unknown>) => void;
}

export interface AuthDepsInput {
  sql: postgres.Sql;
  env: RuntimeEnv;
  clock: () => Date;
  connectors: ConnectorHost;
  outbox: OutboxMessage[];
  outboxDir: string | null;
  log?: (line: Record<string, unknown>) => void;
  options?: RuntimeAuthOptions;
}

export function createAuthDeps(i: AuthDepsInput): AuthDeps {
  const o = i.options ?? {};
  return {
    env: i.env,
    clock: i.clock,
    keys: authKeys(o.secretsKey ?? process.env.WIZARD_SECRETS_KEY, i.env.nodeEnv),
    limiter: o.limiter ?? pgOtpLimiter(i.sql),
    connectors: i.connectors,
    outbox: i.outbox,
    outboxDir: i.outboxDir,
    smsSender: o.smsSender ?? null,
    orgOf: o.orgOf ?? platformOrgOf(i.sql),
    oauthBase: (
      o.telegramOAuthBase ??
      process.env.WIZARD_TELEGRAM_OAUTH_BASE ??
      "https://oauth.telegram.org"
    ).replace(/\/+$/, ""),
    fetch: o.fetch ?? globalThis.fetch,
    log: i.log,
  };
}

/**
 * Reads the org of a system from the platform tables (local: the runtime connects as the owner of everything). The
 * cloud runtime role may not read them (42501) — then null, and the caller falls back to features.phoneOtp.
 */
export function platformOrgOf(sql: postgres.Sql): (entry: RegistryEntry) => Promise<OrgInfo | null> {
  const cache = new Map<string, { at: number; v: OrgInfo | null }>();
  return async (entry) => {
    const hit = cache.get(entry.systemId);
    if (hit && Date.now() - hit.at < 60_000) return hit.v;
    let v: OrgInfo | null = null;
    try {
      const rows = await sql`
        select o.id::text as org_id, o.plan from platform.systems s
        join platform.orgs o on o.id = s.org_id where s.schema_key = ${entry.systemId} limit 1`;
      const r = rows[0];
      if (r && (r.plan === "free" || r.plan === "start" || r.plan === "business"))
        v = { orgId: String(r.org_id), plan: r.plan };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "42P01" && code !== "3F000" && code !== "42501" && code !== "42703") throw e;
    }
    cache.set(entry.systemId, { at: Date.now(), v });
    return v;
  };
}

/** Org key and plan for the SMS budget: the platform org, or the system itself priced by features.phoneOtp. */
export async function budgetOf(deps: AuthDeps, sys: LoadedSystem): Promise<{ orgKey: string; plan: Plan }> {
  const org = await deps.orgOf(sys.entry);
  if (org) return { orgKey: `org:${org.orgId}`, plan: org.plan };
  return { orgKey: `system:${sys.entry.systemId}`, plan: sys.entry.features.phoneOtp ? "start" : "free" };
}

/**
 * Where a phone code goes: drafts always into the preview test box (dev-sender, connectors test_mode); prod —
 * the SMS provider, or the dev-sender in local modes. null → no way to send an SMS.
 */
export function smsRoute(deps: AuthDeps, sys: LoadedSystem): "dev" | "provider" | null {
  if (sys.entry.env === "draft") return "dev";
  if (deps.smsSender) return "provider";
  return isLocalMode(deps.env) ? "dev" : null;
}

/** Dev-sender: the SMS lands in the runtime outbox and in <outboxDir>/<system>/sms.jsonl. */
export async function devSendSms(deps: AuthDeps, m: SmsMessage): Promise<void> {
  const at = deps.clock().toISOString();
  deps.outbox.push({ integration: "_sms", action: "otp", payload: { to: m.to, text: m.text }, at });
  if (!deps.outboxDir) return;
  if (!/^[a-z0-9]{1,64}$/.test(m.systemId)) throw new WizardError("INTERNAL");
  const dir = join(deps.outboxDir, m.systemId);
  await mkdir(dir, { recursive: true });
  await appendFile(
    join(dir, "sms.jsonl"),
    `${JSON.stringify({ ts: at, system: m.systemId, env: m.env, connector: "sms", action: "otp", payload: { to: m.to, text: m.text } })}\n`,
  );
}
