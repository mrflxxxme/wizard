// GitLab — gitlab.com and self-managed instances (V3-31, D77 (3)): OAuth 2 authorization code with PKCE (scope api: merge
// requests, commit statuses, the project hook and git over HTTP), access tokens of 2 h refreshed with the rotating refresh
// token, git over HTTP as oauth2:<token>. Merge requests, commit statuses and a project hook with a secret token.
import { callJson } from "./http.js";
import type { CheckInput, ProviderPr, ProviderRepo, RepoApi } from "./types.js";

export const GITLAB_SCOPES = "api";

interface GlProject {
  id: number;
  path_with_namespace: string;
  default_branch: string | null;
  http_url_to_repo: string;
  web_url: string;
  visibility?: string;
}

interface GlMr {
  iid: number;
  web_url: string;
  state: "opened" | "closed" | "merged" | "locked";
  sha: string | null;
  merge_commit_sha: string | null;
  squash_commit_sha?: string | null;
  draft?: boolean;
}

export interface GitLabTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const projectOf = (p: GlProject): ProviderRepo => ({
  id: String(p.id),
  path: p.path_with_namespace,
  defaultBranch: p.default_branch,
  cloneUrl: p.http_url_to_repo,
  webUrl: p.web_url,
  private: p.visibility !== "public",
});

const mrOf = (m: GlMr): ProviderPr => ({
  number: m.iid,
  url: m.web_url,
  state: m.state === "merged" ? "merged" : m.state === "opened" || m.state === "locked" ? "open" : "closed",
  headSha: m.sha,
  mergeSha: m.state === "merged" ? (m.merge_commit_sha ?? m.squash_commit_sha ?? m.sha) : null,
  ...(m.draft !== undefined ? { draft: m.draft } : {}),
});

const STATE: Record<CheckInput["state"], string> = {
  pending: "running",
  success: "success",
  failure: "failed",
  neutral: "skipped",
};

