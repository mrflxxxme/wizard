// V4-03 stage probe (D79 (10), docs/plans/2026-10-11-v4.md §5.2): one stage of the build run by a live model on its 2–3
// saved inputs (tools/fixtures/probe/inputs/<stage>/*.json); every answer becomes a record (tools/fixtures/records/
// probe/<stage>.jsonl) that CI replays. The probe stops at its cap; the report (stdout, GITHUB_STEP_SUMMARY) has per
// input the calls — model, tier, ₽, seconds, tools called — and whether the stage used the model's answer.
// Entry: `node tools/fixtures/probe.mjs --stage=art_direction [--inputs=a,b] [--model=glm-5.3] [--cap-rub=15]`.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  createRegistry,
  createRouter,
  LlmError,
  type Registry,
  RecordBook,
  type RecordLine,
  type Router,
  type RouteInput,
  recordingRouter,
} from "../../../packages/llm/src/index.ts";
import { type RouteFn, STAGES } from "./stages.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
export const INPUTS_DIR = join(ROOT, "tools", "fixtures", "probe", "inputs");
/** A probe never spends more than this (D79 (10): 5–15 ₽ a stage). */
export const PROBE_MAX_CAP_RUB = 30;
export const PROBE_DEFAULT_CAP_RUB = 15;

export interface ProbeOptions {
  stage: string;
  /** Names of saved inputs (file names without .json); empty — all of the stage. */
  inputs?: string[];
  /** Models (models.yaml ids) forced at the head of the stage's routes; empty — the registry's routes. */
  models?: string[];
  capRub?: number;
  env?: Record<string, string | undefined>;
  /** Tests: the live router (default createRouter live with the registry). */
  router?: (registry: Registry) => Router;
  /** Tests: where records go (default tools/fixtures/records/probe/<stage>.jsonl). */
  book?: RecordBook;
  log?: (line: string) => void;
}

export interface ProbeCall {
  callType: string;
  model: string;
  tier: string;
  rub: number;
  seconds: number;
  tools: string[];
  finish: string;
}

export interface ProbeInputResult {
  input: string;
  model: string | null;
  ok: boolean;
  fallback: boolean;
  summary: string;
  error: string | null;
  calls: ProbeCall[];
  failedCalls: string[];
}

export interface ProbeReport {
  stage: string;
  models: string[];
  capRub: number;
  spentRub: number;
  stoppedByCap: boolean;
  results: ProbeInputResult[];
  ok: boolean;
  records: string;
}

/** Saved inputs of a stage: name → JSON. */
export function stageInputs(stage: string, names: readonly string[] = []): [string, Record<string, unknown>][] {
  const dir = join(INPUTS_DIR, stage);
  const all = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => basename(f, ".json"))
    : [];
  const picked = names.length ? names : all;
  return picked.map((n) => {
    const path = join(dir, `${n}.json`);
    if (!existsSync(path)) throw new Error(`нет сохранённого входа ${stage}/${n} (${dir})`);
    return [n, JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>];
  });
}

/** The registry with `model` at the head of the routes of `callTypes` (a new model probed on its stage). */
export function forceModel(reg: Registry, callTypes: readonly string[], model: string): Registry {
  const def = reg.models.find((m) => m.id === model);
  if (!def) throw new Error(`модели ${model} нет в реестре (specs/agents/models.yaml)`);
  const routes = { ...reg.routes };
  for (const ct of callTypes) {
    const r = routes[ct as keyof typeof routes];
    if (r) routes[ct as keyof typeof routes] = { ...r, defaultTier: def.tier, chain: { [def.tier]: [model] } };
  }
  return {
    ...reg,
    buildDefaultTier: def.tier === "T1" ? "T1" : reg.buildDefaultTier,
    models: reg.models.map((m) => (m.id === model ? { ...m, enabled: true } : m)),
    providers: { ...reg.providers, [def.provider]: { ...reg.providers[def.provider], enabled: true } },
    routes,
  };
}

