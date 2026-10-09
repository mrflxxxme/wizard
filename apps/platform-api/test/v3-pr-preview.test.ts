// V3-32, the items V3-31 left: (1) a preview of a developer's PR before the merge — the PR head is checked as the import
// would check it after the merge (compatibility, line-level merge with Wizard's draft, G0 → G1 → G2) and the gates go to
// the PR as check runs, with a stable address of the preview in Wizard; (2) the line-level merge — a file both Wizard
// and the developers changed is merged when the hunks are apart, and stays a conflict (with the lines named) when they
// touch. GitHub is a mock; the git server is in memory; no network.
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DEV_USER_ID } from "../src/db/index.js";
import { type TxCtx, withTx } from "../src/runs/events.js";
import type { RunExecutors } from "../src/runs/types.js";
import { commitFilesRevision } from "../src/services/revisions.js";
import { startBuild } from "./flow.js";
import { MemRepo } from "./git-sync/mem-repo.js";
import { MockGitHub, routerFetch } from "./git-sync/providers.js";
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

const HOOK_SECRET = "gh-hook-secret-preview";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUB = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const gh = new MockGitHub("23456", PUB);
let ahead = 0;
let failGate: "G0" | "G1" | "G2" | null = null;
const gateCalls: { level: string; files: string[]; price: string | undefined }[] = [];

const ENV = {
  WIZARD_GITHUB_APP_ID: "23456",
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

function executors(): RunExecutors {
  const base = fakeExecutors({ spec: "forum" });
  return {
    ...base,
    gates: async (level, ctx) => {
      gateCalls.push({ level, files: [...ctx.files.keys()], price: ctx.files.get("ui/Price.tsx") });
      return failGate === level
        ? passingReport(level, ctx.specVersion, false)
        : passingReport(level, ctx.specVersion);
    },
  };
}

beforeAll(async () => {
  tdb = await createTestDb("v3prprev");
  api = await startApi(tdb.url, {
    executors: executors(),
    createRouter: fakeRouterFactory(),
    gitSync: {
      env: ENV,
      fetch: routerFetch([
        { origin: gh.api, handle: (r: Request) => gh.handle(r) },
        { origin: gh.web, handle: (r: Request) => gh.handle(r) },
      ]),
      now: () => new Date(Date.now() + ahead),
    },
    repoAgent: { sandbox: null, tickMs: 0 },
  });
});

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

const tx = <T>(fn: (t: TxCtx) => Promise<T>) => withTx(api.deps.db, api.deps.bus, fn);

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await api.gitSync.drain();
    ahead += 31_000;
  }
}

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

