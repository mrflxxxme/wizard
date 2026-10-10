// V3-40: the report of the final v3 measurement by docs/plans/2026-10-08-v3.md §6 (tools/eval/server/v3-final.mjs) —
// a retry of the failed briefs replaces their first attempt, the verdicts (functional, time, money, the development
// budget of the spend journal, the blind comparison, the diversity; no data — «ожидает», never a pass), the diversity
// by the template gate's own metric (tools/eval/blind/diversity.mjs) and the `final` command of the server CLI.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { siteSimilarity, thresholdOf } from "../../../packages/gates/src/template/similarity.ts";
import { readJournal } from "../../deploy/spend.mjs";
import { aggregateVotes } from "../blind/aggregate.mjs";
import { diversityPairs, diversitySites, measureDiversity } from "../blind/diversity.mjs";
import { blindLayout } from "../blind/layout.mjs";
import { VOTES_KIND, VOTES_VERSION } from "../blind/page.mjs";
import { loadBriefs } from "../lib/briefs.mjs";
import { main as serverMain } from "../server/cli.mjs";
import { parseCollectOutput } from "../server/seed.mjs";
import { evaluateV3Final, mergeRuns, renderV3Final, V3_DEV_BUDGET_RUB } from "../server/v3-final.mjs";

const briefs = loadBriefs("v3-final");
const metric = { siteSimilarity, thresholdOf };
const sid = (i: number) => `44444444-4444-4444-8444-4444444444${String(i).padStart(2, "0")}`;
const TYPES = ["hero", "services", "gallery", "reviews", "form", "footer"];
/** A structure-only fingerprint: one home page, a section per variant. */
const fp = (variants: string[]) => ({
  version: 1,
  pages: [
    {
      route: "/",
      sections: variants.map((v, i) => ({ type: TYPES[i % TYPES.length], layout: `layout-${v}`, variant: v })),
    },
  ],
});
const variantsOf = (i: number) => TYPES.map((_, k) => `v${(i * 7 + k * 3) % 11}`);

type R = Record<string, unknown>;
/** A result of the v3 driver (tools/eval/server/v3.mjs) for a brief of the final set. */
function result(i: number, over: R = {}): R {
  const b = briefs[i];
  return {
    id: b.id,
    class: b.class,
    title: b.title,
    status: "ready",
    ready: true,
    systemId: sid(i),
    error: null,
    interview: { minutes: 3 },
    build: {
      status: "succeeded",
      minutes: 12,
      previewMinutes: 3,
      stages: [],
      spentRub: 240,
      capRub: 500,
      scenarios: { total: 4, passed: 4, failed: 0, stopped: 0, toRequests: 0, mustNotPassed: 0, list: [] },
    },
    techreview: { status: "done", blocked: false },
    gates: {},
    screenshots: [{ label: "телефон, 390 px", src: `shots/${b.id}-390.png` }],
    creditsUsed: 50,
    costRubEstimate: 250,
    fromBriefMinutes: 14 + i,
    minutes: 18 + i,
    ...over,
  };
}
const run = (runId: string, startedAt: string, results: R[]) => ({
  kind: "v3",
  threshold: "v3-final",
  base: "https://codename.ru",
  runId,
  startedAt,
  finishedAt: startedAt,
  maxCostRub: 3600,
  concurrency: 2,
  stopped: null,
  results,
});
const dbOf = (ids: number[], rub = 250, fingerprints = true, critic = "оценка 28→40") => ({
  costs: Object.fromEntries(ids.map((i) => [sid(i), { rub, credits: 50, calls: 40 }])),
  gaps: {},
  // The critic's stage note (createCriticHook): the score of the site kept is the design floor's fact.
  metrics: Object.fromEntries(
    ids.map((i) => [sid(i), { stages: { critic: { status: "done", note: `циклов 2, ${critic}, стоп pass` } } }]),
  ),
  v3: {
    calls: {},
    hooks: {},
    similarity: Object.fromEntries(ids.map((i) => [sid(i), { archetype: `a${i}`, similarity: 0.4 }])),
    events: {},
    t1Forbidden: 0,
    ...(fingerprints
      ? {
          fingerprints: Object.fromEntries(
            ids.map((i) => [sid(i), { niche: `niche-${i}`, archetype: `a${i}`, fingerprint: fp(variantsOf(i)) }]),
          ),
        }
      : {}),
  },
});
const all12 = briefs.map((_, i) => i);

