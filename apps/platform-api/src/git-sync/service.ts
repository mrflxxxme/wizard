// The repository sync of platform-api (V3-31): connecting a system to GitHub (App installation) or GitLab (OAuth, also
// self-managed), the owner's view and settings, the webhooks (signature, idempotency) and the retry queue — a scan of
// active links (a new revision → push, the reconcile cadence) and the due jobs, one running job per link, backoff
// 30 s · 2^n up to 1 h, 10 attempts; a job that needs the owner stops the link with a Russian reason, the reconcile
// cadence brings it back once the provider answers again. Work in Wizard never waits for the provider.
import { createHash, randomUUID } from "node:crypto";
import { byokFetch, hostViolation } from "@wizard/llm";
import { type Kysely, sql } from "kysely";
import type postgres from "postgres";
import type { Config } from "../config.js";
import type { DB } from "../db/index.js";
import { ApiError, invalid, notFound } from "../errors.js";
import type { GateRunner, OnG0Passed } from "../runs/types.js";
import type { SecretStore } from "../secrets/store.js";
import type { BlobStore } from "../storage/blobs.js";
import { type GitSyncConfig, gitSyncConfigFromEnv, repoKmsOf } from "./config.js";
import {
  gitlabApp,
  gitlabHookUrl,
  gitlabRedirectUri,
  gitlabToken,
  linkSecrets,
  NeedsOwner,
  RetryLater,
  type SyncDeps,
  safeErr,
  sameHost,
  saveSecrets,
} from "./context.js";
import { githubSignatureOk, newWebhookSecret, type RepoSecrets, StateSigner, safeEqual } from "./crypto.js";
import {
  importFlow,
  isWizardBranch,
  outcomeOf,
  prPreviewFlow,
  pullLink,
  pushFlow,
  reconcileFlow,
  statusesFlow,
} from "./flows.js";
import { GitHubApp } from "./providers/github.js";
import { GitLabClient } from "./providers/gitlab.js";
import { ProviderError } from "./providers/http.js";
import type { ProviderRepo } from "./providers/types.js";
import {
  claimJob,
  closePreview,
  deleteLink,
  dispatchRead,
  dueJobs,
  enqueue,
  failPreview,
  finishJob,
  importsOf,
  insertLink,
  type JobRow,
  jobsOf,
  type LinkRow,
  linkById,
  linkOfSystem,
  orgTx,
  type PreviewRow,
  prByNumber,
  previewOf,
  previewsOf,
  prsOf,
  prune,
  recordDelivery,
  requeueDead,
  updateLink,
  updatePrRow,
} from "./store.js";
import { PROVIDER_RU, syncRu } from "./texts.js";

export const MAX_ATTEMPTS = 10;
const LEASE_MS = 10 * 60_000;
const WEBHOOK_MAX = 5 * 1024 * 1024;
const PARALLEL = 4;

