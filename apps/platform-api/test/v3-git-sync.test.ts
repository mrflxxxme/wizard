// V3-31 acceptance (D77_v3 (3), db.yaml system_repo_*, api.yaml «V3-31»): a system connected to GitHub (App installation,
// repository-scoped hourly tokens, the installation proven by the user's OAuth code) or GitLab (OAuth with PKCE, also a
// self-managed instance, rotating refresh tokens); every revision goes to a wizard/<slug>/<rev> branch with a PR and the
// gates as check runs / commit statuses; a merge or a developer's push comes back through a signed webhook, is checked
// (compatibility, conflicts, spec) and gated, and becomes a revision; publication waits for the merge; the provider's
// outage only delays the queue (backoff, a clear status); auto-merge on green gates; RLS by org, tokens sealed and never
// shown. Providers are mocks (no network); a real `git http-backend` is the oracle of the round trip when git exists.
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DEFAULT_ORG_ID, DEV_USER_ID } from "../src/db/index.js";
import { findCommitRow } from "../src/git/store.js";
import { repoPublishBlock } from "../src/git-sync/publish.js";
import { purgeDeletedSystems } from "../src/privacy/delete-system.js";
import { type TxCtx, withTx } from "../src/runs/events.js";
import type { RunExecutors } from "../src/runs/types.js";
import { commitFilesRevision } from "../src/services/revisions.js";
import { startBuild } from "./flow.js";
import { GitBackend, git, HAS_GIT, startGitHttp } from "./git-sync/git-http.js";
import { MemRepo } from "./git-sync/mem-repo.js";
import { MockGitHub, MockGitLab, routerFetch } from "./git-sync/providers.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  passingReport,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";
import { expectContract } from "./session.js";

const VIEWER = { "x-wizard-dev-user": "viewer-sync@example.test" };
const STRANGER = { "x-wizard-dev-user": "stranger-sync@example.test" };
const HOOK_SECRET = "gh-hook-secret";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUB = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

const gh = new MockGitHub("12345", PUB);
const gl = new MockGitLab("https://git.client.example", "own-app-id", "own-app-secret");
const logs: string[] = [];
/** The sync's clock runs ahead of real time by this much (backoff and token expiry without waiting). */
let ahead = 0;
let failGate: "G0" | "G1" | "G2" | null = null;

const ENV = {
  WIZARD_GITHUB_APP_ID: "12345",
  WIZARD_GITHUB_APP_SLUG: "wizard-test",
  WIZARD_GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, "\\n"),
  WIZARD_GITHUB_APP_WEBHOOK_SECRET: HOOK_SECRET,
  WIZARD_GITHUB_APP_CLIENT_ID: "Iv1.test",
  WIZARD_GITHUB_APP_CLIENT_SECRET: "gh-client-secret",
  WIZARD_GITHUB_API_BASE: gh.api,
  WIZARD_GITHUB_WEB_BASE: gh.web,
  WIZARD_GIT_SYNC_KMS: "local",
  WIZARD_GIT_SYNC_TICK_MS: "0",
};

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let server: Awaited<ReturnType<typeof startGitHttp>> | undefined;
let dir: string;

function executors(): RunExecutors {
  const base = fakeExecutors({ spec: "forum" });
  return {
    ...base,
    gates: async (level, ctx) =>
      failGate === level
        ? passingReport(level, ctx.specVersion, false)
        : passingReport(level, ctx.specVersion),
  };
}

beforeAll(async () => {
  tdb = await createTestDb("v3sync");
  dir = await mkdtemp(join(tmpdir(), "wz-sync-"));
  if (HAS_GIT) server = await startGitHttp(dir);
  const routes = [
    { origin: gh.api, handle: (r: Request) => gh.handle(r) },
    { origin: gh.web, handle: (r: Request) => gh.handle(r) },
    { origin: gl.base, handle: (r: Request) => gl.handle(r) },
  ];
  api = await startApi(tdb.url, {
    executors: executors(),
    createRouter: fakeRouterFactory(),
    log: (m, e) => logs.push(`${m} ${e instanceof Error ? e.message : ""}`),
    gitSync: { env: ENV, fetch: routerFetch(routes), now: () => new Date(Date.now() + ahead) },
  });
  for (const h of [VIEWER, STRANGER]) expect((await api.req("GET", "/me", { headers: h })).status).toBe(200);
  await api.deps.pg`update platform.memberships set role = 'viewer' where user_id =
    (select id from platform.users where email = 'viewer-sync@example.test')`;
  await api.deps.pg`delete from platform.memberships where user_id =
    (select id from platform.users where email = 'stranger-sync@example.test')`;
});

