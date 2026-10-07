// B2-24: the strict threshold of beta v2 (product.yaml#decisions.D76_beta_v2 (6), eval.yaml#thresholds.by_milestone.B2)
// in the measurement driver and its report — plan coverage (covered / uncovered / unknown), browser checks of G1
// (goal scenarios, 390 px) as part of readiness, the verdict «covered: all ready; uncovered: all at a working system
// with recorded requests», the screenshot grid; a driver run over the fake platform with the plan and G1 browser checks.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBriefs } from "../lib/briefs.mjs";
import { cookieNames, platformClient } from "../server/client.mjs";
import {
  browserSummary,
  countedD76,
  isReadyD76,
  pendingPlan,
  planCoverage,
  readPlan,
  runEval,
  summarizeGates,
  unwrapPlan,
} from "../server/driver.mjs";
import { economy, evaluate, renderReport, screenshotGrid } from "../server/report.mjs";
import { collectSql, parseCollectOutput } from "../server/seed.mjs";
import { previewScreenshots, SHOT_VIEWPORTS } from "../server/screenshots.mjs";
import { fakePlan, fakePlatform, scenarioOf } from "./fake-platform.mjs";

const PLAN = {
  version: 1,
  modules: [{ id: "landing" }, { id: "leads" }, { id: "notify" }],
  custom: [],
  outOfScope: [],
};
const UNCOVERED = {
  ...PLAN,
  outOfScope: [{ what: "Оплата картой на сайте", replacement: "Заявка, владелец выставляет счёт" }],
};
const g1 = (extra) => ({
  reports: [
    { level: "G0", passed: true, checks: [] },
    {
      level: "G1",
      passed: !extra.some((c) => c.status === "fail"),
      checks: [{ id: "G1-PERM", status: "pass", severity: "blocker", message_ru: "ok" }, ...extra],
    },
  ],
});
const GOAL_OK = { id: "G1-GOAL-GS-leads-1", status: "pass", severity: "blocker", message_ru: "Сценарий проходит" };
const MOBILE_OK = { id: "G1-MOBILE-01", status: "pass", severity: "blocker", message_ru: "Без прокрутки" };
const lvl = () => ({ passed: true, blockers: [], ownerActions: [], warnings: 0 });
const PASSED = { G0: lvl(), G1: lvl(), G2: lvl() };

describe("D76 pieces", () => {
  it("plan coverage: no custom part and nothing out of scope — covered; otherwise uncovered; no plan — unknown", () => {
    expect(planCoverage(PLAN)).toMatchObject({ coverage: "covered", modules: ["landing", "leads", "notify"] });
    expect(planCoverage(UNCOVERED)).toMatchObject({
      coverage: "uncovered",
      outOfScope: [{ what: "Оплата картой на сайте", replacement: "Заявка, владелец выставляет счёт" }],
    });
    expect(planCoverage({ ...PLAN, custom: [{ id: "quiz", title: "Опрос" }] })).toMatchObject({
      coverage: "uncovered",
      custom: ["Опрос"],
    });
    expect(planCoverage(null).coverage).toBe("unknown");
  });

  it("browser checks of G1 are part of readiness: absent, failed or passed", () => {
    const absent = browserSummary(g1([]));
    expect(absent).toMatchObject({ ran: false, mobile: "absent" });
    expect(isReadyD76(PASSED, "publish", absent)).toBe(false);
    const ok = browserSummary(g1([GOAL_OK, MOBILE_OK]));
    expect(ok).toMatchObject({ ran: true, mobile: "pass", goals: { total: 1, passed: 1, failed: [] } });
    expect(isReadyD76(PASSED, "publish", ok)).toBe(true);
    const bad = browserSummary(g1([{ ...GOAL_OK, status: "fail", message_ru: "Письма нет" }, MOBILE_OK]));
    expect(bad.goals.failed).toEqual([{ id: "GS-leads-1", message: "Письма нет" }]);
    expect(isReadyD76(PASSED, "publish", bad)).toBe(false);
    const wide = browserSummary(g1([GOAL_OK, { ...MOBILE_OK, status: "fail" }]));
    expect(isReadyD76(PASSED, "publish", wide)).toBe(false);
  });

  // B2-41: mvp-01 of the probe failed G1, the driver never reached the publication (where it fills the operator data),
  // and the build's G2-PII-06 showed up as a second cause. Before the publication it is the owner's part.
  it("G2-PII-06 of the build is the owner's data; in the publication's G2 it is a blocker", () => {
    const pii = { id: "G2-PII-06", status: "fail", severity: "blocker", message_ru: "Не указано: адрес оператора ПДн" };
    const latest = { reports: [{ level: "G2", passed: false, checks: [pii] }] };
    expect(summarizeGates(latest, { beforePublish: true }).G2).toMatchObject({
      blockers: [],
      ownerActions: [{ id: "G2-PII-06" }],
    });
    expect(summarizeGates(latest).G2).toMatchObject({ blockers: [{ id: "G2-PII-06" }], ownerActions: [] });
    // Not ready either way when G1 failed: the owner's part does not hide the cause.
    const g1Failed = { ...PASSED, G1: { ...lvl(), passed: false, blockers: [{ id: "SC-AC1", message: "…" }] } };
    expect(isReadyD76(g1Failed, "publish", { ran: true, mobile: "pass", goals: { failed: [] } })).toBe(false);
  });

  it("the plan comes from the system view or from /plan", async () => {
    expect(await readPlan(null, "s1", { plan: PLAN })).toBe(PLAN);
    const client = { get: async () => ({ body: { plan: UNCOVERED } }) };
    expect(await readPlan(client, "s1", { system: {} })).toBe(UNCOVERED);
    const none = { get: async () => Promise.reject(new Error("404 NOT_FOUND")) };
    expect(await readPlan(none, "s1", {})).toBeNull();
  });
});

