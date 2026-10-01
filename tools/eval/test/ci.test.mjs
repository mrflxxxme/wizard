// M1-10: regression vs baseline, live-eval budget (F6, D20_eval_budget) and the nightly brief rotation.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  baselineEntries,
  briefKey,
  briefSetHash,
  compareToBaseline,
  isRegression,
  loadBaseline,
} from "../lib/baseline.mjs";
import { loadBriefs } from "../lib/briefs.mjs";
import {
  costPerPair,
  DEFAULT_PAIR_RUB,
  decide,
  entryFromResult,
  MONTHLY_BUDGET_RUB,
  mergeEntries,
  monthSpent,
  nightsLeft,
  resultsEntries,
} from "../lib/budget.mjs";
import { nightlyBriefs, SEGMENTS } from "../lib/rotation.mjs";

const CI = join(import.meta.dirname, "..", "ci.mjs");
const tmp = mkdtempSync(join(tmpdir(), "wz-eval-ci-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const briefs = loadBriefs();

/** Synthetic harness result: `flags` = {briefId: [g0, g0g1]}. */
function result(flags, o = {}) {
  return {
    mode: "harness",
    llm_mode: o.llmMode ?? "live",
    dry_run: false,
    started_at: o.startedAt ?? "2026-10-10T01:17:00.000Z",
    runs: Object.entries(flags).map(([brief, [g0, g0g1]]) => ({
      brief,
      model: o.model ?? "glm-5.3",
      g0_pass: g0,
      g0g1_pass: g0g1,
      g1_skipped: Boolean(o.g1Skipped),
      cost_rub: o.cost ?? 100,
    })),
  };
}
const ids = briefs.map((b) => b.id);
const allFlags = (n, g0 = true) => Object.fromEntries(ids.slice(0, n).map((id) => [id, [g0, g0]]));

describe("regression (eval.yaml#regression.test)", () => {
  test("baseline 0.80 → 0.74 fails, 0.76 passes; exactly 5 p.p. passes; null is not measured", () => {
    expect(isRegression(0.8, 0.74)).toBe(true);
    expect(isRegression(0.8, 0.76)).toBe(false);
    expect(isRegression(0.8, 0.75)).toBe(false);
    expect(isRegression(null, 0.1)).toBe(false);
    expect(isRegression(0.9, null)).toBe(false);
  });

  test("same brief set: a G0/G1 share drop > 5 p.p. is a regression", () => {
    const base = { v: 1, entries: baselineEntries(result(allFlags(10)), briefs) };
    const flags = allFlags(10);
    flags[ids[0]] = [true, false]; // g0g1 1.0 → 0.9
    const cmp = compareToBaseline(result(flags), briefs, base);
    expect(cmp.regressions).toEqual([expect.stringMatching(/g0g1_pass 90% против baseline 100%/)]);
    expect(compareToBaseline(result(allFlags(10)), briefs, base).regressions).toEqual([]);
  });

  test("nightly subset is compared with the per-brief flags of a full-set baseline", () => {
    const base = { v: 1, entries: baselineEntries(result(allFlags(14)), briefs) };
    const night = nightlyBriefs(briefs, "2026-10-10");
    const flags = Object.fromEntries(night.map((b) => [b.id, [true, true]]));
    const ok = compareToBaseline(result(flags), briefs, base);
    expect(ok.compared.every((c) => c.subset)).toBe(true);
    expect(ok.regressions).toEqual([]);
    flags[night[0].id] = [false, false];
    expect(compareToBaseline(result(flags), briefs, base).regressions).toHaveLength(2);
  });

  test("G1 not run (--gates=G0) → g0g1 is not compared; other mode/model or edited brief → no baseline note", () => {
    const base = { v: 1, entries: baselineEntries(result(allFlags(4)), briefs) };
    const g0only = result(allFlags(4), { g1Skipped: true });
    expect(baselineEntries(g0only, briefs)[0].metrics.g0g1_pass).toBeNull();
    expect(compareToBaseline(g0only, briefs, base).compared.map((c) => c.metric)).toEqual(["g0_pass"]);
    expect(compareToBaseline(result(allFlags(4), { llmMode: "fixture" }), briefs, base).notes).toHaveLength(
      1,
    );
    const edited = briefs.map((b) => (b.id === ids[0] ? { ...b, text: `${b.text} ` } : b));
    expect(briefKey(edited[0])).not.toBe(briefKey(briefs[0]));
    expect(briefSetHash(edited)).not.toBe(briefSetHash(briefs));
    expect(compareToBaseline(result(allFlags(4)), edited, base).notes).toHaveLength(1);
    expect(compareToBaseline({ ...result(allFlags(4)), dry_run: true }, briefs, base).compared).toEqual([]);
  });

  test("committed baseline covers the fixture demos (forum, bakery) at 100%", () => {
    const e = loadBaseline().entries.find((x) => x.mode === "harness-fixture");
    expect(e?.metrics).toMatchObject({ g0_pass: 1, g0g1_pass: 1 });
  });
});

describe("budget (live_cadence.budget, D20_eval_budget ≤ 30 000 ₽/мес)", () => {
  const at = (iso) => new Date(iso);
  const spend = (rub, month = "2026-10") => [
    { id: `${month}-01`, month, pairs: 0, cost_rub: rub, estimated: true },
  ];

  test("nightly does not start once the month's spend + forecast exceeds 30 000 ₽", () => {
    expect(MONTHLY_BUDGET_RUB).toBe(30_000);
    const ok = decide({ kind: "nightly", pairs: 5, entries: spend(10_000), now: at("2026-10-10T01:00:00Z") });
    expect(ok).toMatchObject({
      run: true,
      spent: 10_000,
      forecast: 5 * DEFAULT_PAIR_RUB,
      maxCostRub: 20_000,
    });
    const no = decide({ kind: "nightly", pairs: 5, entries: spend(29_500), now: at("2026-10-10T01:00:00Z") });
    expect(no.run).toBe(false);
    expect(no.reason).toMatch(/ночной прогон не стартует/);
    // A new calendar month starts from zero.
    expect(
      decide({
        kind: "nightly",
        pairs: 5,
        entries: spend(29_900, "2026-09"),
        now: at("2026-10-01T01:00:00Z"),
      }).run,
    ).toBe(true);
  });

  test("full keeps a reserve for the remaining nightly smokes and escalates E-MONEY", () => {
    const now = at("2026-10-10T12:00:00Z");
    expect(nightsLeft(now)).toBe(21);
    const d = decide({ kind: "full", pairs: 28, entries: spend(12_000), now });
    expect(d.reserve).toBe(5 * DEFAULT_PAIR_RUB * 21);
    expect(d.run).toBe(false);
    expect(d.reason).toMatch(/E-MONEY/);
    // Same spend, the nightly smoke still runs.
    expect(decide({ kind: "nightly", pairs: 5, entries: spend(12_000), now }).run).toBe(true);
    expect(
      decide({ kind: "full", pairs: 28, entries: spend(1_000), now: at("2026-10-28T12:00:00Z") }).run,
    ).toBe(true);
  });

  test("forecast per pair = 1.25 × average of real runs once there are ≥ 3", () => {
    const real = [1, 2, 3].map((i) => ({
      id: `2026-10-0${i}`,
      month: "2026-10",
      pairs: 5,
      cost_rub: 200,
      estimated: false,
    }));
    expect(costPerPair(real.slice(0, 2))).toBe(DEFAULT_PAIR_RUB);
    expect(costPerPair(real)).toBe(50);
    expect(monthSpent(real, "2026-10")).toBe(600);
  });

  test("ledger ∪ committed live reports, deduplicated by run id; fixture and dry runs cost nothing", () => {
    const dir = join(tmp, "results");
    execFileSync("mkdir", ["-p", dir]);
    const live = result(allFlags(5), { cost: 40 });
    writeFileSync(join(dir, "2026-10-10-harness.json"), JSON.stringify(live));
    writeFileSync(join(dir, "fx.json"), JSON.stringify(result(allFlags(2), { llmMode: "fixture" })));
    const fromReports = resultsEntries(dir);
    expect(fromReports).toHaveLength(1);
    const merged = mergeEntries([entryFromResult(live, { kind: "nightly" })], fromReports);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ kind: "nightly", pairs: 5, cost_rub: 200, month: "2026-10" });
  });
});