afterAll(async () => {
  await api?.dispose();
  await server?.close();
  await tdb?.drop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const tx = <T>(fn: (t: TxCtx) => Promise<T>) => withTx(api.deps.db, api.deps.bus, fn);

/** Runs the queue until it is quiet, letting short waits (a push waiting for an import) pass on the sync's clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await api.gitSync.drain();
    ahead += 31_000;
  }
}

/** A built system (interview → card → build with G0) of the dev owner. */
async function builtSystem(name: string): Promise<{ id: string; slug: string }> {
  const b = await startBuild(api, name);
  await waitRun(api, b.buildRunId, ["succeeded"]);
  const [s] = await api.deps.pg<
    { slug: string }[]
  >`select slug from platform.systems where id = ${b.systemId}`;
  return { id: b.systemId, slug: s?.slug as string };
}

/** An owner's edit: one file → a revision kind=files. */
async function edit(systemId: string, path: string, content: string): Promise<number> {
  const r = await tx((t) =>
    commitFilesRevision(t, api.deps.blobs, {
      systemId,
      changes: [{ path, content: Buffer.from(content) }],
      author: "user",
      authorUserId: DEV_USER_ID,
      summaryRu: `Правка ${path}`,
    }),
  );
  return r.version;
}

const draftOf = async (id: string) =>
  Number(
    (await api.deps.pg<{ v: number }[]>`select draft_revision as v from platform.systems where id = ${id}`)[0]
      ?.v,
  );

function ghHook(event: string, payload: unknown, o: { delivery?: string; secret?: string } = {}) {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${createHmac("sha256", o.secret ?? HOOK_SECRET)
    .update(raw)
    .digest("hex")}`;
  return api.fetch(
    new Request("http://localhost:4000/api/v1/webhooks/git/github", {
      method: "POST",
      headers: {
        host: "localhost:4000",
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": o.delivery ?? randomUUID(),
        "x-hub-signature-256": sig,
      },
      body: raw,
    }),
  );
}

async function connectGithub(systemId: string, repoId: number, installation: string) {
  const start = await api.req("POST", `/systems/${systemId}/repo-sync/github`);
  expect(start.status).toBe(200);
  const url = new URL(start.body.url);
  expect(url.origin + url.pathname).toBe(`${gh.web}/apps/wizard-test/installations/new`);
  const state = url.searchParams.get("state") as string;
  const code = `code-${randomUUID()}`;
  gh.codes.set(code, [installation]);
  const setup = await api.req(
    "GET",
    `/git-sync/github/setup?installation_id=${installation}&setup_action=install&state=${encodeURIComponent(state)}&code=${code}`,
  );
  expect(setup.status).toBe(302);
  expect(setup.headers.get("location")).toBe(`http://localhost:5173/s/${systemId}/settings?repo=select#repo`);
  const repos = await api.req("GET", `/systems/${systemId}/repo-sync/repos`);
  expect(repos.status).toBe(200);
  expect(repos.body.items.map((r: { id: string }) => r.id)).toContain(String(repoId));
  const sel = await api.req("POST", `/systems/${systemId}/repo-sync/repo`, {
    body: { repoId: String(repoId) },
  });
  expect(sel.status).toBe(200);
  expectContract("selectRepoSyncRepo", sel);
  expect(sel.body.link.status).toBe("active");
  return sel.body;
}

const view = async (id: string, headers: Record<string, string> = {}) => {
  const r = await api.req("GET", `/systems/${id}/repo-sync`, { headers });
  expect(r.status).toBe(200);
  expectContract("getRepoSync", r);
  return r.body;
};

describe("GitHub: connect, PRs with gate checks, merge → import, publication after the merge", () => {
  const mem = new MemRepo("main");
  let sys: { id: string; slug: string };

  test("the installation must be the user's own; the state is signed and single-user", async () => {
    sys = await builtSystem("Стоматология «Улыбка» на GitHub");
    gh.addRepo(501, "acme/dental", mem, "77");
    gh.installations.set("99", []);
    const start = await api.req("POST", `/systems/${sys.id}/repo-sync/github`);
    const state = new URL(start.body.url).searchParams.get("state") as string;
    // An installation the user cannot see (someone else's) is refused.
    gh.codes.set("code-foreign", ["77"]);
    const foreign = await api.req(
      "GET",
      `/git-sync/github/setup?installation_id=99&state=${encodeURIComponent(state)}&code=code-foreign`,
    );
    expect(foreign.status).toBe(403);
    expect(foreign.body.message_ru).toMatch(/не принадлежит/);
    // A forged or another user's state.
    const forged = await api.req(
      "GET",
      `/git-sync/github/setup?installation_id=77&state=${encodeURIComponent(`${state}x`)}&code=x`,
    );
    expect(forged.status).toBe(400);
    const stolen = await api.req(
      "GET",
      `/git-sync/github/setup?installation_id=77&state=${encodeURIComponent(state)}&code=x`,
      {
        headers: VIEWER,
      },
    );
    expect([400, 404]).toContain(stolen.status);
    // Viewers cannot start it; strangers do not see the system.
    expect((await api.req("POST", `/systems/${sys.id}/repo-sync/github`, { headers: VIEWER })).status).toBe(
      403,
    );
    expect((await api.req("GET", `/systems/${sys.id}/repo-sync`, { headers: STRANGER })).status).toBe(404);
  });

  test("connect and the first push: an empty repository gets the source on main directly", async () => {
    await connectGithub(sys.id, 501, "77");
    // Every installation token is scoped to the one repository and asks only for the minimal permissions.
    const scoped = gh.tokenRequests.filter((b) => b.repository_ids);
    await settle();
    expect(gh.tokenRequests.filter((b) => b.repository_ids).length).toBeGreaterThan(scoped.length);
    for (const b of gh.tokenRequests.filter((x) => x.repository_ids)) {
      expect(b.repository_ids).toEqual([501]);
      expect(b.permissions).toEqual({
        contents: "write",
        pull_requests: "write",
        checks: "write",
        metadata: "read",
      });
    }
    const R = await draftOf(sys.id);
    const w = await findCommitRow(api.deps.db, sys.id, { revision: R });
    expect(mem.head("main")).toBe(w?.oid);
    expect(mem.file("main", "AGENTS.md")).toContain("Как устроен репозиторий");
    expect(mem.file("main", "spec/appspec.json")).toContain('"entities"');
    const v = await view(sys.id);
    expect(v.link).toMatchObject({
      provider: "github",
      status: "active",
      lastPushedRevision: R,
      secretRef: "secret://repo/github",
    });
    expect(v.link.repo).toMatchObject({ path: "acme/dental", defaultBranch: "main" });
    expect(v.prs[0]).toMatchObject({ revision: R, state: "direct", number: null });
    expect(await repoPublishBlock(api.deps.db, sys.id, R)).toBeNull();
  });

  let R2 = 0;
  test("a new revision → branch wizard/<slug>/<rev>, a PR with a Russian summary, gates as check runs", async () => {
    R2 = await edit(
      sys.id,
      "ui/Landing.tsx",
      "export default function Landing() { return <h1>Запись онлайн</h1>; }\n",
    );
    await settle();
    const branch = `wizard/${sys.slug}/${R2}`;
    const head = mem.head(branch) as string;
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(mem.file(branch, "ui/Landing.tsx")).toContain("Запись онлайн");
    // The PR commit has the default branch head in its history, so the PR shows only this change.
    expect(mem.isAncestor(mem.head("main") as string, head)).toBe(true);
    const repo = gh.repos.get("acme/dental");
    const pr = repo?.pulls[0];
    expect(pr).toMatchObject({ number: 1, head: branch, base: "main", state: "open" });
    expect(pr?.title).toMatch(new RegExp(`^Wizard: ревизия ${R2} — Правка`));
    expect(pr?.body).toContain("Проверки Wizard");
    expect(pr?.body).toContain(`/api/v1/systems/${sys.id}/repo-sync/preview/${R2}`);
    expect(pr?.body).toContain("Автомерж выключен");
    const names = repo?.checks.filter((c) => c.sha === head).map((c) => c.name);
    expect(names).toEqual([
      "Wizard / G0 — сборка и типы",
      "Wizard / G1 — сценарии в браузере",
      "Wizard / G2 — права, ПДн и секреты",
      "Wizard / Техревью",
    ]);
    // An owner's edit has no gate run of its own: neutral, Wizard runs them at publication.
    expect(repo?.checks.filter((c) => c.sha === head).every((c) => c.conclusion === "neutral")).toBe(true);
    const v = await view(sys.id);
    expect(v.prs[0]).toMatchObject({
      revision: R2,
      number: 1,
      state: "open",
      url: `${gh.web}/acme/dental/pull/1`,
    });
    expect(v.publishGate).toEqual({ required: true, mergedRevision: R2 - 1 });
  });

  test("publication waits for the merge (422 with the PR to merge)", async () => {
    const r = await api.req("POST", `/systems/${sys.id}/publish`, { body: { revision: R2 } });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("GATES_FAILED");
    expect(r.body.message_ru).toMatch(/слейте PR #1 в основную ветку репозитория acme\/dental/);
    expect(r.body.details).toMatchObject({ reason: "REPO_NOT_MERGED", pr: `${gh.web}/acme/dental/pull/1` });
  });

  test("the preview link of the PR opens the revision's preview for a signed-in viewer", async () => {
    await api.deps.pg`update platform.systems set preview_revision = ${R2} where id = ${sys.id}`;
    const browser = { ...VIEWER, accept: "text/html,application/xhtml+xml" };
    const r = await api.req("GET", `/systems/${sys.id}/repo-sync/preview/${R2}`, { headers: browser });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toMatch(/--draft\./);
    const old = await api.req("GET", `/systems/${sys.id}/repo-sync/preview/1`, { headers: browser });
    expect(old.headers.get("location")).toBe(`http://localhost:5173/s/${sys.id}`);
    // An API client gets the address instead of a redirect.
    const json = await api.req("GET", `/systems/${sys.id}/repo-sync/preview/${R2}`, { headers: VIEWER });
    expect(json.status).toBe(200);
    expectContract("getRepoSyncPreview", json);
    expect(json.body).toMatchObject({ current: true, url: expect.stringMatching(/--draft\./) });
    expect(
      (await api.req("GET", `/systems/${sys.id}/repo-sync/preview/${R2}`, { headers: STRANGER })).status,
    ).toBe(404);
  });

  test("webhooks: a bad signature is 401, a merged PR imports (no changes), a redelivery is idempotent", async () => {
    const merge = gh.mergePr("acme/dental", 1) as string;
    const payload = {
      action: "closed",
      installation: { id: 77 },
      repository: { id: 501 },
      pull_request: { number: 1, merged: true, merge_commit_sha: merge, base: { ref: "main" } },
    };
    expect((await ghHook("pull_request", payload, { secret: "wrong" })).status).toBe(401);
    const delivery = randomUUID();
    const first = await ghHook("pull_request", payload, { delivery });
    expect(first.status).toBe(202);
    const again = await ghHook("pull_request", payload, { delivery });
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    await settle();
    const v = await view(sys.id);
    expect(v.prs[0]).toMatchObject({ revision: R2, state: "merged" });
    expect(v.imports[0]).toMatchObject({ headOid: merge, status: "noop", baseRevision: R2 });
    expect(v.link.remoteHead).toEqual({ oid: merge, revision: R2 });
    expect(await repoPublishBlock(api.deps.db, sys.id, R2)).toBeNull();
    expect(await draftOf(sys.id)).toBe(R2);
  });

  let R3 = 0;
  test("a developer's push to main → import → gates → a new revision; their own files stay theirs", async () => {
    const head = mem.commit(
      "main",
      {
        "ui/Landing.tsx": "export default function Landing() { return <h1>Запись онлайн 24/7</h1>; }\n",
        "functions/notify.ts": "export default async function notify() { return { ok: true }; }\n",
        "README.md": "# Наш репозиторий\n",
        "AGENTS.md": "# Свои заметки\n",
      },
      "Правка разработчика: заголовок и уведомление",
    );
    const res = await ghHook("push", {
      ref: "refs/heads/main",
      after: head,
      installation: { id: 77 },
      repository: { id: 501 },
    });
    expect(res.status).toBe(202);
    await settle();
    R3 = await draftOf(sys.id);
    expect(R3).toBe(R2 + 1);
    const [rev] = await api.deps.pg<{ summary_ru: string; author: string; g0_passed: boolean }[]>`
      select summary_ru, author, g0_passed from platform.revisions where system_id = ${sys.id} and version = ${R3}`;
    expect(rev).toMatchObject({ author: "user", g0_passed: true });
    expect(rev?.summary_ru).toBe("Импорт из GitHub: Правка разработчика: заголовок и уведомление");
    const files = await api.req("GET", `/systems/${sys.id}/files/ui/Landing.tsx?rev=${R3}`);
    expect(files.text).toContain("24/7");
    const manifest = await api.req("GET", `/systems/${sys.id}/revisions/${R3}`);
    expect(JSON.stringify(manifest.body)).not.toContain("README.md");
    const v = await view(sys.id);
    expect(v.imports[0]).toMatchObject({ headOid: head, status: "imported", revision: R3, baseRevision: R2 });
    expect(v.imports[0].warnings).toEqual([expect.stringMatching(/AGENTS\.md Wizard пишет сам/)]);
    expect(v.link).toMatchObject({ lastPushedRevision: R3, remoteHead: { oid: head, revision: R3 } });
    const check = gh.repos.get("acme/dental")?.checks.find((c) => c.sha === head);
    expect(check).toMatchObject({ name: "Wizard / Импорт в Wizard", conclusion: "success" });
    expect(await repoPublishBlock(api.deps.db, sys.id, R3)).toBeNull();
    // Nothing goes back for an imported revision.
    await settle();
    expect(gh.repos.get("acme/dental")?.pulls.length).toBe(1);
  });

  test("the next Wizard PR sits on top of the developer's head and keeps their files", async () => {
    const R4 = await edit(
      sys.id,
      "ui/About.tsx",
      "export default function About() { return <p>О клинике</p>; }\n",
    );
    await settle();
    const branch = `wizard/${sys.slug}/${R4}`;
    const head = mem.head(branch) as string;
    const main = mem.head("main") as string;
    expect(mem.commitOf(head).parents).toContain(main);
    expect(mem.file(branch, "README.md")).toBe("# Наш репозиторий\n");
    expect(mem.file(branch, "ui/Landing.tsx")).toContain("24/7");
    expect(mem.file(branch, "ui/About.tsx")).toContain("О клинике");
    expect(gh.repos.get("acme/dental")?.pulls[1]).toMatchObject({ number: 2, state: "open" });
  });

  test("conflicts and incompatible changes are refused with a Russian reason, shown on the head commit", async () => {
    const R5 = await edit(
      sys.id,
      "ui/About.tsx",
      "export default function About() { return <p>О клинике, версия Wizard</p>; }\n",
    );
    const head = mem.commit(
      "main",
      { "ui/About.tsx": "export default function About() { return <p>Своя версия</p>; }\n" },
      "Своя правка About",
    );
    await ghHook("push", { ref: "refs/heads/main", installation: { id: 77 }, repository: { id: 501 } });
    await settle();
    let v = await view(sys.id);
    const rejected = v.imports.find((i: { headOid: string }) => i.headOid === head);
    expect(rejected).toMatchObject({ status: "rejected" });
    expect(rejected.reason_ru).toMatch(/^Конфликт: файл ui\/About\.tsx изменён и в репозитории, и в Wizard/);
    expect(gh.repos.get("acme/dental")?.checks.find((c) => c.sha === head)).toMatchObject({
      conclusion: "failure",
    });
    expect(await draftOf(sys.id)).toBe(R5);
    // The Wizard PR of R5 still goes out, saying what it reverts; the replaced PR #2 is closed with a comment.
    const pulls = gh.repos.get("acme/dental")?.pulls ?? [];
    const last = pulls.at(-1);
    expect(last?.body).toMatch(/Wizard не принял/);
    expect(pulls[1]).toMatchObject({ number: 2, state: "closed" });
    expect(pulls[1]?.comments[0]).toMatch(/заменён более новой ревизией/);
    expect(mem.head(`wizard/${sys.slug}/${R5 - 1}`)).toBeNull();

    // A symlink and a broken spec in one push: incompatible, nothing imported.
    const bad = mem.commit(
      "main",
      { "ui/link.tsx": { link: "../../etc/passwd" }, "spec/appspec.json": "{ не json" },
      "Ломаем",
    );
    await ghHook("push", { ref: "refs/heads/main", installation: { id: 77 }, repository: { id: 501 } });
    await settle();
    v = await view(sys.id);
    const r2 = v.imports.find((i: { headOid: string }) => i.headOid === bad);
    expect(r2.status).toBe("rejected");
    expect(r2.reason_ru).toMatch(/символьная ссылка/);
    expect(await draftOf(sys.id)).toBe(R5);
  });

  test("a failed gate refuses the import with the failed check", async () => {
    // Make the remote match Wizard again: merge the newest Wizard PR (it reverts the refused commits).
    const pulls = gh.repos.get("acme/dental")?.pulls ?? [];
    const open = pulls.filter((p) => p.state === "open").at(-1);
    expect(gh.mergePr("acme/dental", open?.number as number)).not.toBeNull();
    await ghHook("pull_request", {
      action: "closed",
      installation: { id: 77 },
      repository: { id: 501 },
      pull_request: { number: open?.number, merged: true, base: { ref: "main" } },
    });
    await settle();
    const before = await draftOf(sys.id);
    failGate = "G1";
    const head = mem.commit(
      "main",
      { "ui/Price.tsx": "export default function Price() { return null; }\n" },
      "Прайс",
    );
    await ghHook("push", { ref: "refs/heads/main", installation: { id: 77 }, repository: { id: 501 } });
    await settle();
    failGate = null;
    const v = await view(sys.id);
    const imp = v.imports.find((i: { headOid: string }) => i.headOid === head);
    expect(imp).toMatchObject({ status: "rejected" });
    expect(imp.reason_ru).toBe("Проверка G1 не пройдена: Ошибка сборки");
    expect(await draftOf(sys.id)).toBe(before);
  });

  test("an outage of GitHub: retries with backoff and a clear status, then it catches up", async () => {
    const R = await edit(
      sys.id,
      "ui/Contacts.tsx",
      "export default function Contacts() { return <p>Контакты</p>; }\n",
    );
    gh.down = true;
    mem.down = true;
    // One job per link per pass: the push (and a due reconcile) fail and wait for their backoff.
    await api.gitSync.tick();
    await api.gitSync.tick();
    let v = await view(sys.id);
    expect(v.link.status).toBe("active");
    expect(v.link.lastError.message_ru).toBe(
      "GitHub сейчас недоступен. Повторим автоматически — работа в Wizard не останавливается",
    );
    expect(v.queue.failing).toBeGreaterThanOrEqual(1);
    expect(new Date(v.queue.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + ahead + 20_000);
    // Work in Wizard goes on meanwhile; the new revision joins the waiting push and does not cut its backoff short.
    const R6 = await edit(
      sys.id,
      "ui/Contacts.tsx",
      "export default function Contacts() { return <p>Контакты и карта</p>; }\n",
    );
    expect(R6).toBe(R + 1);
    const calls = gh.calls.length;
    expect(await api.gitSync.tick()).toBe(0);
    expect(gh.calls.length).toBe(calls);
    const jobs = await api.deps.pg<{ kind: string; attempts: number; next_attempt_at: Date }[]>`
      select kind, attempts, next_attempt_at from platform.system_repo_jobs
       where system_id = ${sys.id} and status = 'queued'`;
    expect(jobs.find((j) => j.kind === "push")?.attempts).toBe(1);
    for (const j of jobs) expect(new Date(j.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + ahead);
    gh.down = false;
    mem.down = false;
    ahead += 10 * 60_000;
    await settle();
    v = await view(sys.id);
    expect(v.link.lastError).toBeNull();
    expect(v.link.lastPushedRevision).toBe(R6);
    expect(v.prs[0]).toMatchObject({ revision: R6, state: "open" });
  });

  test("auto-merge (owner's choice) merges a PR once G0, G1 and G2 are green", async () => {
    const R = await draftOf(sys.id);
    const [run] = await api.deps.pg<{ id: string }[]>`
      select id from platform.runs where system_id = ${sys.id} and kind = 'build' limit 1`;
    for (const level of ["G0", "G1", "G2"] as const)
      await api.deps.pg`insert into platform.gate_reports (run_id, system_id, revision, level, passed, report)
        values (${run?.id as string}, ${sys.id}, ${R}, ${level}, true,
                ${api.deps.pg.json(passingReport(level, R) as unknown as Parameters<typeof api.deps.pg.json>[0])})`;
    expect(
      (await api.req("PATCH", `/systems/${sys.id}/repo-sync`, { body: { autoMerge: true }, headers: VIEWER }))
        .status,
    ).toBe(403);
    const r = await api.req("PATCH", `/systems/${sys.id}/repo-sync`, { body: { autoMerge: true } });
    expect(r.status).toBe(200);
    expect(r.body.link.autoMerge).toBe(true);
    await settle();
    const pr = gh.repos.get("acme/dental")?.pulls.at(-1);
    expect(pr).toMatchObject({ merged: true });
    const checks = gh.repos
      .get("acme/dental")
      ?.checks.filter((c) => c.sha === mem.head(`wizard/${sys.slug}/${R}`));
    expect(checks?.filter((c) => c.conclusion === "success").map((c) => c.name)).toEqual([
      "Wizard / G0 — сборка и типы",
      "Wizard / G1 — сценарии в браузере",
      "Wizard / G2 — права, ПДн и секреты",
    ]);
    const v = await view(sys.id);
    expect(v.prs[0]).toMatchObject({ revision: R, state: "merged" });
    expect(v.link.remoteHead.revision).toBe(R);
    expect(await repoPublishBlock(api.deps.db, sys.id, R)).toBeNull();
  });

  test("pause lifts the publication rule; no token ever reaches a response, the database or the log", async () => {
    const R = await edit(sys.id, "ui/Footer.tsx", "export default function Footer() { return null; }\n");
    await settle();
    expect(await repoPublishBlock(api.deps.db, sys.id, R)).not.toBeNull();
    const p = await api.req("PATCH", `/systems/${sys.id}/repo-sync`, { body: { paused: true } });
    expect(p.body.link.status).toBe("paused");
    expect(await repoPublishBlock(api.deps.db, sys.id, R)).toBeNull();
    await api.req("PATCH", `/systems/${sys.id}/repo-sync`, { body: { paused: false } });
    const all = JSON.stringify([await view(sys.id), await view(sys.id, VIEWER)]);
    const dump = JSON.stringify(
      await api.deps.pg`select l.*, p.*, j.payload, i.details from platform.system_repo_links l
        left join platform.system_repo_prs p on p.link_id = l.id left join platform.system_repo_jobs j on j.link_id = l.id
        left join platform.system_repo_imports i on i.link_id = l.id`,
    );
    for (const t of gh.issuedTokens()) {
      expect(all).not.toContain(t);
      expect(dump).not.toContain(t);
      expect(logs.join("\n")).not.toContain(t);
    }
  });
});

describe("GitLab self-managed: OAuth with PKCE, project hook, merge requests and commit statuses", () => {
  const mem = new MemRepo("main");
  let sys: { id: string; slug: string };
  let linkId = "";

  test("the instance address must be public https without a path; its own OAuth application is required", async () => {
    sys = await builtSystem("Ремонт техники на своём GitLab");
    gl.addProject(42, "service/repair", mem);
    for (const baseUrl of [
      "http://git.client.example",
      "https://10.0.0.5",
      "https://git.client.example/gitlab",
      "https://user:pw@git.client.example",
    ]) {
      const r = await api.req("POST", `/systems/${sys.id}/repo-sync/gitlab`, {
        body: { baseUrl, clientId: "a", clientSecret: "b" },
      });
      expect(r.status).toBe(400);
    }
    const noApp = await api.req("POST", `/systems/${sys.id}/repo-sync/gitlab`, {
      body: { baseUrl: gl.base },
    });
    expect(noApp.status).toBe(400);
    expect(noApp.body.message_ru).toMatch(/Application ID/);
  });

  test("authorize → callback (PKCE) → project → hook → first push", async () => {
    const r = await api.req("POST", `/systems/${sys.id}/repo-sync/gitlab`, {
      body: { baseUrl: gl.base, clientId: gl.clientId, clientSecret: gl.clientSecret },
    });
    expect(r.status).toBe(200);
    const auth = new URL(r.body.url);
    expect(auth.origin + auth.pathname).toBe(`${gl.base}/oauth/authorize`);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("scope")).toBe("api");
    const { code, state } = gl.approve(r.body.url);
    // A wrong verifier would not pass the mock: the callback's PKCE is checked by the token endpoint.
    const cb = await api.req(
      "GET",
      `/git-sync/gitlab/callback?code=${code}&state=${encodeURIComponent(state)}`,
    );
    expect(cb.status).toBe(302);
    const again = await api.req(
      "GET",
      `/git-sync/gitlab/callback?code=${code}&state=${encodeURIComponent(state)}`,
    );
    expect(again.status).toBe(403);
    const repos = await api.req("GET", `/systems/${sys.id}/repo-sync/repos`);
    expect(repos.body.items).toEqual([
      expect.objectContaining({ id: "42", path: "service/repair", defaultBranch: "main" }),
    ]);
    const sel = await api.req("POST", `/systems/${sys.id}/repo-sync/repo`, { body: { repoId: "42" } });
    expect(sel.status).toBe(200);
    linkId = sel.body.link.id;
    const hook = gl.projects.get(42)?.hooks[0];
    expect(hook?.url).toBe(`http://localhost:5173/api/v1/webhooks/git/gitlab/${linkId}`);
    expect(hook?.token.length).toBeGreaterThan(30);
    await settle();
    expect(mem.head("main")).toBe(
      (await findCommitRow(api.deps.db, sys.id, { revision: await draftOf(sys.id) }))?.oid,
    );
  });

  test("a revision → MR with commit statuses; the hook token is checked; a merge imports", async () => {
    const R = await edit(
      sys.id,
      "ui/Landing.tsx",
      "export default function Landing() { return <h1>Ремонт за день</h1>; }\n",
    );
    await settle();
    const p = gl.projects.get(42);
    expect(p?.mrs[0]).toMatchObject({
      iid: 1,
      source: `wizard/${sys.slug}/${R}`,
      target: "main",
      state: "opened",
    });
    expect(p?.statuses.map((s) => s.name)).toEqual(
      expect.arrayContaining(["Wizard / G0 — сборка и типы", "Wizard / Техревью"]),
    );
    const mrHead = mem.head(`wizard/${sys.slug}/${R}`);
    expect(p?.statuses.filter((s) => s.sha === mrHead).every((s) => s.state === "skipped")).toBe(true);
    gl.mergeMr(42, 1);
    const send = (token: string) =>
      api.fetch(
        new Request(`http://localhost:4000/api/v1/webhooks/git/gitlab/${linkId}`, {
          method: "POST",
          headers: {
            host: "localhost:4000",
            "content-type": "application/json",
            "x-gitlab-event": "Merge Request Hook",
            "x-gitlab-token": token,
            "x-gitlab-event-uuid": randomUUID(),
          },
          body: JSON.stringify({
            object_attributes: { iid: 1, action: "merge", state: "merged", target_branch: "main" },
          }),
        }),
      );
    expect((await send("wrong-token")).status).toBe(401);
    expect((await send(p?.hooks[0]?.token as string)).status).toBe(202);
    await settle();
    const v = await view(sys.id);
    expect(v.prs[0]).toMatchObject({ revision: R, state: "merged" });
    expect(v.imports[0]).toMatchObject({ status: "noop", baseRevision: R });
    expect(await repoPublishBlock(api.deps.db, sys.id, R)).toBeNull();
  });

  test("the access token is refreshed after 2 h (the refresh token rotates); disconnect removes the hook", async () => {
    ahead += 3 * 3600_000;
    await edit(
      sys.id,
      "ui/Landing.tsx",
      "export default function Landing() { return <h1>Ремонт за 2 часа</h1>; }\n",
    );
    await settle();
    expect(gl.refreshed.length).toBeGreaterThanOrEqual(1);
    expect(gl.projects.get(42)?.mrs.length).toBe(2);
    const d = await api.req("DELETE", `/systems/${sys.id}/repo-sync`);
    expect(d.status).toBe(200);
    expect(d.body.link).toBeNull();
    expect(gl.projects.get(42)?.hooks).toEqual([]);
    const rows = await api.deps.pg`select 1 from platform.system_repo_links where id = ${linkId}`;
    expect(rows.length).toBe(0);
    const all = JSON.stringify(await view(sys.id));
    for (const t of gl.issuedTokens()) expect(all + logs.join("\n")).not.toContain(t);
  });
});

describe("rows of the sync: RLS by org, deleted with the system", () => {
  test("without the org nothing is visible; dispatch reads links and jobs only", async () => {
    const sys = await builtSystem("Проверка RLS");
    gh.addRepo(601, "acme/rls", new MemRepo(), "88");
    await connectGithub(sys.id, 601, "88");
    await settle();
    await api.deps.pg.unsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'wz_repo_rls_probe') THEN
        CREATE ROLE wz_repo_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF; END $$`);
    await api.deps.pg.unsafe("GRANT USAGE ON SCHEMA platform TO wz_repo_rls_probe");
    await api.deps.pg.unsafe(
      "GRANT SELECT ON platform.system_repo_links, platform.system_repo_prs, platform.system_repo_jobs, platform.system_repo_imports TO wz_repo_rls_probe",
    );
    const count = (o: { org?: string; dispatch?: boolean }) =>
      api.deps.pg.begin(async (sql) => {
        await sql`set local role wz_repo_rls_probe`;
        if (o.org) await sql`select pg_catalog.set_config('wizard.org_id', ${o.org}, true)`;
        if (o.dispatch) await sql`select pg_catalog.set_config('wizard.repo_dispatch', 'on', true)`;
        const [l] = await sql<
          { n: number }[]
        >`select count(*)::int as n from platform.system_repo_links where system_id = ${sys.id}`;
        const [p] = await sql<
          { n: number }[]
        >`select count(*)::int as n from platform.system_repo_prs where system_id = ${sys.id}`;
        return { links: l?.n, prs: p?.n };
      });
    expect(await count({})).toEqual({ links: 0, prs: 0 });
    expect(await count({ org: randomUUID() })).toEqual({ links: 0, prs: 0 });
    expect(await count({ org: DEFAULT_ORG_ID })).toEqual({ links: 1, prs: 1 });
    expect(await count({ dispatch: true })).toEqual({ links: 1, prs: 0 });
    await expect(
      api.deps.pg.begin(async (sql) => {
        await sql`set local role wz_repo_rls_probe`;
        await sql`select pg_catalog.set_config('wizard.repo_dispatch', 'on', true)`;
        await sql`update platform.system_repo_links set auto_merge = true where system_id = ${sys.id}`;
      }),
    ).rejects.toThrow();

    // delete_system: the connection with its tokens, PRs, imports and queue go with the system.
    await api.deps
      .pg`update platform.systems set deleted_at = now() - interval '31 days' where id = ${sys.id}`;
    await settle();
    await purgeDeletedSystems(
      { db: api.deps.db, pg: api.deps.pg, blobs: api.deps.blobs, config: api.deps.config },
      new Date(),
    );
    const left = await api.deps.pg.begin(async (sql) => {
      await sql`select pg_catalog.set_config('wizard.org_id', ${DEFAULT_ORG_ID}, true)`;
      return sql`select 1 from platform.system_repo_links where system_id = ${sys.id}
                 union all select 1 from platform.system_repo_prs where system_id = ${sys.id}
                 union all select 1 from platform.system_repo_jobs where system_id = ${sys.id}`;
    });
    expect(left.length).toBe(0);
  });
});

describe.skipIf(!HAS_GIT)("round trip with a real git server (oracle)", () => {
  test("push a revision → git → a developer commits with git → webhook → fetch with deltas → import", async () => {
    const bare = join(dir, "clinic.git");
    git(dir, ["init", "--bare", "-q", "-b", "main", bare]);
    git(bare, ["config", "http.receivepack", "true"]);
    const backend = new GitBackend(bare, `${server?.url}/clinic.git`);
    gh.addRepo(701, "acme/clinic", backend, "91");
    const sys = await builtSystem("Клиника на настоящем git");
    await connectGithub(sys.id, 701, "91");
    await settle();
    git(bare, ["fsck", "--strict", "--no-dangling"]);
    const R1 = await draftOf(sys.id);
    const big = Array.from({ length: 300 }, (_, i) => `export const row${i} = "строка ${i}";`).join("\n");
    const R2 = await edit(sys.id, "ui/Rows.tsx", `${big}\n`);
    await settle();
    git(bare, ["fsck", "--strict", "--no-dangling"]);
    const branch = `wizard/${sys.slug}/${R2}`;
    expect(git(bare, ["show", `${branch}:ui/Rows.tsx`])).toBe(`${big}\n`);
    expect(git(bare, ["merge-base", "main", branch]).trim()).toBe(git(bare, ["rev-parse", "main"]).trim());
    expect(R2).toBe(R1 + 1);

    gh.mergePr("acme/clinic", 1);
    await ghHook("pull_request", {
      action: "closed",
      installation: { id: 91 },
      repository: { id: 701 },
      pull_request: { number: 1, merged: true, base: { ref: "main" } },
    });
    await settle();

    const work = join(dir, "clinic-work");
    git(dir, ["clone", "-q", bare, work]);
    for (let i = 0; i < 3; i++) {
      await writeFile(join(work, "ui", "Rows.tsx"), `${big}\n// правка разработчика ${i}\n`);
      git(work, ["add", "-A"]);
      git(work, ["commit", "-q", "-m", `Строки, шаг ${i}`]);
    }
    await writeFile(join(work, ".gitignore"), "node_modules\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "Игнор"]);
    git(work, ["push", "-q", "origin", "main"]);
    git(bare, ["repack", "-adfq", "--depth=50", "--window=50"]);
    await ghHook("push", { ref: "refs/heads/main", installation: { id: 91 }, repository: { id: 701 } });
    await settle();
    const R3 = await draftOf(sys.id);
    expect(R3).toBe(R2 + 1);
    const f = await api.req("GET", `/systems/${sys.id}/files/ui/Rows.tsx?rev=${R3}`);
    expect(f.text).toBe(git(bare, ["show", "main:ui/Rows.tsx"]));

    const R4 = await edit(
      sys.id,
      "ui/Home.tsx",
      "export default function Home() { return <p>Главная</p>; }\n",
    );
    await settle();
    git(bare, ["fsck", "--strict", "--no-dangling"]);
    const b4 = `wizard/${sys.slug}/${R4}`;
    expect(git(bare, ["show", `${b4}:.gitignore`])).toBe("node_modules\n");
    expect(
      git(bare, ["diff", "--name-only", `main...${b4}`])
        .trim()
        .split("\n"),
    ).toEqual(["ui/Home.tsx"]);
    expect(git(bare, ["log", "--format=%an", "-1", b4]).trim()).toBe("Wizard");
  });
});
