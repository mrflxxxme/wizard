// Env names: specs/platform/deploy.yaml#local.env_vars (canonical list; the platform shop keys of M2-07 —
// docs/reviews/impl-notes/M2-07.md).
import { join, resolve } from "node:path";
import {
  isPlainAddress,
  type MailTransport,
  mailTransportOf,
  unisenderApiBase,
  YOOKASSA_API_BASE,
  YOOKASSA_IP_ALLOWLIST,
} from "@wizard/connectors";
import { buildDefaultTierFromEnv, type Tier } from "@wizard/llm";
import { V3_LIMITS } from "./billing/v3-limits.js";
import { DEFAULT_DB_URL, DEFAULT_ORG_ID } from "./db/index.js";

export interface Config {
  dbUrl: string;
  /**
   * api.yaml#info.x-auth: "dev" (M0 X-Wizard-Dev-User, only with WIZARD_AUTH_MODE=dev) or "session" (M1 email OTP,
   * the default). Host guard also applies with unsafeLocalExec / devLogin.
   */
  authMode: string;
  /** WIZARD_DEV_LOGIN=1: POST /auth/dev-login issues a session without OTP (local only, like runtime dev-login). */
  devLogin: boolean;
  /** WIZARD_PUBLIC_SCHEME: https → __Host- cookies with Secure (deploy.yaml#cloud.domains.cookies). */
  publicScheme: "http" | "https";
  /** WIZARD_SECRETS_KEY: OTP pepper and IP hashes are derived from it (db.yaml#auth_otps.code_hash, L3-25). */
  secretsKey: string;
  /** Dev mail outbox (.data/outbox/platform): OTP and invite letters while no SMTP provider is chosen. */
  outboxDir: string;
  nodeEnv: string | undefined;
  kubernetes: boolean;
  unsafeLocalExec: boolean;
  platformOrigin: string;
  runConcurrency: number;
  /**
   * V3-18: a run executing longer than this (time waiting in needs_input not counted) is stopped and finalized failed
   * RUN_TIMEOUT (WIZARD_RUN_DEADLINE_MIN, default 45 min).
   */
  runDeadlineMs: number;
  /** V3-18: a cancelled or timed-out run that does not stop by itself is finalized by force after this (default 20 s). */
  cancelGraceMs: number;
  milestone: string;
  /** Root of .data/artifacts (deploy.yaml#local.artifacts). */
  artifactsDir: string;
  /** Local secret backend (deploy.yaml#local.secrets: .data/secrets.enc, key WIZARD_SECRETS_KEY). */
  secretsFile: string;
  /** Worker: step outputs kept by reference outside dbos.* until the workflow ends (execution.M1.dbos_data). */
  stepsDir: string;
  /** Encrypted uploaded tables (.data/imports; deploy.yaml#cloud bucket imports, TTL 7 days). */
  importsDir: string;
  /** Base of draft preview URLs (runtime :4100, deploy.yaml#local.hosts.systems). */
  runtimePort: number;
  /**
   * WIZARD_SYSTEMS_DOMAIN (deploy.yaml#cloud.domains.systems): "localhost" (default) → http://<host>.localhost:<runtimePort>;
   * otherwise <publicScheme>://<slug>[--draft].<systemsDomain> through the ingress.
   */
  systemsDomain: string;
  /** WIZARD_PREVIEW_SECRET: getPreviewUrl issues one-time preview-login tokens (L3-11); null — M0 dev-login URLs. */
  previewSecret: string | null;
  /** WIZARD_RUNTIME_INTERNAL_URL: runtime internal port (health with revision for the publish smoke; L3-19). */
  runtimeInternalUrl: string | null;
  /**
   * WIZARD_INTERNAL_TOKEN: X-Wizard-Internal-Token shared with the runtime (M3-02): the runtime calls the AI gateway
   * (POST /internal/v1/ai/run), the platform calls the runtime's AI backfill. null — both are off (404).
   */
  internalToken: string | null;
  /** models.yaml#week0_decision.switch via @wizard/llm (env WIZARD_BUILD_DEFAULT_TIER); runs and OrgSettings use it. */
  buildDefaultTier: Tier;
  /**
   * Orgs without plan limits whose missing credits are auto-granted in the ledger (M1-03). Default: the M0 local
   * org in dev auth mode (the dev stand and e2e), otherwise none.
   */
  billingExemptOrgs: string[];
  /**
   * M2-07: the platform's own YooKassa shop (billing.yaml#recurring; never a client's shop). Keys only from
   * WIZARD_PLATFORM_YOOKASSA_SHOP_ID / WIZARD_PLATFORM_YOOKASSA_SECRET_KEY; null — payments are unavailable.
   */
  platformShop: { shopId: string; secretKey: string } | null;
  /** WIZARD_YOOKASSA_API_BASE (stubs in tests; shared with the connector, M2-02). */
  yookassaApiBase: string;
  /** WIZARD_YOOKASSA_IP_ALLOWLIST: sources of shop notifications (connectors/yookassa.yaml#webhooks). */
  yookassaIpAllowlist: readonly string[];
  /** WIZARD_TRUSTED_PROXIES: ingress CIDRs whose X-Forwarded-For is trusted (deploy.yaml#cloud.client_ip). */
  trustedProxies: readonly string[];
  /** 54-FZ receipts of platform payments (billing.yaml#recurring.receipts, #tax_note). */
  receipt: ReceiptConfig;
  /** workflows.yaml#workflows.publish.preconditions «M2: привязана карта РФ»: milestone ≥ M2 or production. */
  cardBindingRequired: boolean;
  /**
   * gates.yaml#report.levels_for_publish «prod: G0+G1+G2 на той же ревизии (M2)», workflows.yaml#workflows.publish
   * gate_G2 (milestone M2): milestone ≥ M2 or production. Off — the M1 publish (G0 for prod only).
   */
  prodG2Required: boolean;
  /**
   * WIZARD_REGISTRATION (D24_pilot_free): "open" (default) — any e-mail signs up; "invite" — a new e-mail signs in only
   * with a founder invitation (pilot CLI) or an active org invite (M2-15).
   */
  registration: string;
  /** WIZARD_FOUNDER_EMAIL (lower-case): the founder signs in on the invite-only pilot without an invitation. */
  founderEmail: string | null;
  /**
   * WIZARD_PAYMENTS=on|off (default on; D24_pilot_free): off — purchase, subscriptions and card binding answer 403
   * PAYMENTS_DISABLED, the shop webhook and renewals are off; plan, balance and ledger stay readable.
   */
  payments: boolean;
  /**
   * WIZARD_BUILD_PIPELINE: "v3" (default, D78 — the only supported configuration until v3 is accepted) — the grill
   * interview of v3, the system brief and the harness v3 (agents/interview-v3.ts, builds-v3); "modules" — beta v2 goal
   * interview and the system plan (B2-20), "legacy" — v1 interview, card and builder: emergency way back only. A system
   * keeps the pipeline it started with (the interview state says which).
   */
  buildPipeline: "legacy" | "modules" | "v3";
  /**
   * WIZARD_BUILD_PIPELINE_ORGS (V3-18): orgs whose new systems start on v3 whatever buildPipeline says — org ids and
   * org kinds (eval — measurement orgs, staff — the founder's); with v3 the default (D78) it matters only after an
   * emergency switch back. A system keeps the pipeline it started with.
   */
  buildPipelineOrgs: BuildPipelineOrgs;
  /**
   * WIZARD_G1_BROWSER (B2-28, gates.yaml#G1.browser.platform): "chromium" (default) — G1 of a plan build runs the goal
   * scenarios and the 390 px check in the process's headless Chromium; "off" — without them (build_metrics
   * goals.checked=false). A missing Chromium works as "off" and is logged (g1_browser_failed).
   */
  g1Browser: "chromium" | "off";
  /** WIZARD_G1_BROWSER_SLOTS (default 2): plan builds whose G1 uses the browser at once; the others wait their turn. */
  g1BrowserSlots: number;
  /**
   * WIZARD_LLM_MONTHLY_CAP_RUB (default 15 000 for V3, D77 (18б); was 6000, D20_eval_budget, D23_pilot): platform LLM
   * spend cap per calendar month (Europe/Moscow) — Σ billable cost_rub of live llm_calls of clients and eval (staff
   * orgs have their own pool, llmFounderMonthlyCapRub); reached → new builds and interview turns are refused.
   */
  /** WIZARD_LLM_DAILY_CAP_RUB (default 3000 for V3, D77 (18б); was 700, D75): platform LLM spend cap per Moscow day. */
  llmDailyCapRub: number;
  /**
   * WIZARD_LLM_STAFF_RESERVE_RUB (default 200; B2-01, grill-6 № 12): the part of the daily cap only staff orgs may
   * use — client and eval runs are refused once the day's total reaches llmDailyCapRub − this.
   */
  llmStaffReserveRub: number;
  /**
   * WIZARD_LLM_EVAL_DAILY_CAP_RUB (B2-01): daily cap of eval orgs' own spend (probes, measurements); default — the
   * daily cap (V3-01: a paid run is bounded by its pre-registered cap and the v3 budget; B2 had 300).
   */
  llmEvalDailyCapRub: number;
  /** WIZARD_B2_BUDGET_RUB (default 1000; B2-04, grill-6 № 18): eval spend budget of the beta v2 development. */
  b2BudgetRub: number;
  /** WIZARD_B2_BUDGET_SINCE (yyyy-mm-dd, Moscow; default 2026-10-07): start of the B2 budget window. */
  b2BudgetSince: string;
  /**
   * WIZARD_LLM_FOUNDER_MONTHLY_CAP_RUB (default 2500; V3-01, D77 (18б)): the founder's own pool per Moscow month — the
   * spend of staff orgs, apart from llmMonthlyCapRub of clients and eval.
   */
  llmFounderMonthlyCapRub: number;
  /** WIZARD_V3_BUDGET_RUB (default 12 000; V3-01, D77 (18б)): eval spend budget of the v3 development. */
  v3BudgetRub: number;
  /** WIZARD_V3_BUDGET_SINCE (yyyy-mm-dd, Moscow; default 2026-10-08): start of the v3 budget; the B2 one ends there. */
  v3BudgetSince: string;
  llmMonthlyCapRub: number;
  /**
   * WIZARD_LLM_BALANCE_ZAI / WIZARD_LLM_BALANCE_CLOUDRU = «<₽>@<ISO time>» (D76, models.yaml#fallback_rules): the balance
   * the founder saw in the provider console at that time; the platform estimates what is left from llm_calls.
   */
  llmBalances: LlmBalance[];
  /** WIZARD_LLM_BALANCE_WARN_RUB (default 300): an estimated remainder at or below it alerts the founder. */
  llmBalanceWarnRub: number;
  /** WIZARD_OPS_ALERT_URL / WIZARD_OPS_ALERT_CHAT_ID: founder alert webhook (deploy.yaml#pilot.observability). */
  opsAlert: { url: string; chatId: string | null } | null;
  /** WIZARD_OPS_ALERT_EMAIL (M2-09, D21_beta_moderation «алерты в Telegram и на почту»): founder alerts by platform mail. */
  opsAlertEmail: string | null;
  /**
   * WIZARD_FOUNDER_REVIEW=on|off (M2-09; abuse.yaml#identification.founder_review): apply orgs.require_founder_review —
   * the first prod publication of a system and a publication with new personal-data fields need an approved founder
   * review. Default: on with NODE_ENV=production (pilot, beta), off for dev and the test stands.
   */
  founderReviewRequired: boolean;
  /**
   * Platform mail over SMTP (M2-09): WIZARD_SMTP_HOST / _PORT / _USER / _PASSWORD / _FROM / _TLS; null — letters go to
   * the outbox files (outboxDir). Production needs it unless a mailer is injected. WIZARD_MAIL_TRANSPORT /
   * WIZARD_MAIL_API_BASE switch it to the Unisender Go HTTP API (email.yaml#transport).
   */
  smtp: PlatformSmtp | null;
  /** WIZARD_SMTP_HOST is set but WIZARD_SMTP_FROM is missing or not an address (refused at startup). */
  smtpFromInvalid: boolean;
  /** WIZARD_MAIL_TRANSPORT has an unknown value (refused at startup). */
  mailTransportInvalid: boolean;
}

