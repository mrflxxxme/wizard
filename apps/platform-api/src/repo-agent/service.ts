// The agent for compatible repositories in platform-api (V3-32, product.yaml D77_v3 (4)): an org connects a client's
// repository (the GitHub App and GitLab OAuth of the repository sync — same callbacks, a state for the agent), Wizard
// checks its compatibility and reports «что сможем / не сможем», proposes AGENTS.md by a separate draft PR when the
// repository has no rules, and runs the owner's tasks: sandbox → the repository's tests → techreview → a draft PR into
// wizard/_agent/*. Wizard never merges these PRs (no code path here merges; the sync's auto-merge only knows revision
// PRs). The client's code goes only to models with inference in RF (callTypes repo_code / repo_review, models.yaml
// #client_code), the task's model part is charged by fact. A queue of tasks (one running per repository), like the sync.
import { randomUUID } from "node:crypto";
import {
  agentAllowed,
  type CompatReport,
  profileRepo,
  REPO_TASK_BUDGET_RUB,
  type RepoAgentResult,
  type RepoSandbox,
  repoRules,
  runCompatCheck,
  runRepoAgent,
} from "@wizard/agents/repo";
import {
  createRegistry,
  createRouter,
  LlmError,
  type LlmMode,
  type Router,
  type RouterOptions,
} from "@wizard/llm";
import type { Kysely } from "kysely";
import type { Billing } from "../billing/ledger.js";
import type { Config } from "../config.js";
import type { DB } from "../db/index.js";
import { ApiError, invalid, notFound } from "../errors.js";
import { recordDevelopmentRequest } from "../gaps/service.js";
import { GitRemote, GitTransportError } from "../git/transport.js";
import {
  gitlabRedirectUri,
  linkSecrets,
  NeedsOwner,
  RetryLater,
  requireKms,
  safeErr,
  sameHost,
} from "../git-sync/context.js";
import { type RepoSecrets, sealSecrets } from "../git-sync/crypto.js";
import { GitLabClient } from "../git-sync/providers/gitlab.js";
import { ProviderError } from "../git-sync/providers/http.js";
import type { ProviderRepo, RepoApi } from "../git-sync/providers/types.js";
import type { GitSync } from "../git-sync/service.js";
import { PROVIDER_RU, syncRu } from "../git-sync/texts.js";
import { orgPolicyOf } from "../runs/queue.js";
import { DbUsageSink } from "../runs/usage.js";
import { commitOnHead, fetchSnapshot, type HeadSnapshot, remoteLimits, SnapshotError } from "./remote.js";
import { NO_SANDBOX_RU, repoSandboxFromEnv } from "./sandbox.js";
import {
  type AgentRepoRow,
  type AgentTaskRow,
  agentRepoById,
  agentReposOf,
  claimTask,
  deleteAgentRepo,
  dueTasks,
  insertAgentRepo,
  insertTask,
  orgTx,
  type TaskPatch,
  tasksOf,
  updateAgentRepo,
  updateTask,
} from "./store.js";
import { AGENT_CHECK_NAME, agentRu } from "./texts.js";

const LEASE_MS = 30 * 60_000;
const MAX_ATTEMPTS = 5;
const PARALLEL = 2;
export const REPO_AGENT_FIXTURE = "repo-agent";

export interface RepoAgentOptions {
  db: Kysely<DB>;
  config: Config;
  sync: GitSync;
  billing: Billing;
  log?: (msg: string, err?: unknown) => void;
  /** The sandbox runner (tests: a fake); default — repoSandboxFromEnv (none in the cloud until the pod runner). */
  sandbox?: RepoSandbox | null;
  createRouter?: (opts: RouterOptions) => Router;
  /** Queue timer, ms (0 — none; tests drive tick()). Default WIZARD_REPO_AGENT_TICK_MS or 5 s. */
  tickMs?: number;
  env?: Record<string, string | undefined>;
}

export interface AgentTaskView {
  id: string;
  kind: AgentTaskRow["kind"];
  kindRu: string;
  status: AgentTaskRow["status"];
  statusRu: string;
  task_ru: string | null;
  branch: string | null;
  pr: { number: number; url: string; draft: boolean } | null;
  summary_ru: string | null;
  error_ru: string | null;
  costRub: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRepoView {
  id: string;
  provider: "github" | "gitlab";
  status: AgentRepoRow["status"];
  statusRu: string;
  hostUrl: string;
  repo: { id: string; path: string; webUrl: string | null; defaultBranch: string } | null;
  secretRef: string;
  headOid: string | null;
  checkedAt: string | null;
  compat: CompatReport | null;
  rulesPr: string | null;
  lastError: { code: string; message_ru: string } | null;
  tasks: AgentTaskView[];
  connectedAt: string;
}

export interface RepoAgentView {
  available: boolean;
  providers: { github: boolean; gitlab: boolean; gitlabSelfManaged: boolean };
  /** The sandbox of JS repositories on this stand (Wizard systems need none). */
  sandbox: { available: boolean; kind: string | null; note_ru: string | null };
  repos: AgentRepoView[];
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** A finished agent run waiting for its PR (kept in agent_repo_tasks.result.push until the PR exists). */
interface PendingPush {
  base: string;
  branch: string;
  /** path → new text (null — deleted). */
  changes: Record<string, string | null>;
  title_ru: string;
  summary_ru: string;
  body: string;
  checkSummary: string;
}

function pendingPush(r: RepoAgentResult, o: { base: string; branch: string; body: string }): PendingPush {
  return {
    ...o,
    changes: Object.fromEntries(r.changes),
    title_ru: r.title_ru,
    summary_ru: r.summary_ru,
    checkSummary: agentRu.checkSummary(r),
  };
}
const short = () => randomUUID().replace(/-/g, "").slice(0, 8);
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

export class RepoAgent {
  readonly #o: RepoAgentOptions;
  readonly sandbox: RepoSandbox | null;
  #router: Router | undefined;
  #timer: NodeJS.Timeout | undefined;
  #busy = false;