export class GitLabClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchFn: typeof globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  authorizeUrl(i: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
    const q = new URLSearchParams({
      client_id: i.clientId,
      redirect_uri: i.redirectUri,
      response_type: "code",
      state: i.state,
      scope: GITLAB_SCOPES,
      code_challenge: i.challenge,
      code_challenge_method: "S256",
    });
    return `${this.baseUrl}/oauth/authorize?${q.toString()}`;
  }

  #tokens(r: { access_token?: string; refresh_token?: string; expires_in?: number }): GitLabTokens {
    if (!r.access_token || !r.refresh_token) throw new Error("gitlab: no token in the answer");
    return {
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresAt: this.now() + (r.expires_in ?? 7200) * 1000,
    };
  }

  async exchange(i: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    verifier: string;
  }) {
    return this.#tokens(
      await callJson(this.fetchFn, `${this.baseUrl}/oauth/token`, {
        method: "POST",
        form: {
          grant_type: "authorization_code",
          client_id: i.clientId,
          client_secret: i.clientSecret,
          code: i.code,
          redirect_uri: i.redirectUri,
          code_verifier: i.verifier,
        },
      }),
    );
  }

  async refresh(i: { clientId: string; clientSecret: string; refreshToken: string; redirectUri: string }) {
    return this.#tokens(
      await callJson(this.fetchFn, `${this.baseUrl}/oauth/token`, {
        method: "POST",
        form: {
          grant_type: "refresh_token",
          client_id: i.clientId,
          client_secret: i.clientSecret,
          refresh_token: i.refreshToken,
          redirect_uri: i.redirectUri,
        },
      }),
    );
  }

  async api<T>(
    token: string,
    path: string,
    init: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown } = {},
  ): Promise<T> {
    return callJson<T>(this.fetchFn, `${this.baseUrl}/api/v4${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  /** Projects the user can push to (Developer and above), most recently active first. */
  async listProjects(token: string): Promise<ProviderRepo[]> {
    const list = await this.api<GlProject[]>(
      token,
      "/projects?membership=true&min_access_level=30&simple=true&per_page=100&order_by=last_activity_at",
    );
    return list.map(projectOf);
  }

  async project(token: string, id: string): Promise<ProviderRepo> {
    return projectOf(await this.api<GlProject>(token, `/projects/${encodeURIComponent(id)}`));
  }

  async createHook(token: string, projectId: string, url: string, secret: string): Promise<string> {
    const r = await this.api<{ id: number }>(token, `/projects/${encodeURIComponent(projectId)}/hooks`, {
      method: "POST",
      body: {
        url,
        token: secret,
        push_events: true,
        merge_requests_events: true,
        enable_ssl_verification: url.startsWith("https://"),
      },
    });
    return String(r.id);
  }

  async deleteHook(token: string, projectId: string, hookId: string): Promise<void> {
    await this.api(token, `/projects/${encodeURIComponent(projectId)}/hooks/${encodeURIComponent(hookId)}`, {
      method: "DELETE",
    });
  }

  repoApi(projectId: string, token: () => Promise<string>): RepoApi {
    return new GitLabRepoApi(this, projectId, token);
  }
}

class GitLabRepoApi implements RepoApi {
  readonly provider = "gitlab" as const;
  constructor(
    private readonly gl: GitLabClient,
    private readonly projectId: string,
    private readonly token: () => Promise<string>,
  ) {}

  async #api<T>(
    path: string,
    init: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown } = {},
  ) {
    return this.gl.api<T>(await this.token(), `/projects/${encodeURIComponent(this.projectId)}${path}`, init);
  }

  async gitAuth() {
    return { username: "oauth2", password: await this.token() };
  }

  async repo(): Promise<ProviderRepo> {
    return projectOf(await this.#api<GlProject>(""));
  }

  async findPr(branch: string): Promise<ProviderPr | null> {
    const list = await this.#api<GlMr[]>(
      `/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all&order_by=created_at&sort=desc&per_page=5`,
    );
    return list[0] ? mrOf(list[0]) : null;
  }

  async createPr(i: {
    branch: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<ProviderPr> {
    // A «Draft:» title makes a draft merge request (GitLab 14+).
    const mr = mrOf(
      await this.#api<GlMr>("/merge_requests", {
        method: "POST",
        body: {
          source_branch: i.branch,
          target_branch: i.base,
          title: i.draft ? `Draft: ${i.title}` : i.title,
          description: i.body,
          remove_source_branch: true,
        },
      }),
    );
    return i.draft ? { ...mr, draft: mr.draft ?? true } : mr;
  }

  async updatePr(number: number, i: { title?: string; body?: string }): Promise<void> {
    await this.#api(`/merge_requests/${number}`, {
      method: "PUT",
      body: { ...(i.title ? { title: i.title } : {}), ...(i.body ? { description: i.body } : {}) },
    });
  }

  async getPr(number: number): Promise<ProviderPr> {
    return mrOf(await this.#api<GlMr>(`/merge_requests/${number}`));
  }

  async closePr(number: number, comment: string): Promise<void> {
    await this.#api(`/merge_requests/${number}/notes`, { method: "POST", body: { body: comment } });
    await this.#api(`/merge_requests/${number}`, { method: "PUT", body: { state_event: "close" } });
  }

  async mergePr(number: number, i: { sha: string; title: string }): Promise<{ sha: string | null }> {
    const r = await this.#api<GlMr>(`/merge_requests/${number}/merge`, {
      method: "PUT",
      body: { sha: i.sha, merge_commit_message: i.title, squash: false },
    });
    return { sha: mrOf(r).mergeSha };
  }

  async setCheck(sha: string, c: CheckInput): Promise<string | null> {
    await this.#api(`/statuses/${encodeURIComponent(sha)}`, {
      method: "POST",
      body: {
        state: STATE[c.state],
        name: c.name,
        description: c.title.slice(0, 255),
        ...(c.detailsUrl ? { target_url: c.detailsUrl } : {}),
      },
    });
    return null;
  }
}