export interface PlatformSmtp {
  host: string;
  port: number;
  /** implicit (465), starttls (587/25, mandatory), none — local receiver only, refused in production. */
  tls: "implicit" | "starttls" | "none";
  user: string | null;
  password: string | null;
  from: { address: string; name: string };
  /**
   * smtp (default) or unisender-api: the Unisender Go HTTP API on 443 with the password as X-API-KEY (the pilot's
   * server has the mail ports closed). Default unisender-api for a *.unisender.ru host.
   */
  transport?: MailTransport;
  /** API origin of transport unisender-api (WIZARD_MAIL_API_BASE, else derived from the host). */
  apiBase?: string;
}

/** WIZARD_SMTP_FROM: "Wizard <noreply@example.ru>" or a bare address; null when invalid. */
export function parseMailFrom(v: string | undefined): { address: string; name: string } | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  const m = /^(.*?)\s*<([^<>\s]+)>$/.exec(s);
  const address = (m ? m[2] : s) ?? "";
  const name = m ? (m[1] ?? "").replace(/^"(.*)"$/, "$1").trim() : "";
  return isPlainAddress(address) ? { address, name } : null;
}

const onOff = (v: string | undefined): boolean | null => {
  const s = (v ?? "").trim().toLowerCase();
  if (["on", "true", "1"].includes(s)) return true;
  if (["off", "false", "0"].includes(s)) return false;
  return null;
};