export interface GitSyncOptions {
  db: Kysely<DB>;
  pg: postgres.Sql;
  blobs: BlobStore;
  config: Config;
  secrets?: SecretStore;
  gates?: GateRunner;
  onG0Passed?: OnG0Passed;
  log?: (msg: string, err?: unknown) => void;
  /** Tests: env of the feature (default process.env), provider and git HTTP, the clock. */
  env?: Record<string, string | undefined>;
  cfg?: Partial<GitSyncConfig>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export interface RepoSyncView {
  available: boolean;
  providers: { github: boolean; gitlab: boolean; gitlabSelfManaged: boolean };
  link: null | {
    id: string;
    provider: "github" | "gitlab";
    status: LinkRow["status"];
    statusRu: string;
    hostUrl: string;
    repo: { id: string; path: string; webUrl: string | null; defaultBranch: string } | null;
    autoMerge: boolean;
    secretRef: string;
    lastSyncAt: string | null;
    lastError: { code: string; message_ru: string } | null;
    remoteHead: { oid: string; revision: number | null } | null;
    lastPushedRevision: number;
    connectedAt: string;
  };
  prs: {
    revision: number;
    number: number | null;
    url: string | null;
    branch: string;
    state: string;
    checks: { key: string; state: string; title: string }[];
    createdAt: string;
  }[];
  imports: {
    headOid: string;
    status: string;
    revision: number | null;
    baseRevision: number | null;
    prNumber: number | null;
    reason_ru: string | null;
    warnings: string[];
    createdAt: string;
  }[];
  queue: { waiting: number; failing: number; stopped: number; nextAttemptAt: string | null };
  publishGate: { required: boolean; mergedRevision: number | null };
  /** V3-32: previews of the developers' open PRs (before the merge). */
  pulls: RepoPullView[];
}

/** V3-32: the preview of a developer's PR (api.yaml RepoPullPreview). */
export interface RepoPullView {
  number: number;
  url: string | null;
  branch: string | null;
  headOid: string;
  status: PreviewRow["status"];
  statusRu: string;
  baseRevision: number | null;
  reason_ru: string | null;
  gates: { level: string; state: string; title: string }[];
  files: { path: string; status: string }[];
  merged: string[];
  previewUrl: string;
  updatedAt: string;
}

// biome-ignore lint/suspicious/noExplicitAny: webhook payloads are read field by field with checks
type Json = Record<string, any>;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export class GitSync {
  readonly d: SyncDeps;
  readonly #signer: StateSigner;
  #timer: NodeJS.Timeout | undefined;
  #busy = false;

  constructor(o: GitSyncOptions) {
    const cfg = { ...gitSyncConfigFromEnv(o.env ?? process.env), ...o.cfg };
    const fetchFn =
      o.fetch ?? byokFetch({ allowPrivateNetwork: cfg.allowPrivateNetwork, timeoutMs: 120_000 });
    const now = o.now ?? (() => new Date());
    this.d = {
      db: o.db,
      pg: o.pg,
      blobs: o.blobs,
      config: o.config,
      cfg,
      kms: repoKmsOf(cfg, o.secrets),
      github: cfg.github ? new GitHubApp(cfg.github, fetchFn, () => now().getTime()) : null,
      fetch: fetchFn,
      gates: o.gates,
      onG0Passed: o.onG0Passed,
      now,
      log: o.log ?? (() => {}),
    };
    this.#signer = StateSigner.of(o.config.secretsKey, o.secrets);
  }

  get available(): boolean {
    return this.d.cfg.enabled && !!this.d.kms;
  }

  /** The signer of redirect states (V3-32: the agent's connections use the same App callbacks). */
  get signer(): StateSigner {
    return this.#signer;
  }

  /** Who a redirect is for: a system link (V3-31) or a repository of the agent (V3-32); null — forged or expired. */
  stateTarget(state: string | undefined): "system" | "agent" | null {
    const st = this.#signer.verify(state);
    if (!st) return null;
    return st.target === "agent" ? "agent" : "system";
  }

  start(): void {
    if (!this.d.cfg.enabled || this.d.cfg.tickMs <= 0 || this.#timer) return;
    this.#timer = setInterval(() => {
      this.tick().catch((e) => this.d.log("git-sync tick failed", safeErr(e)));
    }, this.d.cfg.tickMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  // ---- queue ----

  /** New revisions → push, the reconcile cadence → reconcile (links in error get only the reconcile). */
  async scan(): Promise<void> {
    const now = this.d.now();
    const links = await dispatchRead(this.d.db, async (trx) => {
      const { rows } = await sql<{
        id: string;
        org_id: string;
        system_id: string;
        status: LinkRow["status"];
        last_pushed_revision: number;
        last_reconcile_at: Date | null;
        draft_revision: number;
        deleted: boolean;
      }>`
        select l.id, l.org_id, l.system_id, l.status, l.last_pushed_revision, l.last_reconcile_at, s.draft_revision,
               s.deleted_at is not null as deleted
          from platform.system_repo_links as l join platform.systems as s on s.id = l.system_id
         where l.status in ('active','error')`.execute(trx);
      return rows;
    });
    for (const l of links) {
      if (l.deleted) continue;
      const push = l.status === "active" && l.draft_revision > l.last_pushed_revision;
      const reconcile =
        !l.last_reconcile_at ||
        now.getTime() - new Date(l.last_reconcile_at).getTime() > this.d.cfg.reconcileMs;
      if (!push && !reconcile) continue;
      await orgTx(this.d.db, l.org_id, async (trx) => {
        if (push)
          await enqueue(trx, {
            orgId: l.org_id,
            systemId: l.system_id,
            linkId: l.id,
            kind: "push",
            key: "push",
          });
        if (reconcile)
          await enqueue(trx, {
            orgId: l.org_id,
            systemId: l.system_id,
            linkId: l.id,
            kind: "reconcile",
            key: "reconcile",
          });
      });
    }
  }

  /** One pass: scan, then the due jobs (one per link, a few links in parallel). Returns the number of jobs run. */
  async tick(): Promise<number> {
    if (this.#busy) return 0;
    this.#busy = true;
    try {
      await this.scan();
      const now = this.d.now();
      const due = await dueJobs(this.d.db, now, 50);
      const seen = new Set<string>();
      const first = due.filter((j) => {
        if (seen.has(j.link_id)) return false;
        seen.add(j.link_id);
        return true;
      });
      let ran = 0;
      for (let i = 0; i < first.length; i += PARALLEL) {
        const part = first.slice(i, i + PARALLEL);
        const res = await Promise.all(
          part.map(async (j) => {
            const job = await claimJob(this.d.db, j.org_id, j.id, j.link_id, now, LEASE_MS);
            if (!job) return 0;
            await this.runJob(job);
            return 1;
          }),
        );
        ran += res.reduce<number>((a, b) => a + b, 0);
      }
      return ran;
    } finally {
      this.#busy = false;
    }
  }

  /** Ticks until nothing is due (tests; bounded). */
  async drain(max = 50): Promise<void> {
    for (let i = 0; i < max; i++) if ((await this.tick()) === 0) return;
  }

  async runJob(job: JobRow): Promise<void> {
    const link = await orgTx(this.d.db, job.org_id, (trx) => linkById(trx, job.link_id));
    if (!link) return;
    const now = this.d.now();
    let out: ReturnType<typeof outcomeOf>;
    try {
      out =
        job.kind === "push"
          ? await pushFlow(this.d, link, job)
          : job.kind === "statuses"
            ? await statusesFlow(this.d, link, job)
            : job.kind === "import"
              ? await importFlow(this.d, link, job)
              : job.kind === "pr_preview"
                ? await prPreviewFlow(this.d, link, job)
                : await reconcileFlow(this.d, link);
    } catch (e) {
      if (e instanceof ProviderError && e.code === "AUTH_FAILED" && link.installation_id)
        this.d.github?.forget(link.installation_id);
      out = outcomeOf(e, link.provider, job.attempts, now, MAX_ATTEMPTS);
      if (!(e instanceof RetryLater) && !(e instanceof NeedsOwner))
        this.d.log(
          `git-sync ${job.kind} of link ${link.id} failed`,
          e instanceof Error ? new Error(e.message) : undefined,
        );
    }
    await orgTx(this.d.db, job.org_id, async (trx) => {
      await finishJob(trx, job, out);
      // V3-32: a preview of a developer's PR never stops the sync; its failure is the preview's own.
      if (job.kind === "pr_preview") {
        if (out.kind === "dead")
          await failPreview(trx, link.id, Number(job.payload.number), out.code, out.message_ru);
        return;
      }
      if (out.kind === "retry")
        await updateLink(trx, link.id, { last_error_code: out.code, last_error_ru: out.message_ru });
      if (out.kind === "dead")
        await updateLink(trx, link.id, {
          ...(out.owner && link.status === "active" ? { status: "error" as const } : {}),
          last_error_code: out.code,
          last_error_ru: out.message_ru,
        });
      if (job.kind === "reconcile") await prune(trx, link.id, now);
    });
  }

  // ---- owner's view ----

  #provided() {
    return { github: !!this.d.github, gitlab: !!this.d.cfg.gitlab, gitlabSelfManaged: true };
  }

  async view(systemId: string, orgId: string): Promise<RepoSyncView> {
    const empty: RepoSyncView = {
      available: this.available,
      providers: this.#provided(),
      link: null,
      prs: [],
      imports: [],
      queue: { waiting: 0, failing: 0, stopped: 0, nextAttemptAt: null },
      publishGate: { required: false, mergedRevision: null },
      pulls: [],
    };
    return orgTx(this.d.db, orgId, async (trx) => {
      const l = await linkOfSystem(trx, systemId);
      if (!l) return empty;
      const prs = await prsOf(trx, l.id, { limit: 10 });
      const imports = await importsOf(trx, l.id, 10);
      const pulls = (await previewsOf(trx, l.id, 10)).map((v) => this.#pullView(systemId, v));
      const jobs = (await jobsOf(trx, l.id, 100)).filter((j) => j.status === "queued" || j.status === "dead");
      const waiting = jobs.filter((j) => j.status === "queued");
      const merged = Math.max(
        l.remote_head_revision ?? 0,
        ...prs.filter((p) => p.state === "merged" || p.state === "direct").map((p) => p.revision),
      );
      return {
        ...empty,
        link: {
          id: l.id,
          provider: l.provider,
          status: l.status,
          statusRu: syncRu.status[l.status],
          hostUrl: l.host_url,
          repo:
            l.repo_path && l.repo_id && l.default_branch
              ? { id: l.repo_id, path: l.repo_path, webUrl: l.web_url, defaultBranch: l.default_branch }
              : null,
          autoMerge: l.auto_merge,
          secretRef: l.secret_ref,
          lastSyncAt: iso(l.last_sync_at),
          lastError:
            l.last_error_code && l.last_error_ru
              ? { code: l.last_error_code, message_ru: l.last_error_ru }
              : null,
          remoteHead: l.remote_head_oid ? { oid: l.remote_head_oid, revision: l.remote_head_revision } : null,
          lastPushedRevision: l.last_pushed_revision,
          connectedAt: iso(l.created_at) as string,
        },
        prs: prs.map((p) => ({
          revision: p.revision,
          number: p.number,
          url: p.url,
          branch: p.branch,
          state: p.state,
          checks: Object.entries(p.checks).map(([key, c]) => ({ key, state: c.state, title: c.title })),
          createdAt: iso(p.created_at) as string,
        })),
        imports: imports.map((i) => ({
          headOid: i.head_oid,
          status: i.status,
          revision: i.revision,
          baseRevision: i.base_revision,
          prNumber: i.pr_number,
          reason_ru: i.reason_ru,
          warnings: Array.isArray(i.details.warnings) ? (i.details.warnings as string[]) : [],
          createdAt: iso(i.created_at) as string,
        })),
        queue: {
          waiting: waiting.length,
          failing: waiting.filter((j) => j.last_error_code).length,
          stopped: jobs.filter((j) => j.status === "dead").length,
          nextAttemptAt: iso(
            waiting.map((j) => j.next_attempt_at).sort((a, b) => +new Date(a) - +new Date(b))[0],
          ),
        },
        publishGate: {
          required: l.status === "active" || l.status === "error",
          mergedRevision: merged || null,
        },
        pulls,
      };
    });
  }

  #pullView(systemId: string, v: PreviewRow): RepoPullView {
    const gates = Array.isArray(v.details.gates)
      ? (v.details.gates as { level: string; passed: boolean | null; title: string }[]).map((g) => ({
          level: g.level,
          state: g.passed === null ? "neutral" : g.passed ? "success" : "failure",
          title: g.title,
        }))
      : [];
    return {
      number: v.number,
      url: v.url,
      branch: v.branch,
      headOid: v.head_oid,
      status: v.status,
      statusRu: syncRu.preview.status[v.status] ?? v.status,
      baseRevision: v.base_revision,
      reason_ru: v.reason_ru,
      gates,
      files: Array.isArray(v.details.files) ? (v.details.files as { path: string; status: string }[]) : [],
      merged: Array.isArray(v.details.merged) ? (v.details.merged as string[]) : [],
      previewUrl: pullLink(this.d, systemId, v.number),
      updatedAt: iso(v.updated_at) as string,
    };
  }

  /** V3-32: the preview of one developer's PR (null — never previewed). */
  async pull(systemId: string, orgId: string, number: number): Promise<RepoPullView | null> {
    return orgTx(this.d.db, orgId, async (trx) => {
      const l = await linkOfSystem(trx, systemId);
      if (!l) return null;
      const v = await previewOf(trx, l.id, number);
      return v ? this.#pullView(systemId, v) : null;
    });
  }

  // ---- connecting ----

  #require(): void {
    if (!this.available) throw new ApiError("FORBIDDEN", syncRu.connect.unavailable);
  }

  /** Where the owner installs the GitHub App (the state names the system and the user). */
  githubInstallUrl(systemId: string, userId: string): string {
    this.#require();
    const gh = this.d.cfg.github;
    if (!gh) throw new ApiError("FORBIDDEN", syncRu.connect.notConfiguredGithub);
    const state = this.#signer.sign({ systemId, userId, provider: "github" });
    return `${gh.webBase}/apps/${encodeURIComponent(gh.slug)}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /** Setup callback of the App: the user's OAuth code must show the installation among the user's own. */
  async githubSetup(
    user: { id: string },
    q: { installationId: string; state: string; code: string },
    orgOf: (systemId: string) => Promise<string>,
  ): Promise<string> {
    this.#require();
    const st = this.#signer.verify(q.state);
    if (st?.provider !== "github" || st.userId !== user.id || st.target || !st.systemId)
      throw invalid(syncRu.connect.stateInvalid);
    const systemId = st.systemId;
    const gh = this.d.github;
    if (!gh) throw new ApiError("FORBIDDEN", syncRu.connect.notConfiguredGithub);
    if (!/^[0-9]{1,20}$/.test(q.installationId)) throw invalid(syncRu.connect.stateInvalid);
    const orgId = await orgOf(systemId);
    let mine: boolean;
    try {
      mine = await gh.userOwnsInstallation(q.code, q.installationId);
    } catch (e) {
      if (e instanceof ProviderError && e.retryable)
        throw new ApiError("LLM_UNAVAILABLE", syncRu.errors.UNAVAILABLE("GitHub"));
      mine = false;
    }
    if (!mine) throw new ApiError("FORBIDDEN", syncRu.connect.installationNotYours);
    await orgTx(this.d.db, orgId, async (trx) => {
      const l = await linkOfSystem(trx, systemId);
      if (l && l.provider !== "github") {
        if (l.status !== "pending") throw new ApiError("VERSION_CONFLICT", syncRu.connect.alreadyLinkedOther);
        await deleteLink(trx, l.id);
      }
      if (l && l.provider === "github")
        await updateLink(trx, l.id, {
          installation_id: q.installationId,
          ...(l.status === "error" ? { status: "active" as const } : {}),
        });
      else
        await insertLink(trx, {
          id: randomUUID(),
          org_id: orgId,
          system_id: systemId,
          provider: "github",
          host_url: gh.cfg.webBase,
          secret_ref: "secret://repo/github",
          connected_by: user.id,
          installation_id: q.installationId,
        });
    });
    return systemId;
  }

  /** Starts the GitLab OAuth: gitlab.com with the platform's application, or the owner's instance with theirs. */
  async gitlabAuthorize(
    systemId: string,
    orgId: string,
    userId: string,
    i: { baseUrl?: string | null; clientId?: string | null; clientSecret?: string | null },
  ): Promise<string> {
    this.#require();
    let host: string;
    let own: { clientId: string; clientSecret: string } | null = null;
    if (i.baseUrl?.trim()) {
      host = this.#gitlabHost(i.baseUrl);
      if (this.d.cfg.gitlab?.baseUrl === host && !i.clientId) own = null;
      else {
        if (!i.clientId?.trim() || !i.clientSecret?.trim())
          throw invalid(syncRu.connect.needOwnApp, { field: "clientId" });
        own = { clientId: i.clientId.trim(), clientSecret: i.clientSecret.trim() };
      }
    } else {
      if (!this.d.cfg.gitlab) throw invalid(syncRu.connect.notConfiguredGitlab, { field: "baseUrl" });
      host = this.d.cfg.gitlab.baseUrl;
    }
    const app = own ?? (this.d.cfg.gitlab && this.d.cfg.gitlab.baseUrl === host ? this.d.cfg.gitlab : null);
    if (!app) throw invalid(syncRu.connect.needOwnApp, { field: "clientId" });
    const linkId = await orgTx(this.d.db, orgId, async (trx) => {
      const l = await linkOfSystem(trx, systemId);
      if (l && l.status !== "pending")
        throw new ApiError("VERSION_CONFLICT", "Репозиторий уже подключён — сначала отключите его");
      if (l) await deleteLink(trx, l.id);
      const id = randomUUID();
      await insertLink(trx, {
        id,
        org_id: orgId,
        system_id: systemId,
        provider: "gitlab",
        host_url: host,
        secret_ref: "secret://repo/gitlab",
        connected_by: userId,
      });
      if (own) await saveSecrets(this.d, trx, { id, org_id: orgId }, own);
      return id;
    });
    const state = this.#signer.sign({ systemId, userId, provider: "gitlab", linkId });
    const nonce = this.#signer.verify(state)?.nonce as string;
    return new GitLabClient(host, this.d.fetch).authorizeUrl({
      clientId: app.clientId,
      redirectUri: gitlabRedirectUri(this.d),
      state,
      challenge: this.#signer.pkce(nonce).challenge,
    });
  }

  /** A self-managed GitLab address checked as for a system link (V3-32: the agent's connections). */
  gitlabHost(raw: string): string {
    return this.#gitlabHost(raw);
  }

  #gitlabHost(raw: string): string {
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      throw invalid(syncRu.connect.hostInvalid, { field: "baseUrl" });
    }
    const http = u.protocol === "http:" && this.d.cfg.allowPrivateNetwork;
    if (
      (u.protocol !== "https:" && !http) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      (u.pathname !== "/" && u.pathname !== "")
    )
      throw invalid(syncRu.connect.hostInvalid, { field: "baseUrl" });
    if (hostViolation(u.hostname, { allowPrivateNetwork: this.d.cfg.allowPrivateNetwork }))
      throw invalid(syncRu.connect.hostPrivate, { field: "baseUrl" });
    return `${u.protocol}//${u.host}`;
  }

  /** OAuth callback: the code and the PKCE verifier of the state → tokens sealed in the link. */
  async gitlabCallback(
    user: { id: string },
    q: { code: string; state: string },
    orgOf: (systemId: string) => Promise<string>,
  ): Promise<string> {
    this.#require();
    const st = this.#signer.verify(q.state);
    if (st?.provider !== "gitlab" || st.userId !== user.id || !st.linkId || st.target || !st.systemId)
      throw invalid(syncRu.connect.stateInvalid);
    const systemId = st.systemId;
    const orgId = await orgOf(systemId);
    const link = await orgTx(this.d.db, orgId, (trx) => linkById(trx, st.linkId as string));
    if (!link || link.system_id !== systemId || link.provider !== "gitlab")
      throw invalid(syncRu.connect.stateInvalid);
    const s = await linkSecrets(this.d, link);
    const app = gitlabApp(this.d, link, s);
    if (!app) throw invalid(syncRu.connect.needOwnApp);
    let tokens: Awaited<ReturnType<GitLabClient["exchange"]>>;
    try {
      tokens = await new GitLabClient(link.host_url, this.d.fetch, () => this.d.now().getTime()).exchange({
        ...app,
        code: q.code,
        redirectUri: gitlabRedirectUri(this.d),
        verifier: this.#signer.pkce(st.nonce).verifier,
      });
    } catch (e) {
      if (e instanceof ProviderError && e.retryable)
        throw new ApiError("LLM_UNAVAILABLE", syncRu.errors.UNAVAILABLE("GitLab"));
      throw new ApiError("FORBIDDEN", syncRu.errors.AUTH_FAILED("GitLab"));
    }
    await orgTx(this.d.db, orgId, (trx) => saveSecrets(this.d, trx, link, { ...s, ...tokens }));
    return systemId;
  }

  /** Repositories the owner may pick: the installation's (GitHub) or the user's projects with push rights (GitLab). */
  async repos(systemId: string, orgId: string): Promise<ProviderRepo[]> {
    this.#require();
    const link = await orgTx(this.d.db, orgId, (trx) => linkOfSystem(trx, systemId));
    if (!link) throw new ApiError("VERSION_CONFLICT", syncRu.connect.notPending);
    try {
      if (link.provider === "github") {
        if (!this.d.github || !link.installation_id)
          throw new ApiError("VERSION_CONFLICT", syncRu.connect.notPending);
        return await this.d.github.listRepos(link.installation_id);
      }
      const token = await gitlabToken(this.d, link.id, orgId);
      return await new GitLabClient(link.host_url, this.d.fetch).listProjects(token);
    } catch (e) {
      throw this.#apiError(e, link.provider);
    }
  }

  #apiError(e: unknown, provider: "github" | "gitlab"): unknown {
    if (e instanceof ApiError) return e;
    const p = PROVIDER_RU[provider];
    if (e instanceof ProviderError)
      return e.retryable
        ? new ApiError("LLM_UNAVAILABLE", syncRu.errors[e.code](p))
        : new ApiError("FORBIDDEN", syncRu.errors[e.code](p));
    if (e instanceof NeedsOwner) return new ApiError("FORBIDDEN", e.message_ru);
    if (e instanceof RetryLater) return new ApiError("LLM_UNAVAILABLE", e.message_ru);
    return e;
  }

