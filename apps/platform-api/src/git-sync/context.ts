// Shared plumbing of the sync flows (V3-31): dependencies, the provider API and the git remote of a link (GitLab tokens
// refreshed under the link row lock and sealed again), the managed paths of the repository layout and the errors the
// queue understands.
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { KmsError, type TransitKms } from "../byok/kms.js";
import type { Config } from "../config.js";
import type { DB } from "../db/index.js";
import { GitRemote } from "../git/transport.js";
import type { GateRunner, OnG0Passed } from "../runs/types.js";
import type { BlobStore } from "../storage/blobs.js";
import type { GitSyncConfig } from "./config.js";
import { openSecrets, type RepoSecrets, sealSecrets } from "./crypto.js";
import type { GitHubApp } from "./providers/github.js";
import { GitLabClient } from "./providers/gitlab.js";
import type { RepoApi } from "./providers/types.js";
import { type LinkRow, linkById, orgTx, updateLink } from "./store.js";

export interface SyncDeps {
  db: Kysely<DB>;
  pg: postgres.Sql;
  blobs: BlobStore;
  config: Config;
  cfg: GitSyncConfig;
  kms: TransitKms | null;
  github: GitHubApp | null;
  /** Provider APIs and git over HTTP (tests: mocks; default — guarded fetch, no redirects). */
  fetch: typeof globalThis.fetch;
  /** G0–G2 of an import (the run engine's gate executor); absent — imports wait. */
  gates?: GateRunner | undefined;
  /** Bundle and preview of an imported revision (the run engine's post-G0 step). */
  onG0Passed?: OnG0Passed | undefined;
  now(): Date;
  log(msg: string, err?: unknown): void;
}

/** An error for the log: the message only (no stack, no cause chain, no request objects), bounded. */
export const safeErr = (e: unknown): Error | undefined =>
  e instanceof Error ? new Error(e.message.slice(0, 300)) : undefined;

/** A failure the queue retries later with a Russian reason (not an error of the provider). */
export class RetryLater extends Error {
  constructor(
    readonly code: string,
    readonly message_ru: string,
    readonly delayMs = 60_000,
  ) {
    super(code);
    this.name = "RetryLater";
  }
}

/** A failure that needs the owner (no retry): the link goes to «error» with the reason. */
export class NeedsOwner extends Error {
  constructor(
    readonly code: string,
    readonly message_ru: string,
  ) {
    super(code);
    this.name = "NeedsOwner";
  }
}

/** Paths Wizard writes in the repository; the rest belong to the client and are kept as they are (README, CI, …). */
export function isManagedPath(path: string): boolean {
  const top = path.split("/")[0] ?? "";
  return path === "AGENTS.md" || ["ui", "functions", "assets", "brief", "spec", "tests"].includes(top);
}

/** Paths an import may change: the sources and the spec. */
export function isImportablePath(path: string): boolean {
  const top = path.split("/")[0] ?? "";
  return path === "spec/appspec.json" || ["ui", "functions", "assets"].includes(top);
}

/** Wizard's generated files (brief, tests, AGENTS.md): an edit in the repository is not taken over. */
export const isGeneratedRepoPath = (path: string): boolean => isManagedPath(path) && !isImportablePath(path);

export function requireKms(d: SyncDeps): TransitKms {
  if (!d.kms) throw new RetryLater("KMS_UNAVAILABLE", "Хранилище ключей недоступно. Повторим автоматически");
  return d.kms;
}

export async function linkSecrets(d: SyncDeps, link: LinkRow): Promise<RepoSecrets> {
  if (!link.ciphertext) return {};
  try {
    return await openSecrets(requireKms(d), link.org_id, link.id, link);
  } catch (e) {
    if (e instanceof KmsError)
      throw new RetryLater("KMS_UNAVAILABLE", "Хранилище ключей недоступно. Повторим автоматически");
    throw e;
  }
}