function smtpFromEnv(env: NodeJS.ProcessEnv): {
  smtp: PlatformSmtp | null;
  fromInvalid: boolean;
  transportInvalid: boolean;
} {
  const transport = mailTransportOf(env);
  const host = env.WIZARD_SMTP_HOST?.trim();
  if (!host) return { smtp: null, fromInvalid: false, transportInvalid: transport === null };
  const port = Number(env.WIZARD_SMTP_PORT ?? 465);
  const t = env.WIZARD_SMTP_TLS?.trim().toLowerCase();
  const tls: PlatformSmtp["tls"] =
    t === "implicit" || t === "starttls" || t === "none" ? t : port === 465 ? "implicit" : "starttls";
  const from = parseMailFrom(env.WIZARD_SMTP_FROM);
  if (!from) return { smtp: null, fromInvalid: true, transportInvalid: transport === null };
  return {
    smtp: {
      host,
      port,
      tls,
      user: env.WIZARD_SMTP_USER || null,
      password: env.WIZARD_SMTP_PASSWORD || null,
      from,
      transport: transport ?? "smtp",
      ...(transport === "unisender-api" ? { apiBase: unisenderApiBase(host, env.WIZARD_MAIL_API_BASE) } : {}),
    },
    fromInvalid: false,
    transportInvalid: transport === null,
  };
}

