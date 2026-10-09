// V3-32 acceptance (D77_v3 (4); api.yaml «V3-32», db.yaml agent_repo*): a client's repository connected to an org for
// the agent (the GitHub App and GitLab OAuth of the sync, an «agent» state); the compatibility check with the report
// «что сможем / не сможем»; no rules → AGENTS.md proposed by a separate draft PR; a task → install in the sandbox (the
// registry only) → the agent without network → the repository's build and tests → techreview → a draft PR into
// wizard/_agent/* that only a human merges (the sync's auto-merge never touches it); the client's code goes only to
// models with inference in RF — the real router in live mode against an in-process provider: every request it made,
// every llm_calls row. Providers and git are mocks, the sandbox is a fake that runs nothing; no network, no spend.
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { createRegistry, createRouter } from "@wizard/llm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fixture } from "../../../packages/agents/test/repo-fixtures.js";
import { FakeSandbox } from "../../../packages/agents/test/repo-helpers.js";
import { DEFAULT_ORG_ID } from "../src/db/index.js";
import { startBuild } from "./flow.js";
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

const ORG = DEFAULT_ORG_ID;
const VIEWER = { "x-wizard-dev-user": "viewer-agent@example.test" };
const STRANGER = { "x-wizard-dev-user": "stranger-agent@example.test" };
const HOOK_SECRET = "gh-hook-secret-agent";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUB = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const gh = new MockGitHub("34567", PUB);
const gl = new MockGitLab("https://git.studio.example", "studio-app", "studio-secret");
const logs: string[] = [];
let ahead = 0;

