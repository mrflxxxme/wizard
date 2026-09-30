// Env names: specs/platform/deploy.yaml#local.env_vars (canonical list, no new names).
import { join, resolve } from "node:path";
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
  /** Encrypted uploaded tables (.data/imports; deploy.yaml#cloud bucket imports, TTL 7 days). */
  importsDir: string;
  /** Base of draft preview URLs (runtime :4100, deploy.yaml#local.hosts.systems). */
  runtimePort: number;
  /** models.yaml#week0_decision.switch via @wizard/llm (env WIZARD_BUILD_DEFAULT_TIER); runs and OrgSettings use it. */
  buildDefaultTier: Tier;
  /**
   * Orgs without plan limits whose missing credits are auto-granted in the ledger (M1-03). Default: the M0 local
   * org in dev auth mode (the dev stand and e2e), otherwise none.
   */
  billingExemptOrgs: string[];
}

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env, over: Partial<Config> = {}): Config {
  const conc = Number(env.WIZARD_RUN_CONCURRENCY ?? 2);
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
    ...over,
    importsDir:
      over.importsDir ??
      (over.artifactsDir ? join(over.artifactsDir, ".imports") : join(REPO_ROOT, ".data", "imports")),
    buildDefaultTier: over.buildDefaultTier ?? buildDefaultTierFromEnv(env),
    billingExemptOrgs:
      over.billingExemptOrgs ?? ((over.authMode ?? env.WIZARD_AUTH_MODE) === "dev" ? [DEFAULT_ORG_ID] : []),
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
  if (c.nodeEnv === "production" && c.billingExemptOrgs.length > 0)
    throw new StartupError("организации без учёта кредитов запрещены при NODE_ENV=production");
  if (c.nodeEnv === "production" && c.secretsKey.length < 32)
    throw new StartupError("WIZARD_SECRETS_KEY обязателен при NODE_ENV=production");
}