  /** The owner picks the repository: the link becomes active, the first push and a reconcile are queued. */
  async selectRepo(systemId: string, orgId: string, repoId: string): Promise<void> {
    this.#require();
    const link = await orgTx(this.d.db, orgId, (trx) => linkOfSystem(trx, systemId));
    if (!link) throw new ApiError("VERSION_CONFLICT", syncRu.connect.notPending);
    if (link.status !== "pending") throw new ApiError("VERSION_CONFLICT", syncRu.connect.alreadyChosen);
    let repo: ProviderRepo | undefined;
    let secrets: RepoSecrets | null = null;
    try {
      if (link.provider === "github") {
        if (!this.d.github || !link.installation_id)
          throw new ApiError("VERSION_CONFLICT", syncRu.connect.notPending);
        repo = (await this.d.github.listRepos(link.installation_id)).find((r) => r.id === repoId);
      } else {
        const token = await gitlabToken(this.d, link.id, orgId);
        const gl = new GitLabClient(link.host_url, this.d.fetch);
        repo = (await gl.listProjects(token)).find((r) => r.id === repoId);
        if (repo) {
          const s = await linkSecrets(this.d, link);
          if (s.hookId && link.repo_id) await gl.deleteHook(token, link.repo_id, s.hookId).catch(() => {});
          const webhookSecret = newWebhookSecret();
          const hookId = await gl.createHook(token, repo.id, gitlabHookUrl(this.d, link.id), webhookSecret);
          secrets = { ...s, webhookSecret, hookId };
        }
      }
    } catch (e) {
      throw this.#apiError(e, link.provider);
    }
    if (!repo) throw new ApiError("FORBIDDEN", syncRu.connect.noAccess);
    if (!sameHost(repo.cloneUrl, link.host_url)) throw new ApiError("FORBIDDEN", syncRu.connect.cloneHost);
    const chosen = repo;
    await orgTx(this.d.db, orgId, async (trx) => {
      if (secrets) await saveSecrets(this.d, trx, link, secrets);
      await updateLink(trx, link.id, {
        status: "active",
        repo_id: chosen.id,
        repo_path: chosen.path,
        clone_url: chosen.cloneUrl,
        web_url: chosen.webUrl,
        default_branch: chosen.defaultBranch ?? "main",
        remote_head_oid: null,
        remote_head_revision: null,
        last_pushed_revision: 0,
        last_error_code: null,
        last_error_ru: null,
      });
      await enqueue(trx, { orgId, systemId, linkId: link.id, kind: "reconcile", key: "reconcile" });
      await enqueue(trx, { orgId, systemId, linkId: link.id, kind: "push", key: "push" });
    }).catch((e: unknown) => {
      if (String((e as { code?: unknown }).code) === "23505")
        throw new ApiError("VERSION_CONFLICT", syncRu.connect.alreadyLinked);
      throw e;
    });
  }