/** Default of WIZARD_LLM_MONTHLY_CAP_RUB (D77 (18б), on the time of V3; D23_pilot had 6 000 ₽). */
export const DEFAULT_LLM_MONTHLY_CAP_RUB = V3_LIMITS.monthlyCapRub;
/** Default of WIZARD_LLM_DAILY_CAP_RUB (D77 (18б), on the time of V3; D75 had 700 ₽). */
export const DEFAULT_LLM_DAILY_CAP_RUB = V3_LIMITS.dailyCapRub;
/** Default of WIZARD_LLM_STAFF_RESERVE_RUB (grill-6 № 12: «например, 200 ₽»). */
export const DEFAULT_LLM_STAFF_RESERVE_RUB = 200;
/** Default of WIZARD_LLM_FOUNDER_MONTHLY_CAP_RUB (D77 (18б): the founder's builds — 2 500 ₽ a month apart). */
export const DEFAULT_LLM_FOUNDER_MONTHLY_CAP_RUB = V3_LIMITS.founderMonthlyCapRub;
/** Default of WIZARD_V3_BUDGET_RUB (D77 (18б): the v3 development ≤ 12 000 ₽). */
export const DEFAULT_V3_BUDGET_RUB = V3_LIMITS.budgetRub;
/** Default of WIZARD_V3_BUDGET_SINCE: the day of D77. */
export const DEFAULT_V3_BUDGET_SINCE = V3_LIMITS.budgetSince;
/** Default of WIZARD_B2_BUDGET_RUB (grill-6 № 18: ≤ 1 000 ₽ for probes and the measurement). */
export const DEFAULT_B2_BUDGET_RUB = 1000;
/** Default of WIZARD_B2_BUDGET_SINCE: the day of D76. */
export const DEFAULT_B2_BUDGET_SINCE = "2026-10-07";
/** Default of WIZARD_LLM_BALANCE_WARN_RUB (D76): less than half a day of builds at the D75 daily cap is left. */
export const DEFAULT_LLM_BALANCE_WARN_RUB = 300;

/** A provider balance reconciled by hand (D76): `rub` seen in the provider console at `since`. */
export interface LlmBalance {
  provider: "zai" | "cloudru";
  rub: number;
  since: Date;
}

/** «5000@2026-10-06T12:00:00+03:00» → {rub, since}; empty → null; malformed → NaN fields (refused at startup). */
export function parseLlmBalance(provider: LlmBalance["provider"], v: string | undefined): LlmBalance | null {
  if (!v?.trim()) return null;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*@\s*(\S+)\s*$/.exec(v);
  return {
    provider,
    rub: m?.[1] ? Number(m[1].replace(",", ".")) : Number.NaN,
    since: new Date(m?.[2] ?? Number.NaN),
  };
}

export interface ReceiptConfig {
  /** WIZARD_RECEIPT_VAT_CODE (1..12, YooKassa vat_code incl. 5%/7% USN codes 7–10); null — not set (1 «без НДС» outside production). */
  vatCode: number | null;
  /** billing.yaml#tax_note: two items «право использования ПО» (share, own VAT) + «услуги хостинга». */
  split?: { softwareShare: number; softwareVatCode: number };
}

