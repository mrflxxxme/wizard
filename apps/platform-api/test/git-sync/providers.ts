// Mock GitHub and GitLab for the sync tests (V3-31): the REST calls Wizard makes, OAuth with PKCE (GitLab) and the user
// installation proof (GitHub), RS256 App JWTs verified with the App's public key, repository-scoped installation tokens,
// pull/merge requests merged into the in-memory git repositories, check runs and commit statuses. No network.
import { createHash, createVerify, randomBytes } from "node:crypto";
import type { MemRepo } from "./mem-repo.js";

/** What a code host needs from a repository: the in-memory one, or a real server behind a proxy (oracle tests). */
export type RepoBackend = Pick<MemRepo, "defaultBranch" | "head" | "merge" | "handle">;

type Json = Record<string, unknown>;

const json = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function bodyOf(req: Request): Promise<Json> {
  const text = await req.text();
  if (!text) return {};
  if ((req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded"))
    return Object.fromEntries(new URLSearchParams(text));
  return JSON.parse(text) as Json;
}

const basic = (req: Request): { user: string; pass: string } | null => {
  const h = req.headers.get("authorization") ?? "";
  if (!h.startsWith("Basic ")) return null;
  const [user, ...rest] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
  return { user: user as string, pass: rest.join(":") };
};
const bearer = (req: Request) => (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");

export interface MockPr {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: "open" | "closed";
  merged: boolean;
  mergeSha: string | null;
  comments: string[];
}

export interface Check {
  id: number;
  sha: string;
  name: string;
  status: string;
  conclusion: string | null;
  title: string;
}

export class MockGitHub {
  readonly api = "https://api.github.test";
  readonly web = "https://github.test";
  readonly calls: { method: string; path: string; body: Json }[] = [];
  readonly tokenRequests: Json[] = [];
  readonly repos = new Map<
    string,
    { id: number; full: string; mem: RepoBackend; pulls: MockPr[]; checks: Check[] }
  >();
  readonly installations = new Map<string, number[]>();
  readonly codes = new Map<string, string[]>();
  readonly #userTokens = new Map<string, string[]>();
  readonly #tokens = new Map<string, { installation: string; repos: number[] | null }>();
  /** 503 on every API call (an outage). */
  down = false;
  #checkId = 0;

  constructor(
    readonly appId: string,
    private readonly publicKey: string,
  ) {}

  addRepo(id: number, full: string, mem: RepoBackend, installation: string): void {
    this.repos.set(full, { id, full, mem, pulls: [], checks: [] });
    this.installations.set(installation, [...(this.installations.get(installation) ?? []), id]);
  }

  repoById(id: number) {
    return [...this.repos.values()].find((r) => r.id === id);
  }

  /** Every installation token ever issued (to check none leaks). */
  issuedTokens(): string[] {
    return [...this.#tokens.keys()];
  }

  #jwtOk(token: string): boolean {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return false;
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    if (!v.verify(this.publicKey, Buffer.from(s, "base64url"))) return false;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as {
      iss: string;
      exp: number;
      iat: number;
    };
    return claims.iss === this.appId && claims.exp - claims.iat <= 600;
  }

  #repoAccess(token: string, repoId: number): boolean {
    const t = this.#tokens.get(token);
    if (!t) return false;
    const installed = this.installations.get(t.installation) ?? [];
    return installed.includes(repoId) && (t.repos === null || t.repos.includes(repoId));
  }

  #pr(r: { full: string; mem: RepoBackend }, p: MockPr) {
    return {
      number: p.number,
      html_url: `${this.web}/${r.full}/pull/${p.number}`,
      state: p.state,
      merged: p.merged,
      merged_at: p.merged ? "2026-10-09T10:00:00Z" : null,
      head: { sha: r.mem.head(p.head) ?? p.head, ref: p.head },
      merge_commit_sha: p.mergeSha,
    };
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // git over HTTP: https://github.test/<owner>/<repo>.git/...
    if (url.origin === this.web) {
      const m = /^\/([^/]+\/[^/]+)\.git(\/.*)$/.exec(url.pathname);
      if (m) {
        const r = this.repos.get(m[1] as string);
        const a = basic(req);
        if (!r || !a || a.user !== "x-access-token" || !this.#repoAccess(a.pass, r.id))
          return new Response("denied", { status: 401 });
        return r.mem.handle(req, m[2] as string);
      }
      if (url.pathname === "/login/oauth/access_token") {
        const b = await bodyOf(req);
        const inst = this.codes.get(String(b.code));
        if (!inst || b.client_id !== "Iv1.test" || b.client_secret !== "gh-client-secret")
          return json(200, { error: "bad_verification_code" });
        const t = `ghu_${randomBytes(8).toString("hex")}`;
        this.#userTokens.set(t, inst);
        this.codes.delete(String(b.code));
        return json(200, { access_token: t, token_type: "bearer" });
      }
      return json(404, { message: "Not Found" });
    }
    if (url.origin !== this.api) return json(404, { message: "Not Found" });
    const path = url.pathname;
    const body = req.method === "GET" ? {} : await bodyOf(req);
    this.calls.push({ method: req.method, path: `${path}${url.search}`, body });
    if (this.down) return json(503, { message: "Service Unavailable" });
    const tok = bearer(req);

    let m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (m && req.method === "POST") {
      if (!this.#jwtOk(tok)) return json(401, { message: "A JSON web token could not be decoded" });
      if (!this.installations.has(m[1] as string)) return json(404, { message: "Not Found" });
      this.tokenRequests.push(body);
      const t = `ghs_${randomBytes(12).toString("hex")}`;
      this.#tokens.set(t, {
        installation: m[1] as string,
        repos: (body.repository_ids as number[] | undefined) ?? null,
      });
      return json(201, { token: t, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (path === "/user/installations") {
      const inst = this.#userTokens.get(tok);
      if (!inst) return json(401, { message: "Bad credentials" });
      return json(200, { installations: inst.map((id) => ({ id: Number(id) })) });
    }
    if (path === "/installation/repositories") {
      const t = this.#tokens.get(tok);
      if (!t) return json(401, { message: "Bad credentials" });
      const repos = (this.installations.get(t.installation) ?? [])
        .map((id) => this.repoById(id))
        .filter((r) => !!r);
      return json(200, { repositories: repos.map((r) => this.#repoJson(r)) });
    }
    m = /^\/repositories\/(\d+)$/.exec(path);
    if (m) {
      const r = this.repoById(Number(m[1]));
      if (!r || !this.#repoAccess(tok, r.id)) return json(404, { message: "Not Found" });
      return json(200, this.#repoJson(r));
    }
    m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
    if (!m) return json(404, { message: "Not Found" });
    const r = this.repos.get(m[1] as string);
    if (!r || !this.#repoAccess(tok, r.id)) return json(404, { message: "Not Found" });
    const rest = m[2] ?? "";
    if (rest === "/pulls" && req.method === "GET") {
      const head = (url.searchParams.get("head") ?? "").split(":")[1];
      return json(
        200,
        r.pulls
          .filter((p) => p.head === head)
          .reverse()
          .map((p) => this.#pr(r, p)),
      );
    }
    if (rest === "/pulls" && req.method === "POST") {
      if (!r.mem.head(String(body.head))) return json(422, { message: "Validation Failed" });
      const p: MockPr = {
        number: r.pulls.length + 1,
        title: String(body.title),
        body: String(body.body),
        head: String(body.head),
        base: String(body.base),
        state: "open",
        merged: false,
        mergeSha: null,
        comments: [],
      };
      r.pulls.push(p);
      return json(201, this.#pr(r, p));
    }
    m = /^\/pulls\/(\d+)(\/merge)?$/.exec(rest);
    if (m) {
      const p = r.pulls.find((x) => x.number === Number(m?.[1]));
      if (!p) return json(404, { message: "Not Found" });
      if (m[2] && req.method === "PUT") {
        const sha = r.mem.head(p.head);
        if (body.sha !== sha) return json(409, { message: "Head branch was modified" });
        if (body.merge_method !== "merge") return json(422, { message: "only merge in the mock" });
        const out = this.mergePr(r.full, p.number);
        if (!out) return json(405, { message: "Pull Request is not mergeable" });
        return json(200, { merged: true, sha: out, message: "Pull Request successfully merged" });
      }
      if (req.method === "PATCH") {
        if (typeof body.title === "string") p.title = body.title;
        if (typeof body.body === "string") p.body = body.body;
        if (body.state === "closed") p.state = "closed";
        return json(200, this.#pr(r, p));
      }
      return json(200, { ...this.#pr(r, p), head: { sha: r.mem.head(p.head) ?? p.head, ref: p.head } });
    }
    m = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (m && req.method === "POST") {
      r.pulls.find((x) => x.number === Number(m?.[1]))?.comments.push(String(body.body));
      return json(201, { id: 1 });
    }
    if (rest === "/check-runs" && req.method === "POST") {
      const c: Check = {
        id: ++this.#checkId,
        sha: String(body.head_sha),
        name: String(body.name),
        status: String(body.status),
        conclusion: (body.conclusion as string | undefined) ?? null,
        title: String((body.output as Json | undefined)?.title ?? ""),
      };
      r.checks.push(c);
      return json(201, { id: c.id });
    }
    m = /^\/check-runs\/(\d+)$/.exec(rest);
    if (m && req.method === "PATCH") {
      const c = r.checks.find((x) => x.id === Number(m?.[1]));
      if (!c) return json(404, { message: "Not Found" });
      c.status = String(body.status);
      c.conclusion = (body.conclusion as string | undefined) ?? null;
      c.title = String((body.output as Json | undefined)?.title ?? "");
      return json(200, { id: c.id });
    }
    return json(404, { message: "Not Found" });
  }

  /** The client merges a PR in the GitHub UI (merge commit or squash). */
  mergePr(full: string, number: number, method: "merge" | "squash" = "merge"): string | null {
    const r = this.repos.get(full) as NonNullable<ReturnType<MockGitHub["repoById"]>>;
    const p = r.pulls.find((x) => x.number === number) as MockPr;
    const sha = r.mem.merge(p.base, r.mem.head(p.head) as string, method, `Merge pull request #${number}`);
    if (!sha) return null;
    p.state = "closed";
    p.merged = true;
    p.mergeSha = sha;
    return sha;
  }

  #repoJson(r: { id: number; full: string; mem: RepoBackend }) {
    return {
      id: r.id,
      full_name: r.full,
      default_branch: r.mem.defaultBranch,
      clone_url: `${this.web}/${r.full}.git`,
      html_url: `${this.web}/${r.full}`,
      private: true,
    };
  }
}

export interface GlMr {
  iid: number;
  title: string;
  description: string;
  source: string;
  target: string;
  state: "opened" | "closed" | "merged";
  mergeSha: string | null;
  notes: string[];
}

export class MockGitLab {
  readonly calls: { method: string; path: string; body: Json }[] = [];
  readonly projects = new Map<
    number,
    {
      id: number;
      path: string;
      mem: MemRepo;
      mrs: GlMr[];
      statuses: Json[];
      hooks: { id: number; url: string; token: string }[];
    }
  >();
  /** code → PKCE challenge and the app it was issued to. */
  readonly codes = new Map<string, { challenge: string; clientId: string }>();
  readonly #access = new Map<string, number>();
  readonly #refresh = new Set<string>();
  readonly refreshed: string[] = [];
  down = false;
  #hookId = 0;

  constructor(
    readonly base: string,
    readonly clientId: string,
    readonly clientSecret: string,
  ) {}

  addProject(id: number, path: string, mem: MemRepo): void {
    this.projects.set(id, { id, path, mem, mrs: [], statuses: [], hooks: [] });
  }

  /** The user approved the app on the authorize page: the code GitLab redirects back with. */
  approve(authorizeUrl: string): { code: string; state: string } {
    const u = new URL(authorizeUrl);
    const code = `glc_${randomBytes(6).toString("hex")}`;
    this.codes.set(code, {
      challenge: u.searchParams.get("code_challenge") as string,
      clientId: u.searchParams.get("client_id") as string,
    });
    return { code, state: u.searchParams.get("state") as string };
  }

  issuedTokens(): string[] {
    return [...this.#access.keys(), ...this.#refresh];
  }

  #tokens() {
    const a = `gla_${randomBytes(10).toString("hex")}`;
    const r = `glr_${randomBytes(10).toString("hex")}`;
    this.#access.set(a, Date.now() + 7200_000);
    this.#refresh.add(r);
    return { access_token: a, refresh_token: r, expires_in: 7200, token_type: "Bearer" };
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const gitm = /^\/(.+)\.git(\/.*)$/.exec(path);
    if (gitm) {
      const p = [...this.projects.values()].find((x) => x.path === gitm[1]);
      const a = basic(req);
      if (!p || !a || a.user !== "oauth2" || !this.#access.has(a.pass))
        return new Response("denied", { status: 401 });
      return p.mem.handle(req, gitm[2] as string);
    }
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await bodyOf(req);
    this.calls.push({ method: req.method, path: `${path}${url.search}`, body });
    if (this.down) return json(503, { message: "503 Service Unavailable" });
    if (path === "/oauth/token" && req.method === "POST") {
      if (body.client_id !== this.clientId || body.client_secret !== this.clientSecret)
        return json(401, { error: "invalid_client" });
      if (body.grant_type === "authorization_code") {
        const c = this.codes.get(String(body.code));
        const challenge = createHash("sha256").update(String(body.code_verifier)).digest("base64url");
        if (!c || c.challenge !== challenge) return json(400, { error: "invalid_grant" });
        this.codes.delete(String(body.code));
        return json(200, this.#tokens());
      }
      if (body.grant_type === "refresh_token") {
        if (!this.#refresh.delete(String(body.refresh_token))) return json(400, { error: "invalid_grant" });
        this.refreshed.push(String(body.refresh_token));
        return json(200, this.#tokens());
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (!path.startsWith("/api/v4/")) return json(404, { message: "404 Not Found" });
    if (!this.#access.has(bearer(req))) return json(401, { message: "401 Unauthorized" });
    if (path === "/api/v4/projects" && req.method === "GET")
      return json(
        200,
        [...this.projects.values()].map((p) => this.#project(p)),
      );
    const m = /^\/api\/v4\/projects\/(\d+)(\/.*)?$/.exec(path);
    const p = m ? this.projects.get(Number(m[1])) : undefined;
    if (!m || !p) return json(404, { message: "404 Project Not Found" });
    const rest = m[2] ?? "";
    if (rest === "") return json(200, this.#project(p));
    if (rest === "/hooks" && req.method === "POST") {
      const h = { id: ++this.#hookId, url: String(body.url), token: String(body.token) };
      p.hooks.push(h);
      return json(201, { id: h.id });
    }
    let mm = /^\/hooks\/(\d+)$/.exec(rest);
    if (mm && req.method === "DELETE") {
      p.hooks = p.hooks.filter((h) => h.id !== Number(mm?.[1]));
      return json(204, null);
    }
    if (rest === "/merge_requests" && req.method === "GET")
      return json(
        200,
        p.mrs
          .filter((x) => x.source === url.searchParams.get("source_branch"))
          .reverse()
          .map((x) => this.#mr(p, x)),
      );
    if (rest === "/merge_requests" && req.method === "POST") {
      const x: GlMr = {
        iid: p.mrs.length + 1,
        title: String(body.title),
        description: String(body.description),
        source: String(body.source_branch),
        target: String(body.target_branch),
        state: "opened",
        mergeSha: null,
        notes: [],
      };
      p.mrs.push(x);
      return json(201, this.#mr(p, x));
    }
    mm = /^\/merge_requests\/(\d+)(\/merge|\/notes)?$/.exec(rest);
    if (mm) {
      const x = p.mrs.find((y) => y.iid === Number(mm?.[1]));
      if (!x) return json(404, { message: "404 Not found" });
      if (mm[2] === "/notes") {
        x.notes.push(String(body.body));
        return json(201, { id: 1 });
      }
      if (mm[2] === "/merge") {
        if (body.sha !== p.mem.head(x.source))
          return json(409, { message: "SHA does not match HEAD of source branch" });
        const sha = this.mergeMr(p.id, x.iid);
        return sha ? json(200, this.#mr(p, x)) : json(406, { message: "Branch cannot be merged" });
      }
      if (req.method === "PUT") {
        if (typeof body.title === "string") x.title = body.title;
        if (typeof body.description === "string") x.description = body.description;
        if (body.state_event === "close") x.state = "closed";
      }
      return json(200, this.#mr(p, x));
    }
    mm = /^\/statuses\/([0-9a-f]{40})$/.exec(rest);
    if (mm && req.method === "POST") {
      p.statuses.push({ sha: mm[1], ...body });
      return json(201, { id: p.statuses.length });
    }
    return json(404, { message: "404 Not Found" });
  }

  mergeMr(projectId: number, iid: number): string | null {
    const p = this.projects.get(projectId) as NonNullable<ReturnType<MockGitLab["projects"]["get"]>>;
    const x = p.mrs.find((y) => y.iid === iid) as GlMr;
    const sha = p.mem.merge(x.target, p.mem.head(x.source) as string, "merge", `Merge branch '${x.source}'`);
    if (!sha) return null;
    x.state = "merged";
    x.mergeSha = sha;
    return sha;
  }

  #project(p: { id: number; path: string; mem: MemRepo }) {
    return {
      id: p.id,
      path_with_namespace: p.path,
      default_branch: p.mem.defaultBranch,
      http_url_to_repo: `${this.base}/${p.path}.git`,
      web_url: `${this.base}/${p.path}`,
      visibility: "private",
    };
  }

  #mr(p: { mem: MemRepo }, x: GlMr) {
    return {
      iid: x.iid,
      web_url: `${this.base}/mr/${x.iid}`,
      state: x.state,
      sha: p.mem.head(x.source),
      merge_commit_sha: x.mergeSha,
    };
  }
}

/** One fetch for everything outside the API under test: the mocks by origin, a real local server by URL prefix. */
export function routerFetch(
  routes: { origin: string; handle(req: Request): Promise<Response> }[],
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const origin = new URL(req.url).origin;
    const r = routes.find((x) => x.origin === origin);
    if (!r) throw new TypeError(`fetch failed: no route to ${origin}`);
    return r.handle(req);
  }) as typeof globalThis.fetch;
}
