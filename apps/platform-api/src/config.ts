// Env names: specs/platform/deploy.yaml#local.env_vars (canonical list; the platform shop keys of M2-07 —
// docs/reviews/impl-notes/M2-07.md).
import { join, resolve } from "node:path";
import { isPlainAddress, YOOKASSA_API_BASE, YOOKASSA_IP_ALLOWLIST } from "@wizard/connectors";
import { buildDefaultTierFromEnv, type Tier } from "@wizard/llm";
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
   * WIZARD_LLM_MONTHLY_CAP_RUB (default 6000; D20_eval_budget, D23_pilot): platform LLM spend cap per calendar month
   * (Europe/Moscow) — Σ billable cost_rub of live llm_calls; reached → new builds and interview turns are refused.
   */
  llmMonthlyCapRub: number;
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
   * the outbox files (outboxDir). Production needs it unless a mailer is injected.
   */
  smtp: PlatformSmtp | null;
  /** WIZARD_SMTP_HOST is set but WIZARD_SMTP_FROM is missing or not an address (refused at startup). */
  smtpFromInvalid: boolean;
}

export interface PlatformSmtp {
  host: string;
  port: number;
  /** implicit (465), starttls (587/25, mandatory), none — local receiver only, refused in production. */
  tls: "implicit" | "starttls" | "none";
  user: string | null;
  password: string | null;
  from: { address: string; name: string };
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

function smtpFromEnv(env: NodeJS.ProcessEnv): { smtp: PlatformSmtp | null; fromInvalid: boolean } {
  const host = env.WIZARD_SMTP_HOST?.trim();
  if (!host) return { smtp: null, fromInvalid: false };
  const port = Number(env.WIZARD_SMTP_PORT ?? 465);
  const t = env.WIZARD_SMTP_TLS?.trim().toLowerCase();
  const tls: PlatformSmtp["tls"] =
    t === "implicit" || t === "starttls" || t === "none" ? t : port === 465 ? "implicit" : "starttls";
  const from = parseMailFrom(env.WIZARD_SMTP_FROM);
  if (!from) return { smtp: null, fromInvalid: true };
  return {
    smtp: {
      host,
      port,
      tls,
      user: env.WIZARD_SMTP_USER || null,
      password: env.WIZARD_SMTP_PASSWORD || null,
      from,
    },
    fromInvalid: false,
  };
}

/** Default of WIZARD_LLM_MONTHLY_CAP_RUB (D23_pilot: models ≤ 10 000 ₽/month, of them live eval ≤ 4 000 ₽). */
export const DEFAULT_LLM_MONTHLY_CAP_RUB = 6000;

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

const milestoneRank = (m: string | undefined): number => Number(/^M(\d+)$/.exec(m ?? "")?.[1] ?? 0);

/** M2 platform rules: milestone ≥ M2 (WIZARD_MILESTONE) or NODE_ENV=production. */
const m2OrProd = (env: NodeJS.ProcessEnv, over: Partial<Config>): boolean =>
  milestoneRank(over.milestone ?? env.WIZARD_MILESTONE) >= 2 ||
  (over.nodeEnv ?? env.NODE_ENV) === "production";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

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
    llmMonthlyCapRub: env.WIZARD_LLM_MONTHLY_CAP_RUB
      ? Number(env.WIZARD_LLM_MONTHLY_CAP_RUB)
      : DEFAULT_LLM_MONTHLY_CAP_RUB,
    opsAlert: env.WIZARD_OPS_ALERT_URL
      ? { url: env.WIZARD_OPS_ALERT_URL, chatId: env.WIZARD_OPS_ALERT_CHAT_ID || null }
      : null,
    opsAlertEmail: env.WIZARD_OPS_ALERT_EMAIL?.trim() || null,
    founderReviewRequired:
      onOff(env.WIZARD_FOUNDER_REVIEW) ?? (over.nodeEnv ?? env.NODE_ENV) === "production",
    smtp: mail.smtp,
    smtpFromInvalid: mail.fromInvalid,
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
  if (!Number.isFinite(c.llmMonthlyCapRub) || c.llmMonthlyCapRub <= 0)
    throw new StartupError("WIZARD_LLM_MONTHLY_CAP_RUB: нужен положительный лимит в рублях");
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
