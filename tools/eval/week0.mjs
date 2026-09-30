#!/usr/bin/env node
// Week-0 report and recommended build tier (M0-30) from tools/eval/run.mjs results.
// Usage: node tools/eval/week0.mjs <results.json> [more.json…] [--out=tools/eval/results/week0.md] [--t1=glm-5.3]
//   [--zai-terms=confirmed|unconfirmed] [--threshold=10]
// Prints the report and, as the last line, WIZARD_BUILD_DEFAULT_TIER=<T0|T1>.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decideWeek0, renderWeek0Report, THRESHOLD_PP } from "./lib/week0.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flags = Object.fromEntries(
  argv
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? true];
    }),
);
const files = argv.filter((a) => !a.startsWith("--"));

function fail(msg) {
  console.error(`Ошибка: ${msg}`);
  process.exit(1);
}

if (!files.length) fail("укажите файл(ы) результатов tools/eval/run.mjs (JSON)");
const terms = flags["zai-terms"];
if (terms !== undefined && terms !== "confirmed" && terms !== "unconfirmed")
  fail("--zai-terms: confirmed | unconfirmed");
const threshold = flags.threshold === undefined ? THRESHOLD_PP : Number(flags.threshold);
if (!Number.isFinite(threshold) || threshold < 0) fail("--threshold: число п. п. ≥ 0");

let results;
try {
  results = await Promise.all(files.map(async (f) => JSON.parse(await readFile(resolve(f), "utf8"))));
} catch (e) {
  fail(`не удалось прочитать результаты: ${e.message}`);
}

let decision;
try {
  decision = decideWeek0(results, {
    thresholdPp: threshold,
    ...(typeof flags.t1 === "string" ? { t1Model: flags.t1 } : {}),
    ...(terms ? { zaiTermsConfirmed: terms === "confirmed" } : {}),
  });
} catch (e) {
  fail(e.message);
}

const report = renderWeek0Report(decision);
const out = resolve(typeof flags.out === "string" ? flags.out : join(HERE, "results", "week0.md"));
await mkdir(dirname(out), { recursive: true });
await writeFile(out, report);
console.log(report);
console.log(`Отчёт: ${out}`);
if (decision.dryRun) console.log("DRY-RUN: решение не применять");
console.log(`WIZARD_BUILD_DEFAULT_TIER=${decision.tier}`);