/** The blind summary of 4 raters who prefer Wizard in `wins` of the 12 pairs. */
function blindOf(wins: number) {
  const sites = briefs.flatMap((b) =>
    ["wizard", "competitor"].map((source) => ({
      source,
      briefId: b.id,
      class: b.class,
      title: b.title,
      service: source === "wizard" ? "Wizard" : "Конструктор Y",
      images: { 390: `${source}/${b.id}-390.png`, 1440: `${source}/${b.id}-1440.png` },
    })),
  );
  const { key } = blindLayout({ sites, seed: "v3-40" });
  const wc = key.pairs.filter((p: { kind: string }) => p.kind === "wc");
  const won = new Set(wc.slice(0, wins).map((p: { id: string }) => p.id));
  const files = ["Основатель", "О1", "О2", "О3"].map((rater) => ({
    name: rater,
    data: {
      kind: VOTES_KIND,
      version: VOTES_VERSION,
      layoutId: key.layoutId,
      rater,
      savedAt: "2026-10-22T10:00:00Z",
      votes: key.pairs.map((p: { id: string; kind: string; A: { source: string } }) => {
        const wiz = p.A.source === "wizard" ? "A" : "B";
        return {
          pair: p.id,
          better: p.kind !== "wc" ? "same" : won.has(p.id) ? wiz : wiz === "A" ? "B" : "A",
          sameTemplate: false,
        };
      }),
    },
  }));
  return aggregateVotes(key, files);
}

describe("diversity by the template gate's metric", () => {
  test("pairs inside each class only; a copy is over the threshold, different sections are not", () => {
    const db = dbOf(all12);
    const items = all12.map((i) => result(i));
    // v3-06 repeats v3-01 section by section (both sites of class «site»).
    const copy = db.v3.fingerprints as Record<string, { fingerprint: unknown }>;
    copy[sid(5)].fingerprint = copy[sid(0)].fingerprint;
    const { sites, missing } = diversitySites(items, copy);
    expect(sites).toHaveLength(12);
    expect(missing).toEqual([]);
    const d = diversityPairs(sites, metric);
    expect(d.pairs).toHaveLength(12);
    expect(d.pairs.every((p: { class: string | null }) => p.class !== null)).toBe(true);
    expect(d.max).toMatchObject({ a: "v3-01-interior-studio", b: "v3-06-frame-houses", score: 1, mode: "structure" });
    expect(d.max.threshold).toBe(0.85);
    expect(d.over).toHaveLength(1);
    expect(d.passed).toBe(false);
    expect(d.pairs.slice(1).every((p: { over: boolean }) => !p.over)).toBe(true);
  });

  test("no fingerprints — pending; a site without one is listed; the metric loads under plain node through tsx", async () => {
    const items = all12.map((i) => result(i));
    expect(await measureDiversity(items, dbOf(all12, 250, false))).toMatchObject({ status: "pending" });
    const db = dbOf(all12.slice(1));
    const done = await measureDiversity(items, db, { metric });
    expect(done).toMatchObject({ status: "done", sites: 11, missing: ["v3-01-interior-studio"], passed: true });
    const failing = await measureDiversity(items, db, {
      load: async () => {
        throw new Error("не найден tsx");
      },
    });
    expect(failing).toMatchObject({ status: "pending", why: "не найден tsx" });
    const script = `import(${JSON.stringify(join(import.meta.dirname, "..", "blind", "diversity.mjs"))}).then(async (m) => { const x = await m.loadTemplateMetric(); console.log(typeof x.siteSimilarity, x.TEMPLATE_THRESHOLD, x.thresholdOf("structure")); })`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("function 0.7 0.85");
  });

  test("collect of the final measurement carries the fingerprints and the niche", () => {
    const out = [
      "costs=[]",
      `v3calls=[]`,
      `v3similarity=${JSON.stringify([{ system_id: sid(0), archetype: "editorial", niche: "interior", similarity: 0.41 }])}`,
      `v3fingerprints=${JSON.stringify([{ system_id: sid(0), niche: "interior", archetype: "editorial", fingerprint: fp(["a"]) }])}`,
    ].join("\n");
    const db = parseCollectOutput(out);
    expect(db.v3.similarity[sid(0)]).toEqual({ archetype: "editorial", niche: "interior", similarity: 0.41 });
    expect(db.v3.fingerprints[sid(0)]).toEqual({ niche: "interior", archetype: "editorial", fingerprint: fp(["a"]) });
    expect(parseCollectOutput("costs=[]\nv3calls=[]").v3).not.toHaveProperty("fingerprints");
  });
});

