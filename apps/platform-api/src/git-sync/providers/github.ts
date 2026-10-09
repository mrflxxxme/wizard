// GitHub through the platform's GitHub App (V3-31, D77 (3)): minimal permissions — Contents and Pull requests (write),
// Checks (write), Metadata (read). Installation tokens live an hour and are minted per repository (repository_ids), kept
// only in this process's memory and never stored. The App's JWT is RS256 over node:crypto (no library). Installing the
// App is proven by the user's own OAuth code: the installation must be among the user's installations.
import { createSign } from "node:crypto";
import type { GitHubAppConfig } from "../config.js";
import { callJson } from "./http.js";
import type { CheckInput, ProviderPr, ProviderRepo, RepoApi } from "./types.js";

const API_VERSION = "2022-11-28";
/** Permissions every installation token asks for (and the App must have): nothing more. */
export const GITHUB_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  checks: "write",
  metadata: "read",
} as const;

interface GhRepo {
  id: number;
  full_name: string;
  default_branch: string | null;
  clone_url: string;
  html_url: string;
  private: boolean;
}

interface GhPull {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  merged?: boolean;
  head: { sha: string; ref: string };
  merge_commit_sha: string | null;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

const repoOf = (r: GhRepo): ProviderRepo => ({
  id: String(r.id),
  path: r.full_name,
  defaultBranch: r.default_branch,
  cloneUrl: r.clone_url,
  webUrl: r.html_url,
  private: r.private,
});

const prOf = (p: GhPull): ProviderPr => ({
  number: p.number,
  url: p.html_url,
  state: p.merged_at || p.merged ? "merged" : p.state === "open" ? "open" : "closed",
  headSha: p.head?.sha ?? null,
  mergeSha: p.merged_at || p.merged ? p.merge_commit_sha : null,
});

export class GitHubApp {
  readonly #cache = new Map<string, { token: string; until: number }>();
  constructor(
    readonly cfg: GitHubAppConfig,
    private readonly fetchFn: typeof globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** App JWT: iat a minute back (clock drift), 9 minutes of life (GitHub allows 10). */
  jwt(): string {
    const t = Math.floor(this.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const body = b64url(JSON.stringify({ iat: t - 60, exp: t + 540, iss: this.cfg.appId }));
    const s = createSign("RSA-SHA256");
    s.update(`${head}.${body}`);
    return `${head}.${body}.${b64url(s.sign(this.cfg.privateKey))}`;
  }

  #headers(token: string): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      "x-github-api-version": API_VERSION,
      authorization: `Bearer ${token}`,
    };
  }

  async api<T>(
    token: string,
    path: string,
    init: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown } = {},
  ) {
    return callJson<T>(this.fetchFn, `${this.cfg.apiBase}${path}`, {
      ...init,
      headers: this.#headers(token),
    });
  }

  /** An installation token for one repository (or the whole installation when repoId is null), cached until 5 min before expiry. */
  async installationToken(installationId: string, repoId: string | null): Promise<string> {
    const key = `${installationId}:${repoId ?? "*"}`;
    const hit = this.#cache.get(key);
    if (hit && hit.until > this.now()) return hit.token;
    const res = await this.api<{ token: string; expires_at: string }>(
      this.jwt(),
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: "POST",
        body: repoId
          ? { repository_ids: [Number(repoId)], permissions: GITHUB_PERMISSIONS }
          : { permissions: { metadata: "read" } },
      },
    );
    const until = Date.parse(res.expires_at) - 5 * 60_000;
    this.#cache.set(key, {
      token: res.token,
      until: Number.isFinite(until) ? until : this.now() + 50 * 60_000,
    });
    return res.token;
  }

  /** Drops cached tokens of an installation (after a 401: the App was suspended or the token revoked). */
  forget(installationId: string): void {
    for (const k of this.#cache.keys()) if (k.startsWith(`${installationId}:`)) this.#cache.delete(k);
  }

  /** The user's OAuth code (setup callback) proves the user can see this installation. The user token is not kept. */
  async userOwnsInstallation(code: string, installationId: string): Promise<boolean> {
    const t = await callJson<{ access_token?: string }>(
      this.fetchFn,
      `${this.cfg.webBase}/login/oauth/access_token`,
      {
        method: "POST",
        form: { client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, code },
      },
    );
    if (!t?.access_token) return false;
    for (let page = 1; page <= 10; page++) {
      const r = await this.api<{ installations: { id: number }[] }>(
        t.access_token,
        `/user/installations?per_page=100&page=${page}`,
      );
      if (r.installations.some((i) => String(i.id) === installationId)) return true;
      if (r.installations.length < 100) break;
    }
    return false;
  }

  /** Repositories the installation was given (the owner picks one). */
  async listRepos(installationId: string): Promise<ProviderRepo[]> {
    const token = await this.installationToken(installationId, null);
    const out: ProviderRepo[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await this.api<{ repositories: GhRepo[] }>(
        token,
        `/installation/repositories?per_page=100&page=${page}`,
      );
      out.push(...r.repositories.map(repoOf));
      if (r.repositories.length < 100) break;
    }
    return out;
  }

  repoApi(link: { installationId: string; repoId: string; repoPath: string }): RepoApi {
    return new GitHubRepoApi(this, link);
  }
}

