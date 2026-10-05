// G0 orchestration (specs/quality/gates.yaml#G0): order, dependencies, since/milestone, time budget.
import type { AppSpec } from "@wizard/appspec";
import { buildSystem } from "@wizard/build";
import {
  CHECK_BY_ID,
  compareMilestones,
  G0_CHECKS,
  G0_TARGET_MS,
  G0_TIME_BUDGET_MS,
  resolveMilestone,
} from "../catalog.js";
import { type CheckOutcome, type Finding, isPassed, summarize, toChecks } from "../report.js";
import type { Check, GateContext, GateReport } from "../types.js";
import {
  checkDataLimits,
  checkFilesExist,
  checkFunctionDefs,
  checkOrphans,
  type WhereRange,
} from "./code.js";
import { checkImports } from "./imports.js";
import { checkMigrationPlan, checkShadowApply } from "./migrations.js";
import { checkSecurity } from "./security.js";
import { parseAll, type SourceInfo } from "./source.js";
import { checkRolesAndRoutes, checkSchema, checkSemantics, fieldPii } from "./spec.js";
import { typecheck } from "./typecheck.js";

/** UI bundle soft limit (G0-BUILD-01: warning > 1 MB). */
export const UI_BUNDLE_WARN = 1024 * 1024;

export interface G0Options {
  /** Run only these check ids (the rest → skip). G0-IMP-01/G0-SEC-01 still gate tsc and the build. */
  only?: readonly string[];
  timeBudgetMs?: number;
  /** Injection points for tests. */
  deps?: {
    buildSystem?: typeof buildSystem;
    typecheck?: typeof typecheck;
  };
}

const ok = (findings: Finding[] = []): CheckOutcome => ({ kind: "findings", findings });
const skip = (reason_ru: string): CheckOutcome => ({ kind: "skip", reason_ru });

export function piiFieldNames(spec: AppSpec): Set<string> {
  const out = new Set<string>();
  for (const e of spec.entities ?? [])
    for (const f of e.fields ?? []) if (fieldPii(f) !== "none") out.add(f.name);
  return out;
}

/** Code checks of G0 that need no database, bundle or previous revision (agents/builder.yaml#harness.tasks.check). */
export const G0_CODE_CHECKS = [
  "G0-IMP-01",
  "G0-SEC-01",
  "G0-SPEC-01",
  "G0-SPEC-03",
  "G0-FN-01",
  "G0-TS-01",
] as const;

/**
 * The code checks of G0 over the whole working tree, without a database and without gate events; the failed or
 * erroring checks whose finding names `file` (or that name no file at all when `file` is absent).
 */
export async function checkCode(input: {
  spec: AppSpec;
  files: ReadonlyMap<string, string>;
  file?: string;
  timeBudgetMs?: number;
}): Promise<Check[]> {
  const report = await runG0(
    {
      spec: input.spec,
      prevSpec: null,
      specVersion: 0,
      files: input.files,
      env: "draft",
      systemKey: "code_check",
      db: undefined as never,
    },
    { only: G0_CODE_CHECKS, ...(input.timeBudgetMs ? { timeBudgetMs: input.timeBudgetMs } : {}) },
  );
  const bad = report.checks.filter((c) => c.status === "fail" || c.status === "error");
  return input.file === undefined ? bad : bad.filter((c) => c.file === input.file);
}

/** write_file fast path (gates.yaml#G0.runs_on): G0-IMP-01 and G0-SEC-01 for one file. */
export function checkFile(path: string, source: string, spec?: AppSpec): Check[] {
  const src = parseAll(new Map([[path, source]]))[0];
  const imp = CHECK_BY_ID.get("G0-IMP-01");
  const sec = CHECK_BY_ID.get("G0-SEC-01");
  if (!imp || !sec) throw new Error("catalog");
  if (!src) return [];
  return [
    ...toChecks(imp, ok(checkImports(src))),
    ...toChecks(sec, ok(checkSecurity(src, spec ? { piiFieldNames: piiFieldNames(spec) } : {}))),
  ];
}