export async function runProbe(o: ProbeOptions): Promise<ProbeReport> {
  const stage = STAGES[o.stage];
  if (!stage) throw new Error(`неизвестный этап ${o.stage}: ${Object.keys(STAGES).join(", ")}`);
  const env = o.env ?? process.env;
  const capRub = Math.min(o.capRub ?? PROBE_DEFAULT_CAP_RUB, PROBE_MAX_CAP_RUB);
  const log = o.log ?? ((l: string) => console.log(l));
  const inputs = stageInputs(o.stage, o.inputs);
  if (!inputs.length) throw new Error(`у этапа ${o.stage} нет сохранённых входов в ${join(INPUTS_DIR, o.stage)}`);
  const book = o.book ?? RecordBook.named(`probe/${o.stage}`, ROOT);
  const models = o.models?.length ? o.models : [null];
  const results: ProbeInputResult[] = [];
  let spent = 0;
  let stoppedByCap = false;

  for (const model of models) {
    const base = createRegistry({ buildDefaultTier: "T1" }, env);
    const registry = model ? forceModel(base, stage.callTypes, model) : base;
    const inner =
      o.router?.(registry) ??
      createRouter({ mode: "live", registry, env, sink: { write: () => {} }, t1Reserve: true });
    let label = "";
    let calls: ProbeCall[] = [];
    let failed: string[] = [];
    const recorder = recordingRouter(inner, {
      book,
      source: "probe",
      label: () => (model ? `${label}@${model}` : label),
      onRecord: (l: RecordLine) => {
        spent += l.costRub;
        calls.push({
          callType: l.callType,
          model: l.model,
          tier: l.tier,
          rub: l.costRub,
          seconds: Math.round(l.latencyMs / 100) / 10,
          tools: l.response.toolCalls.map((c) => c.name),
          finish: l.response.finishReason,
        });
      },
    });
    const route: RouteFn = async (input: RouteInput) => {
      if (spent >= capRub) {
        stoppedByCap = true;
        throw new LlmError("BUDGET_EXCEEDED", `Проба остановлена на потолке ${capRub} ₽.`);
      }
      try {
        return await recorder.route(input);
      } catch (e) {
        failed.push(`${input.callType}: ${e instanceof LlmError ? `${e.code} ${JSON.stringify(e.details)}` : String(e)}`);
        throw e;
      }
    };
    for (const [name, input] of inputs) {
      if (stoppedByCap) break;
      label = name;
      calls = [];
      failed = [];
      const ctx = { orgId: "probe", systemId: `probe-${o.stage}-${name}` };
      let run: { fallback: boolean; summary: string } = { fallback: true, summary: "" };
      let error: string | null = null;
      try {
        run = await stage.run(input, route, ctx);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const ok = error === null && !run.fallback && calls.length > 0 && failed.length === 0;
      const r: ProbeInputResult = {
        input: name,
        model,
        ok,
        fallback: run.fallback,
        summary: run.summary,
        error,
        calls,
        failedCalls: failed,
      };
      results.push(r);
      log(
        `${ok ? "✓" : "✗"} ${o.stage}/${name}${model ? ` @${model}` : ""}: ${calls.length} вызов(ов), ${calls
          .reduce((s, c) => s + c.rub, 0)
          .toFixed(2)} ₽${run.fallback ? ", запасной путь" : ""}${error ? `, ошибка: ${error}` : ""}${
          failed.length ? `, отказы: ${failed.join("; ")}` : ""
        }`,
      );
    }
  }
  return {
    stage: o.stage,
    models: models.filter((m): m is string => m !== null),
    capRub,
    spentRub: Math.round(spent * 100) / 100,
    stoppedByCap,
    results,
    ok: results.length > 0 && results.every((r) => r.ok),
    records: book.path.slice(ROOT.length + 1),
  };
}

/** The Markdown report of a probe (job summary). */
export function renderProbe(r: ProbeReport): string {
  const out = [
    `### Проба этапа ${r.stage}${r.models.length ? ` (${r.models.join(", ")})` : ""}: ${r.ok ? "✅ модель ответила на всех входах" : "❌ есть провалы"}`,
    "",
    `Потрачено ${r.spentRub.toFixed(2)} ₽ из ${r.capRub} ₽${r.stoppedByCap ? " — остановлена на потолке" : ""}. Записи: \`${r.records}\`.`,
    "",
    "| Вход | Модель | Итог | Вызовы (тип · модель · ₽ · с · инструменты) | Результат этапа |",
    "|---|---|---|---|---|",
  ];
  for (const x of r.results) {
    const calls = x.calls
      .map((c) => `${c.callType} · ${c.model} (${c.tier}) · ${c.rub.toFixed(2)} · ${c.seconds} · ${c.tools.join("+") || c.finish}`)
      .join("<br>");
    const verdict = x.ok ? "✅" : x.error ? `❌ ${x.error}` : x.fallback ? "❌ запасной путь" : "❌ отказ вызова";
    const fails = x.failedCalls.length ? `<br>отказы: ${x.failedCalls.join("; ")}` : "";
    out.push(
      `| ${x.input} | ${x.model ?? "по маршруту"} | ${verdict} | ${calls || "—"}${fails} | ${x.summary.replace(/\|/g, "/")} |`.replace(
        /\n/g,
        " ",
      ),
    );
  }
  return `${out.join("\n")}\n`;
}

/** CLI: --stage=<name>[,<name>] --inputs=a,b --model=<id>[,<id>] --cap-rub=15. Exit 1 when any input failed. */
export async function probeCli(argv: readonly string[]): Promise<number> {
  const args = Object.fromEntries(
    argv
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [k, ...v] = a.slice(2).split("=");
        return [k, v.join("=")];
      }),
  ) as Record<string, string | undefined>;
  const list = (v: string | undefined) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (args["stages-for"] !== undefined) {
    // `--stages-for=<file with changed paths>`: prints the stages to probe, comma-separated.
    const files = readFileSync(args["stages-for"], "utf8").split("\n").filter(Boolean);
    const manifest = JSON.parse(readFileSync(join(ROOT, "tools", "fixtures", "records", "prompts.json"), "utf8"));
    console.log(stagesFor(files, manifest).join(","));
    return 0;
  }
  const stages = list(args.stage);
  if (!stages.length) {
    console.error(`укажите --stage=<${Object.keys(STAGES).join("|")}>`);
    return 2;
  }
  let ok = true;
  // The cap holds per stage (D79 (10): 5–15 ₽ a stage).
  const cap = Number(args["cap-rub"] ?? PROBE_DEFAULT_CAP_RUB);
  for (const stage of stages) {
    const report = await runProbe({ stage, inputs: list(args.inputs), models: list(args.model), capRub: cap });
    const md = renderProbe(report);
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    ok &&= report.ok;
  }
  return ok ? 0 : 1;
}

/**
 * Stages whose prompt changed (the push trigger): a changed file under a prompt source of one of the stage's callTypes
 * (tools/fixtures/records/prompts.json) or under the stage's saved inputs.
 */
export function stagesFor(files: readonly string[], manifest: Record<string, readonly string[]>): string[] {
  return Object.entries(STAGES)
    .filter(([name, s]) =>
      files.some(
        (f) =>
          f.startsWith(`tools/fixtures/probe/inputs/${name}/`) ||
          s.callTypes.some((ct) => (manifest[ct] ?? []).some((p) => f === p || f.startsWith(`${p}/`))),
      ),
    )
    .map(([name]) => name);
}
