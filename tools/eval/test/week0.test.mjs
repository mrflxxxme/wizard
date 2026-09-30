// M0-30: week-0 decision on synthetic run.mjs results (rule D2_w0_fallback: gap < 10 p.p. → T0).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { decideWeek0, renderWeek0Report } from "../lib/week0.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIEFS = Array.from({ length: 10 }, (_, i) => `b-${String(i + 1).padStart(2, "0")}`);

/**
 * Synthetic results in run.mjs shape: `firstTry` briefs valid at attempt 1, `retry` more valid at attempt 2, the rest
 * invalid; every valid run scores `score`, invalid ones 0 (as scoreSpec(null) — the mean matches run.mjs «Скор»).
 */
function model(id, tier, { firstTry, retry = 0, score, briefs = BRIEFS }) {
  return briefs.map((brief, i) => {
    const valid = i < firstTry + retry;
    return {
      brief,
      model: id,
      tier,
      valid,
      attempts: i < firstTry ? 1 : i < firstTry + retry ? 2 : 3,
      score: { total: valid ? score : 0 },
    };
  });
}
const results = (...runs) => ({ started_at: "2026-10-05T10:00:00.000Z", dry_run: false, runs: runs.flat() });

const tmp = mkdtempSync(join(tmpdir(), "wz-week0-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("decideWeek0", () => {
  test("T1 better by ≥ 10 p.p. on first-try validity and score → T1", () => {
    const d = decideWeek0([
      results(
        model("glm-5.3", "T1", { firstTry: 10, score: 0.8 }),
        model("glm-5.1", "T0", { firstTry: 7, score: 0.8 }),
        model("kimi-k2.6", "T0", { firstTry: 9, retry: 1, score: 0.7 }),
      ),
    ]);
    expect(d.bestT0.model).toBe("kimi-k2.6");
    expect([d.gapValidPp, d.gapScorePp]).toEqual([10, 10]);
    expect(d.tier).toBe("T1");
    expect(d.reasons).toEqual([]);
  });

  test("validity gap < 10 p.p. → T0 even with a large score gap", () => {
    const d = decideWeek0([
      results(
        model("glm-5.3", "T1", { firstTry: 9, score: 0.9 }),
        model("glm-5.1", "T0", { firstTry: 8, score: 0.6 }),
      ),
    ]);
    expect(d.gapValidPp).toBe(10);
    const d2 = decideWeek0([
      results(
        model("glm-5.3", "T1", { firstTry: 9, score: 0.9, briefs: BRIEFS.slice(0, 9) }),
        model("glm-5.1", "T0", { firstTry: 9, score: 0.6, briefs: BRIEFS.slice(0, 9) }),
      ),
    ]);
    expect(d2.gapValidPp).toBe(0);
    expect(d2.tier).toBe("T0");
    expect(d2.reasons[0]).toContain("валидности");
  });

  test("score gap < 10 p.p. → T0; the best T0 model is chosen by validity, then score", () => {
    const d = decideWeek0([
      results(
        model("glm-5.3", "T1", { firstTry: 10, score: 0.8 }),
        model("glm-5.1", "T0", { firstTry: 5, retry: 5, score: 0.75 }),
        model("deepseek-v4-pro", "T0", { firstTry: 5, retry: 5, score: 0.72 }),
      ),
    ]);
    expect(d.bestT0.model).toBe("glm-5.1");
    expect(d.gapValidPp).toBe(50);
    expect(d.gapScorePp).toBe(5);
    expect(d.tier).toBe("T0");
    expect(d.reasons).toHaveLength(1);
  });

  test("Z.ai terms unconfirmed (E-LEGAL) → T0 regardless of the gap", () => {
    const runs = results(
      model("glm-5.3", "T1", { firstTry: 10, score: 0.9 }),
      model("glm-5.1", "T0", { firstTry: 5, score: 0.5 }),
    );
    expect(decideWeek0([runs]).tier).toBe("T1");
    const d = decideWeek0([runs], { zaiTermsConfirmed: false });
    expect(d.tier).toBe("T0");
    expect(d.reasons.join()).toContain("E-LEGAL");
  });

  test("only briefs common to all models count; separate files are merged", () => {
    const d = decideWeek0([
      results(model("glm-5.3", "T1", { firstTry: 10, score: 0.9 })),
      results(model("glm-5.1", "T0", { firstTry: 5, score: 0.5, briefs: BRIEFS.slice(0, 5) })),
    ]);
    expect(d.briefs).toEqual(BRIEFS.slice(0, 5));
    expect(d.t1.n).toBe(5);
    expect(d.bestT0.firstTryValid).toBe(1);
    expect(d.tier).toBe("T0");
  });

  test("missing T1 or T0 runs is an error", () => {
    expect(() => decideWeek0([results(model("glm-5.1", "T0", { firstTry: 5, score: 0.5 }))])).toThrow(/T1/);
    expect(() => decideWeek0([results(model("glm-5.3", "T1", { firstTry: 5, score: 0.5 }))])).toThrow(/T0/);
  });

  test("report: table, gaps, decision and the parameter line; dry-run is flagged", () => {
    const d = decideWeek0([
      { ...results(model("glm-5.3", "T1", { firstTry: 6, score: 0.7 }), model("glm-5.1", "T0", { firstTry: 6, score: 0.68 })), dry_run: true },
    ]);
    const md = renderWeek0Report(d, { generatedAt: "2026-10-05T12:00:00.000Z" });
    expect(md).toContain("| glm-5.1 (лучшая T0) | T0 | 10 | 60% | 60% | 0.408 |");
    expect(md).toContain("валидность с первой попытки **0 п. п.**, скор **1.2 п. п.**");
    expect(md).toContain("## Решение: сборка по умолчанию — T0 (модели в РФ)");
    expect(md).toContain("`WIZARD_BUILD_DEFAULT_TIER=T0`");
    expect(md).toContain("DRY-RUN");
  });
});

describe("CLI tools/eval/week0.mjs", () => {
  test("writes the report to --out and prints the recommended tier last", () => {
    const input = join(tmp, "synthetic.json");
    writeFileSync(
      input,
      JSON.stringify(
        results(model("glm-5.3", "T1", { firstTry: 8, score: 0.8 }), model("glm-5.1", "T0", { firstTry: 8, score: 0.78 })),
      ),
    );
    const out = join(tmp, "week0.md");
    const stdout = execFileSync(process.execPath, [join(HERE, "..", "week0.mjs"), input, `--out=${out}`], {
      encoding: "utf8",
    });
    expect(stdout.trim().split("\n").at(-1)).toBe("WIZARD_BUILD_DEFAULT_TIER=T0");
    expect(readFileSync(out, "utf8")).toContain("# Eval недели 0");
  });

  test("bad arguments fail with a Russian message", () => {
    let err = "";
    try {
      execFileSync(process.execPath, [join(HERE, "..", "week0.mjs")], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      err = String(e.stderr);
    }
    expect(err).toContain("укажите файл");
  });
});