export async function runG0(ctx: GateContext, opts: G0Options = {}): Promise<GateReport> {
  const started = Date.now();
  const startedAt = (ctx.now ?? new Date(started)).toISOString();
  const deadline = started + (opts.timeBudgetMs ?? G0_TIME_BUDGET_MS);
  const milestone = resolveMilestone(ctx.milestone);
  const runBuild = opts.deps?.buildSystem ?? buildSystem;
  const runTsc = opts.deps?.typecheck ?? typecheck;
  const outcomes = new Map<string, CheckOutcome>();
  const wanted = (id: string) => !opts.only || opts.only.includes(id);

  const files = new Map<string, string>();
  for (const [p, t] of ctx.files) if (/^(ui|functions)\//.test(p)) files.set(p, t);
  const spec = ctx.spec;

  const failed = (id: string) => {
    const o = outcomes.get(id);
    return (
      o !== undefined &&
      (o.kind === "error" ||
        (o.kind === "findings" && o.findings.some((f) => (f.status ?? "fail") === "fail")))
    );
  };

  async function run(
    id: string,
    fn: () => CheckOutcome | Promise<CheckOutcome>,
    force = false,
  ): Promise<void> {
    const def = CHECK_BY_ID.get(id);
    if (!def) throw new Error(`unknown check ${id}`);
    if (!wanted(id) && !force) return void outcomes.set(id, skip("Проверка не запускалась в этом прогоне"));
    if (def.since && compareMilestones(milestone, def.since) < 0) {
      return void outcomes.set(id, skip(`Проверка включается с этапа ${def.since}`));
    }
    if (ctx.signal?.aborted)
      return void outcomes.set(id, { kind: "error", reason_ru: "проверка остановлена" });
    const left = deadline - Date.now();
    if (left <= 0)
      return void outcomes.set(id, { kind: "error", reason_ru: "превышено время проверки (60 с)" });
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<CheckOutcome>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: "error", reason_ru: "превышено время проверки (60 с)" }),
          left,
        );
      });
      outcomes.set(id, await Promise.race([Promise.resolve().then(fn), timeout]));
    } catch (e) {
      outcomes.set(id, {
        kind: "error",
        reason_ru: "внутренняя ошибка проверки",
        evidence: String((e as Error)?.message ?? e),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // 1. Static AST checks on sources — before anything compiles or bundles code (L3-13).
  let sources: SourceInfo[] = [];
  const bySource = () => new Map(sources.map((s) => [s.path, s]));
  const needAst = ["G0-IMP-01", "G0-SEC-01", "G0-TS-01", "G0-BUILD-01"].some(wanted);
  await run(
    "G0-IMP-01",
    () => {
      sources = parseAll(files);
      return ok(sources.flatMap(checkImports));
    },
    needAst,
  );
  const pii = (() => {
    try {
      return piiFieldNames(spec);
    } catch {
      return new Set<string>();
    }
  })();
  await run("G0-SEC-01", () => ok(sources.flatMap((s) => checkSecurity(s, { piiFieldNames: pii }))), needAst);
  if (sources.length === 0 && files.size > 0) sources = parseAll(files);
  const staticBlocked = failed("G0-IMP-01") || failed("G0-SEC-01");

  // 2. Spec.
  await run("G0-SPEC-01", () => ok(checkSchema(spec)));
  const specShapeOk = !failed("G0-SPEC-01");
  const needsSpec = (fn: () => CheckOutcome | Promise<CheckOutcome>) => () =>
    specShapeOk ? fn() : skip("Не запускалась: описание системы не соответствует схеме");
  await run(
    "G0-SPEC-02",
    needsSpec(() => ok(checkSemantics(spec))),
  );
  await run(
    "G0-SPEC-03",
    needsSpec(() => ok(checkFilesExist(spec, files, bySource()))),
  );
  await run(
    "G0-SPEC-04",
    needsSpec(() => ok(checkOrphans(spec, files, sources))),
  );
  await run(
    "G0-SPEC-05",
    needsSpec(() => ok(checkRolesAndRoutes(spec))),
  );

  // 3. Migrations.
  const specValid = specShapeOk && !failed("G0-SPEC-02");
  await run("G0-MIG-01", () =>
    specValid
      ? ok(
          checkMigrationPlan(ctx.prevSpec, spec, ctx.env, {
            destructiveConfirmed: ctx.destructiveConfirmed === true,
          }),
        )
      : skip("Не запускалась: описание системы содержит ошибки"),
  );
  await run("G0-MIG-02", async () => {
    if (!specValid || failed("G0-MIG-01")) return skip("Не запускалась: план миграции не построен");
    if (!ctx.db) return { kind: "error", reason_ru: "нет подключения к базе данных" };
    return ok(
      await checkShadowApply(ctx.db, ctx.systemKey, ctx.prevSpec, spec, ctx.env, {
        destructiveConfirmed: ctx.destructiveConfirmed === true,
      }),
    );
  });

  // 4. Code vs spec (AST).
  let whereRanges: WhereRange[] = [];
  let idxFindings: Finding[] = [];
  await run(
    "G0-FN-01",
    needsSpec(() => ok(checkFunctionDefs(spec, bySource()))),
  );

  // 5. tsc — only after G0-IMP-01/G0-SEC-01 passed.
  const blockedReason = "Не запускалась: код не прошёл проверку импортов и запрещённых API";
  let tsIdx: Finding[] = [];
  await run(
    "G0-TS-01",
    () => {
      if (staticBlocked) return skip(blockedReason);
      if (!specShapeOk) return skip("Не запускалась: описание системы не соответствует схеме");
      const limits = checkDataLimits(sources);
      whereRanges = limits.whereRanges;
      idxFindings = limits.findings;
      const diags = runTsc(spec, files);
      const inWhere = (d: { file?: string; start?: number }) =>
        d.start !== undefined &&
        whereRanges.some(
          (r) => r.file === d.file && d.start !== undefined && d.start >= r.start && d.start < r.end,
        );
      tsIdx = diags.filter(inWhere).map(({ start: _s, code: _c, ...f }) => ({
        ...f,
        message_ru: `Условие where не опирается на индекс (${f.file}${f.line ? `:${f.line}` : ""})`,
        fixHint:
          "Фильтруйте по полям объявленного индекса (префиксом) или добавьте индекс в описание системы",
      }));
      return ok(diags.filter((d) => !inWhere(d)).map(({ start: _s, code: _c, ...f }) => f));
    },
    ["G0-TS-01", "G0-IDX-01"].some(wanted),
  );
  await run("G0-IDX-01", () => {
    if (outcomes.get("G0-TS-01")?.kind !== "findings") {
      const limits = checkDataLimits(sources);
      return ok(limits.findings);
    }
    return ok([...idxFindings, ...tsIdx]);
  });
  if (!wanted("G0-TS-01") && outcomes.get("G0-TS-01")?.kind === "findings") {
    outcomes.set("G0-TS-01", skip("Проверка не запускалась в этом прогоне"));
  }

  await run("G0-LINT-01", () => skip("Проверка ещё не подключена"));

  // 6. Build via @wizard/build — the same call as the gate_G0 workflow step.
  await run("G0-BUILD-01", async () => {
    if (staticBlocked) return skip(blockedReason);
    if (!specShapeOk) return skip("Не запускалась: описание системы не соответствует схеме");
    const r = await runBuild({ spec, files, env: ctx.env });
    const findings: Finding[] = r.errors.map((c) => ({
      message_ru: c.message_ru,
      ...(c.file ? { file: c.file } : {}),
      ...(c.line ? { line: c.line } : {}),
      ...(c.evidence ? { evidence: c.evidence } : {}),
      ...(c.fixHint ? { fixHint: c.fixHint } : {}),
      ...(c.status === "warn" ? { status: "warn" as const } : {}),
    }));
    if (r.ok && r.errors.length === 0 && r.manifest.sizes.client > UI_BUNDLE_WARN) {
      findings.push({
        status: "warn",
        message_ru: `Интерфейс весит ${(r.manifest.sizes.client / 1024 / 1024).toFixed(1)} МБ (рекомендуется до 1 МБ)`,
        fixHint: "Уменьшите число и размер страниц и компонентов",
      });
    }
    if (!r.ok && findings.length === 0) findings.push({ message_ru: "Система не собирается" });
    return ok(findings);
  });

  for (const id of ["G0-A11Y-01", "G0-I18N-01", "G0-PH-01", "G0-DATA-01"]) {
    await run(id, () => skip("Проверка ещё не подключена"));
  }

  const checks: Check[] = G0_CHECKS.flatMap((def) =>
    toChecks(def, outcomes.get(def.id) ?? skip("Проверка не запускалась в этом прогоне")),
  );
  const durationMs = Date.now() - started;
  if (durationMs > G0_TARGET_MS) {
    checks.push({
      id: "G0",
      status: "warn",
      severity: "warning",
      message_ru: `Проверка G0 шла ${Math.round(durationMs / 1000)} с — дольше цели 20 с`,
    });
  }
  return {
    level: "G0",
    passed: isPassed(checks),
    specVersion: ctx.specVersion,
    startedAt,
    durationMs,
    checks,
    summary: summarize(checks),
  };
}