const item = (id, over) => ({
  id,
  class: "site",
  title: `Бриф ${id}`,
  status: "ready",
  ready: true,
  systemId: `sys-${id}`,
  gates: PASSED,
  gaps: { outOfScope: [], reported: [], mentions: [] },
  plan: planCoverage(PLAN),
  browser: browserSummary(g1([GOAL_OK, MOBILE_OK])),
  screenshots: [],
  creditsUsed: 1,
  costRubEstimate: 5,
  minutes: 4,
  ...over,
});
const doc = (results) => ({ kind: "d76", threshold: "d76", startedAt: "2026-10-20T10:00:00Z", maxCostRub: 300, concurrency: 2, results });

describe("D76 verdict and report", () => {
  it("covered briefs all ready, uncovered ones at a working system with recorded requests — the threshold passes", () => {
    const d = doc([
      item("mvp-01-a", { screenshots: [{ label: "Главная", src: "shots/mvp-01.png" }] }),
      item("mvp-02-b", { plan: planCoverage(UNCOVERED) }),
    ]);
    const db = { gaps: { "sys-mvp-02-b": [{ category: "Оплата", quote: "Оплата картой на сайте" }] } };
    const e = evaluate(d, db);
    expect(e.coverage).toEqual({
      covered: { total: 1, counted: 1 },
      uncovered: { total: 1, counted: 1 },
      unknown: { total: 0, counted: 0 },
    });
    expect(e.passed).toBe(true);
    const { text } = renderReport(d, db);
    expect(text).toContain("# Замер беты v2 (порог D76)");
    expect(text).toContain("строгий порог D76 пройден");
    expect(text).toContain("Брифы в модулях (план без дописывания и без «не входит»): готовы 1 из 1");
    expect(text).toContain("Не входит: Оплата картой на сайте — замена: Заявка, владелец выставляет счёт");
    expect(text).toContain("Сценарии целей в браузере: прошли 1 из 1; страницы на 390 px: без прокрутки вбок");
    expect(text).toContain("## Сетка скриншотов");
    expect(text).toContain("![Главная](shots/mvp-01.png)");
  });

  it("one covered brief not ready, an uncovered one without a recorded request, an unread plan — not passed", () => {
    const failedGoal = browserSummary(g1([{ ...GOAL_OK, status: "fail", message_ru: "Письма нет" }, MOBILE_OK]));
    const d = doc([
      item("mvp-01-a", { ready: false, status: "not_ready", browser: failedGoal }),
      item("mvp-02-b", { plan: planCoverage(UNCOVERED) }),
      item("mvp-03-c", { plan: planCoverage(null) }),
    ]);
    const e = evaluate(d, { gaps: {} });
    expect(e.items.map((x) => [x.coverage, x.counted])).toEqual([
      ["covered", false],
      ["uncovered", false],
      ["unknown", false],
    ]);
    expect(e.passed).toBe(false);
    const { text } = renderReport(d, { gaps: {} });
    expect(text).toContain("строгий порог D76 не пройден — засчитано 0 из 3");
    expect(text).toContain("GS-leads-1: Письма нет");
    expect(text).toContain("План системы не прочитан у 1 брифов");
    expect(text).toContain("| mvp-01-a | в модулях | ❌");
  });

  it("an uncovered brief with nothing out of scope (custom part done) counts when ready; countedD76 mirrors it", () => {
    const custom = planCoverage({ ...PLAN, custom: [{ id: "quiz", title: "Опрос" }] });
    expect(evaluate(doc([item("mvp-04-d", { plan: custom })]), { gaps: {} }).passed).toBe(true);
    expect(countedD76(item("x", { plan: custom }))).toBe(true);
    // The platform records «не входит» on approval (B2-41), so a ready uncovered brief counts during the run (the early
    // stop of the full run); the report re-checks the recorded requests in the database.
    expect(countedD76(item("x", { plan: planCoverage(UNCOVERED) }))).toBe(true);
    expect(countedD76(item("x", { plan: planCoverage(UNCOVERED), ready: false }))).toBe(false);
    expect(countedD76(item("x", { plan: planCoverage(null) }))).toBe(false);
  });

  it("the grid lays screenshots 3 per row", () => {
    const shots = (n) => Array.from({ length: n }, (_, i) => ({ label: `Экран ${i}`, src: `s${i}.png` }));
    const L = screenshotGrid([{ id: "a", screenshots: shots(4) }]);
    expect(L.filter((l) => l.startsWith("| ![")).length).toBe(2);
    expect(screenshotGrid([{ id: "a", screenshots: [] }])).toEqual([]);
  });
});

