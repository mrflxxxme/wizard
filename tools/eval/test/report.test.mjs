// M2-12 (L4-27): the eval report records p80 build time and p80 time to the first preview.
import { describe, expect, test } from "vitest";
import {
  aggregateHarness,
  M2_TIME_TARGETS,
  percentile,
  renderHarnessReport,
  timeTargetMisses,
} from "../lib/report.mjs";

const run = (brief, minutes, preview, o = {}) => ({
  brief,
  model: o.model ?? "glm-5.1",
  tier: "T0",
  fixture: null,
  g0_pass: preview !== null,
  g0g1_pass: preview !== null,
  g1_skipped: false,
  coverage: 0.5,
  tokens: { input: 1, cached: 0, output: 1 },
  cost_rub: 1,
  credits: 1,
  minutes,
  first_preview_minutes: preview,
  questions_asked: 4,
  estimate_ratio: 1,
  escalations: 0,
  budget_exceeded: false,
  pii_leaks: 0,
  fallback_rate: 0,
  fixture_miss: false,
  outcome: preview === null ? "failed" : "succeeded",
  ...(o.skipped ? { skipped: o.skipped } : {}),
});

const result = (runs, o = {}) => ({
  mode: "harness",
  llm_mode: o.llmMode ?? "live",
  dry_run: false,
  started_at: "2026-10-12T09:00:00.000Z",
  models: [...new Set(runs.map((r) => r.model))],
  briefs: runs.map((r) => r.brief),
  gates: "G0G1",
  max_cost_rub: null,
  runs,
});

describe("percentile (nearest rank)", () => {
  test("p80 of 1..10 is 8, of 1..5 is 4; nulls and NaN are ignored; empty → null", () => {
    expect(percentile([3, 1, 2, 4, 5, 6, 7, 8, 9, 10], 0.8)).toBe(8);
    expect(percentile([5, 4, 3, 2, 1], 0.8)).toBe(4);
    expect(percentile([null, 7, undefined, Number.NaN], 0.8)).toBe(7);
    expect(percentile([], 0.8)).toBeNull();
    expect(percentile([2, 9], 1)).toBe(9);
  });
});

describe("aggregateHarness: p80 minutes and first preview", () => {
  const runs = [
    ...Array.from({ length: 10 }, (_, i) => run(`hz-${i}`, (i + 1) * 4, i + 1)),
    run("hz-x", 50, null), // never reached a preview
    run("hz-s", 0, null, { skipped: "бюджет" }),
  ];
  const [a] = aggregateHarness(runs);

  test("p80 over evaluated runs; runs without a preview are counted separately", () => {
    expect(a.n).toBe(11);
    // minutes: 4..40 and 50 → 11 values, rank ceil(8.8) = 9 → 36.
    expect(a.minutes_p80).toBe(36);
    expect(a.first_preview_minutes_p80).toBe(8);
    expect(a.first_preview_minutes).toBeCloseTo(5.5);
    expect(a.no_preview).toBe(1);
  });

  test("the markdown report has the p80 columns and the M2 misses for live", () => {
    const md = renderHarnessReport(result(runs));
    expect(md).toContain("| мин p80 | до превью, мин (ср.) | до превью p80 |");
    expect(md).toMatch(/\| 36\.00 \| 5\.50 \| 8\.00 \(без превью: 1\) \|/);
    expect(md).toContain("до превью, мин | Итог |");
    expect(timeTargetMisses(result(runs))).toEqual([
      `glm-5.1: minutes_p80 = 36.0 > ${M2_TIME_TARGETS.minutes_p80}`,
    ]);
    expect(md).toContain("Цель M2 по времени не достигнута: glm-5.1: minutes_p80");
  });

  test("fixture runs are not judged against the M2 time targets", () => {
    const fx = result(runs, { llmMode: "fixture" });
    expect(timeTargetMisses(fx)).toEqual([]);
    expect(renderHarnessReport(fx)).toContain("В fixture время не показательно");
  });

  test("a model without any preview reports «—»", () => {
    const [b] = aggregateHarness([run("hz-1", 3, null, { model: "glm-5.3" })]);
    expect(b.first_preview_minutes_p80).toBeNull();
    expect(renderHarnessReport(result([run("hz-1", 3, null, { model: "glm-5.3" })]))).toMatch(
      /\| 3\.00 \| — \| — \(без превью: 1\) \|/,
    );
  });
});