class GitHubRepoApi implements RepoApi {
  readonly provider = "github" as const;
  constructor(
    private readonly app: GitHubApp,
    private readonly link: { installationId: string; repoId: string; repoPath: string },
  ) {}

  #token() {
    return this.app.installationToken(this.link.installationId, this.link.repoId);
  }

  async #api<T>(
    path: string,
    init: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown } = {},
  ) {
    const repo = this.link.repoPath.split("/").map(encodeURIComponent).join("/");
    return this.app.api<T>(await this.#token(), `/repos/${repo}${path}`, init);
  }

  async gitAuth() {
    return { username: "x-access-token", password: await this.#token() };
  }

  /** By id: a renamed or transferred repository is still found (reconcile updates its path). */
  async repo(): Promise<ProviderRepo> {
    return repoOf(
      await this.app.api<GhRepo>(
        await this.#token(),
        `/repositories/${encodeURIComponent(this.link.repoId)}`,
      ),
    );
  }

  async findPr(branch: string): Promise<ProviderPr | null> {
    const owner = this.link.repoPath.split("/")[0] as string;
    const list = await this.#api<GhPull[]>(
      `/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=5&sort=created&direction=desc`,
    );
    return list[0] ? prOf(list[0]) : null;
  }

  async createPr(i: { branch: string; base: string; title: string; body: string }): Promise<ProviderPr> {
    return prOf(
      await this.#api<GhPull>("/pulls", {
        method: "POST",
        body: { title: i.title, head: i.branch, base: i.base, body: i.body, maintainer_can_modify: false },
      }),
    );
  }

  async updatePr(number: number, i: { title?: string; body?: string }): Promise<void> {
    await this.#api(`/pulls/${number}`, { method: "PATCH", body: i });
  }

  async getPr(number: number): Promise<ProviderPr> {
    return prOf(await this.#api<GhPull>(`/pulls/${number}`));
  }

  async closePr(number: number, comment: string): Promise<void> {
    await this.#api(`/issues/${number}/comments`, { method: "POST", body: { body: comment } });
    await this.#api(`/pulls/${number}`, { method: "PATCH", body: { state: "closed" } });
  }

  async mergePr(number: number, i: { sha: string; title: string }): Promise<{ sha: string | null }> {
    const r = await this.#api<{ merged: boolean; sha?: string }>(`/pulls/${number}/merge`, {
      method: "PUT",
      body: { sha: i.sha, merge_method: "merge", commit_title: i.title },
    });
    return { sha: r.sha ?? null };
  }

  async setCheck(sha: string, c: CheckInput, previousId: string | null): Promise<string | null> {
    const body = {
      name: c.name,
      ...(c.detailsUrl ? { details_url: c.detailsUrl } : {}),
      external_id: c.name,
      ...(c.state === "pending"
        ? { status: "in_progress" }
        : { status: "completed", conclusion: c.state, completed_at: new Date().toISOString() }),
      output: { title: c.title.slice(0, 200), summary: c.summary.slice(0, 60_000) },
    };
    if (previousId) {
      await this.#api(`/check-runs/${encodeURIComponent(previousId)}`, { method: "PATCH", body });
      return previousId;
    }
    const r = await this.#api<{ id: number }>("/check-runs", {
      method: "POST",
      body: { ...body, head_sha: sha },
    });
    return String(r.id);
  }
}