  constructor(o: RepoAgentOptions) {
    this.#o = o;
    this.sandbox = o.sandbox !== undefined ? o.sandbox : repoSandboxFromEnv(o.config, o.env ?? process.env);
  }

  get #d() {
    return this.#o.sync.d;
  }

  get available(): boolean {
    return (this.#o.env ?? process.env).WIZARD_REPO_AGENT !== "off" && this.#o.sync.available;
  }

  #require(): void {
    if (!this.available) throw new ApiError("FORBIDDEN", agentRu.unavailable);
  }

  start(): void {
    const env = this.#o.env ?? process.env;
    const ms = this.#o.tickMs ?? Number(env.WIZARD_REPO_AGENT_TICK_MS ?? 5000);
    if (!this.available || !(ms > 0) || this.#timer) return;
    this.#timer = setInterval(() => {
      this.tick().catch((e) => this.#log("repo-agent tick failed", safeErr(e)));
    }, ms);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #log(m: string, e?: unknown) {
    (this.#o.log ?? (() => {}))(m, e);
  }

  /** The platform router of the agent (fixture by default; live with WIZARD_LLM_MODE=live), usage into llm_calls. */
  router(): Router {
    if (this.#router) return this.#router;
    const env = this.#o.env ?? process.env;
    const mode: LlmMode = env.WIZARD_LLM_MODE === "live" ? "live" : "fixture";
    const opts: RouterOptions = {
      mode,
      registry: createRegistry({ buildDefaultTier: this.#o.config.buildDefaultTier }),
      sink: new DbUsageSink(this.#o.db),
      ...(mode === "fixture"
        ? {
            fixture: { suite: "unit", name: REPO_AGENT_FIXTURE, lenient: env.WIZARD_FIXTURE_LENIENT === "1" },
          }
        : {}),
    };
    this.#router = (this.#o.createRouter ?? createRouter)(opts);
    return this.#router;
  }

  // ---- connecting ----

  /** Where the owner installs the GitHub App for the agent (the state names the org and the user). */
  githubInstallUrl(orgId: string, userId: string): string {
    this.#require();
    const gh = this.#d.cfg.github;
    if (!gh) throw new ApiError("FORBIDDEN", agentRu.connect.notConfiguredGithub);
    const state = this.#o.sync.signer.sign({ target: "agent", orgId, userId, provider: "github" });
    return `${gh.webBase}/apps/${encodeURIComponent(gh.slug)}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /** The App's callback for an agent state: the installation must be the user's own; a pending repository row. */
  async githubSetup(
    user: { id: string },
    q: { installationId: string; state: string; code: string },
    canOwn: (orgId: string) => void,
  ): Promise<{ orgId: string; repoId: string }> {
    this.#require();
    const st = this.#o.sync.signer.verify(q.state);
    if (st?.target !== "agent" || st.provider !== "github" || st.userId !== user.id || !st.orgId)
      throw invalid(agentRu.connect.stateInvalid);
    const orgId = st.orgId;
    canOwn(orgId);
    const gh = this.#d.github;
    if (!gh) throw new ApiError("FORBIDDEN", agentRu.connect.notConfiguredGithub);
    if (!/^[0-9]{1,20}$/.test(q.installationId)) throw invalid(agentRu.connect.stateInvalid);
    let mine: boolean;
    try {
      mine = await gh.userOwnsInstallation(q.code, q.installationId);
    } catch (e) {
      if (e instanceof ProviderError && e.retryable)
        throw new ApiError("LLM_UNAVAILABLE", syncRu.errors.UNAVAILABLE("GitHub"));
      mine = false;
    }
    if (!mine) throw new ApiError("FORBIDDEN", syncRu.connect.installationNotYours);
    const id = randomUUID();
    await orgTx(this.#o.db, orgId, (trx) =>
      insertAgentRepo(trx, {
        id,
        org_id: orgId,
        provider: "github",
        host_url: gh.cfg.webBase,
        secret_ref: "secret://repo/github",
        connected_by: user.id,
        installation_id: q.installationId,
      }),
    );
    return { orgId, repoId: id };
  }

  /** GitLab OAuth for the agent: gitlab.com with the platform's application or the owner's instance with theirs. */
  async gitlabAuthorize(
    orgId: string,
    userId: string,
    i: { baseUrl?: string | null; clientId?: string | null; clientSecret?: string | null },
  ): Promise<string> {
    this.#require();
    const cfg = this.#d.cfg.gitlab;
    let host: string;
    let own: { clientId: string; clientSecret: string } | null = null;
    if (i.baseUrl?.trim()) {
      host = this.#o.sync.gitlabHost(i.baseUrl);
      if (!(cfg?.baseUrl === host && !i.clientId)) {
        if (!i.clientId?.trim() || !i.clientSecret?.trim())
          throw invalid(syncRu.connect.needOwnApp, { field: "clientId" });
        own = { clientId: i.clientId.trim(), clientSecret: i.clientSecret.trim() };
      }
    } else {
      if (!cfg) throw invalid(syncRu.connect.notConfiguredGitlab, { field: "baseUrl" });
      host = cfg.baseUrl;
    }
    const app = own ?? (cfg && cfg.baseUrl === host ? cfg : null);
    if (!app) throw invalid(syncRu.connect.needOwnApp, { field: "clientId" });
    const id = randomUUID();
    await orgTx(this.#o.db, orgId, async (trx) => {
      await insertAgentRepo(trx, {
        id,
        org_id: orgId,
        provider: "gitlab",
        host_url: host,
        secret_ref: "secret://repo/gitlab",
        connected_by: userId,
      });
      if (own) await this.#seal(trx, { id, org_id: orgId }, own);
    });
    const state = this.#o.sync.signer.sign({
      target: "agent",
      orgId,
      userId,
      provider: "gitlab",
      linkId: id,
    });
    const nonce = this.#o.sync.signer.verify(state)?.nonce as string;
    return new GitLabClient(host, this.#d.fetch).authorizeUrl({
      clientId: app.clientId,
      redirectUri: gitlabRedirectUri(this.#d),
      state,
      challenge: this.#o.sync.signer.pkce(nonce).challenge,
    });
  }

  /** The OAuth callback for an agent state: tokens sealed into the repository row. */
  async gitlabCallback(
    user: { id: string },
    q: { code: string; state: string },
    canOwn: (orgId: string) => void,
  ): Promise<{ orgId: string; repoId: string }> {
    this.#require();
    const st = this.#o.sync.signer.verify(q.state);
    if (
      st?.target !== "agent" ||
      st.provider !== "gitlab" ||
      st.userId !== user.id ||
      !st.orgId ||
      !st.linkId
    )
      throw invalid(agentRu.connect.stateInvalid);
    const orgId = st.orgId;
    const repoId = st.linkId;
    canOwn(orgId);
    const row = await orgTx(this.#o.db, orgId, (trx) => agentRepoById(trx, repoId));
    if (row?.provider !== "gitlab") throw invalid(agentRu.connect.stateInvalid);
    const s = await linkSecrets(this.#d, row);
    const app = this.#gitlabApp(row, s);
    if (!app) throw invalid(syncRu.connect.needOwnApp);
    let tokens: Awaited<ReturnType<GitLabClient["exchange"]>>;
    try {
      tokens = await new GitLabClient(row.host_url, this.#d.fetch, () => this.#d.now().getTime()).exchange({
        ...app,
        code: q.code,
        redirectUri: gitlabRedirectUri(this.#d),
        verifier: this.#o.sync.signer.pkce(st.nonce).verifier,
      });
    } catch (e) {
      if (e instanceof ProviderError && e.retryable)
        throw new ApiError("LLM_UNAVAILABLE", syncRu.errors.UNAVAILABLE("GitLab"));
      throw new ApiError("FORBIDDEN", syncRu.errors.AUTH_FAILED("GitLab"));
    }
    await orgTx(this.#o.db, orgId, (trx) => this.#seal(trx, row, { ...s, ...tokens }));
    return { orgId, repoId };
  }

  /** Seals the connection's secrets into the agent repository row (envelope encryption as system links). */
  async #seal(q: Kysely<DB>, row: Pick<AgentRepoRow, "id" | "org_id">, s: RepoSecrets): Promise<void> {
    const sealed = await sealSecrets(requireKms(this.#d), row.org_id, row.id, s);
    await updateAgentRepo(q, row.id, {
      ciphertext: sealed.ciphertext,
      wrapped_dek: sealed.wrappedDek,
      kek_backend: sealed.kekBackend,
      kek_name: sealed.kekName,
    });
  }

  #gitlabApp(row: Pick<AgentRepoRow, "host_url">, s: { clientId?: string; clientSecret?: string }) {
    if (s.clientId && s.clientSecret) return { clientId: s.clientId, clientSecret: s.clientSecret };
    const cfg = this.#d.cfg.gitlab;
    return cfg && cfg.baseUrl === row.host_url
      ? { clientId: cfg.clientId, clientSecret: cfg.clientSecret }
      : null;
  }

  /** A fresh GitLab access token of an agent repository (refreshed under the row lock; the refresh token rotates). */
  async #gitlabToken(orgId: string, id: string): Promise<string> {
    return orgTx(this.#o.db, orgId, async (trx) => {
      const row = await agentRepoById(trx, id, { lock: true });
      if (!row) throw new NeedsOwner("NOT_FOUND", "Подключение репозитория удалено");
      const s = await linkSecrets(this.#d, row);
      if (!s.accessToken || !s.refreshToken)
        throw new NeedsOwner("AUTH_FAILED", "GitLab не подключён: подключите репозиторий заново");
      if ((s.expiresAt ?? 0) - 5 * 60_000 > this.#d.now().getTime()) return s.accessToken;
      const app = this.#gitlabApp(row, s);
      if (!app)
        throw new NeedsOwner("AUTH_FAILED", "Приложение GitLab не настроено: подключите репозиторий заново");
      const t = await new GitLabClient(row.host_url, this.#d.fetch, () => this.#d.now().getTime()).refresh({
        ...app,
        refreshToken: s.refreshToken,
        redirectUri: gitlabRedirectUri(this.#d),
      });
      await this.#seal(trx, row, { ...s, ...t });
      return t.accessToken;
    });
  }

  async #row(orgId: string, id: string): Promise<AgentRepoRow> {
    const row = await orgTx(this.#o.db, orgId, (trx) => agentRepoById(trx, id));
    if (!row) throw notFound("Репозиторий");
    return row;
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

  /** Repositories the owner may pick for a pending connection. */
  async choices(orgId: string, id: string): Promise<ProviderRepo[]> {
    this.#require();
    const row = await this.#row(orgId, id);
    try {
      if (row.provider === "github") {
        if (!this.#d.github || !row.installation_id)
          throw new ApiError("VERSION_CONFLICT", agentRu.connect.notPending);
        return await this.#d.github.listRepos(row.installation_id);
      }
      return await new GitLabClient(row.host_url, this.#d.fetch).listProjects(
        await this.#gitlabToken(orgId, id),
      );
    } catch (e) {
      throw this.#apiError(e, row.provider);
    }
  }

  /** The owner picks the repository: its compatibility check is queued. */
  async select(orgId: string, id: string, repoId: string, userId: string): Promise<void> {
    this.#require();
    const row = await this.#row(orgId, id);
    if (row.status !== "pending") throw new ApiError("VERSION_CONFLICT", agentRu.connect.alreadyChosen);
    const repo = (await this.choices(orgId, id)).find((r) => r.id === repoId);
    if (!repo) throw new ApiError("FORBIDDEN", agentRu.connect.noAccess);
    if (!sameHost(repo.cloneUrl, row.host_url)) throw new ApiError("FORBIDDEN", syncRu.connect.cloneHost);
    await orgTx(this.#o.db, orgId, async (trx) => {
      await updateAgentRepo(trx, id, {
        status: "checking",
        repo_id: repo.id,
        repo_path: repo.path,
        clone_url: repo.cloneUrl,
        web_url: repo.webUrl,
        default_branch: repo.defaultBranch ?? "main",
        last_error_code: null,
        last_error_ru: null,
      });
      await insertTask(trx, { orgId, repoId: id, kind: "check", userId });
    }).catch((e: unknown) => {
      if (String((e as { code?: unknown }).code) === "23505")
        throw new ApiError("VERSION_CONFLICT", agentRu.connect.alreadyConnected);
      throw e;
    });
  }

  /** «Проверить снова». */
  async recheck(orgId: string, id: string, userId: string): Promise<void> {
    this.#require();
    const row = await this.#row(orgId, id);
    if (row.status === "pending") throw new ApiError("VERSION_CONFLICT", agentRu.connect.notPending);
    await orgTx(this.#o.db, orgId, async (trx) => {
      await updateAgentRepo(trx, id, { status: "checking" });
      await insertTask(trx, { orgId, repoId: id, kind: "check", userId });
    });
  }

  /** The owner's task: queued when the repository is compatible and the org has credits left. */
  async createTask(orgId: string, id: string, userId: string, text: string): Promise<AgentTaskView> {
    this.#require();
    const task = text.trim();
    if (!task) throw invalid(agentRu.taskEmpty, { field: "task" });
    const row = await this.#row(orgId, id);
    const report = row.compat as CompatReport | null;
    if (row.status !== "ready" || !report || !agentAllowed(report))
      throw new ApiError("VERSION_CONFLICT", agentRu.notReady(report));
    await this.#o.billing.assertLlmBudget(orgId);
    // Like an interview turn: nothing available → 402 INSUFFICIENT_CREDITS (an exempt dev org is topped up).
    const capMilli = Math.round((REPO_TASK_BUDGET_RUB / createRegistry().rubPerCredit) * 1000);
    await this.#o.db.transaction().execute((trx) => this.#o.billing.requireForTurn(trx, orgId, capMilli));
    const taskId = await orgTx(this.#o.db, orgId, (trx) =>
      insertTask(trx, { orgId, repoId: id, kind: "change", text: task.slice(0, 4000), userId }),
    );
    const t = await orgTx(this.#o.db, orgId, (trx) => tasksOf(trx, id, 20));
    const mine = t.find((x) => x.id === taskId);
    if (!mine) throw new Error("repo-agent: the task was not saved");
    return this.#taskView(mine);
  }

  /** Disconnects: the row with its sealed tokens and tasks is deleted; the repository and its PRs stay as they are. */
  async disconnect(orgId: string, id: string): Promise<void> {
    await this.#row(orgId, id);
    await orgTx(this.#o.db, orgId, (trx) => deleteAgentRepo(trx, id));
  }

  // ---- views ----

  #taskView(t: AgentTaskRow): AgentTaskView {
    const rpc = createRegistry().rubPerCredit;
    return {
      id: t.id,
      kind: t.kind,
      kindRu: agentRu.taskKind[t.kind],
      status: t.status,
      statusRu: agentRu.taskStatus[t.status],
      task_ru: t.task_ru,
      branch: t.branch,
      pr: t.pr_number && t.pr_url ? { number: t.pr_number, url: t.pr_url, draft: t.draft } : null,
      summary_ru: typeof t.result.summary_ru === "string" ? t.result.summary_ru : null,
      error_ru: t.error_ru,
      costRub: Math.round((Number(t.credits_milli) / 1000) * rpc * 100) / 100,
      createdAt: iso(t.created_at) as string,
      updatedAt: iso(t.updated_at) as string,
    };
  }

  async #repoView(orgId: string, r: AgentRepoRow): Promise<AgentRepoView> {
    const tasks = await orgTx(this.#o.db, orgId, (trx) => tasksOf(trx, r.id, 10));
    return {
      id: r.id,
      provider: r.provider,
      status: r.status,
      statusRu: agentRu.repoStatus[r.status],
      hostUrl: r.host_url,
      repo:
        r.repo_id && r.repo_path && r.default_branch
          ? { id: r.repo_id, path: r.repo_path, webUrl: r.web_url, defaultBranch: r.default_branch }
          : null,
      secretRef: r.secret_ref,
      headOid: r.head_oid,
      checkedAt: iso(r.checked_at),
      compat: (r.compat as CompatReport | null) ?? null,
      rulesPr: r.rules_pr_url,
      lastError:
        r.last_error_code && r.last_error_ru
          ? { code: r.last_error_code, message_ru: r.last_error_ru }
          : null,
      tasks: tasks.map((t) => this.#taskView(t)),
      connectedAt: iso(r.created_at) as string,
    };
  }

  async view(orgId: string): Promise<RepoAgentView> {
    const rows = await orgTx(this.#o.db, orgId, (trx) => agentReposOf(trx, orgId));
    return {
      available: this.available,
      providers: { github: !!this.#d.github, gitlab: !!this.#d.cfg.gitlab, gitlabSelfManaged: true },
      sandbox: {
        available: !!this.sandbox,
        kind: this.sandbox?.kind ?? null,
        note_ru: this.sandbox ? null : NO_SANDBOX_RU,
      },
      repos: await Promise.all(rows.map((r) => this.#repoView(orgId, r))),
    };
  }

  async repoView(orgId: string, id: string): Promise<AgentRepoView> {
    return this.#repoView(orgId, await this.#row(orgId, id));
  }

  // ---- queue ----

  async tick(): Promise<number> {
    if (this.#busy) return 0;
    this.#busy = true;
    try {
      const now = this.#d.now();
      const due = await dueTasks(this.#o.db, now, 20);
      const seen = new Set<string>();
      const first = due.filter((t) => {
        if (seen.has(t.repo_id)) return false;
        seen.add(t.repo_id);
        return true;
      });
      let ran = 0;
      for (let i = 0; i < first.length; i += PARALLEL) {
        const part = first.slice(i, i + PARALLEL);
        const res = await Promise.all(
          part.map(async (t) => {
            const task = await claimTask(this.#o.db, t.org_id, t.id, t.repo_id, now, LEASE_MS);
            if (!task) return 0;
            await this.runTask(task);
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
  async drain(max = 20): Promise<void> {
    for (let i = 0; i < max; i++) if ((await this.tick()) === 0) return;
  }

  #api(row: AgentRepoRow): RepoApi {
    if (row.provider === "github") {
      if (!this.#d.github) throw new NeedsOwner("UNAVAILABLE", "Подключение GitHub выключено на платформе");
      if (!row.installation_id || !row.repo_id || !row.repo_path)
        throw new NeedsOwner("NOT_FOUND", "Репозиторий не выбран");
      return this.#d.github.repoApi({
        installationId: row.installation_id,
        repoId: row.repo_id,
        repoPath: row.repo_path,
      });
    }
    if (!row.repo_id) throw new NeedsOwner("NOT_FOUND", "Репозиторий не выбран");
    return new GitLabClient(row.host_url, this.#d.fetch, () => this.#d.now().getTime()).repoApi(
      row.repo_id,
      () => this.#gitlabToken(row.org_id, row.id),
    );
  }

  async #remote(row: AgentRepoRow, api: RepoApi): Promise<GitRemote> {
    if (!row.clone_url || !sameHost(row.clone_url, row.host_url))
      throw new NeedsOwner("FORBIDDEN", syncRu.connect.cloneHost);
    return new GitRemote({
      url: row.clone_url,
      auth: await api.gitAuth(),
      fetch: this.#d.fetch,
      limits: remoteLimits,
    });
  }

  async #head(row: AgentRepoRow, remote: GitRemote): Promise<HeadSnapshot | null> {
    const refs = await remote.lsRefs();
    const head = refs.refs.get(`refs/heads/${row.default_branch}`);
    if (!head) return null;
    try {
      return await fetchSnapshot(remote, head);
    } catch (e) {
      if (e instanceof SnapshotError)
        throw e.code === "TOO_LARGE"
          ? new NeedsOwner("TOO_LARGE", agentRu.tooLarge)
          : new RetryLater("FETCH_INCOMPLETE", agentRu.fetchIncomplete);
      throw e;
    }
  }

  async #finish(task: AgentTaskRow, patch: TaskPatch): Promise<void> {
    await orgTx(this.#o.db, task.org_id, (trx) => updateTask(trx, task.id, { locked_until: null, ...patch }));
  }

  /** Runs one claimed task; failures of the provider or the network are retried, the rest end the task. */
  async runTask(task: AgentTaskRow): Promise<void> {
    const row = await orgTx(this.#o.db, task.org_id, (trx) => agentRepoById(trx, task.repo_id));
    if (!row) return;
    try {
      if (task.kind === "check") await this.#check(row, task);
      else if (task.kind === "rules") await this.#rules(row, task);
      else await this.#change(row, task);
    } catch (e) {
      const retryable =
        e instanceof RetryLater ||
        (e instanceof ProviderError && e.retryable) ||
        (e instanceof GitTransportError && (e.retryable || e.code === "PROTOCOL"));
      const p = PROVIDER_RU[row.provider];
      const message_ru =
        e instanceof RetryLater || e instanceof NeedsOwner
          ? e.message_ru
          : e instanceof ProviderError
            ? syncRu.errors[e.code](p)
            : e instanceof GitTransportError
              ? e.code === "AUTH_FAILED"
                ? syncRu.errors.AUTH_FAILED(p)
                : e.code === "NOT_FOUND"
                  ? syncRu.errors.NOT_FOUND(p)
                  : syncRu.errors.UNAVAILABLE(p)
              : agentRu.internal;
      const code =
        e instanceof RetryLater ||
        e instanceof NeedsOwner ||
        e instanceof ProviderError ||
        e instanceof GitTransportError
          ? String(e.code).toUpperCase()
          : "INTERNAL";
      if (!(e instanceof RetryLater) && !(e instanceof NeedsOwner))
        this.#log(`repo-agent ${task.kind} of ${row.id} failed`, safeErr(e));
      if (retryable && task.attempts < MAX_ATTEMPTS) {
        const at = new Date(this.#d.now().getTime() + Math.min(30_000 * 2 ** (task.attempts - 1), 3_600_000));
        await this.#finish(task, {
          status: "queued",
          next_attempt_at: at,
          error_code: code,
          error_ru: message_ru,
        });
        return;
      }
      await this.#finish(task, { status: "failed", error_code: code, error_ru: message_ru });
      if (task.kind === "check")
        await orgTx(this.#o.db, row.org_id, (trx) =>
          updateAgentRepo(trx, row.id, { status: "error", last_error_code: code, last_error_ru: message_ru }),
        );
    }
  }

  /** The compatibility check: the head, the profile, the sandbox run, the report; a rules proposal when none. */
  async #check(row: AgentRepoRow, task: AgentTaskRow): Promise<void> {
    const api = this.#api(row);
    const head = await this.#head(row, await this.#remote(row, api));
    if (!head) {
      await orgTx(this.#o.db, row.org_id, async (trx) => {
        await updateAgentRepo(trx, row.id, {
          status: "incompatible",
          compat: null,
          checked_at: this.#d.now(),
          last_error_code: "EMPTY",
          last_error_ru: agentRu.emptyRepo,
        });
        await updateTask(trx, task.id, { status: "done", locked_until: null, result: { verdict: "empty" } });
      });
      return;
    }
    const run = await runCompatCheck(head.snapshot, this.sandbox, { unavailableRu: NO_SANDBOX_RU });
    const r = run.report;
    const status =
      r.verdict === "compatible" || r.verdict === "partial"
        ? "ready"
        : r.verdict === "unchecked"
          ? "unchecked"
          : "incompatible";
    await orgTx(this.#o.db, row.org_id, async (trx) => {
      await updateAgentRepo(trx, row.id, {
        status,
        compat: r as unknown as Record<string, unknown>,
        head_oid: head.head,
        checked_at: this.#d.now(),
        last_error_code: null,
        last_error_ru: null,
      });
      await updateTask(trx, task.id, {
        status: "done",
        locked_until: null,
        head_oid: head.head,
        result: { verdict: r.verdict, kind: r.kind },
        error_code: null,
        error_ru: null,
      });
      // No rules in the repository: Wizard proposes AGENTS.md by a separate draft PR (once).
      if (status === "ready" && !r.rules.length && !row.rules_pr_url)
        await insertTask(trx, { orgId: row.org_id, repoId: row.id, kind: "rules" });
    });
    // «Запросы на развитие» (D73): PHP / 1С-Битрикс, 1С, mobile — once per connection and quote.
    if (r.developmentRequest && row.compat === null) {
      try {
        await recordDevelopmentRequest(
          this.#o.db,
          { id: null, org_id: row.org_id, system_id: null, started_by: row.connected_by },
          {
            category: r.developmentRequest.category,
            quote: r.developmentRequest.quote,
            offered: "доработка «под ключ»",
          },
        );
      } catch (e) {
        this.#log("repo-agent: a development request was not recorded", safeErr(e));
      }
    }
  }

  /** Pushes `changes` on top of `head` to a wizard/_agent/* branch and opens a draft PR there. */
  async #pushDraft(
    row: AgentRepoRow,
    api: RepoApi,
    remote: GitRemote,
    head: HeadSnapshot,
    changes: ReadonlyMap<string, string | null>,
    o: { branch: string; message: string; title: string; body: string },
  ): Promise<{ commit: string; number: number; url: string; draft: boolean }> {
    const { commit, objects } = commitOnHead(head, changes, o.message, this.#d.now());
    const adv = await remote.receiveRefs();
    const ref = `refs/heads/${o.branch}`;
    const res = await remote.push([{ ref, old: adv.refs.get(ref) ?? null, new: commit }], objects, adv);
    if (!res.ok) throw new RetryLater("PUSH_REJECTED", agentRu.pushRejected);
    const pr = await api.createPr({
      branch: o.branch,
      base: row.default_branch as string,
      title: o.title,
      body: o.body,
      draft: true,
    });
    return { commit, number: pr.number, url: pr.url, draft: pr.draft !== false };
  }

  /** The AGENTS.md proposal: a draft PR adding the draft rules (no model). */
  async #rules(row: AgentRepoRow, task: AgentTaskRow): Promise<void> {
    const api = this.#api(row);
    const remote = await this.#remote(row, api);
    const head = await this.#head(row, remote);
    if (!head) {
      await this.#finish(task, { status: "failed", error_code: "EMPTY", error_ru: agentRu.emptyRepo });
      return;
    }
    const rules = repoRules(head.snapshot, profileRepo(head.snapshot), row.repo_path ?? "repo");
    if (!rules.draft) {
      await this.#finish(task, { status: "done", result: { note_ru: agentRu.rulesExist } });
      return;
    }
    const branch = `wizard/_agent/rules-${short()}`;
    const pr = await this.#pushDraft(row, api, remote, head, new Map([["AGENTS.md", rules.draft]]), {
      branch,
      message: `Wizard: правила для агентов (AGENTS.md)\n\nWizard-Task: ${task.id}\n`,
      title: agentRu.rulesTitle,
      body: agentRu.rulesBody(row.repo_path ?? ""),
    });
    await orgTx(this.#o.db, row.org_id, async (trx) => {
      await updateAgentRepo(trx, row.id, { rules_pr_url: pr.url });
      await updateTask(trx, task.id, {
        status: "done",
        locked_until: null,
        base_oid: head.head,
        head_oid: pr.commit,
        branch,
        pr_number: pr.number,
        pr_url: pr.url,
        draft: pr.draft,
        result: { files: ["AGENTS.md"] },
        error_code: null,
        error_ru: null,
      });
    });
  }

  /**
   * Opens the draft PR of a finished agent run and ends the task. The run is kept in the task first (`push`): a provider
   * outage between the run and the PR retries only the push — the agent does not run (and cost) twice.
   */
  async #publishChange(
    row: AgentRepoRow,
    task: AgentTaskRow,
    api: RepoApi,
    remote: GitRemote,
    head: HeadSnapshot,
    push: PendingPush,
  ): Promise<void> {
    const changes = new Map(Object.entries(push.changes));
    const branch = push.branch;
    const pr = await this.#pushDraft(row, api, remote, head, changes, {
      branch,
      message: agentRu.commitMessage(push.title_ru, push.summary_ru, task.id),
      title: agentRu.changeTitle(push.title_ru),
      body: push.body,
    });
    try {
      await api.setCheck(
        pr.commit,
        {
          name: AGENT_CHECK_NAME,
          state: "success",
          title: "Сборка, тесты и техревью пройдены в песочнице Wizard",
          summary: push.checkSummary,
          detailsUrl: null,
        },
        null,
      );
    } catch (e) {
      this.#log("repo-agent: the check on the PR failed", safeErr(e));
    }
    const { push: _done, ...result } = task.result;
    await this.#finish(task, {
      status: "done",
      base_oid: head.head,
      head_oid: pr.commit,
      branch,
      pr_number: pr.number,
      pr_url: pr.url,
      draft: pr.draft,
      result,
      error_code: null,
      error_ru: null,
    });
  }

  /** The owner's task: check again on the current head (install in the sandbox), the agent, a draft PR. */
  async #change(row: AgentRepoRow, task: AgentTaskRow): Promise<void> {
    const api = this.#api(row);
    const remote = await this.#remote(row, api);
    const pending = task.result.push as PendingPush | undefined;
    if (pending) {
      // A retry after the agent finished: push the kept change on the head it was made on.
      let base: HeadSnapshot;
      try {
        base = await fetchSnapshot(remote, pending.base);
      } catch (e) {
        if (e instanceof SnapshotError) throw new RetryLater("FETCH_INCOMPLETE", agentRu.fetchIncomplete);
        throw e;
      }
      await this.#publishChange(row, task, api, remote, base, pending);
      return;
    }
    const head = await this.#head(row, remote);
    if (!head) {
      await this.#finish(task, { status: "failed", error_code: "EMPTY", error_ru: agentRu.emptyRepo });
      return;
    }
    const check = await runCompatCheck(head.snapshot, this.sandbox, {
      keepOpen: true,
      unavailableRu: NO_SANDBOX_RU,
    });
    try {
      await orgTx(this.#o.db, row.org_id, (trx) =>
        updateAgentRepo(trx, row.id, {
          compat: check.report as unknown as Record<string, unknown>,
          head_oid: head.head,
          checked_at: this.#d.now(),
          ...(agentAllowed(check.report)
            ? {}
            : { status: check.report.verdict === "unchecked" ? "unchecked" : "incompatible" }),
        }),
      );
      if (!check.workspace || !check.plan || !agentAllowed(check.report)) {
        await this.#finish(task, {
          status: "failed",
          base_oid: head.head,
          error_code: "INCOMPATIBLE",
          error_ru: agentRu.noMoreCompatible(check.report),
        });
        return;
      }
      await this.#o.billing.assertLlmBudget(row.org_id);
      const org = await this.#o.db
        .selectFrom("platform.orgs")
        .select(["ru_only", "t1_restricted"])
        .where("id", "=", row.org_id)
        .executeTakeFirst();
      const rules = repoRules(head.snapshot, check.profile, row.repo_path ?? "repo");
      const router = this.router();
      const result = await runRepoAgent({
        task: task.task_ru ?? "",
        snapshot: head.snapshot,
        profile: check.profile,
        rules,
        workspace: check.workspace,
        plan: check.plan,
        route: (input) => router.route(input),
        orgPolicy: org ? orgPolicyOf(org) : null,
        ctx: { orgId: row.org_id },
      });
      const creditsMilli = Math.round((result.costRub / createRegistry().rubPerCredit) * 1000);
      if (creditsMilli > 0)
        await this.#o.db.transaction().execute((trx) =>
          this.#o.billing.chargeRepoTask(trx, {
            orgId: row.org_id,
            taskId: task.id,
            amountMilli: creditsMilli,
          }),
        );
      const summary = {
        summary_ru: result.summary_ru || null,
        title_ru: result.title_ru || null,
        files: [...result.changes.keys()],
        verify: {
          build: result.verify.build
            ? { ok: result.verify.build.ok, durationMs: result.verify.build.durationMs }
            : null,
          test: result.verify.test
            ? { ok: result.verify.test.ok, durationMs: result.verify.test.durationMs }
            : null,
        },
        review: result.review
          ? {
              blockers: result.review.blockers,
              findings: result.review.findings,
              reviewer: result.review.reviewer,
            }
          : null,
        calls: result.calls,
        agentRuns: result.agentRuns,
        rules: rules.sources.map((s) => s.path),
      };
      if (!result.ok) {
        await this.#finish(task, {
          status: "failed",
          base_oid: head.head,
          credits_milli: creditsMilli,
          result: summary,
          error_code: result.code ?? "FAILED",
          error_ru: (result.reason_ru ?? "").slice(0, 2000),
        });
        return;
      }
      const push = pendingPush(result, {
        base: head.head,
        branch: `wizard/_agent/${ymd(this.#d.now())}-${short()}`,
        body: agentRu.changeBody({
          task: task.task_ru ?? "",
          result,
          report: check.report,
          rules,
          rulesPrUrl: row.rules_pr_url,
          taskId: task.id,
        }),
      });
      const kept = { ...summary, push } as Record<string, unknown>;
      await orgTx(this.#o.db, row.org_id, (trx) =>
        updateTask(trx, task.id, { base_oid: head.head, credits_milli: creditsMilli, result: kept }),
      );
      await this.#publishChange(row, { ...task, result: kept }, api, remote, head, push);
    } catch (e) {
      if (e instanceof LlmError) {
        await this.#finish(task, {
          status: "failed",
          base_oid: head.head,
          error_code: "LLM_UNAVAILABLE",
          error_ru: "Модели в РФ сейчас недоступны — повторите задачу позже",
        });
        return;
      }
      if (e instanceof ApiError && e.code === "LLM_BUDGET_EXHAUSTED") {
        await this.#finish(task, {
          status: "failed",
          base_oid: head.head,
          error_code: "LLM_BUDGET_EXHAUSTED",
          error_ru: e.message_ru,
        });
        return;
      }
      throw e;
    } finally {
      await check.workspace?.close();
    }
  }
}