export async function saveSecrets(
  d: SyncDeps,
  q: Kysely<DB>,
  link: Pick<LinkRow, "id" | "org_id">,
  s: RepoSecrets,
): Promise<void> {
  const sealed = await sealSecrets(requireKms(d), link.org_id, link.id, s);
  await updateLink(q, link.id, {
    ciphertext: sealed.ciphertext,
    wrapped_dek: sealed.wrappedDek,
    kek_backend: sealed.kekBackend,
    kek_name: sealed.kekName,
  });
}

/** OAuth application of a GitLab link: the owner's own (self-managed) or the platform's gitlab.com one. */
export function gitlabApp(
  d: SyncDeps,
  link: Pick<LinkRow, "host_url">,
  s: RepoSecrets,
): { clientId: string; clientSecret: string } | null {
  if (s.clientId && s.clientSecret) return { clientId: s.clientId, clientSecret: s.clientSecret };
  if (d.cfg.gitlab && d.cfg.gitlab.baseUrl === link.host_url)
    return { clientId: d.cfg.gitlab.clientId, clientSecret: d.cfg.gitlab.clientSecret };
  return null;
}

export const gitlabRedirectUri = (d: SyncDeps) =>
  `${d.config.platformOrigin}/api/v1/git-sync/gitlab/callback`;
export const gitlabHookUrl = (d: SyncDeps, linkId: string) =>
  `${d.config.platformOrigin}/api/v1/webhooks/git/gitlab/${linkId}`;

/** A fresh GitLab access token of a link (refreshed when < 5 min are left; the refresh token rotates). */
export async function gitlabToken(d: SyncDeps, linkId: string, orgId: string): Promise<string> {
  return orgTx(d.db, orgId, async (trx) => {
    const link = await linkById(trx, linkId, { lock: true });
    if (!link) throw new NeedsOwner("NOT_FOUND", "Подключение репозитория удалено");
    const s = await linkSecrets(d, link);
    if (!s.accessToken || !s.refreshToken)
      throw new NeedsOwner("AUTH_FAILED", "GitLab не подключён: подключите репозиторий заново");
    if ((s.expiresAt ?? 0) - 5 * 60_000 > d.now().getTime()) return s.accessToken;
    const app = gitlabApp(d, link, s);
    if (!app)
      throw new NeedsOwner("AUTH_FAILED", "Приложение GitLab не настроено: подключите репозиторий заново");
    const gl = new GitLabClient(link.host_url, d.fetch, () => d.now().getTime());
    const t = await gl.refresh({ ...app, refreshToken: s.refreshToken, redirectUri: gitlabRedirectUri(d) });
    await saveSecrets(d, trx, link, { ...s, ...t });
    return t.accessToken;
  });
}

/** The provider API of an active link. */
export function apiOf(d: SyncDeps, link: LinkRow): RepoApi {
  if (link.provider === "github") {
    if (!d.github) throw new NeedsOwner("UNAVAILABLE", "Подключение GitHub выключено на платформе");
    if (!link.installation_id || !link.repo_id || !link.repo_path)
      throw new NeedsOwner("NOT_FOUND", "Репозиторий не выбран");
    return d.github.repoApi({
      installationId: link.installation_id,
      repoId: link.repo_id,
      repoPath: link.repo_path,
    });
  }
  if (!link.repo_id) throw new NeedsOwner("NOT_FOUND", "Репозиторий не выбран");
  return new GitLabClient(link.host_url, d.fetch, () => d.now().getTime()).repoApi(link.repo_id, () =>
    gitlabToken(d, link.id, link.org_id),
  );
}

/** Same scheme, host and port as the link's host: credentials never go to another server. */
export function sameHost(url: string, host: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(host);
    return a.protocol === b.protocol && a.host === b.host;
  } catch {
    return false;
  }
}

export async function remoteOf(d: SyncDeps, link: LinkRow, api: RepoApi): Promise<GitRemote> {
  if (!link.clone_url || !sameHost(link.clone_url, link.host_url))
    throw new NeedsOwner(
      "FORBIDDEN",
      "Адрес репозитория ведёт на другой сервер — подключите репозиторий заново",
    );
  return new GitRemote({ url: link.clone_url, auth: await api.gitAuth(), fetch: d.fetch });
}