// The driver over the fake platform: d76 reads the plan and the browser checks of G1, takes screenshots.
const SESSION = { token: "t".repeat(43), csrf: "c".repeat(43) };
let srv;
let base;
const holder = { handler: async () => new Response(null, { status: 503 }) };
beforeAll(async () => {
  srv = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await holder.handler(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers,
        ...(body && req.method !== "GET" ? { body } : {}),
      }),
    );
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) for await (const c of r.body) res.write(c);
    res.end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${srv.address().port}`;
});
afterAll(() => srv?.close());

describe("D76 driver run", () => {
  it("a site brief: covered plan, goal scenarios and 390 px pass in G1 → ready and counted", async () => {
    const f = fakePlatform({
      ...SESSION,
      origin: base,
      cookieNames: cookieNames(base),
      override: (method, path) =>
        method === "GET" && /^\/systems\/[^/]+\/plan$/.test(path)
          ? new Response(JSON.stringify({ plan: PLAN }), { headers: { "content-type": "application/json" } })
          : undefined,
    });
    // The fake's G1 reports get the browser checks a v2 platform runs.
    holder.handler = async (req) => {
      const res = await f.handler(req);
      if (!new URL(req.url).pathname.endsWith("/gates/latest")) return res;
      const latest = await res.json();
      for (const r of latest.reports ?? []) if (r.level === "G1") r.checks.push(GOAL_OK, MOBILE_OK);
      return new Response(JSON.stringify(latest), { headers: { "content-type": "application/json" } });
    };
    const shots = [];
    const run = await runEval({
      client: platformClient({ base, session: SESSION, sleep: async () => {} }),
      briefs: loadBriefs("mvp").slice(0, 1),
      threshold: "d76",
      log: () => {},
      sleep: async () => {},
      pollMs: 1,
      maxBriefRub: 10_000,
      screenshot: async (r) => {
        shots.push(r.systemId);
        return [{ label: "Главная, 390 px", src: `shots/${r.id}.png` }];
      },
    });
    expect(run).toMatchObject({ kind: "d76", threshold: "d76" });
    const r = run.results[0];
    expect(r.plan.coverage).toBe("covered");
    expect(r.browser).toMatchObject({ ran: true, mobile: "pass" });
    expect(r.screenshots).toEqual([{ label: "Главная, 390 px", src: `shots/${r.id}.png` }]);
    expect(shots).toEqual([r.systemId]);
    expect(r.ready).toBe(r.gates.G0?.passed === true && r.gates.G1?.passed === true);
    expect(evaluate(run).items[0].counted).toBe(r.ready);
  });
});

describe("D76 screenshots of the systems", () => {
  it("one browser for the run, a fresh preview link per viewport, PNGs at 390 and 1280 px", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wz-d76-shots-"));
    const launched = [];
    const opened = [];
    const fakeBrowser = {
      newContext: async ({ viewport }) => ({
        newPage: async () => ({
          goto: async (url) => {
            if (url.includes("broken")) throw new Error("timeout");
            opened.push(`${viewport.width}:${url}`);
          },
          waitForLoadState: async () => {},
          screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        }),
        close: async () => {},
      }),
      close: async () => launched.push("closed"),
    };
    let n = 0;
    const client = { get: async (p) => ({ body: { url: `https://draft.test/login?t=${++n}&p=${p}` } }) };
    const logs = [];
    const s = previewScreenshots({
      client,
      dir,
      launch: async () => {
        launched.push("launch");
        return fakeBrowser;
      },
      log: (l) => logs.push(l),
    });
    try {
      const [a, b] = await Promise.all([
        s.screenshot({ id: "mvp-01-a", systemId: "sys-1" }),
        s.screenshot({ id: "mvp-02-b", systemId: "sys-2" }),
      ]);
      expect(a.map((x) => x.label)).toEqual(SHOT_VIEWPORTS.map((v) => v.label));
      expect(a[0].src).toBe(join(dir, "mvp-01-a-390.png"));
      expect(readFileSync(b[1].src).length).toBe(4);
      expect(new Set(opened.map((o) => o.split("t=")[1].split("&")[0])).size).toBe(4);
      expect(await s.screenshot({ id: "x", systemId: null })).toEqual([]);
      client.get = async () => ({ body: { url: "https://broken.test/" } });
      expect(await s.screenshot({ id: "mvp-03-c", systemId: "sys-3" })).toEqual([]);
      expect(logs[0]).toContain("снимок телефон, 390 px не снят");
      await s.close();
      expect(launched).toEqual(["launch", "closed"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// B2-41: the beta v2 path of the platform — the goal interview ends with a plan awaiting approval (no card).
describe("D76 on the modules pipeline", () => {
  it("SystemPlan pieces: the revision wrapper of getSystemPlan, outOfScope.request, the plan awaiting approval", async () => {
    const plan = fakePlan(scenarioOf("Студия йоги"));
    expect(unwrapPlan({ plan: { revision: 2, status: "approved", plan } })).toBe(plan);
    expect(unwrapPlan(plan)).toBe(plan);
    expect(unwrapPlan({ plan: null })).toBeNull();
    expect(planCoverage(plan).outOfScope[0]).toEqual({
      what: "Оплата картой с автоплатежом и платная подписка пока недоступны",
      replacement: "доступ к урокам по приглашению владельца",
    });
    const get = (body) => ({ get: async () => ({ body }) });
    expect(await pendingPlan(get({ plan: { revision: 1, status: "awaiting_approval", plan } }), "s")).toMatchObject({
      revision: 1,
    });
    expect(await pendingPlan(get({ plan: { revision: 1, status: "approved", plan } }), "s")).toBeNull();
    expect(await pendingPlan(get({ plan: null }), "s")).toBeNull();
  });

  it("brief → goal interview → plan approved as it is → build → G1 in the browser → publish probe; counted", async () => {
    const f = fakePlatform({ ...SESSION, origin: base, cookieNames: cookieNames(base), pipeline: "modules" });
    holder.handler = f.handler;
    const lines = [];
    const run = await runEval({
      client: platformClient({ base, session: SESSION, sleep: async () => {} }),
      briefs: loadBriefs("mvp").filter((b) => /^mvp-0[12]-/.test(b.id)),
      threshold: "d76",
      maxCostRub: 1000,
      log: (l) => lines.push(l),
      sleep: async () => {},
      pollMs: 1,
      maxBriefRub: 10_000,
    });
    for (const r of run.results) {
      expect(r.pipeline).toBe("modules");
      expect(r.card).toMatchObject({ planRevision: 1, outOfScope: [] });
      expect(r.plan).toMatchObject({ coverage: "covered", modules: ["landing", "leads", "notify"] });
      expect(r.browser).toMatchObject({ ran: true, mobile: "pass", goals: { total: 1, passed: 1 } });
    }
    expect(f.st.requests.filter((x) => /plan\/approve$/.test(x))).toHaveLength(2);
    expect(f.st.requests.some((x) => x.endsWith("/card/approve"))).toBe(false);
    expect(lines.some((l) => l.includes("план v1 утверждён (модули: landing, leads, notify)"))).toBe(true);
    const e = evaluate(run);
    expect(e.items.map((x) => [x.coverage, x.counted])).toEqual(run.results.map((r) => ["covered", r.ready]));
  });

  it("the budget is a hard stop under d76: the running brief is cancelled, the rest never start", async () => {
    const f = fakePlatform({ ...SESSION, origin: base, cookieNames: cookieNames(base), pipeline: "modules" });
    holder.handler = f.handler;
    const run = await runEval({
      client: platformClient({ base, session: SESSION, sleep: async () => {} }),
      briefs: loadBriefs("mvp").slice(0, 3),
      threshold: "d76",
      // The fake build costs 40 credits ≈ 200 ₽: over 50 ₽ once the first build reports its spend.
      maxCostRub: 50,
      concurrency: 1,
      log: () => {},
      sleep: async () => {},
      pollMs: 1,
      maxBriefRub: 10_000,
    });
    expect(run.stopped).toMatch(/бюджет замера 50 ₽ исчерпан/);
    expect(run.results[0].status).toBe("error");
    expect(run.results[0].error).toMatch(/замер остановлен/);
    expect(run.results.slice(1).map((r) => r.status)).toEqual(["skipped", "skipped"]);
    // The fake reports a build's credits when it ends: the next run of the brief (the publish probe) is cancelled.
    expect([...f.st.runs.values()].filter((x) => x.status === "cancelled").map((x) => x.kind)).toEqual(["publish"]);
    expect(renderReport(run).text).toContain("Замер остановлен: бюджет замера 50 ₽ исчерпан");
  });

  it("economics of the builds and the beta v2 development budget in the report", () => {
    const custom = planCoverage({ ...PLAN, custom: [{ id: "quiz", title: "Опрос" }] });
    const items = [
      { ...item("a"), build: { status: "succeeded" }, costRub: 12, buildMinutes: 4 },
      { ...item("b"), build: { status: "succeeded" }, costRub: 14, buildMinutes: 5 },
      { ...item("c", { plan: custom }), build: { status: "succeeded" }, costRub: 30, buildMinutes: 7 },
    ];
    expect(economy(items)).toEqual({
      plain: { n: 2, rub: 13, minutes: 4.5 },
      custom: { n: 1, rub: 30 },
      customExtraRub: 17,
      ok: true,
    });
    expect(economy([{ ...items[0], costRub: 16 }]).ok).toBe(false);
    const d = doc([
      { ...item("mvp-01-a"), build: { status: "succeeded" }, costRubEstimate: 12, buildMinutes: 4 },
      {
        ...item("mvp-04-d", { plan: custom }),
        build: { status: "succeeded" },
        costRubEstimate: 40,
        buildMinutes: 6,
      },
    ]);
    const { text } = renderReport(d, { gaps: {}, b2: { since: "2026-10-07", rub: 742.5 } }, { b2BudgetRub: 1000 });
    expect(text).toContain(
      "Экономика: средняя сборка без дописывания — 12 ₽ (в норме, цель ≤ 15 ₽) и 4 мин сборки (в норме, цель ≤ 5 мин), сборок: 1.",
    );
    expect(text).toContain(
      "Дописывание кодом: в среднем 40 ₽ за сборку, на 28 ₽ дороже сборки без него (выше цели, цель ≤ +20 ₽)",
    );
    expect(text).toContain("Бюджет разработки беты v2: потрачено 743 ₽ из 1 000 ₽ с 2026-10-07");
    expect(text).toContain("Потрачено больше 70 %");
  });

  it("collect reads the spend of every eval org since the start of the beta v2 budget", () => {
    const org = "11111111-1111-4111-8111-111111111111";
    const sql = collectSql({ orgId: org, b2Since: "2026-10-07" });
    expect(sql).toContain("\\set b2_since '2026-10-07'");
    expect(sql).toContain("o.kind = 'eval'");
    expect(sql).toContain("c.mode IN ('live', 'record')");
    expect(sql).toContain("AT TIME ZONE 'Europe/Moscow'");
    expect(() => collectSql({ orgId: org, b2Since: "7 oct" })).toThrow(/b2_since/);
    expect(collectSql({ orgId: org })).not.toContain("b2=");
    const out = 'costs=[]\ngaps=null\nmetrics=[]\nb2={"rub": 12.5, "since": "2026-10-07"}\n';
    expect(parseCollectOutput(out).b2).toEqual({ since: "2026-10-07", rub: 12.5 });
    expect(parseCollectOutput("costs=[]\n").b2).toBeUndefined();
  });

  // B2-41: a retryable failure of the interview or the plan turn is repeated once, like the client's «Повторить».
  it.each([
    ["the brief turn", { create: 1 }, { messages: 1, answers: 0 }],
    ["the plan turn", { answers: 1 }, { messages: 0, answers: 2 }],
  ])("a failed %s is repeated once like the client's «Повторить»; the brief goes on", async (_n, failTurns, posts) => {
    const f = fakePlatform({ ...SESSION, origin: base, cookieNames: cookieNames(base), pipeline: "modules", failTurns });
    holder.handler = f.handler;
    const lines = [];
    const run = await runEval({
      client: platformClient({ base, session: SESSION, sleep: async () => {} }),
      briefs: loadBriefs("mvp").filter((b) => /^mvp-01-/.test(b.id)),
      threshold: "d76",
      maxCostRub: 1000,
      log: (l) => lines.push(l),
      sleep: async () => {},
      pollMs: 1,
      maxBriefRub: 10_000,
    });
    const r = run.results[0];
    expect(r.status).toBe("ready");
    expect(r.interview.retries).toBe(1);
    expect(lines.filter((l) => l.includes("повтор хода, как сделал бы клиент"))).toHaveLength(1);
    // The brief turn is repeated with the brief text; the plan turn — with the answers to the open questions.
    const post = (sub) => f.st.requests.filter((x) => x.startsWith("POST ") && x.endsWith(sub));
    expect(post("/messages")).toHaveLength(posts.messages);
    expect(post("/answers")).toHaveLength(posts.answers);
  });

  it("a turn that fails again after its repeat ends the brief as interview_failed", async () => {
    const f = fakePlatform({
      ...SESSION,
      origin: base,
      cookieNames: cookieNames(base),
      pipeline: "modules",
      failTurns: { create: 1, message: 1 },
    });
    holder.handler = f.handler;
    const run = await runEval({
      client: platformClient({ base, session: SESSION, sleep: async () => {} }),
      briefs: loadBriefs("mvp").filter((b) => /^mvp-01-/.test(b.id)),
      threshold: "d76",
      maxCostRub: 1000,
      log: () => {},
      sleep: async () => {},
      pollMs: 1,
      maxBriefRub: 10_000,
    });
    expect(run.results[0]).toMatchObject({ status: "interview_failed", interview: { retries: 1 } });
    expect(run.results[0].error).toContain("Не получилось составить план");
  });

  it("collect reads orch_invalid of the systems; the report lists what did not pass and what replaced it", () => {
    expect(collectSql({ orgId: "11111111-1111-4111-8111-111111111111" })).toContain("e.type = 'orch_invalid'");
    const payload = (step, fallback, path, code) => ({
      step,
      fallback,
      issues: [{ path, code, message: "Ответ должен быть вызовом инструмента submit_goals." }],
    });
    const out = [
      "costs=[]",
      "gaps=[]",
      "metrics=[]",
      `invalid=${JSON.stringify([
        { system_id: "sys-1", ts: "2026-10-07T10:00:00Z", payload: payload("interview", "questions", "", "NO_TOOL_CALL") },
        { system_id: "sys-1", ts: "2026-10-07T10:01:00Z", payload: payload("system_plan", "plan", "goals", "too_small") },
        { system_id: null, payload: {} },
      ])}`,
    ].join("\n");
    const db = parseCollectOutput(out);
    expect(db.invalid["sys-1"].map((x) => [x.step, x.fallback])).toEqual([
      ["interview", "questions"],
      ["system_plan", "plan"],
    ]);
    expect(parseCollectOutput("costs=[]\n").invalid).toEqual({});
    const d = doc([{ ...item("mvp-01-a"), systemId: "sys-1", interview: { turns: 3, buttons: 2, free: 0, retries: 1 } }]);
    const { text } = renderReport(d, db);
    expect(text).toContain("Ответы моделей интервью и плана, не прошедшие проверку: 2 — в брифах mvp-01");
    expect(text).toContain(
      "Ответ модели не прошёл проверку: 2 раз (интервью → запасные вопросы без модели; план → план из ответов интервью без модели).",
    );
    expect(text).toContain("  - интервью: весь ответ (NO_TOOL_CALL) — Ответ должен быть вызовом инструмента submit_goals.");
    expect(text).toContain("  - план: goals (too_small)");
    expect(text).toContain("повторов хода после сбоя 1");
  });
});
