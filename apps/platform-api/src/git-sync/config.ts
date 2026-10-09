// Configuration of the repository sync (V3-31; deploy.yaml#local.env_vars.git_sync): the platform's GitHub App, the
// gitlab.com OAuth application, the KMS that wraps the sealed tokens (as BYOK: OpenBao Transit in the cloud, the local
// store on dev stands) and the queue timer. GitHub is available when the App is configured; GitLab.com when its OAuth
// application is; a self-managed GitLab brings its own OAuth application (the owner enters it), so it needs neither.

import { LocalTransit, OpenBaoTransit, type TransitKms } from "../byok/kms.js";
import type { SecretStore } from "../secrets/store.js";

export type Env = Record<string, string | undefined>;

export interface GitHubAppConfig {
  appId: string;
  slug: string;
  /** PEM of the App's private key (RS256 JWT for installation tokens). */
  privateKey: string;
  webhookSecret: string;
  /** OAuth client of the App: the setup callback proves the user can see the installation (GET /user/installations). */
  clientId: string;
  clientSecret: string;
  apiBase: string;
  webBase: string;
}

export interface GitLabAppConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface GitSyncConfig {
  /** WIZARD_GIT_SYNC=off hides the feature. */
  enabled: boolean;
  github: GitHubAppConfig | null;
  gitlab: GitLabAppConfig | null;
  /** Queue timer period in-process (0 — no timer, tests drive tick()). */
  tickMs: number;
  /** How often an active link is reconciled without a webhook (missed deliveries, PR state, default branch head). */
  reconcileMs: number;
  kms: "local" | "openbao";
  openbao: { addr: string; token: string; mount: string; keyName: string } | null;
  /** Dev stands and tests: self-managed GitLab and git remotes on private addresses and over http. */
  allowPrivateNetwork: boolean;
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

export function gitSyncConfigFromEnv(env: Env = process.env): GitSyncConfig {
  const production = env.NODE_ENV === "production";
  const appId = env.WIZARD_GITHUB_APP_ID?.trim();
  const key = env.WIZARD_GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  const hook = env.WIZARD_GITHUB_APP_WEBHOOK_SECRET?.trim();
  const slug = env.WIZARD_GITHUB_APP_SLUG?.trim();
  const cid = env.WIZARD_GITHUB_APP_CLIENT_ID?.trim();
  const csec = env.WIZARD_GITHUB_APP_CLIENT_SECRET?.trim();
  const glId = env.WIZARD_GITLAB_CLIENT_ID?.trim();
  const glSecret = env.WIZARD_GITLAB_CLIENT_SECRET?.trim();
  const addr = env.WIZARD_OPENBAO_ADDR?.trim();
  const token = env.WIZARD_OPENBAO_TOKEN?.trim();
  const kms =
    env.WIZARD_GIT_SYNC_KMS === "local" || env.WIZARD_GIT_SYNC_KMS === "openbao"
      ? env.WIZARD_GIT_SYNC_KMS
      : production
        ? "openbao"
        : "local";
  const tick = Number(env.WIZARD_GIT_SYNC_TICK_MS ?? 5000);
  const reconcile = Number(env.WIZARD_GIT_SYNC_RECONCILE_MS ?? 15 * 60_000);
  return {
    enabled: env.WIZARD_GIT_SYNC !== "off",
    github:
      appId && key && hook && slug && cid && csec
        ? {
            appId,
            slug,
            privateKey: key,
            webhookSecret: hook,
            clientId: cid,
            clientSecret: csec,
            apiBase: trimSlash(env.WIZARD_GITHUB_API_BASE?.trim() || "https://api.github.com"),
            webBase: trimSlash(env.WIZARD_GITHUB_WEB_BASE?.trim() || "https://github.com"),
          }
        : null,
    gitlab:
      glId && glSecret
        ? {
            baseUrl: trimSlash(env.WIZARD_GITLAB_BASE?.trim() || "https://gitlab.com"),
            clientId: glId,
            clientSecret: glSecret,
          }
        : null,
    tickMs: Number.isFinite(tick) && tick >= 0 ? tick : 5000,
    reconcileMs: Number.isFinite(reconcile) && reconcile >= 60_000 ? reconcile : 15 * 60_000,
    kms,
    openbao:
      addr && token
        ? {
            addr,
            token,
            mount: env.WIZARD_OPENBAO_TRANSIT_MOUNT?.trim() || "transit",
            keyName: env.WIZARD_GIT_SYNC_TRANSIT_KEY?.trim() || "wizard-repo",
          }
        : null,
    allowPrivateNetwork: !production && env.WIZARD_GIT_SYNC_ALLOW_PRIVATE_NETWORK === "1",
  };
}

/** The KMS of the tokens, or null when it is not configured (openbao without address/token). */
export function repoKmsOf(c: GitSyncConfig, secrets: SecretStore | undefined): TransitKms | null {
  if (c.kms === "openbao") return c.openbao ? new OpenBaoTransit(c.openbao) : null;
  return secrets ? new LocalTransit(secrets, "repo") : null;
}