  async setOptions(
    systemId: string,
    orgId: string,
    o: { autoMerge?: boolean; paused?: boolean },
  ): Promise<void> {
    await orgTx(this.d.db, orgId, async (trx) => {
      const link = await linkOfSystem(trx, systemId);
      if (!link) throw notFound("Подключение репозитория");
      if (link.status === "pending" && o.paused !== undefined)
        throw new ApiError("VERSION_CONFLICT", syncRu.connect.notPending);
      await updateLink(trx, link.id, {
        ...(o.autoMerge !== undefined ? { auto_merge: o.autoMerge } : {}),
        ...(o.paused === true ? { status: "paused" as const } : {}),
        ...(o.paused === false && link.status === "paused" ? { status: "active" as const } : {}),
      });
      if (o.paused === false && link.status === "paused")
        await enqueue(trx, { orgId, systemId, linkId: link.id, kind: "reconcile", key: "reconcile" });
      if (o.autoMerge === true && link.last_pushed_revision > 0)
        await enqueue(trx, {
          orgId,
          systemId,
          linkId: link.id,
          kind: "statuses",
          key: "statuses",
          payload: { revision: link.last_pushed_revision },
        });
    });
  }

  /** «Повторить»: stopped jobs go back to the queue, the link out of «error», a reconcile now. */
  async retry(systemId: string, orgId: string): Promise<void> {
    await orgTx(this.d.db, orgId, async (trx) => {
      const link = await linkOfSystem(trx, systemId);
      if (!link || link.status === "pending")
        throw new ApiError("VERSION_CONFLICT", syncRu.connect.notPending);
      await requeueDead(trx, link.id, this.d.now());
      if (link.status === "error") await updateLink(trx, link.id, { status: "active" });
      await enqueue(trx, { orgId, systemId, linkId: link.id, kind: "reconcile", key: "reconcile" });
    });
  }

