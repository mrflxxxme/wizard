#!/usr/bin/env node
// CI helpers for the eval stand (docs/ops/eval.md, specs/quality/eval.yaml#live_cadence, #regression). Node 22, no deps.
//   plan     --kind=nightly|full [--date=YYYY-MM-DD] [--ledger=file] [--models=a,b] [--github-output=file]
//            → run, reason, briefs, models, pairs, forecast_rub, spent_rub, max_cost_rub (key=value lines)
//   record   --kind=… --ledger=file --result-dir=dir [--forecast-rub=N] [--pairs=N] [--run-url=…] [--commit=…]
//            → books the run's cost_rub (or the forecast if the run left no result) into the ledger
//   baseline --result=file.json [--baseline=path]   → updates tools/eval/baseline.json (eval.yaml#regression.update)
//   violations --result-dir=dir                     → prints hard-threshold and regression lines of the result
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_FILE, baselineEntries, loadBaseline, updateBaseline } from "./lib/baseline.mjs";
import { loadBriefs } from "./lib/briefs.mjs";
import {
  addEntry,
  decide,
  entryFromResult,
  estimatedEntry,
  loadLedger,
  mergeEntries,
  resultsEntries,
} from "./lib/budget.mjs";
import { parseArgs } from "./lib/report.mjs";
import { nightlyBriefs } from "./lib/rotation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** live_cadence.full: default build model + the best alternative (models.yaml#week0_decision; override --models). */
const FULL_MODELS = ["glm-5.3", "glm-5.1"];

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const str = (k) => (typeof args[k] === "string" && args[k] !== "" ? args[k] : undefined);

try {
  if (cmd === "plan") plan();
  else if (cmd === "record") record();
  else if (cmd === "baseline") baseline();
  else if (cmd === "violations") violations();
  else throw new Error("команда: plan | record | baseline | violations");
} catch (e) {
  console.error(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

function plan() {
  const kind = str("kind");
  if (kind !== "nightly" && kind !== "full") throw new Error("--kind: nightly или full");
  const now = str("date") ? new Date(`${str("date")}T12:00:00Z`) : new Date();
  const all = loadBriefs();
  const briefs = kind === "nightly" ? nightlyBriefs(all, now) : all;
  // nightly: one model — the registry's default build model (empty = harness default); full: two models.
  const models = str("models")?.split(",").filter(Boolean) ?? (kind === "full" ? FULL_MODELS : []);
  const pairs = briefs.length * Math.max(1, models.length);
  const entries = mergeEntries(loadLedger(str("ledger")).entries, resultsEntries(join(HERE, "results")));
  const d = decide({ kind, pairs, entries, now });
  const out = {
    run: String(d.run),
    reason: d.reason,
    briefs: briefs.map((b) => b.id).join(","),
    models: models.join(","),
    pairs: String(pairs),
    forecast_rub: String(d.forecast),
    spent_rub: String(d.spent),
    reserve_rub: String(d.reserve),
    max_cost_rub: String(d.maxCostRub),
    month: d.month,
  };
  const lines = Object.entries(out).map(([k, v]) => `${k}=${String(v).replace(/\n/g, " ")}`);
  if (str("github-output")) appendFileSync(str("github-output"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

function record() {
  const ledgerFile = str("ledger");
  if (!ledgerFile) throw new Error("--ledger обязателен");
  const kind = str("kind") ?? "manual";
  const meta = { kind, runUrl: str("run-url"), commit: str("commit") };
  const results = readResults(str("result-dir"));
  let ledger = loadLedger(ledgerFile);
  for (const r of results) ledger = addEntry(ledger, entryFromResult(r, meta));
  if (!results.length)
    ledger = addEntry(
      ledger,
      estimatedEntry(new Date(), {
        ...meta,
        pairs: Number(str("pairs") ?? 0),
        forecastRub: Number(str("forecast-rub") ?? 0),
      }),
    );
  mkdirSync(dirname(ledgerFile), { recursive: true });
  writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
  const last = ledger.entries.at(-1);
  console.log(
    `Журнал бюджета: ${ledger.entries.length} записей; последняя ${last.date} ${last.kind} ${last.cost_rub} ₽${last.estimated ? " (по прогнозу: результата нет)" : ""}`,
  );
}

function baseline() {
  const file = str("result");
  if (!file) throw new Error("--result=<results/…json> обязателен");
  const result = JSON.parse(readFileSync(file, "utf8"));
  if (result.dry_run) throw new Error("DRY-RUN не может быть baseline");
  const target = str("baseline") ?? BASELINE_FILE;
  const entries = baselineEntries(result, loadBriefs(), { commit: str("commit") });
  updateBaseline(loadBaseline(target), entries, target);
  for (const e of entries)
    console.log(
      `baseline: ${e.mode} ${e.modelId} ${e.briefSetHash} g0=${e.metrics.g0_pass} g0g1=${e.metrics.g0g1_pass}`,
    );
}

function violations() {
  for (const r of readResults(str("result-dir"))) for (const v of r.violations ?? []) console.log(`- ${v}`);
}

function readResults(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .filter((r) => Array.isArray(r?.runs) && r.started_at);
}
