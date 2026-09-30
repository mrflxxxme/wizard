// `node tools/eval/run.mjs --harness …` (eval.yaml#modes.harness): runs briefs × models through runBrief, writes
// results/<stamp>-harness[-fixture|-record|-dry].{json,md} and returns the exit code (hard thresholds).
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getModel, type LlmMode } from "../../../packages/llm/src/index.ts";
import { loadBriefs } from "../lib/briefs.mjs";
import { loadForbiddenForT1 } from "../lib/canary.mjs";
import { hardViolations, harnessBaseName, renderHarnessReport } from "../lib/report.mjs";
import { connectDb } from "./db.ts";
import { resolveFixture } from "./fixtures.ts";
import { createG1Runtime } from "./g1.ts";
import { type Brief, defaultBuildModel, type HarnessRun, registryFor, runBrief } from "./run-brief.ts";

export interface HarnessOptions {
  llmMode: LlmMode;
  dryRun: boolean;
  /** Model overrides (models.yaml ids); empty = registry default. */
  models: string[];
  briefs?: string | string[];
  /** Default tools/eval/briefs (tests pass a temp folder). */
  briefsDir?: string;
  outDir: string;
  env: Record<string, string | undefined>;
  fixturesDir?: string;
  fetch?: typeof globalThis.fetch;
  log?: (line: string) => void;
}

export interface HarnessResult {
  mode: "harness";
  llm_mode: LlmMode;
  dry_run: boolean;
  started_at: string;
  finished_at: string;
  models: string[];
  briefs: string[];
  runs: HarnessRun[];
}

const DEFAULT_DB = "postgres://wizard@localhost:5433/wizard";

/** Russian reason why the options cannot run, or null. */
export function harnessPreflight(o: HarnessOptions): string | null {
  if (!["fixture", "live", "record"].includes(o.llmMode))
    return `--llm-mode: fixture, live или record (получено ${o.llmMode})`;
  if (o.dryRun && o.llmMode !== "fixture") return "--dry-run работает только с --llm-mode=fixture (без сети)";
  const reg = registryFor(undefined, o.env);
  for (const id of o.models) {
    try {
      getModel(reg, id);
    } catch {
      return `неизвестная модель ${id}: только id из specs/agents/models.yaml#models`;
    }
  }
  if (o.llmMode !== "fixture") {
    if (o.env.WIZARD_UNSAFE_LOCAL_EXEC !== "1")
      return "live/record: G1 исполняет сгенерированные функции — только локально с WIZARD_UNSAFE_LOCAL_EXEC=1";
    const ids = o.models.length
      ? o.models
      : [...new Set(Object.values(reg.routes).flatMap((r) => r.chain.T1 ?? []))];
    const providers = new Set(ids.map((id) => getModel(reg, id).provider));
    providers.add("cloudru"); // T0 reserve of every chain
    for (const p of providers) {
      const def = reg.providers[p];
      if (def.enabled && !o.env[def.apiKeyEnv]) return `live/record: не задан ${def.apiKeyEnv}`;
    }
  }
  return null;
}