describe("nightly rotation (live_cadence.nightly_smoke)", () => {
  test("5 briefs a night: ≥ 1 per segment and ≥ 1 with canaries; deterministic; the whole set within 14 nights", () => {
    const seen = new Set();
    for (let d = 0; d < 60; d++) {
      const date = new Date(Date.UTC(2026, 9, 1 + d));
      const pick = nightlyBriefs(briefs, date);
      expect(new Set(pick.map((b) => b.id)).size).toBe(5);
      for (const seg of SEGMENTS) expect(pick.some((b) => b.segment === seg)).toBe(true);
      expect(pick.some((b) => b.canaries?.length)).toBe(true);
      if (d < 14) for (const b of pick) seen.add(b.id);
    }
    expect(seen.size).toBe(briefs.length);
    expect(nightlyBriefs(briefs, "2026-10-10").map((b) => b.id)).toEqual(
      nightlyBriefs([...briefs].reverse(), "2026-10-10").map((b) => b.id),
    );
  });
});

describe("ci.mjs", () => {
  const run = (...a) => execFileSync(process.execPath, [CI, ...a], { encoding: "utf8" });

  test("plan writes GitHub outputs; over budget → run=false", () => {
    const out = join(tmp, "gh-output");
    const ledger = join(tmp, "ledger.json");
    writeFileSync(ledger, JSON.stringify({ v: 1, entries: spend("2026-10", 29_800) }));
    run("plan", "--kind=nightly", "--date=2026-10-10", `--ledger=${ledger}`, `--github-output=${out}`);
    const kv = Object.fromEntries(
      readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(kv).toMatchObject({ run: "false", pairs: "5", models: "", spent_rub: "29800" });
    expect(kv.briefs.split(",")).toHaveLength(5);
    const full = run("plan", "--kind=full", "--date=2026-10-30", `--ledger=${join(tmp, "none.json")}`);
    expect(full).toMatch(/^run=true$/m);
    expect(full).toMatch(/^models=glm-5\.3,glm-5\.1$/m);
    expect(full).toMatch(new RegExp(`^pairs=${briefs.length * 2}$`, "m"));
  });

  test("record books the result's cost, or the forecast when the run left no result", () => {
    const ledger = join(tmp, "rec.json");
    const dir = join(tmp, "rec-out");
    execFileSync("mkdir", ["-p", dir]);
    run(
      "record",
      "--kind=nightly",
      `--ledger=${ledger}`,
      `--result-dir=${join(tmp, "missing")}`,
      "--forecast-rub=750",
      "--pairs=5",
    );
    writeFileSync(join(dir, "r.json"), JSON.stringify(result(allFlags(5), { cost: 12.5 })));
    run("record", "--kind=nightly", `--ledger=${ledger}`, `--result-dir=${dir}`);
    const l = JSON.parse(readFileSync(ledger, "utf8"));
    expect(l.entries.map((e) => [e.estimated, e.cost_rub])).toEqual([
      [true, 750],
      [false, 62.5],
    ]);
  });

  function spend(month, rub) {
    return [{ id: `${month}-01T00:00:00Z`, month, pairs: 0, cost_rub: rub, estimated: true }];
  }
});