function ghHook(event: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${createHmac("sha256", HOOK_SECRET).update(raw).digest("hex")}`;
  return api.fetch(
    new Request("http://localhost:4000/api/v1/webhooks/git/github", {
      method: "POST",
      headers: {
        host: "localhost:4000",
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": sig,
      },
      body: raw,
    }),
  );
}

const PRICE = (rows: string[]) =>
  [
    "export default function Price() {",
    "  return (",
    "    <ul>",
    ...rows.map((r) => `      <li>${r}</li>`),
    "    </ul>",
    "  );",
    "}",
    "",
  ].join("\n");
const ROWS = [
  "Чистка — 3000 ₽",
  "Пломба — 4500 ₽",
  "Отбеливание — 9000 ₽",
  "Имплант — 45000 ₽",
  "Коронка — 20000 ₽",
  "Осмотр — бесплатно",
];

describe("previews of developers' PRs before the merge; line-level merge", () => {
  const mem = new MemRepo("main");
  let sys: { id: string; slug: string };

  const prEvent = (number: number, action: string, head: string, branch: string) =>
    ghHook("pull_request", {
      action,
      installation: { id: 81 },
      repository: { id: 801 },
      pull_request: {
        number,
        html_url: `${gh.web}/acme/clinic/pull/${number}`,
        head: { sha: head, ref: branch },
        base: { ref: "main" },
      },
    });

  test("setup: a system synced with GitHub, Wizard's price list merged", async () => {
    const b = await startBuild(api, "Клиника с превью PR");
    await waitRun(api, b.buildRunId, ["succeeded"]);
    const [s] = await api.deps.pg<
      { slug: string }[]
    >`select slug from platform.systems where id = ${b.systemId}`;
    sys = { id: b.systemId, slug: s?.slug as string };
    gh.addRepo(801, "acme/clinic", mem, "81");
    const start = await api.req("POST", `/systems/${sys.id}/repo-sync/github`);
    const state = new URL(start.body.url).searchParams.get("state") as string;
    gh.codes.set("code-prev", ["81"]);
    const setup = await api.req(
      "GET",
      `/git-sync/github/setup?installation_id=81&state=${encodeURIComponent(state)}&code=code-prev`,
    );
    expect(setup.status).toBe(302);
    expect(
      (await api.req("POST", `/systems/${sys.id}/repo-sync/repo`, { body: { repoId: "801" } })).status,
    ).toBe(200);
    await settle();
    await edit(sys.id, "ui/Price.tsx", PRICE(ROWS));
    await settle();
    const pr = gh.repos.get("acme/clinic")?.pulls.at(-1);
    gh.mergePr("acme/clinic", pr?.number as number);
    await ghHook("pull_request", {
      action: "closed",
      installation: { id: 81 },
      repository: { id: 801 },
      pull_request: { number: pr?.number, merged: true, base: { ref: "main" } },
    });
    await settle();
    const v = (await api.req("GET", `/systems/${sys.id}/repo-sync`)).body;
    expect(v.link.remoteHead.revision).toBe(await draftOf(sys.id));
  });

  let dev: { number: number; head: string };
  test("a developer's PR: its head gated as after the merge — checks in the PR, the preview at a stable address", async () => {
    const before = await draftOf(sys.id);
    const main = mem.head("main") as string;
    mem.refs.set("refs/heads/feature/prices", main);
    const head = mem.commit(
      "feature/prices",
      { "ui/Promo.tsx": "export default function Promo() { return <p>Скидка 10%</p>; }\n" },
      "Акция",
    );
    const pr = gh.openPr("acme/clinic", "feature/prices", "main", "Акция");
    dev = { number: pr.number, head };
    gateCalls.length = 0;
    expect((await prEvent(pr.number, "opened", head, "feature/prices")).status).toBe(202);
    await settle();
    // Nothing was written to the system: the preview is a check only.
    expect(await draftOf(sys.id)).toBe(before);
    expect(gateCalls.map((g) => g.level)).toEqual(["G0", "G1", "G2"]);
    expect(gateCalls[0]?.files).toContain("ui/Promo.tsx");
    const checks = gh.repos.get("acme/clinic")?.checks.filter((c) => c.sha === head) ?? [];
    expect(checks.map((c) => [c.name, c.conclusion])).toEqual([
      ["Wizard / G0 — сборка и типы", "success"],
      ["Wizard / G1 — сценарии в браузере", "success"],
      ["Wizard / G2 — права, ПДн и секреты", "success"],
      ["Wizard / Превью PR", "success"],
    ]);
    const r = await api.req("GET", `/systems/${sys.id}/repo-sync/pulls/${pr.number}`);
    expect(r.status).toBe(200);
    expectContract("getRepoSyncPull", r);
    expect(r.body).toMatchObject({
      number: pr.number,
      branch: "feature/prices",
      headOid: head,
      status: "passed",
      statusRu: "Проверки пройдены",
      files: [{ path: "ui/Promo.tsx", status: "added" }],
      previewUrl: `http://localhost:5173/api/v1/systems/${sys.id}/repo-sync/pulls/${pr.number}`,
    });
    expect(r.body.gates.map((g: { state: string }) => g.state)).toEqual(["success", "success", "success"]);
    const browser = await api.req("GET", `/systems/${sys.id}/repo-sync/pulls/${pr.number}`, {
      headers: { accept: "text/html" },
    });
    expect(browser.status).toBe(302);
    expect(browser.headers.get("location")).toBe(
      `http://localhost:5173/s/${sys.id}/settings?pr=${pr.number}#repo`,
    );
    const view = (await api.req("GET", `/systems/${sys.id}/repo-sync`)).body;
    expectContract("getRepoSync", { status: 200, body: view } as never);
    expect(view.pulls[0]).toMatchObject({ number: pr.number, status: "passed" });
  });

  test("a new push to the PR is checked again: a failed G1 shows in the PR, G2 did not run", async () => {
    const head = mem.commit(
      "feature/prices",
      { "ui/Promo.tsx": "export default function Promo() { return <p>Скидка 15%</p>; }\n" },
      "Акция 15%",
    );
    failGate = "G1";
    await prEvent(dev.number, "synchronize", head, "feature/prices");
    await settle();
    failGate = null;
    const checks = gh.repos.get("acme/clinic")?.checks.filter((c) => c.sha === head) ?? [];
    expect(checks.map((c) => [c.name, c.conclusion])).toEqual([
      ["Wizard / G0 — сборка и типы", "success"],
      ["Wizard / G1 — сценарии в браузере", "failure"],
      ["Wizard / G2 — права, ПДн и секреты", "neutral"],
      ["Wizard / Превью PR", "failure"],
    ]);
    expect(checks[2]?.title).toBe("Не запускалась: раньше не прошла G1");
    const r = await api.req("GET", `/systems/${sys.id}/repo-sync/pulls/${dev.number}`);
    expect(r.body).toMatchObject({
      status: "failed",
      reason_ru: "G1 не пройдена: Ошибка сборки",
      headOid: head,
    });
  });

  test("Wizard's own branches (revision PRs, the agent's PRs) are never previewed", async () => {
    const jobs = async () =>
      Number(
        (
          await api.deps.pg<{ n: number }[]>`select count(*)::int as n from platform.system_repo_jobs
            where system_id = ${sys.id} and kind = 'pr_preview'`
        )[0]?.n,
      );
    const n = await jobs();
    const r = await prEvent(99, "opened", mem.head("main") as string, "wizard/_agent/20261009-abcdef12");
    expect(await r.json()).toEqual({ ok: true, ignored: true });
    expect(await jobs()).toBe(n);
  });

  test("line-level merge: a PR touching other lines of a file Wizard also changed is merged; the same lines conflict", async () => {
    // Wizard changes the first price row (a draft revision not in the repository yet).
    const wizardRows = [...ROWS];
    wizardRows[0] = "Чистка — 3500 ₽";
    await edit(sys.id, "ui/Price.tsx", PRICE(wizardRows));
    const main = mem.head("main") as string;
    // A developer changes the last row: apart from Wizard's hunk → merged line by line.
    mem.refs.set("refs/heads/feature/last-row", main);
    const devRows = [...ROWS];
    devRows[5] = "Осмотр и консультация — бесплатно";
    const apart = mem.commit("feature/last-row", { "ui/Price.tsx": PRICE(devRows) }, "Последняя строка");
    const p1 = gh.openPr("acme/clinic", "feature/last-row", "main", "Последняя строка");
    gateCalls.length = 0;
    await prEvent(p1.number, "opened", apart, "feature/last-row");
    await settle();
    const ok = (await api.req("GET", `/systems/${sys.id}/repo-sync/pulls/${p1.number}`)).body;
    expect(ok).toMatchObject({ status: "passed", merged: ["ui/Price.tsx"] });
    // The candidate the gates checked holds both edits.
    const g0 = gateCalls.find((g) => g.level === "G0");
    expect(g0?.price).toContain("Чистка — 3500 ₽");
    expect(g0?.price).toContain("Осмотр и консультация — бесплатно");
    // A developer changes the same first row: a conflict, the line named.
    mem.refs.set("refs/heads/feature/first-row", main);
    const clashRows = [...ROWS];
    clashRows[0] = "Чистка — 2900 ₽";
    const clash = mem.commit("feature/first-row", { "ui/Price.tsx": PRICE(clashRows) }, "Первая строка");
    const p2 = gh.openPr("acme/clinic", "feature/first-row", "main", "Первая строка");
    await prEvent(p2.number, "opened", clash, "feature/first-row");
    await settle();
    const bad = (await api.req("GET", `/systems/${sys.id}/repo-sync/pulls/${p2.number}`)).body;
    expect(bad.status).toBe("rejected");
    expect(bad.reason_ru).toMatch(
      /^Конфликт: файл ui\/Price\.tsx изменён и в репозитории, и в Wizard \(ревизия \d+\) в одних и тех же строках: ui\/Price\.tsx:4/,
    );
    const check = gh.repos
      .get("acme/clinic")
      ?.checks.find((c) => c.sha === clash && c.name === "Wizard / Превью PR");
    expect(check?.conclusion).toBe("failure");
  });

  test("the import merges line by line too: the developer's row and Wizard's row both land in the new revision", async () => {
    const before = await draftOf(sys.id);
    // The developer merges the «apart» PR into main by hand (GitHub UI) — the import of the default branch follows.
    const pulls = gh.repos.get("acme/clinic")?.pulls ?? [];
    const apart = pulls.find((p) => p.head === "feature/last-row");
    expect(gh.mergePr("acme/clinic", apart?.number as number)).not.toBeNull();
    await ghHook("pull_request", {
      action: "closed",
      installation: { id: 81 },
      repository: { id: 801 },
      pull_request: { number: apart?.number, merged: true, base: { ref: "main" } },
    });
    await settle();
    const after = await draftOf(sys.id);
    expect(after).toBeGreaterThan(before);
    const f = await api.req("GET", `/systems/${sys.id}/files/ui/Price.tsx?rev=${after}`);
    expect(f.text).toContain("Чистка — 3500 ₽");
    expect(f.text).toContain("Осмотр и консультация — бесплатно");
    const v = (await api.req("GET", `/systems/${sys.id}/repo-sync`)).body;
    const imp = v.imports.find((i: { status: string }) => i.status === "imported");
    expect(imp.warnings).toContain("Правки в файле ui/Price.tsx объединены построчно с правками Wizard");
    // Its preview is closed with the PR.
    const pv = (await api.req("GET", `/systems/${sys.id}/repo-sync/pulls/${apart?.number}`)).body;
    expect(pv.status).toBe("closed");
  });
});
