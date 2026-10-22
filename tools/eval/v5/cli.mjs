#!/usr/bin/env node
// V5-02: the evaluation stand.
//   node tools/eval/v5/cli.mjs run [--set full|slice] [--mode fixture|live] [--seed S] [--wizard-shots <dir>]
//        [--judges a,b,c] [--cap-rub N] [--out <dir>]
// fixture (default, no network): stub judges, a missing Wizard snapshot is a placeholder. live: the judges are real
// models through the router (tools/eval/v5/live-judge.ts; keys in the environment; the cap is at most 1 500 ₽).
// --wizard-shots: <dir>/<brief id>/{1440,390}.png of the Wizard builds. Exit 0 once the report is written.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPairs, DEFAULT_CAP_RUB, DEFAULT_SEED, JUDGES, judgePairs, loadRefs, selectBriefs, summarize } from "./lib.mjs";
import { writeReport } from "./report.mjs";

export function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  if (command !== "run") throw new Error("команда: run");
  const o = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`неизвестный аргумент ${a}`);
    const eq = a.indexOf("=");
    if (eq > 0) o[a.slice(2, eq)] = a.slice(eq + 1);
    else o[a.slice(2)] = rest[++i] ?? "";
  }
  return o;
}

/** Fixture judge: a verdict from a hash of (model, brief text) — the same input gives the same answer; costs 0 ₽. */
export function fixtureJudge(model, input) {
  const h = createHash("sha256").update(model).update(input.text).digest()[0] % 5;
  const winner = h < 2 ? "A" : h < 4 ? "B" : "tie";
  return Promise.resolve({ text: JSON.stringify({ winner, reason: "заглушка fixture" }), costRub: 0 });
}

async function liveJudge(judges, capRub) {
  // tsx loads the TypeScript router the way tools/fixtures/probe.mjs does.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  let loader;
  for (const base of [import.meta.url, pathToFileURL(join(root, "packages", "e2e", "package.json")).href]) {
    try {
      loader = createRequire(base).resolve("tsx");
      break;
    } catch {}
  }
  if (!loader) throw new Error("не найден tsx: выполните pnpm install");
  const { register } = await import(pathToFileURL(join(dirname(loader), "esm", "api", "index.mjs")).href);
  register();
  const { createLiveJudge } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "live-judge.ts")).href);
  return createLiveJudge({ judges, capRub });
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const o = parseArgs(argv);
  const mode = o.mode ?? process.env.WIZARD_LLM_MODE ?? "fixture";
  if (!["fixture", "live"].includes(mode)) throw new Error("режим: fixture | live");
  const set = o.set ?? "full";
  const seed = o.seed ?? DEFAULT_SEED;
  const judges = o.judges ? o.judges.split(",").map((s) => s.trim()) : JUDGES;
  const capRub = Number(o["cap-rub"] ?? DEFAULT_CAP_RUB);
  const out = resolve(o.out ?? join("tools", "eval", "results", `v5-${set}-${mode}`));
  const log = deps.log ?? ((s) => console.error(s));
  const pairs = buildPairs({
    briefs: selectBriefs(set),
    refs: loadRefs(),
    seed,
    wizardDir: o["wizard-shots"] ? resolve(o["wizard-shots"]) : undefined,
    placeholders: mode === "fixture",
  });
  const judge = deps.judge ?? (mode === "live" ? await liveJudge(judges, capRub) : fixtureJudge);
  const run = await judgePairs({ pairs, judges, judge, capRub });
  const summary = summarize({ ...run, mode, seed, set, judges });
  writeReport(out, summary, run.pairs);
  log(`доля «не хуже эталона»: ${summary.share === null ? "—" : `${Math.round(summary.share * 100)} %`} (${summary.notWorse} из ${summary.judged}); стоимость ${summary.costRub} ₽; отчёт: ${out}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(`ошибка: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