export const VAT_CODES: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

const list = (v: string | undefined): string[] | undefined => {
  const xs = (v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return xs.length > 0 ? xs : undefined;
};

/**
 * WIZARD_BUILD_PIPELINE → the pipeline of new systems: v3 by default (D78), modules (B2-20) and legacy only when named.
 */
export function buildPipelineOf(v: string | undefined): Config["buildPipeline"] {
  const p = (v ?? "").trim().toLowerCase();
  return p === "modules" || p === "legacy" ? p : "v3";
}

/** Org kinds WIZARD_BUILD_PIPELINE_ORGS takes besides org ids (db.yaml#orgs.kind; clients follow the pipeline). */
export const PIPELINE_ORG_KINDS = ["eval", "staff"] as const;
export type PipelineOrgKind = (typeof PIPELINE_ORG_KINDS)[number];
/** Orgs of WIZARD_BUILD_PIPELINE_ORGS: by id and by kind. */
export interface BuildPipelineOrgs {
  ids: string[];
  kinds: PipelineOrgKind[];
}

const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * WIZARD_BUILD_PIPELINE_ORGS (V3-18) → the orgs whose new systems start on v3: a comma list of org ids (uuid) and org
 * kinds (eval, staff), case-insensitive; anything else in the list is ignored.
 */
export function buildPipelineOrgsOf(v: string | undefined): BuildPipelineOrgs {
  const out: BuildPipelineOrgs = { ids: [], kinds: [] };
  for (const raw of (v ?? "").split(",")) {
    const x = raw.trim().toLowerCase();
    if (ORG_ID.test(x) && !out.ids.includes(x)) out.ids.push(x);
    else if (
      (PIPELINE_ORG_KINDS as readonly string[]).includes(x) &&
      !out.kinds.includes(x as PipelineOrgKind)
    )
      out.kinds.push(x as PipelineOrgKind);
  }
  return out;
}

/** WIZARD_BUILD_PIPELINE_ORGS names at least one org (the v3 build executor must then be on). */
export const pipelineOrgsOn = (c: Pick<Config, "buildPipelineOrgs">): boolean =>
  (c.buildPipelineOrgs?.ids.length ?? 0) + (c.buildPipelineOrgs?.kinds.length ?? 0) > 0;

/** The pipeline a new system of `org` starts on: v3 for an org of WIZARD_BUILD_PIPELINE_ORGS, else buildPipeline. */
export function pipelineOfOrg(
  c: Pick<Config, "buildPipeline" | "buildPipelineOrgs">,
  org: { id: string; kind?: string | null },
): Config["buildPipeline"] {
  const o = c.buildPipelineOrgs;
  if (o?.ids.includes(org.id.toLowerCase())) return "v3";
  if (org.kind && (o?.kinds as readonly string[] | undefined)?.includes(org.kind)) return "v3";
  return c.buildPipeline;
}

const milestoneRank = (m: string | undefined): number => Number(/^M(\d+)$/.exec(m ?? "")?.[1] ?? 0);

/** M2 platform rules: milestone ≥ M2 (WIZARD_MILESTONE) or NODE_ENV=production. */
const m2OrProd = (env: NodeJS.ProcessEnv, over: Partial<Config>): boolean =>
  milestoneRank(over.milestone ?? env.WIZARD_MILESTONE) >= 2 ||
  (over.nodeEnv ?? env.NODE_ENV) === "production";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

/** Minutes of an env variable as ms; not a positive number — the default. */
const positiveMinutes = (v: string | undefined, def: number): number => {
  const n = Number(v);
  return (v !== undefined && v !== "" && Number.isFinite(n) && n > 0 ? n : def) * 60_000;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env, over: Partial<Config> = {}): Config {
  const conc = Number(env.WIZARD_RUN_CONCURRENCY ?? 2);
  const mail = smtpFromEnv(env);
  return {
    dbUrl: env.WIZARD_DB_URL ?? env.DATABASE_URL ?? DEFAULT_DB_URL,
    authMode: env.WIZARD_AUTH_MODE || "session",
    devLogin: env.WIZARD_DEV_LOGIN === "1",
    publicScheme:
      env.WIZARD_PUBLIC_SCHEME === "https" || (!env.WIZARD_PUBLIC_SCHEME && env.NODE_ENV === "production")
        ? "https"
        : "http",
    secretsKey: env.WIZARD_SECRETS_KEY ?? "",
    outboxDir: join(REPO_ROOT, ".data", "outbox", "platform"),
    nodeEnv: env.NODE_ENV,
    kubernetes: !!env.KUBERNETES_SERVICE_HOST,
    unsafeLocalExec: env.WIZARD_UNSAFE_LOCAL_EXEC === "1",
    platformOrigin: env.WIZARD_PLATFORM_ORIGIN || "http://localhost:5173",
    runConcurrency: Number.isInteger(conc) && conc > 0 ? conc : 2,
    runDeadlineMs: positiveMinutes(env.WIZARD_RUN_DEADLINE_MIN, 45),
    cancelGraceMs: 20_000,
    milestone: env.WIZARD_MILESTONE || "M0",
    artifactsDir: join(REPO_ROOT, ".data", "artifacts"),
    runtimePort: 4100,
    systemsDomain: env.WIZARD_SYSTEMS_DOMAIN || "localhost",
    previewSecret: env.WIZARD_PREVIEW_SECRET || null,
    runtimeInternalUrl: env.WIZARD_RUNTIME_INTERNAL_URL || null,
    internalToken: env.WIZARD_INTERNAL_TOKEN || null,
    platformShop:
      env.WIZARD_PLATFORM_YOOKASSA_SHOP_ID && env.WIZARD_PLATFORM_YOOKASSA_SECRET_KEY
        ? {
            shopId: env.WIZARD_PLATFORM_YOOKASSA_SHOP_ID,
            secretKey: env.WIZARD_PLATFORM_YOOKASSA_SECRET_KEY,
          }
        : null,
    yookassaApiBase: env.WIZARD_YOOKASSA_API_BASE || YOOKASSA_API_BASE,
    yookassaIpAllowlist: list(env.WIZARD_YOOKASSA_IP_ALLOWLIST) ?? YOOKASSA_IP_ALLOWLIST,
    trustedProxies: list(env.WIZARD_TRUSTED_PROXIES) ?? [],
    receipt: { vatCode: env.WIZARD_RECEIPT_VAT_CODE ? Number(env.WIZARD_RECEIPT_VAT_CODE) : null },
    registration: env.WIZARD_REGISTRATION || "open",
    founderEmail: env.WIZARD_FOUNDER_EMAIL?.trim().toLowerCase() || null,
    payments: !["off", "false", "0"].includes((env.WIZARD_PAYMENTS ?? "").trim().toLowerCase()),
    buildPipeline: buildPipelineOf(env.WIZARD_BUILD_PIPELINE),
    buildPipelineOrgs: buildPipelineOrgsOf(env.WIZARD_BUILD_PIPELINE_ORGS),
    g1Browser: ["off", "false", "0"].includes((env.WIZARD_G1_BROWSER ?? "").trim().toLowerCase())
      ? "off"
      : "chromium",
    g1BrowserSlots: Math.max(1, Number(env.WIZARD_G1_BROWSER_SLOTS) || 2),
    llmDailyCapRub: env.WIZARD_LLM_DAILY_CAP_RUB
      ? Number(env.WIZARD_LLM_DAILY_CAP_RUB)
      : DEFAULT_LLM_DAILY_CAP_RUB,
    llmStaffReserveRub: env.WIZARD_LLM_STAFF_RESERVE_RUB
      ? Number(env.WIZARD_LLM_STAFF_RESERVE_RUB)
      : DEFAULT_LLM_STAFF_RESERVE_RUB,
    llmEvalDailyCapRub: Number(
      env.WIZARD_LLM_EVAL_DAILY_CAP_RUB || env.WIZARD_LLM_DAILY_CAP_RUB || DEFAULT_LLM_DAILY_CAP_RUB,
    ),
    b2BudgetRub: env.WIZARD_B2_BUDGET_RUB ? Number(env.WIZARD_B2_BUDGET_RUB) : DEFAULT_B2_BUDGET_RUB,
    b2BudgetSince: env.WIZARD_B2_BUDGET_SINCE?.trim() || DEFAULT_B2_BUDGET_SINCE,
    llmFounderMonthlyCapRub: env.WIZARD_LLM_FOUNDER_MONTHLY_CAP_RUB
      ? Number(env.WIZARD_LLM_FOUNDER_MONTHLY_CAP_RUB)
      : DEFAULT_LLM_FOUNDER_MONTHLY_CAP_RUB,
    v3BudgetRub: env.WIZARD_V3_BUDGET_RUB ? Number(env.WIZARD_V3_BUDGET_RUB) : DEFAULT_V3_BUDGET_RUB,
    v3BudgetSince: env.WIZARD_V3_BUDGET_SINCE?.trim() || DEFAULT_V3_BUDGET_SINCE,
    llmMonthlyCapRub: env.WIZARD_LLM_MONTHLY_CAP_RUB
      ? Number(env.WIZARD_LLM_MONTHLY_CAP_RUB)
      : DEFAULT_LLM_MONTHLY_CAP_RUB,
    llmBalances: [
      parseLlmBalance("zai", env.WIZARD_LLM_BALANCE_ZAI),
      parseLlmBalance("cloudru", env.WIZARD_LLM_BALANCE_CLOUDRU),
    ].filter((b): b is LlmBalance => b !== null),
    llmBalanceWarnRub: env.WIZARD_LLM_BALANCE_WARN_RUB
      ? Number(env.WIZARD_LLM_BALANCE_WARN_RUB)
      : DEFAULT_LLM_BALANCE_WARN_RUB,
    opsAlert: env.WIZARD_OPS_ALERT_URL
      ? { url: env.WIZARD_OPS_ALERT_URL, chatId: env.WIZARD_OPS_ALERT_CHAT_ID || null }
      : null,
    opsAlertEmail: env.WIZARD_OPS_ALERT_EMAIL?.trim() || null,
    founderReviewRequired:
      onOff(env.WIZARD_FOUNDER_REVIEW) ?? (over.nodeEnv ?? env.NODE_ENV) === "production",
    smtp: mail.smtp,
    smtpFromInvalid: mail.fromInvalid,
    mailTransportInvalid: mail.transportInvalid,
    ...over,
    // Tests that move artifactsDir get the other .data stores next to it.
    secretsFile:
      over.secretsFile ??
      (over.artifactsDir ? join(over.artifactsDir, ".secrets.enc") : join(REPO_ROOT, ".data", "secrets.enc")),
    stepsDir:
      over.stepsDir ??
      (over.artifactsDir ? join(over.artifactsDir, ".steps") : join(REPO_ROOT, ".data", "steps")),
    importsDir:
      over.importsDir ??
      (over.artifactsDir ? join(over.artifactsDir, ".imports") : join(REPO_ROOT, ".data", "imports")),
    buildDefaultTier: over.buildDefaultTier ?? buildDefaultTierFromEnv(env),
    billingExemptOrgs:
      over.billingExemptOrgs ?? ((over.authMode ?? env.WIZARD_AUTH_MODE) === "dev" ? [DEFAULT_ORG_ID] : []),
    cardBindingRequired: over.cardBindingRequired ?? m2OrProd(env, over),
    prodG2Required: over.prodG2Required ?? m2OrProd(env, over),
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export class StartupError extends Error {
  override name = "StartupError";
}

/** Local-only modes: host guard on, loopback bind required (deploy.yaml#local.bind, #local.host_guard). */
export const isLocalMode = (c: Config): boolean => c.authMode === "dev" || c.unsafeLocalExec || c.devLogin;

/**
 * api.yaml#info.x-auth.M1 and deploy.yaml#local.bind: dev auth, dev-login and unsafe exec are refused with
 * NODE_ENV=production, inside Kubernetes and on a non-loopback bind; production needs WIZARD_SECRETS_KEY.
 */
export function assertStartupAllowed(c: Config, bindHost?: string): void {
  if (c.authMode !== "dev" && c.authMode !== "session")
    throw new StartupError(`неизвестный WIZARD_AUTH_MODE=${c.authMode} (dev | session)`);
  const on = [
    c.authMode === "dev" ? "WIZARD_AUTH_MODE=dev" : "",
    c.devLogin ? "WIZARD_DEV_LOGIN=1" : "",
    c.unsafeLocalExec ? "WIZARD_UNSAFE_LOCAL_EXEC=1" : "",
  ].filter(Boolean);
  if (on.length > 0) {
    const what = on.join(", ");
    if (c.nodeEnv === "production") throw new StartupError(`${what} запрещено при NODE_ENV=production`);
    if (c.kubernetes) throw new StartupError(`${what} запрещено внутри Kubernetes`);
    if (bindHost !== undefined && !LOOPBACK.has(bindHost) && !/^127(\.\d{1,3}){3}$/.test(bindHost))
      throw new StartupError(
        `в режиме разработки (${what}) слушать можно только 127.0.0.1 (HOST=${bindHost})`,
      );
  }
  if (c.registration !== "open" && c.registration !== "invite")
    throw new StartupError(`неизвестный WIZARD_REGISTRATION=${c.registration} (open | invite)`);
  if (!Number.isFinite(c.llmDailyCapRub) || c.llmDailyCapRub <= 0)
    throw new StartupError("WIZARD_LLM_DAILY_CAP_RUB: нужен положительный лимит в рублях");
  if (!Number.isFinite(c.llmStaffReserveRub) || c.llmStaffReserveRub < 0)
    throw new StartupError("WIZARD_LLM_STAFF_RESERVE_RUB: нужен резерв в рублях, не меньше нуля");
  if (!Number.isFinite(c.llmEvalDailyCapRub) || c.llmEvalDailyCapRub <= 0)
    throw new StartupError("WIZARD_LLM_EVAL_DAILY_CAP_RUB: нужен положительный лимит в рублях");
  if (!Number.isFinite(c.b2BudgetRub) || c.b2BudgetRub <= 0)
    throw new StartupError("WIZARD_B2_BUDGET_RUB: нужен положительный бюджет в рублях");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.b2BudgetSince) || Number.isNaN(Date.parse(c.b2BudgetSince)))
    throw new StartupError("WIZARD_B2_BUDGET_SINCE: нужна дата вида 2026-10-06");
  if (!Number.isFinite(c.llmMonthlyCapRub) || c.llmMonthlyCapRub <= 0)
    throw new StartupError("WIZARD_LLM_MONTHLY_CAP_RUB: нужен положительный лимит в рублях");
  if (!Number.isFinite(c.llmFounderMonthlyCapRub) || c.llmFounderMonthlyCapRub <= 0)
    throw new StartupError("WIZARD_LLM_FOUNDER_MONTHLY_CAP_RUB: нужен положительный лимит в рублях");
  if (!Number.isFinite(c.v3BudgetRub) || c.v3BudgetRub <= 0)
    throw new StartupError("WIZARD_V3_BUDGET_RUB: нужен положительный бюджет в рублях");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.v3BudgetSince) || Number.isNaN(Date.parse(c.v3BudgetSince)))
    throw new StartupError("WIZARD_V3_BUDGET_SINCE: нужна дата вида 2026-10-08");
  for (const b of c.llmBalances)
    if (!Number.isFinite(b.rub) || Number.isNaN(b.since.getTime()))
      throw new StartupError(
        `WIZARD_LLM_BALANCE_${b.provider.toUpperCase()}: нужен формат «<остаток ₽>@<время ISO 8601>», например 5000@2026-10-06T12:00:00+03:00`,
      );
  if (!Number.isFinite(c.llmBalanceWarnRub) || c.llmBalanceWarnRub < 0)
    throw new StartupError("WIZARD_LLM_BALANCE_WARN_RUB: нужен порог в рублях (0 и больше)");
  if (c.nodeEnv === "production" && c.billingExemptOrgs.length > 0)
    throw new StartupError("организации без учёта кредитов запрещены при NODE_ENV=production");
  const vat = c.receipt.vatCode;
  if (vat !== null && !VAT_CODES.has(vat))
    throw new StartupError("WIZARD_RECEIPT_VAT_CODE: допустимы коды НДС ЮKassa 1–12");
  if (c.nodeEnv === "production" && c.platformShop && vat === null)
    throw new StartupError("WIZARD_RECEIPT_VAT_CODE обязателен для чеков платежей платформы (54-ФЗ)");
  if (c.smtpFromInvalid)
    throw new StartupError(
      'WIZARD_SMTP_FROM: нужен адрес отправителя писем платформы, например "Wizard <noreply@домен>"',
    );
  if (c.mailTransportInvalid)
    throw new StartupError("WIZARD_MAIL_TRANSPORT: допустимо smtp или unisender-api");
  if (c.smtp?.transport === "unisender-api") {
    if (!c.smtp.password)
      throw new StartupError("WIZARD_SMTP_PASSWORD: нужен API-ключ Unisender Go (он же пароль SMTP)");
    if (c.nodeEnv === "production" && !c.smtp.apiBase?.startsWith("https://"))
      throw new StartupError("WIZARD_MAIL_API_BASE: нужен https-адрес");
  }
  if (c.smtp && !(Number.isInteger(c.smtp.port) && c.smtp.port > 0 && c.smtp.port < 65536))
    throw new StartupError("WIZARD_SMTP_PORT: нужен номер порта");
  if (c.nodeEnv === "production" && c.smtp?.tls === "none")
    throw new StartupError(
      "WIZARD_SMTP_TLS=none запрещено при NODE_ENV=production (только TLS 465 или STARTTLS)",
    );
  if (c.opsAlertEmail !== null && !isPlainAddress(c.opsAlertEmail))
    throw new StartupError("WIZARD_OPS_ALERT_EMAIL: нужен адрес почты");
  if (c.nodeEnv === "production" && c.secretsKey.length < 32)
    throw new StartupError("WIZARD_SECRETS_KEY обязателен при NODE_ENV=production");
}