describe("the report of the final measurement (§6)", () => {
  test("a retry replaces the failed and skipped briefs of the first run; the spend of every attempt is kept", () => {
    const first = run(
      "r1",
      "2026-10-20T07:00:00Z",
      all12.map((i) =>
        i === 2
          ? result(i, { status: "build_failed", ready: false, build: null })
          : i === 6
            ? result(i, { status: "skipped", ready: false, systemId: null, costRubEstimate: 0 })
            : result(i),
      ),
    );
    const retry = run("r2", "2026-10-21T07:00:00Z", [
      result(2, { systemId: sid(20) }),
      result(6, { systemId: sid(21) }),
    ]);
    const m = mergeRuns([
      { doc: retry, db: dbOf([20, 21], 300) },
      { doc: first, db: dbOf(all12.filter((i) => i !== 6), 250) },
    ]);
    expect(m.doc.results).toHaveLength(12);
    expect(m.doc.results.every((r: R) => r.ready)).toBe(true);
    expect(m.doc.results.find((r: R) => r.id === "v3-03-cleaning-crm")?.systemId).toBe(sid(20));
    expect(m.doc.startedAt).toBe("2026-10-20T07:00:00Z");
    expect(m.attempts.map((a: R) => a.runId)).toEqual(["r1", "r2"]);
    expect(m.attempts.map((a: R) => a.costRub)).toEqual([2750, 600]);
    expect(m.attempts[1].briefs).toEqual(["v3-03-cleaning-crm", "v3-07-auto-service"]);
    expect(m.db.costs[sid(20)].rub).toBe(300);
    expect(m.db.v3.fingerprints[sid(21)]).toBeTruthy();
    expect(() => mergeRuns([])).toThrow(/нет ни одного прогона/);
  });

  test("without raters and diversity — pending; with both and every target met — passed", async () => {
    const doc = run("r1", "2026-10-20T07:00:00Z", all12.map((i) => result(i)));
    const db = dbOf(all12);
    const journal = readJournal();
    const pending = evaluateV3Final({ doc, db, journal });
    expect(pending.criteria).toMatchObject({ functional: true, time: true, money: true, devBudget: true });
    expect(pending.criteria.blind).toBeNull();
    expect(pending.criteria.diversity).toBeNull();
    expect(pending.verdict).toBe("pending");
    const diversity = await measureDiversity(doc.results, db, { metric });
    const passed = evaluateV3Final({ doc, db, journal, blind: blindOf(9), diversity });
    expect(passed.verdict).toBe("passed");
    const { text } = renderV3Final(
      { doc, db, journal, blind: blindOf(9), diversity, attempts: mergeRuns([{ doc, db }]).attempts },
      { date: "2026-10-22", shotsBase: "v3-final-2026-10-22" },
    );
    expect(text).toContain("# Финальный замер v3 — 2026-10-22");
    expect(text).toContain("**Итог: ✅ критерии §6 (1–4) выполнены.**");
    expect(text).toContain(
      "| 1 | Функционально | 12 брифов, по 3 на класс; сценарии брифа проходят, техревью без блокеров | готовы 12 из 12 (сайт бизнеса 3/3, услуги и запись 3/3, CRM и админка 3/3, магазин 3/3); сценарии прошли у 12, техревью без блокеров у 12 | ✅ |",
    );
    expect(text).toContain("| 2 | Слепое сравнение | Wizard ≥ 70 % пар; основатель и 3–5 оценщиков | 9 из 12 пар (75 %), оценщиков 4 | ✅ |");
    expect(text).toMatch(/\| 4 \| Время \| .* \| медиана 19\.5 мин, максимум 25 мин \| ✅ \|/);
    expect(text).toMatch(/\| 4 \| Деньги \| .* \| средняя 250 ₽, максимум 250 ₽ \| ✅ \|/);
    expect(text).toContain("## Разнообразие");
    expect(text).toMatch(/\| v3-0\d-[a-z-]+ — v3-\d\d-[a-z-]+ \| (сайт бизнеса|услуги и запись|CRM и админка|магазин) \| \d+ % \| 85 % \| только структура \| ✅ \|/);
    expect(text).toContain("![телефон, 390 px](v3-final-2026-10-22/v3-01-interior-studio-390.png)");
  });

  test("each criterion fails on its own: a brief not ready, too slow, too dear, over the budget, Wizard below 70 %, a template", async () => {
    const base = all12.map((i) => result(i));
    const doc = (results: R[]) => run("r1", "2026-10-20T07:00:00Z", results);
    const journal = readJournal();
    const failed = evaluateV3Final({
      doc: doc(base.map((r, i) => (i === 4 ? { ...r, ready: false, status: "not_ready" } : r))),
      db: dbOf(all12),
      journal,
    });
    expect(failed.criteria.functional).toBe(false);
    expect(failed.failed).toEqual(["v3-05-ceramics-shop"]);
    // The founder's design floor: a site the critic scores under 30 fails it; a cycle that scored lower was rolled
    // back, so the site kept is the one scored before it.
    const low = evaluateV3Final({ doc: doc(base), db: dbOf(all12, 250, true, "оценка 16→16"), journal });
    expect(low.criteria.design).toBe(false);
    expect(low.lowDesign).toHaveLength(12);
    expect(renderV3Final({ doc: doc(base), db: dbOf(all12, 250, true, "оценка 16→16"), journal }).text).toContain(
      "| 1 | Дизайн | оценка критика каждой системы ≥ 30 из 100 (пол основателя) | от 16 до 16; ниже 30:",
    );
    const kept = evaluateV3Final({ doc: doc(base), db: dbOf(all12, 250, true, "оценка 34→22"), journal });
    expect(kept.criteria.design).toBe(true);
    expect(kept.scored[0]?.critic.kept).toBe(34);
    expect(failed.verdict).toBe("failed");
    expect(
      evaluateV3Final({ doc: doc(base.map((r, i) => (i === 0 ? { ...r, fromBriefMinutes: 31 } : r))), db: dbOf(all12) })
        .criteria.time,
    ).toBe(false);
    const dear = dbOf(all12);
    dear.costs[sid(3)].rub = 520;
    expect(evaluateV3Final({ doc: doc(base), db: dear }).criteria.money).toBe(false);
    const spent = { ...journal, entries: [{ id: "x", wave: "final", actualRub: V3_DEV_BUDGET_RUB - 100 }] };
    expect(evaluateV3Final({ doc: doc(base), db: dbOf(all12), journal: spent, extraRub: 200 }).criteria.devBudget).toBe(
      false,
    );
    expect(evaluateV3Final({ doc: doc(base), db: dbOf(all12), blind: blindOf(8) }).criteria.blind).toBe(false);
    const copy = dbOf(all12);
    const fps = copy.v3.fingerprints as Record<string, { fingerprint: unknown }>;
    fps[sid(5)].fingerprint = fps[sid(0)].fingerprint;
    const diversity = await measureDiversity(base, copy, { metric });
    expect(evaluateV3Final({ doc: doc(base), db: copy, blind: blindOf(12), diversity }).criteria.diversity).toBe(false);
    // The report names the failed briefs and the retry of them only.
    const { text } = renderV3Final({
      doc: doc(base.map((r, i) => (i === 2 || i === 8 ? { ...r, ready: false, status: "build_failed" } : r))),
      db: dbOf(all12),
      journal,
    });
    expect(text).toContain("**Итог: ❌ не выполнено — функционально.** Ещё ждут данных: слепое сравнение, разнообразие.");
    expect(text).toContain("briefs `v3-03,v3-09`, волна `retry`");
    expect(text).toContain("Ожидает оценщиков.");
  });

  test("cli final: the runs (first and retry), the blind summary, the journal → docs/progress/v3-final-<date>.md; exit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v3-final-"));
    const first = run(
      "r1",
      "2026-10-20T07:00:00Z",
      all12.map((i) => (i === 1 ? result(i, { status: "build_failed", ready: false }) : result(i))),
    );
    const retry = run("r2", "2026-10-21T07:00:00Z", [result(1, { systemId: sid(30) })]);
    writeFileSync(join(dir, "r1.json"), JSON.stringify({ ...first, db: dbOf(all12) }));
    writeFileSync(join(dir, "r2.json"), JSON.stringify({ ...retry, db: dbOf([30]) }));
    writeFileSync(join(dir, "blind.json"), JSON.stringify(blindOf(10)));
    const out = join(dir, "v3-final-2026-10-22.md");
    const logs: string[] = [];
    const code = await serverMain(
      [
        "final",
        "--results",
        `${join(dir, "r2.json")},${join(dir, "r1.json")}`,
        "--blind",
        join(dir, "blind.json"),
        "--date",
        "2026-10-22",
        "--out",
        out,
      ],
      { metric, log: (l: string) => logs.push(l) },
    );
    const text = readFileSync(out, "utf8");
    expect(code, `${logs.join("\n")}\n${text.slice(0, 1500)}`).toBe(0);
    expect(text).toContain("прогонов: 2 (первый и повторы упавших брифов: `r1`, `r2`)");
    expect(text).toContain("10 из 12 пар (83 %)");
    expect(text).toMatch(/все прогоны замера с повторами: 3\s250 ₽/);
    await expect(serverMain(["final"])).rejects.toThrow(/--results/);
  });
});
