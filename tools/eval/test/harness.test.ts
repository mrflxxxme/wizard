// M0-18: --harness on the real orchestrator + builder + QA + G0/G1, offline (fixture mode, --dry-run).
// Needs Postgres at DATABASE_URL (G0 shadow schema, G1 runtime), as the other gate tests.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  finishResult,
  type HarnessOptions,
  harnessPreflight,
  missingKeys,
  runHarness,
  writeHarnessResult,
} from "../harness/cli.ts";
import { EVAL_OWNER_COMPLIANCE, withOwnerCompliance } from "../harness/qa.ts";
import { baselineEntries } from "../lib/baseline.mjs";
import { BRIEFS_DIR, loadBriefs } from "../lib/briefs.mjs";
import { aggregateHarness, hardViolations, harnessBaseName, renderHarnessReport } from "../lib/report.mjs";
import { decideWeek0, mergeRuns, modelStats } from "../lib/week0.mjs";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "wz-eval-harness-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const env: Record<string, string | undefined> = { ...process.env, WIZARD_LLM_MODE: "fixture" };
const opts = (o: Partial<HarnessOptions>): HarnessOptions => ({
  llmMode: "fixture",
  dryRun: false,
  models: [],
  outDir: tmp,
  env,
  ...o,
});

describe("CLI (backlog M0-18 acceptance)", () => {
  test("--harness --llm-mode=fixture --briefs=ev-01-forum-registration prints {g0_pass, g0g1_pass, tokens, ₽, мин}", () => {
    const out = join(tmp, "cli");
    const stdout = execFileSync(
      process.execPath,
      [
        join(ROOT, "tools", "eval", "run.mjs"),
        "--harness",
        "--llm-mode=fixture",
        "--briefs=ev-01-forum-registration",
        `--out=${out}`,
      ],
      { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
    );
    const header = stdout.split("\n").find((l) => l.startsWith("| Бриф |")) ?? "";
    for (const col of ["g0_pass", "g0g1_pass", "tokens", "₽", "мин"]) expect(header).toContain(col);
    const row = stdout.split("\n").find((l) => l.startsWith("| ev-01-forum-registration |")) ?? "";
    expect(row).toMatch(/\| demo\/forum \| ✓ \| ✓ \|/);
    const files = readdirSync(out);
    expect(files.some((f) => /-harness-fixture\.json$/.test(f))).toBe(true);
    expect(files.some((f) => /-harness-fixture\.md$/.test(f))).toBe(true);
  }, 180_000);
});

describe("fixture mode", async () => {
  const result = await runHarness(
    opts({ models: ["glm-5.3", "glm-5.1"], briefs: "ev-01-forum-registration,ev-02-speaker-moderation" }),
  );
  const run = (brief: string, model: string) =>
    result.runs.find((r) => r.brief === brief && r.model === model);

  test("forum brief goes orchestrator → card → builder → G0 → QA → G1 on the demo fixture", () => {
    const r = run("ev-01-forum-registration", "glm-5.3");
    expect(r, JSON.stringify(result.runs.map((x) => [x.brief, x.model, x.errors]))).toBeDefined();
    expect(r?.errors).toEqual([]);
    expect(r).toMatchObject({ fixture: "demo/forum", g0_pass: true, g0g1_pass: true, outcome: "succeeded" });
    expect(r?.fixture_miss).toBe(false);
    expect(r?.questions_asked).toBe(5);
    expect(r?.steps).toBeGreaterThan(0);
    expect(r?.tokens.input).toBeGreaterThan(0);
    expect(r?.cost_rub).toBeGreaterThan(0);
    expect(r?.credits).toBeGreaterThan(0);
    expect(r?.estimate_ratio).toBeGreaterThan(0);
    expect(r?.first_preview_minutes).not.toBeNull();
    expect(Object.keys(r?.llm_calls.byCallType ?? {})).toEqual(
      expect.arrayContaining(["interview", "card", "plan", "build_ops", "build_code", "qa_generate"]),
    );
    expect(r?.gates.map((g) => [g.level, g.passed])).toEqual([
      ["G0", true],
      ["G1", true],
    ]);
    expect(r?.pii_leaks).toBe(0);
    expect(r?.coverage).toBeGreaterThan(0.3);
  });

  test("--models overrides the build model and its tier", () => {
    expect(run("ev-01-forum-registration", "glm-5.1")).toMatchObject({ tier: "T0", g0g1_pass: true });
    expect(run("ev-01-forum-registration", "glm-5.3")).toMatchObject({ tier: "T1" });
  });

  test("a brief without its own fixture is skipped, not failed", () => {
    expect(run("ev-02-speaker-moderation", "glm-5.3")).toMatchObject({
      skipped: expect.any(String),
      g0_pass: false,
    });
    expect(hardViolations(result)).toEqual([]);
  });

  test("results JSON is consumable by week0 (M0-30)", async () => {
    const file = await writeHarnessResult(result, join(tmp, "w0"));
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(mergeRuns([parsed]).map((r: { brief: string }) => r.brief)).not.toContain(
      "ev-02-speaker-moderation",
    );
    expect(modelStats(parsed.runs, "glm-5.3", ["ev-01-forum-registration"])).toMatchObject({
      n: 1,
      firstTryValid: 1,
      valid: 1,
    });
    const d = decideWeek0([parsed]);
    expect(["T0", "T1"]).toContain(d.tier);
    expect(renderHarnessReport(parsed)).toContain("| glm-5.1 | T0 | 100% | 100% |");
  });

  test("M2-12 (L4-27): p80 build time and time to first preview are recorded in the JSON and the report", async () => {
    const file = await writeHarnessResult(result, join(tmp, "p80"));
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    for (const model of ["glm-5.3", "glm-5.1"]) {
      const a = parsed.aggregates.find((x: { model: string }) => x.model === model);
      expect(a, model).toBeDefined();
      expect(a.minutes_p80).toBeGreaterThan(0);
      expect(a.first_preview_minutes_p80).toBeGreaterThan(0);
      expect(a.first_preview_minutes_p80).toBeLessThanOrEqual(a.minutes_p80);
      expect(a.no_preview).toBe(0);
    }
    const md = readFileSync(file.replace(/\.json$/, ".md"), "utf8");
    expect(md).toContain("| мин p80 | до превью, мин (ср.) | до превью p80 |");
    expect(md).toContain("В fixture время не показательно");
    const row = md.split("\n").find((l) => l.startsWith("| ev-01-forum-registration | glm-5.3 |")) ?? "";
    expect(row).toMatch(/\| \d+\.\d\d \| \d+\.\d\d \| succeeded \|$/);
  });
});

describe("--dry-run: canaries and pii_leaks", async () => {
  const result = await runHarness(
    opts({
      dryRun: true,
      briefs: "ev-03-partner-quotas,hz-01-purchase-requests,hz-03-field-service,hz-04-client-crm",
    }),
  );

  test("canary briefs replay a stand-in with their canary sentences; scrub keeps them out of T1 payloads", () => {
    // hz-01: «помощник финдиректора Hiroshi Tanaka-Weller» (FU-2) must be scrubbed as well.
    for (const id of ["ev-03-partner-quotas", "hz-01-purchase-requests", "hz-03-field-service"]) {
      const r = result.runs.find((x) => x.brief === id);
      expect(r?.errors, id).toEqual([]);
      expect(r?.g0g1_pass, id).toBe(true);
      expect(r?.pii.t1Payloads, id).toBeGreaterThan(0);
      expect(r?.pii_leaks, id).toBe(0);
      // The brief with PII goes to T0 for the interview (models.yaml#routing_algorithm).
      expect(r?.llm_calls.byCallType.interview, id).toMatch(/^T0:pii_detected/);
    }
    expect(result.runs.find((x) => x.brief === "hz-04-client-crm")).toMatchObject({ fixture: "demo/forum" });
    expect(hardViolations(result)).toEqual([]);
  });

  test("a canary that reaches a T1 payload is counted and breaks the hard threshold", async () => {
    // A synthetic canary that no PII detector would scrub: the meter must not depend on packages/pii.
    const dir = join(tmp, "briefs");
    mkdirSync(dir, { recursive: true });
    const base = JSON.parse(readFileSync(join(BRIEFS_DIR, "hz-04-client-crm.json"), "utf8"));
    const canary = "zqxcanary7731";
    const brief = {
      ...base,
      id: "hz-90-canary-probe",
      text: `${base.text.slice(0, 1400)} Код проекта ${canary}.`,
      canaries: [canary],
    };
    writeFileSync(join(dir, `${brief.id}.json`), JSON.stringify(brief));
    const leak = await runHarness(opts({ dryRun: true, briefsDir: dir }));
    const r = leak.runs[0];
    expect(r?.pii.canaryHits).toBeGreaterThan(0);
    expect(r?.pii_leaks).toBe(r?.pii.canaryHits);
    expect(hardViolations(leak)).toEqual([expect.stringContaining("pii_leaks")]);
    expect(renderHarnessReport(leak)).toContain("Жёсткие пороги нарушены");
  });
});

describe("fixture mode: bakery (hard threshold «кондитерская G0+G1 = 100%»)", async () => {
  const result = await runHarness(opts({ briefs: "gd-01-cake-preorder" }));

  test("gd-01-cake-preorder reaches G0+G1 on demo/bakery without FIXTURE_MISS", () => {
    const r = result.runs.find((x) => x.brief === "gd-01-cake-preorder");
    expect(r?.errors).toEqual([]);
    expect(r).toMatchObject({ fixture: "demo/bakery", g0_pass: true, g0g1_pass: true, outcome: "succeeded" });
    expect(r?.fixture_miss).toBe(false);
    expect(r?.questions_asked).toBe(4);
    expect(r?.gates.map((g) => [g.level, g.passed])).toEqual([
      ["G0", true],
      ["G1", true],
    ]);
    expect(hardViolations(result)).toEqual([]);
  });
});

describe("preflight and G1 inputs", () => {
  test("live/record need keys and WIZARD_UNSAFE_LOCAL_EXEC; --dry-run is offline only; model ids from models.yaml", () => {
    const clean = { DATABASE_URL: env.DATABASE_URL };
    expect(harnessPreflight(opts({ llmMode: "live", env: clean }))).toMatch(/WIZARD_UNSAFE_LOCAL_EXEC/);
    expect(
      harnessPreflight(opts({ llmMode: "live", env: { ...clean, WIZARD_UNSAFE_LOCAL_EXEC: "1" } })),
    ).toMatch(/не задан [A-Z_]+_API_KEY/);
    expect(harnessPreflight(opts({ llmMode: "live", dryRun: true }))).toMatch(/--dry-run/);
    expect(harnessPreflight(opts({ models: ["gpt-5"] }))).toMatch(/неизвестная модель gpt-5/);
    expect(harnessPreflight(opts({}))).toBeNull();
  });

  test("result names: live report per date (committed), other modes stamped and local", () => {
    const d = new Date("2026-10-05T10:00:00.000Z");
    expect(harnessBaseName(d, { llmMode: "live", dryRun: false })).toBe("2026-10-05-harness");
    expect(harnessBaseName(d, { llmMode: "fixture", dryRun: false })).toBe(
      "2026-10-05T10-00-00-000Z-harness-fixture",
    );
    expect(harnessBaseName(d, { llmMode: "fixture", dryRun: true })).toBe(
      "2026-10-05T10-00-00-000Z-harness-dry",
    );
  });

  test("G1 sees owner compliance fields the agent may not set; existing values are kept", () => {
    const spec = {
      specVersion: "1",
      app: { name: "x" },
      compliance: { operatorName: "ООО «Своё»" },
    } as never;
    const out = withOwnerCompliance(spec) as unknown as { compliance: Record<string, string> };
    expect(out.compliance.operatorName).toBe("ООО «Своё»");
    expect(out.compliance.consentText).toBe(EVAL_OWNER_COMPLIANCE.consentText);
  });
});

describe("M1-10: CI options (--gates=G0, --max-cost-rub, baseline)", async () => {
  const g0 = await runHarness(opts({ gates: "G0", briefs: "ev-01-forum-registration" }));

  test("--gates=G0: G1 is a pass-through stub, g0g1_pass is not measured, nothing is executed", () => {
    const r = g0.runs[0];
    expect(r).toMatchObject({ g0_pass: true, g0g1_pass: false, g1_skipped: true, outcome: "succeeded" });
    expect(aggregateHarness(g0.runs)[0]?.g0g1_pass).toBeNull();
    expect(hardViolations(g0)).toEqual([]);
    expect(renderHarnessReport(g0)).toContain("G1 не запускался");
  });

  test("live with --gates=G0 does not need WIZARD_UNSAFE_LOCAL_EXEC; missing keys are reported by name", () => {
    const clean = { DATABASE_URL: env.DATABASE_URL };
    const live = opts({ llmMode: "live", gates: "G0", env: clean });
    expect(harnessPreflight(live)).toMatch(/не задан .*CLOUDRU_API_KEY/);
    expect(missingKeys(live)).toEqual(expect.arrayContaining(["CLOUDRU_API_KEY", "ZAI_API_KEY"]));
    expect(missingKeys(opts({ llmMode: "live", gates: "G0", models: ["glm-5.1"], env: clean }))).toEqual([
      "CLOUDRU_API_KEY",
    ]);
    const keys = { ...clean, CLOUDRU_API_KEY: "x", ZAI_API_KEY: "y" };
    expect(harnessPreflight(opts({ llmMode: "live", gates: "G0", env: keys }))).toBeNull();
    expect(harnessPreflight(opts({ llmMode: "live", env: keys }))).toMatch(/WIZARD_UNSAFE_LOCAL_EXEC/);
  });

  test("--max-cost-rub: no brief starts once the run's budget is spent", async () => {
    const capped = await runHarness(opts({ maxCostRub: 0, briefs: "ev-01-forum-registration" }));
    expect(capped.runs[0]?.skipped).toMatch(/бюджет прогона 0 ₽ исчерпан/);
    expect(capped.max_cost_rub).toBe(0);
  });

  test("a G0/G1 share drop > 5 p.p. against the baseline fails the run (acceptance M1-10)", () => {
    const briefs = loadBriefs("ev-01-forum-registration,gd-01-cake-preorder");
    const good = {
      ...g0,
      gates: "G0G1" as const,
      briefs: briefs.map((b) => b.id),
      runs: briefs.map(
        (b) => ({ ...g0.runs[0], brief: b.id, fixture: null, g0g1_pass: true, g1_skipped: false }) as never,
      ),
    };
    const baseline = { v: 1, entries: baselineEntries(good, briefs) };
    expect(finishResult(structuredClone(good), briefs, baseline)).toEqual([]);
    const worse = structuredClone(good);
    worse.runs[1] = { ...worse.runs[1], g0g1_pass: false } as never;
    const v = finishResult(worse, briefs, baseline);
    expect(v).toEqual([expect.stringMatching(/g0g1_pass 50% против baseline 100%/)]);
    expect(renderHarnessReport(worse)).toContain("Регрессия к baseline");
  });
});