export async function runHarness(o: HarnessOptions): Promise<HarnessResult> {
  const started = new Date();
  const briefs = loadBriefs(o.briefs, o.briefsDir) as Brief[];
  const forbiddenForT1 = loadForbiddenForT1();
  const db = connectDb(o.env.WIZARD_DB_URL ?? o.env.DATABASE_URL ?? DEFAULT_DB);
  // Fixture code is the repository's own; live/record code is generated and needs WIZARD_UNSAFE_LOCAL_EXEC=1.
  const g1 = await createG1Runtime(db, {
    unsafeLocalExec: o.llmMode === "fixture" || o.env.WIZARD_UNSAFE_LOCAL_EXEC === "1",
    env: o.env,
  });
  const runs: HarnessRun[] = [];
  try {
    for (const modelId of o.models.length ? o.models : [undefined]) {
      for (const brief of briefs) {
        const fixture = resolveFixture(brief, {
          dryRun: o.dryRun,
          ...(o.fixturesDir ? { dir: o.fixturesDir } : {}),
        });
        if (o.llmMode === "fixture" && !fixture) {
          runs.push(skipped(brief, modelId, o, "нет фикстуры (tools/fixtures/eval/<id>.jsonl)"));
          continue;
        }
        const run = await runBrief(brief, {
          llmMode: o.llmMode,
          ...(modelId ? { modelId } : {}),
          fixture,
          ...(o.fixturesDir ? { fixturesDir: o.fixturesDir } : {}),
          db,
          g1,
          env: o.env,
          forbiddenForT1,
          ...(o.fetch ? { fetch: o.fetch } : {}),
        });
        runs.push(run);
        o.log?.(
          `${run.g0g1_pass ? "✓" : run.g0_pass ? "~" : "✗"} ${run.model.padEnd(18)} ${run.brief.padEnd(28)} G0=${run.g0_pass} G1=${run.g0g1_pass} ${run.minutes.toFixed(2)} мин ${run.cost_rub.toFixed(2)} ₽ pii_leaks=${run.pii_leaks}${run.errors.length ? ` — ${run.errors[0]}` : ""}`,
        );
      }
    }
  } finally {
    await g1.close();
    await db.end();
  }
  return {
    mode: "harness",
    llm_mode: o.llmMode,
    dry_run: o.dryRun,
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    models: o.models.length ? o.models : [...new Set(runs.map((r) => r.model))],
    briefs: briefs.map((b) => b.id),
    runs,
  };
}

function skipped(brief: Brief, modelId: string | undefined, o: HarnessOptions, reason: string): HarnessRun {
  const zero = { input: 0, cached: 0, output: 0 };
  const reg = registryFor(modelId, o.env);
  const model = modelId ?? defaultBuildModel(reg);
  return {
    brief: brief.id,
    segment: brief.segment,
    model,
    tier: getModel(reg, model).tier,
    mode: "harness",
    llm_mode: o.llmMode,
    fixture: null,
    skipped: reason,
    valid: false,
    attempts: 0,
    score: {
      total: 0,
      roles: 0,
      entities: 0,
      features: 0,
      acceptance: 0,
      missing: { roles: [], entities: [], features: [], acceptance: [] },
    },
    outcome: "skipped",
    g0_pass: false,
    g0g1_pass: false,
    coverage: 0,
    tokens: zero,
    cost_rub: 0,
    credits: 0,
    minutes: 0,
    first_preview_minutes: null,
    steps: 0,
    questions_asked: 0,
    estimate_ratio: null,
    budget_exceeded: false,
    escalations: 0,
    pii_leaks: 0,
    pii: { canaryHits: 0, forbiddenCalls: 0, t1Payloads: 0 },
    fallback_rate: 0,
    fixture_miss: false,
    llm_calls: { total: 0, T0: 0, T1: 0, byCallType: {} },
    gates: [],
    errors: [],
  };
}

/** Writes <out>/<stamp>-harness….{json,md}; returns the JSON path. */
export async function writeHarnessResult(result: HarnessResult, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const base = harnessBaseName(new Date(result.started_at), {
    llmMode: result.llm_mode,
    dryRun: result.dry_run,
  });
  const file = join(outDir, `${base}.json`);
  await writeFile(file, JSON.stringify(result, null, 2));
  await writeFile(join(outDir, `${base}.md`), renderHarnessReport(result));
  return file;
}

export async function runHarnessCli(args: Record<string, string | true>): Promise<number> {
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  const env = { ...process.env };
  const o: HarnessOptions = {
    llmMode: (str("llm-mode") ?? env.WIZARD_LLM_MODE ?? "fixture") as LlmMode,
    dryRun: Boolean(args["dry-run"]),
    models: (str("models") ?? "").split(",").filter(Boolean),
    ...(str("briefs") ? { briefs: str("briefs") } : {}),
    outDir: resolve(str("out") ?? join(import.meta.dirname, "..", "results")),
    env,
    log: (l) => process.stderr.write(`${l}\n`),
  };
  const bad = harnessPreflight(o);
  if (bad) {
    console.error(`Ошибка: ${bad}`);
    return 1;
  }
  const result = await runHarness(o);
  const file = await writeHarnessResult(result, o.outDir);
  console.log(`\n${renderHarnessReport(result)}`);
  console.log(`Результаты: ${file}`);
  const v = hardViolations(result);
  if (v.length) {
    console.error(`Жёсткие пороги нарушены (${v.length}).`);
    return 1;
  }
  return 0;
}