  /** Disconnects: the GitLab hook is removed (best effort), the link with its tokens, PRs, imports and queue is deleted. */
  async disconnect(systemId: string, orgId: string): Promise<void> {
    const link = await orgTx(this.d.db, orgId, (trx) => linkOfSystem(trx, systemId));
    if (!link) throw notFound("Подключение репозитория");
    if (link.provider === "gitlab" && link.repo_id) {
      try {
        const s = await linkSecrets(this.d, link);
        if (s.hookId) {
          const token = await gitlabToken(this.d, link.id, orgId);
          await new GitLabClient(link.host_url, this.d.fetch).deleteHook(token, link.repo_id, s.hookId);
        }
      } catch (e) {
        this.d.log(
          "git-sync: removing the GitLab hook failed",
          e instanceof Error ? new Error(e.message) : undefined,
        );
      }
    }
    await orgTx(this.d.db, orgId, (trx) => deleteLink(trx, link.id));
  }

  // ---- webhooks ----

  /** POST /webhooks/git/github — the App's single webhook (X-Hub-Signature-256 with the App's secret). */
  async githubWebhook(
    h: (name: string) => string | undefined,
    raw: Buffer,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const gh = this.d.cfg.github;
    if (!gh || !this.d.cfg.enabled)
      return { status: 404, body: { code: "NOT_FOUND", message_ru: "Не найдено" } };
    if (raw.byteLength > WEBHOOK_MAX)
      return { status: 413, body: { code: "PAYLOAD_TOO_LARGE", message_ru: "Слишком большое уведомление" } };
    if (!githubSignatureOk(gh.webhookSecret, raw, h("x-hub-signature-256")))
      return { status: 401, body: { code: "UNAUTHORIZED", message_ru: "Подпись уведомления не сошлась" } };
    const event = h("x-github-event") ?? "";
    const delivery = h("x-github-delivery") ?? "";
    let p: Json;
    try {
      p = JSON.parse(raw.toString("utf8"));
    } catch {
      return {
        status: 400,
        body: { code: "VALIDATION_FAILED", message_ru: "Тело уведомления должно быть JSON" },
      };
    }
    const installation = p.installation?.id !== undefined ? String(p.installation.id) : null;
    if (event === "ping" || !installation) return { status: 200, body: { ok: true } };
    if (event === "installation" || event === "installation_repositories") {
      const removed: string[] =
        event === "installation"
          ? []
          : ((p.repositories_removed ?? []) as { id: number }[]).map((r) => String(r.id));
      const links = await this.#githubLinks(installation, null);
      for (const l of links) {
        const gone =
          (event === "installation" && ["deleted", "suspend"].includes(p.action)) ||
          removed.includes(l.repo_id ?? "");
        const back = event === "installation" && p.action === "unsuspend";
        if (!gone && !back) continue;
        await orgTx(this.d.db, l.org_id, async (trx) => {
          await updateLink(
            trx,
            l.id,
            gone
              ? {
                  status: l.status === "pending" ? "pending" : "error",
                  last_error_code: "FORBIDDEN",
                  last_error_ru:
                    "Доступ приложения Wizard к репозиторию в GitHub снят: установите приложение заново",
                }
              : { status: "active", last_error_code: null, last_error_ru: null },
          );
          if (back)
            await enqueue(trx, {
              orgId: l.org_id,
              systemId: l.system_id,
              linkId: l.id,
              kind: "reconcile",
              key: "reconcile",
            });
        });
      }
      return { status: 202, body: { ok: true } };
    }
    const repoId = p.repository?.id !== undefined ? String(p.repository.id) : null;
    if (!repoId) return { status: 200, body: { ok: true } };
    const [link] = await this.#githubLinks(installation, repoId);
    if (!link || link.status === "pending") return { status: 202, body: { ok: true, ignored: true } };
    if (
      event === "pull_request" &&
      ["opened", "synchronize", "reopened", "ready_for_review"].includes(p.action) &&
      p.pull_request?.base?.ref === link.default_branch
    )
      return this.#previewEvent(link, delivery, event, {
        number: Number(p.pull_request?.number),
        head: typeof p.pull_request?.head?.sha === "string" ? p.pull_request.head.sha : null,
        branch: typeof p.pull_request?.head?.ref === "string" ? p.pull_request.head.ref : null,
        url: typeof p.pull_request?.html_url === "string" ? p.pull_request.html_url : null,
      });
    if (event === "pull_request" && p.action === "closed") {
      const number = Number(p.pull_request?.number);
      const merged = p.pull_request?.merged === true;
      const sha =
        typeof p.pull_request?.merge_commit_sha === "string" ? p.pull_request.merge_commit_sha : null;
      return this.#event(link, delivery, event, merged && p.pull_request?.base?.ref === link.default_branch, {
        number,
        merged,
        sha,
      });
    }
    if (event === "push")
      return this.#event(link, delivery, event, p.ref === `refs/heads/${link.default_branch}`, null);
    return { status: 202, body: { ok: true, ignored: true } };
  }

  async #githubLinks(installation: string, repoId: string | null): Promise<LinkRow[]> {
    return dispatchRead(this.d.db, async (trx) => {
      const { rows } = await sql<LinkRow>`
        select l.* from platform.system_repo_links as l
         where l.provider = 'github' and l.installation_id = ${installation}
           ${repoId ? sql`and l.repo_id = ${repoId}` : sql``}`.execute(trx);
      return rows;
    });
  }

  /** POST /webhooks/git/gitlab/:linkId — the project hook Wizard created (X-Gitlab-Token, compared in constant time). */
  async gitlabWebhook(
    linkId: string,
    h: (name: string) => string | undefined,
    raw: Buffer,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!this.d.cfg.enabled) return { status: 404, body: { code: "NOT_FOUND", message_ru: "Не найдено" } };
    if (raw.byteLength > WEBHOOK_MAX)
      return { status: 413, body: { code: "PAYLOAD_TOO_LARGE", message_ru: "Слишком большое уведомление" } };
    const link = await dispatchRead(this.d.db, (trx) => linkById(trx, linkId));
    if (link?.provider !== "gitlab")
      return { status: 404, body: { code: "NOT_FOUND", message_ru: "Не найдено" } };
    let secret: string | undefined;
    try {
      secret = (await linkSecrets(this.d, link)).webhookSecret;
    } catch {
      return { status: 503, body: { code: "LLM_UNAVAILABLE", message_ru: syncRu.errors.KMS_UNAVAILABLE } };
    }
    const token = h("x-gitlab-token");
    if (!secret || !token || !safeEqual(secret, token))
      return { status: 401, body: { code: "UNAUTHORIZED", message_ru: "Токен уведомления не сошёлся" } };
    let p: Json;
    try {
      p = JSON.parse(raw.toString("utf8"));
    } catch {
      return {
        status: 400,
        body: { code: "VALIDATION_FAILED", message_ru: "Тело уведомления должно быть JSON" },
      };
    }
    const event = h("x-gitlab-event") ?? "";
    const delivery =
      h("x-gitlab-event-uuid") ??
      h("x-gitlab-webhook-uuid") ??
      h("idempotency-key") ??
      `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    if (link.status === "pending") return { status: 202, body: { ok: true, ignored: true } };
    if (event === "Merge Request Hook") {
      const a = p.object_attributes ?? {};
      const number = Number(a.iid);
      if (["open", "update", "reopen"].includes(a.action) && a.target_branch === link.default_branch)
        return this.#previewEvent(link, delivery, event, {
          number,
          head: typeof a.last_commit?.id === "string" ? a.last_commit.id : null,
          branch: typeof a.source_branch === "string" ? a.source_branch : null,
          url: typeof a.url === "string" ? a.url : null,
        });
      const merged = a.action === "merge" || a.state === "merged";
      const closed = a.action === "close";
      if (!merged && !closed) return { status: 202, body: { ok: true, ignored: true } };
      const sha = typeof a.merge_commit_sha === "string" ? a.merge_commit_sha : null;
      return this.#event(link, delivery, event, merged && a.target_branch === link.default_branch, {
        number,
        merged,
        sha,
      });
    }
    if (event === "Push Hook")
      return this.#event(link, delivery, event, p.ref === `refs/heads/${link.default_branch}`, null);
    return { status: 202, body: { ok: true, ignored: true } };
  }

  /**
   * V3-32: a developer's PR opened or updated → its preview in the queue (one per PR: a newer head replaces the waiting
   * one). Wizard's own branches (wizard/*: revision PRs and the agent's) are never previewed.
   */
  async #previewEvent(
    link: LinkRow,
    delivery: string,
    event: string,
    pr: { number: number; head: string | null; branch: string | null; url: string | null },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!delivery)
      return {
        status: 400,
        body: { code: "VALIDATION_FAILED", message_ru: "Нет идентификатора уведомления" },
      };
    if (
      !Number.isInteger(pr.number) ||
      pr.number < 1 ||
      isWizardBranch(pr.branch) ||
      link.status !== "active"
    )
      return { status: 202, body: { ok: true, ignored: true } };
    const fresh = await orgTx(this.d.db, link.org_id, async (trx) => {
      if (
        !(await recordDelivery(trx, {
          orgId: link.org_id,
          linkId: link.id,
          deliveryId: delivery.slice(0, 200),
          event,
        }))
      )
        return false;
      await enqueue(trx, {
        orgId: link.org_id,
        systemId: link.system_id,
        linkId: link.id,
        kind: "pr_preview",
        key: `pr:${pr.number}`,
        payload: {
          number: pr.number,
          ...(pr.head ? { head: pr.head } : {}),
          ...(pr.branch ? { branch: pr.branch.slice(0, 250) } : {}),
          ...(pr.url ? { url: pr.url.slice(0, 500) } : {}),
        },
      });
      return true;
    });
    return { status: 202, body: { ok: true, ...(fresh ? {} : { duplicate: true }) } };
  }

  /** One delivery once: PR state from the event, an import of the default branch when it moved. */
  async #event(
    link: LinkRow,
    delivery: string,
    event: string,
    importNow: boolean,
    pr: { number: number; merged: boolean; sha: string | null } | null,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!delivery)
      return {
        status: 400,
        body: { code: "VALIDATION_FAILED", message_ru: "Нет идентификатора уведомления" },
      };
    const fresh = await orgTx(this.d.db, link.org_id, async (trx) => {
      if (
        !(await recordDelivery(trx, {
          orgId: link.org_id,
          linkId: link.id,
          deliveryId: delivery.slice(0, 200),
          event,
        }))
      )
        return false;
      if (pr && Number.isInteger(pr.number)) {
        await closePreview(trx, link.id, pr.number);
        const row = await prByNumber(trx, link.id, pr.number);
        if (row && row.state === "open")
          await updatePrRow(
            trx,
            row.id,
            pr.merged
              ? { state: "merged", merged_at: this.d.now(), ...(pr.sha ? { merge_oid: pr.sha } : {}) }
              : { state: "closed" },
          );
      }
      if (importNow && link.status !== "paused")
        await enqueue(trx, {
          orgId: link.org_id,
          systemId: link.system_id,
          linkId: link.id,
          kind: "import",
          key: "import",
          payload: {
            source: "webhook",
            ...(pr ? { prNumber: pr.number, ...(pr.sha ? { mergeSha: pr.sha } : {}) } : {}),
          },
        });
      return true;
    });
    return { status: 202, body: { ok: true, ...(fresh ? {} : { duplicate: true }) } };
  }
}
