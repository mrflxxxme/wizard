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
  planCoverage,
  readPlan,
  runEval,
} from "../server/driver.mjs";
import { evaluate, renderReport, screenshotGrid } from "../server/report.mjs";
import { previewScreenshots, SHOT_VIEWPORTS } from "../server/screenshots.mjs";
import { fakePlatform } from "./fake-platform.mjs";

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
    expect(countedD76(item("x", { plan: planCoverage(UNCOVERED) }))).toBe(false);
    expect(
      countedD76(item("x", { plan: planCoverage(UNCOVERED), gaps: { reported: [{ missing: "оплата" }] } })),
    ).toBe(true);
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