const ENV = {
  WIZARD_GITHUB_APP_ID: "34567",
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

// ---- models: the real router, live, against an in-process OpenAI-compatible provider per host ----

const LLM_ENV = {
  CLOUDRU_BASE_URL: "https://cloudru.test/v1",
  CLOUDRU_API_KEY: "k-cloudru",
  YANDEX_BASE_URL: "https://yandex.test/v1",
  YANDEX_API_KEY: "k-yandex",
  YANDEX_FOLDER_ID: "b1folder",
  ZAI_BASE_URL: "https://zai.test/v4",
  ZAI_API_KEY: "k-zai",
};
const llmRequests: { host: string; model: string; tools: string[] }[] = [];
/** Called when the reviewer answers — the last model call before the push (a test makes the git server go down there). */
let onReview: (() => void) | null = null;
const ADDED = '\nexport const orderLabel = "Оформить заказ";\n';

// biome-ignore lint/suspicious/noExplicitAny: OpenAI chat bodies are read field by field
type Json = Record<string, any>;

/** The scripted agent: list → read the main page → append a line → run the checks → finish; the reviewer finds nothing. */
function llmAnswer(body: Json): { name: string; args: unknown } {
  const tools: string[] = (body.tools ?? []).map((t: Json) => t.function?.name);
  if (tools.includes("submit_repo_review")) {
    onReview?.();
    return { name: "submit_repo_review", args: { findings: [] } };
  }
  const messages: Json[] = body.messages ?? [];
  const calls: { name: string; id: string }[] = messages.flatMap((m) =>
    (m.tool_calls ?? []).map((t: Json) => ({ name: t.function.name, id: t.id })),
  );
  const last = calls.at(-1);
  const result = (name: string) => {
    const id = [...calls].reverse().find((c) => c.name === name)?.id;
    const m = messages.find((x) => x.role === "tool" && x.tool_call_id === id);
    return m ? (JSON.parse(String(m.content)) as Json) : {};
  };
  if (!last) return { name: "list_files", args: { prefix: "" } };
  if (last.name === "list_files") {
    const paths: string[] = result("list_files").paths ?? [];
    const target = paths.find((p) => p === "src/App.tsx") ?? paths.find((p) => /^ui\/.*\.tsx$/.test(p));
    return { name: "read_file", args: { path: target } };
  }
  if (last.name === "read_file") {
    const r = result("read_file");
    return { name: "write_file", args: { path: r.path, content: `${r.text}${ADDED}` } };
  }
  if (last.name === "write_file") return { name: "run_checks", args: {} };
  return {
    name: "finish",
    args: { title_ru: "Подпись «Оформить заказ»", summary_ru: "Добавил подпись кнопки оформления заказа." },
  };
}

const llmFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url));
  const body = JSON.parse(String(init?.body ?? "{}")) as Json;
  llmRequests.push({
    host: u.host,
    model: String(body.model),
    tools: (body.tools ?? []).map((t: Json) => t.function?.name),
  });
  const a = llmAnswer(body);
  return new Response(
    JSON.stringify({
      id: `c-${randomUUID()}`,
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_${randomUUID().slice(0, 8)}`,
                type: "function",
                function: { name: a.name, arguments: JSON.stringify(a.args) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 2000, completion_tokens: 300, total_tokens: 2300 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof globalThis.fetch;

const sandbox = new FakeSandbox({
  install: { ok: true, ms: 45_000 },
  build: { ok: true, ms: 30_000 },
  test: { ok: true, ms: 20_000 },
});

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;

beforeAll(async () => {
  tdb = await createTestDb("v3agent");
  const base = fakeExecutors({ spec: "forum" });
  api = await startApi(tdb.url, {
    executors: { ...base, gates: async (level, ctx) => passingReport(level, ctx.specVersion) },
    createRouter: fakeRouterFactory(),
    log: (m, e) => logs.push(`${m} ${e instanceof Error ? e.message : ""}`),
    gitSync: {
      env: ENV,
      fetch: routerFetch([
        { origin: gh.api, handle: (r: Request) => gh.handle(r) },
        { origin: gh.web, handle: (r: Request) => gh.handle(r) },
        { origin: gl.base, handle: (r: Request) => gl.handle(r) },
      ]),
      now: () => new Date(Date.now() + ahead),
    },
    repoAgent: {
      sandbox,
      tickMs: 0,
      env: {},
      createRouter: (opts) =>
        createRouter({
          ...opts,
          mode: "live",
          env: LLM_ENV,
          registry: createRegistry({ buildDefaultTier: "T1" }, LLM_ENV),
          fetch: llmFetch,
          // Z.ai as the reserve of Cloud.ru is on: client code must still never reach it.
          t1Reserve: true,
          sleep: async () => {},
        }),
    },
  });
  for (const h of [VIEWER, STRANGER]) expect((await api.req("GET", "/me", { headers: h })).status).toBe(200);
  await api.deps.pg`update platform.memberships set role = 'viewer' where user_id =
    (select id from platform.users where email = 'viewer-agent@example.test')`;
  await api.deps.pg`delete from platform.memberships where user_id =
    (select id from platform.users where email = 'stranger-agent@example.test')`;
});

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await api.repoAgent.drain();
    await api.gitSync.drain();
    ahead += 31_000;
  }
}

function seed(mem: MemRepo, name: string): string {
  return mem.commit("main", fixture(name).files as Record<string, string>, "Начальный коммит");
}

/** GitHub App installation for the agent → the repository picked → its check queued. Returns the agent repository id. */
async function connectGithub(repoId: number, installation: string): Promise<string> {
  const start = await api.req("POST", `/orgs/${ORG}/repo-agent/github`);
  expect(start.status).toBe(200);
  expectContract("startRepoAgentGithub", start);
  const state = new URL(start.body.url).searchParams.get("state") as string;
  const code = `code-${randomUUID()}`;
  gh.codes.set(code, [installation]);
  const setup = await api.req(
    "GET",
    `/git-sync/github/setup?installation_id=${installation}&setup_action=install&state=${encodeURIComponent(state)}&code=${code}`,
  );
  expect(setup.status).toBe(302);
  const loc = new URL(setup.headers.get("location") as string);
  expect(loc.origin + loc.pathname).toBe("http://localhost:5173/settings/repos");
  const id = loc.searchParams.get("agentRepo") as string;
  const choices = await api.req("GET", `/orgs/${ORG}/repo-agent/${id}/choices`);
  expect(choices.status).toBe(200);
  expectContract("listAgentRepoChoices", choices);
  expect(choices.body.items.map((r: { id: string }) => r.id)).toContain(String(repoId));
  const sel = await api.req("POST", `/orgs/${ORG}/repo-agent/${id}/repo`, {
    body: { repoId: String(repoId) },
  });
  expect(sel.status).toBe(200);
  expectContract("selectAgentRepo", sel);
  expect(sel.body.status).toBe("checking");
  return id;
}

const repoView = async (id: string) => {
  const r = await api.req("GET", `/orgs/${ORG}/repo-agent/${id}`);
  expect(r.status).toBe(200);
  expectContract("getAgentRepo", r);
  return r.body;
};

describe("GitHub: a Vite + React repository — report, rules proposal, a task → a draft PR", () => {
  const mem = new MemRepo("main");
  let id = "";
  let base = "";

  test("connecting: the App installation must be the user's; viewers cannot start, strangers do not see the org", async () => {
    base = seed(mem, "vite-react-pnpm");
    gh.addRepo(901, "acme/bakery", mem, "91");
    expect((await api.req("POST", `/orgs/${ORG}/repo-agent/github`, { headers: VIEWER })).status).toBe(403);
    expect((await api.req("GET", `/orgs/${ORG}/repo-agent`, { headers: STRANGER })).status).toBe(404);
    const start = await api.req("POST", `/orgs/${ORG}/repo-agent/github`);
    const state = new URL(start.body.url).searchParams.get("state") as string;
    gh.codes.set("code-other", ["77"]);
    const foreign = await api.req(
      "GET",
      `/git-sync/github/setup?installation_id=91&state=${encodeURIComponent(state)}&code=code-other`,
    );
    expect(foreign.status).toBe(403);
    id = await connectGithub(901, "91");
  });

  test("the compatibility check: «что сможем / не сможем», install with the registry, build and tests without network", async () => {
    await settle();
    const r = await api.req("GET", `/orgs/${ORG}/repo-agent`);
    expect(r.status).toBe(200);
    expectContract("getRepoAgent", r);
    expect(r.body.sandbox).toEqual({ available: true, kind: "fake", note_ru: null });
    const v = await repoView(id);
    expect(v).toMatchObject({
      status: "ready",
      statusRu: "Агент может работать",
      headOid: base,
      secretRef: "secret://repo/github",
    });
    expect(v.compat.verdict).toBe("compatible");
    expect(v.compat.can[0]).toBe("Дорабатывать код по задаче: Vite и React на TypeScript");
    expect(v.compat.cannot.map((c: { what_ru: string }) => c.what_ru)).toEqual([
      "Менять CI (.github/workflows, .gitlab-ci.yml) и lockfile",
      "Мержить PR и деплоить",
    ]);
    expect(v.compat.sandbox.steps.map((s: { command: string }) => s.command)).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm run build",
      "pnpm run test",
    ]);
    expect(sandbox.runs.slice(0, 3).map((x) => `${x.phase}:${x.network}`)).toEqual([
      "install:registry",
      "build:none",
      "test:none",
    ]);
  });

  test("no rules in the repository: AGENTS.md is proposed by a separate draft PR into wizard/_agent/*", async () => {
    const v = await repoView(id);
    const rulesTask = v.tasks.find((t: { kind: string }) => t.kind === "rules");
    expect(rulesTask).toMatchObject({ status: "done", pr: { number: 1, draft: true } });
    expect(rulesTask.branch).toMatch(/^wizard\/_agent\/rules-[0-9a-f]{8}$/);
    expect(v.rulesPr).toBe(`${gh.web}/acme/bakery/pull/1`);
    const pr = gh.repos.get("acme/bakery")?.pulls[0];
    expect(pr).toMatchObject({
      number: 1,
      draft: true,
      base: "main",
      title: "Wizard: правила для агентов (AGENTS.md)",
    });
    expect(pr?.body).toContain("Мержит только человек");
    const agents = mem.file(rulesTask.branch, "AGENTS.md") as string;
    expect(agents).toContain("# acme/bakery");
    expect(agents).toContain("- Установка зависимостей: `pnpm install --frozen-lockfile`");
    // Only AGENTS.md changed: the parent is the default branch head.
    expect(mem.commitOf(mem.head(rulesTask.branch) as string).parents).toEqual([base]);
    expect(mem.file(rulesTask.branch, "src/App.tsx")).toBe(mem.file("main", "src/App.tsx"));
  });

  let taskId = "";
  test("a task: the agent without network, the repository's tests, techreview → a draft PR; merged only by a human", async () => {
    sandbox.runs.length = 0;
    const t = await api.req("POST", `/orgs/${ORG}/repo-agent/${id}/tasks`, {
      body: { task: "Добавь подпись «Оформить заказ». Контакт для вопросов: Иван Петров, +7 916 123-45-67" },
    });
    expect(t.status).toBe(202);
    expectContract("createAgentTask", t);
    expect(t.body).toMatchObject({ kind: "change", status: "queued" });
    taskId = t.body.id;
    expect(
      (await api.req("POST", `/orgs/${ORG}/repo-agent/${id}/tasks`, { body: { task: "x" }, headers: VIEWER }))
        .status,
    ).toBe(403);
    await settle();
    const v = await repoView(id);
    const task = v.tasks.find((x: { id: string }) => x.id === taskId);
    expect(task).toMatchObject({
      status: "done",
      pr: { number: 2, draft: true },
      summary_ru: "Добавил подпись кнопки оформления заказа.",
    });
    expect(task.costRub).toBeGreaterThan(0);
    expect(task.branch).toMatch(/^wizard\/_agent\/\d{8}-[0-9a-f]{8}$/);
    // The change on top of the default branch head.
    const head = mem.head(task.branch) as string;
    expect(mem.commitOf(head).parents).toEqual([base]);
    expect(mem.commitOf(head).author.name).toBe("Wizard");
    expect(mem.file(task.branch, "src/App.tsx")).toBe(`${mem.file("main", "src/App.tsx")}${ADDED}`);
    expect(mem.file(task.branch, "AGENTS.md")).toBeNull();
    // The draft PR: what was done and checked, who merges; no personal data of the task.
    const pr = gh.repos.get("acme/bakery")?.pulls[1];
    expect(pr).toMatchObject({
      number: 2,
      draft: true,
      base: "main",
      head: task.branch,
      title: "Wizard: Подпись «Оформить заказ»",
    });
    expect(pr?.body).toContain(
      "| Установка зависимостей (pnpm install --frozen-lockfile) | пройдена, 45 с |",
    );
    expect(pr?.body).toContain("| Тесты репозитория | пройдены, 20 с |");
    expect(pr?.body).toContain("| Техревью | блокеров нет |");
    expect(pr?.body).toContain("Код репозитория обрабатывали только модели с инференсом в России.");
    expect(pr?.body).toContain(
      "Мержит только человек: Wizard этот PR не сливает, автомерж для него выключен.",
    );
    expect(pr?.body).toContain(
      `агент работал по черновику AGENTS.md от Wizard (${gh.web}/acme/bakery/pull/1)`,
    );
    expect(pr?.body).not.toContain("+7 916");
    expect(pr?.body).not.toContain("Иван Петров");
    expect(gh.repos.get("acme/bakery")?.checks.find((c) => c.sha === head)).toMatchObject({
      name: "Wizard / Агент — песочница и техревью",
      conclusion: "success",
    });
    // The sandbox: install had the registry; the agent's run and the verification after it — no network.
    expect(sandbox.runs.map((x) => `${x.phase}:${x.network}`)).toEqual([
      "install:registry",
      "build:none",
      "test:none",
      "agent:none",
      "agent:none",
      "build:none",
      "test:none",
    ]);
    expect(sandbox.runs.at(-1)?.files.get("src/App.tsx")).toContain("orderLabel");
    // The model part by fact, once.
    const [charge] = await api.deps.pg<{ n: number; amount: string }[]>`
      select count(*)::int as n, coalesce(sum(amount_milli), 0)::text as amount from platform.credit_ledger
       where org_id = ${ORG} and idempotency_key like ${`repo:${taskId}%`}`;
    expect(charge?.n).toBeGreaterThanOrEqual(1);
    expect(Number(charge?.amount)).toBeLessThan(0);
    // Nobody merged anything.
    expect(gh.calls.filter((c) => c.method === "PUT" && /\/merge$/.test(c.path))).toEqual([]);
    expect(mem.head("main")).toBe(base);
  });

  test("route test: every call carrying the client's code went to models with inference in RF (never Z.ai)", async () => {
    expect(llmRequests.length).toBeGreaterThan(4);
    for (const r of llmRequests) expect(["cloudru.test", "yandex.test"], r.host).toContain(r.host);
    const rows = await api.deps.pg<
      { call_type: string; tier: string; provider: string; route_reason: string; model_id: string }[]
    >`
      select call_type, tier, provider, route_reason, model_id from platform.llm_calls
       where org_id = ${ORG} and call_type in ('repo_code', 'repo_review')`;
    expect(new Set(rows.map((r) => r.call_type))).toEqual(new Set(["repo_code", "repo_review"]));
    for (const r of rows) {
      expect(r.tier).toBe("T0");
      expect(["cloudru", "yandex"]).toContain(r.provider);
      expect(r.route_reason).toBe("callType_forbidden_T1");
    }
    // The reviewer is of another family than the agent.
    const agentModels = new Set(rows.filter((r) => r.call_type === "repo_code").map((r) => r.model_id));
    const reviewModels = new Set(rows.filter((r) => r.call_type === "repo_review").map((r) => r.model_id));
    expect([...agentModels]).toEqual(["deepseek-v4-pro"]);
    expect([...reviewModels]).toEqual(["gpt-oss-120b"]);
  });

  test("the sync's auto-merge never touches the agent's PRs — even with the same repository linked to a system", async () => {
    const b = await startBuild(api, "Пекарня на GitHub");
    await waitRun(api, b.buildRunId, ["succeeded"]);
    const start = await api.req("POST", `/systems/${b.systemId}/repo-sync/github`);
    const state = new URL(start.body.url).searchParams.get("state") as string;
    gh.codes.set("code-sys", ["91"]);
    expect(
      (
        await api.req(
          "GET",
          `/git-sync/github/setup?installation_id=91&state=${encodeURIComponent(state)}&code=code-sys`,
        )
      ).status,
    ).toBe(302);
    expect(
      (await api.req("POST", `/systems/${b.systemId}/repo-sync/repo`, { body: { repoId: "901" } })).status,
    ).toBe(200);
    await settle();
    const wizardPr = gh.repos.get("acme/bakery")?.pulls.at(-1);
    expect(wizardPr?.head).toMatch(/^wizard\/[a-z0-9-]+\/\d+$/);
    // Green gates for the Wizard PR's revision, auto-merge on.
    const [run] = await api.deps.pg<{ id: string; v: number }[]>`
      select r.id, s.draft_revision as v from platform.runs r join platform.systems s on s.id = r.system_id
       where r.system_id = ${b.systemId} and r.kind = 'build' limit 1`;
    for (const level of ["G0", "G1", "G2"] as const)
      await api.deps.pg`insert into platform.gate_reports (run_id, system_id, revision, level, passed, report)
        values (${run?.id as string}, ${b.systemId}, ${run?.v as number}, ${level}, true,
                ${api.deps.pg.json(passingReport(level, run?.v as number) as unknown as Parameters<typeof api.deps.pg.json>[0])})
        on conflict (run_id, level, revision) do nothing`;
    expect(
      (await api.req("PATCH", `/systems/${b.systemId}/repo-sync`, { body: { autoMerge: true } })).status,
    ).toBe(200);
    // A webhook about the agent's PR: never previewed (a wizard/* branch).
    const agentPr = gh.repos.get("acme/bakery")?.pulls[1];
    const raw = JSON.stringify({
      action: "opened",
      installation: { id: 91 },
      repository: { id: 901 },
      pull_request: {
        number: 2,
        head: { sha: mem.head(agentPr?.head as string), ref: agentPr?.head },
        base: { ref: "main" },
      },
    });
    const hook = await api.fetch(
      new Request("http://localhost:4000/api/v1/webhooks/git/github", {
        method: "POST",
        headers: {
          host: "localhost:4000",
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": randomUUID(),
          "x-hub-signature-256": `sha256=${createHmac("sha256", HOOK_SECRET).update(raw).digest("hex")}`,
        },
        body: raw,
      }),
    );
    expect(await hook.json()).toEqual({ ok: true, ignored: true });
    await settle();
    const merges = gh.calls
      .filter((c) => c.method === "PUT" && /\/pulls\/\d+\/merge$/.test(c.path))
      .map((c) => c.path);
    expect(merges).toEqual([`/repos/acme/bakery/pulls/${wizardPr?.number}/merge`]);
    const pulls = gh.repos.get("acme/bakery")?.pulls ?? [];
    expect(pulls[0]).toMatchObject({ state: "open", merged: false, draft: true });
    expect(pulls[1]).toMatchObject({ state: "open", merged: false, draft: true });
  });
});

describe("a Wizard system's repository: the agent's change checked by our G0 and G2 (nothing of the client's runs)", () => {
  test("a compiled system in the repository → compatible by the gates → a task → a draft PR with the change", async () => {
    const mem = new MemRepo("main");
    const base = seed(mem, "wizard-system");
    gh.addRepo(904, "acme/clinic-src", mem, "94");
    const runs = sandbox.runs.length;
    const id = await connectGithub(904, "94");
    await settle();
    const v = await repoView(id);
    expect(v.compat).toMatchObject({ verdict: "compatible", kind: "wizard_system", rules: ["AGENTS.md"] });
    expect(v.compat.sandbox.steps.map((x: { command: string; ok: boolean }) => [x.command, x.ok])).toEqual([
      ["G0 — сборка и типы", true],
      ["G2 — права, ПДн и секреты", true],
    ]);
    // A Wizard system has its rules (AGENTS.md): nothing to propose.
    expect(v.tasks.some((t: { kind: string }) => t.kind === "rules")).toBe(false);
    const t = await api.req("POST", `/orgs/${ORG}/repo-agent/${id}/tasks`, {
      body: { task: "Добавь подпись кнопки заказа" },
    });
    expect(t.status).toBe(202);
    await settle();
    const task = (await repoView(id)).tasks.find((x: { id: string }) => x.id === t.body.id);
    expect(task).toMatchObject({ status: "done", pr: { draft: true } });
    const page = [...mem.flat(mem.head(task.branch) as string).keys()].find((p) =>
      /^ui\/.*\.tsx$/.test(p),
    ) as string;
    expect(mem.file(task.branch, page)).toBe(`${mem.file("main", page)}${ADDED}`);
    expect(mem.commitOf(mem.head(task.branch) as string).parents).toEqual([base]);
    // The client's code never ran: the fake runner was not used for this repository.
    expect(sandbox.runs.length).toBe(runs);
    expect(gh.repos.get("acme/clinic-src")?.pulls.find((p) => p.head === task.branch)).toMatchObject({
      draft: true,
      state: "open",
    });
  }, 120_000);
});

describe("refusals: an incompatible repository, a repository without draft PRs", () => {
  test("PHP / 1С-Битрикс: incompatible with the reason, a development request; a task is refused (412)", async () => {
    const mem = new MemRepo("main");
    seed(mem, "php-bitrix");
    gh.addRepo(902, "acme/bitrix", mem, "92");
    const id = await connectGithub(902, "92");
    await settle();
    const v = await repoView(id);
    expect(v.status).toBe("incompatible");
    expect(v.compat.cannot[0].why_ru).toMatch(/^PHP \(1С-Битрикс\) пока не дорабатываем/);
    const [req] = await api.deps.pg<{ category: string; quote: string }[]>`
      select category, quote from platform.development_requests where org_id = ${ORG} and quote like 'Доработка репозитория%'`;
    expect(req).toEqual({ category: "other", quote: "Доработка репозитория на PHP (1С-Битрикс)" });
    expect(v.tasks.some((t: { kind: string }) => t.kind === "rules")).toBe(false);
    const t = await api.req("POST", `/orgs/${ORG}/repo-agent/${id}/tasks`, {
      body: { task: "Почини корзину" },
    });
    expect(t.status).toBe(412);
    expect(t.body.message_ru).toMatch(/^Репозиторий несовместим: PHP \(1С-Битрикс\)/);
  });

  test("GitHub Free private repository (no draft PRs): a usual PR titled «Черновик: …», still never merged by Wizard", async () => {
    const mem = new MemRepo("main");
    seed(mem, "vite-react-npm");
    gh.addRepo(903, "acme/shop", mem, "93");
    const repo = gh.repos.get("acme/shop");
    if (repo) repo.noDraft = true;
    const id = await connectGithub(903, "93");
    await settle();
    const v = await repoView(id);
    const rules = v.tasks.find((t: { kind: string }) => t.kind === "rules");
    expect(rules).toMatchObject({ status: "done", pr: { number: 1, draft: false } });
    expect(repo?.pulls[0]).toMatchObject({
      draft: false,
      title: "Черновик: Wizard: правила для агентов (AGENTS.md)",
    });
  });
});

describe("an outage between the agent and the PR", () => {
  test("only the push is retried: the agent does not run (and cost) twice", async () => {
    const mem = new MemRepo("main");
    seed(mem, "vite-react-pnpm");
    gh.addRepo(905, "acme/retry", mem, "95");
    const id = await connectGithub(905, "95");
    await settle();
    onReview = () => {
      mem.down = true;
    };
    const t = await api.req("POST", `/orgs/${ORG}/repo-agent/${id}/tasks`, {
      body: { task: "Подпись кнопки" },
    });
    expect(t.status).toBe(202);
    await api.repoAgent.drain();
    onReview = null;
    let task = (await repoView(id)).tasks.find((x: { id: string }) => x.id === t.body.id);
    expect(task).toMatchObject({ status: "queued", pr: null });
    expect(task.error_ru).toBe(
      "GitHub сейчас недоступен. Повторим автоматически — работа в Wizard не останавливается",
    );
    const calls = llmRequests.length;
    mem.down = false;
    ahead += 120_000;
    await settle();
    task = (await repoView(id)).tasks.find((x: { id: string }) => x.id === t.body.id);
    expect(task).toMatchObject({ status: "done", pr: { draft: true }, error_ru: null });
    expect(llmRequests.length).toBe(calls);
    expect(mem.file(task.branch, "src/App.tsx")).toContain("orderLabel");
    const [row] = await api.deps.pg.begin(async (sql) => {
      await sql`select pg_catalog.set_config('wizard.org_id', ${ORG}, true)`;
      return sql<
        { result: Record<string, unknown> }[]
      >`select result from platform.agent_repo_tasks where id = ${t.body.id}`;
    });
    expect(row?.result.push).toBeUndefined();
  });
});

describe("GitLab self-managed for the agent: OAuth with PKCE, tokens sealed in the agent's row, a draft MR", () => {
  test("authorize → callback (agent state) → project → check → rules as a «Draft:» merge request", async () => {
    const mem = new MemRepo("main");
    seed(mem, "vite-react-yarn");
    gl.addProject(77, "studio/landing", mem);
    const r = await api.req("POST", `/orgs/${ORG}/repo-agent/gitlab`, {
      body: { baseUrl: gl.base, clientId: gl.clientId, clientSecret: gl.clientSecret },
    });
    expect(r.status).toBe(200);
    expectContract("startRepoAgentGitlab", r);
    const { code, state } = gl.approve(r.body.url);
    const cb = await api.req(
      "GET",
      `/git-sync/gitlab/callback?code=${code}&state=${encodeURIComponent(state)}`,
    );
    expect(cb.status).toBe(302);
    const id = new URL(cb.headers.get("location") as string).searchParams.get("agentRepo") as string;
    const [row] = await api.deps.pg.begin(async (sql) => {
      await sql`select pg_catalog.set_config('wizard.org_id', ${ORG}, true)`;
      return sql<{ ciphertext: string | null; kek_backend: string | null }[]>`
        select ciphertext, kek_backend from platform.agent_repos where id = ${id}`;
    });
    expect(row?.ciphertext).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(row?.kek_backend).toBe("local");
    const sel = await api.req("POST", `/orgs/${ORG}/repo-agent/${id}/repo`, { body: { repoId: "77" } });
    expect(sel.status).toBe(200);
    await settle();
    const v = await repoView(id);
    expect(v.compat.stack).toMatchObject({ packageManager: "yarn", lockfile: "yarn.lock" });
    const mr = gl.projects.get(77)?.mrs[0];
    expect(mr?.title).toBe("Draft: Wizard: правила для агентов (AGENTS.md)");
    expect(v.tasks.find((t: { kind: string }) => t.kind === "rules")?.pr).toMatchObject({ draft: true });
    // No token reaches a response, the database in the clear or the log.
    const all = JSON.stringify(await api.req("GET", `/orgs/${ORG}/repo-agent`));
    const dump = JSON.stringify(
      await api.deps.pg.begin(async (sql) => {
        await sql`select pg_catalog.set_config('wizard.org_id', ${ORG}, true)`;
        return sql`select r.*, t.* from platform.agent_repos r left join platform.agent_repo_tasks t on t.repo_id = r.id`;
      }),
    );
    for (const t of [...gl.issuedTokens(), ...gh.issuedTokens()]) {
      expect(all).not.toContain(t);
      expect(dump).not.toContain(t);
      expect(logs.join("\n")).not.toContain(t);
    }
  });
});

describe("rows of the agent: RLS by org", () => {
  test("without the org nothing is visible; the dispatch read sees repositories and tasks only", async () => {
    await api.deps.pg.unsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'wz_agent_rls_probe') THEN
        CREATE ROLE wz_agent_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF; END $$`);
    await api.deps.pg.unsafe("GRANT USAGE ON SCHEMA platform TO wz_agent_rls_probe");
    await api.deps.pg.unsafe(
      "GRANT SELECT, UPDATE ON platform.agent_repos, platform.agent_repo_tasks TO wz_agent_rls_probe",
    );
    const count = (o: { org?: string; dispatch?: boolean }) =>
      api.deps.pg.begin(async (sql) => {
        await sql`set local role wz_agent_rls_probe`;
        if (o.org) await sql`select pg_catalog.set_config('wizard.org_id', ${o.org}, true)`;
        if (o.dispatch) await sql`select pg_catalog.set_config('wizard.repo_dispatch', 'on', true)`;
        const [r] = await sql<{ n: number }[]>`select count(*)::int as n from platform.agent_repos`;
        return r?.n;
      });
    expect(await count({})).toBe(0);
    expect(await count({ org: randomUUID() })).toBe(0);
    expect(await count({ org: ORG })).toBeGreaterThanOrEqual(4);
    expect(await count({ dispatch: true })).toBeGreaterThanOrEqual(4);
    await expect(
      api.deps.pg.begin(async (sql) => {
        await sql`set local role wz_agent_rls_probe`;
        await sql`select pg_catalog.set_config('wizard.repo_dispatch', 'on', true)`;
        const r = await sql`update platform.agent_repos set status = 'error' returning id`;
        if (r.length === 0) throw new Error("no rows updated under dispatch");
      }),
    ).rejects.toThrow();
  });
});
