#!/usr/bin/env node
// D67 measurement on the pilot server (docs/ops/eval-d67.md). Node 22, no dependencies. The GitHub action
// `bootstrap-pilot → eval` (tools/deploy/pilot.mjs) runs the same steps; by hand:
//   node tools/eval/server/cli.mjs seed --session-file s.json [--runid id] [--max-cost-rub 2000] [--threshold d76] > seed.sql
//        → psql on the platform database < seed.sql > seed.out   (the raw token stays in s.json, mode 0600)
//   node tools/eval/server/cli.mjs run --base https://borntobuild.ru --session-file s.json --seed-output seed.out \
//        [--briefs all|mvp-01-…,…] [--max-cost-rub 2000] [--concurrency 2] [--g2 publish|skip] [--out results.json]
//        [--threshold d67|d76|v3]   (d76 — strict threshold of beta v2: plan coverage, goal scenarios, 390 px;
//        v3 — V3-18: the v3 briefs v3-* through the v3 path, the checkpoint report v3-a-checkpoint1-<date>)
//        [--screenshots DIR]     (PNGs of each system at 390 and 1280 px for the report grid; Chromium of packages/e2e)
//   node tools/eval/server/cli.mjs collect --seed-output seed.out [--b2-since 2026-10-07] [--threshold v3] > collect.sql
//        → psql < collect.sql > collect.out   (--b2-since: spend of the beta v2 development budget since that day)
//   node tools/eval/server/cli.mjs report --results results.json [--collect collect.out] [--out report.md]
//        [--b2-budget-rub 1000]
//   node tools/eval/server/cli.mjs cleanup --session-file s.json [--base URL] > revoke.sql (logout + revoke SQL)
// V3-40: --threshold v3-final — the final measurement (12 briefs v3-*, screenshots at 390 and 1440 px, collect with the
// site fingerprints); its report by the exit criteria of the plan §6 from the run(s) and the blind comparison:
//   node tools/eval/server/cli.mjs final --results run.json[,retry.json] [--collect c.out[,retry.out]] [--pay v3-pay.json]
//        [--blind blind-summary.json] [--spend docs/progress/v3-spend.json] [--shots-base v3-final-<date>]
//        [--date yyyy-mm-dd] [--out docs/progress/v3-final-<date>.md]
//        (a results file of pilot.mjs carries its collect as `db`; exit 0 — every criterion met, 1 — not met or pending)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readJournal } from "../../deploy/spend.mjs";
import { measureDiversity } from "../blind/diversity.mjs";
import { loadBriefs } from "../lib/briefs.mjs";
import { platformClient } from "./client.mjs";
import { D76_MAX_COST_RUB, DEFAULTS, isV3Threshold, runEval, THRESHOLDS } from "./driver.mjs";
import { photosAnnotation, renderReport } from "./report.mjs";
import { launchChromium, previewScreenshots, V3_FINAL_VIEWPORTS } from "./screenshots.mjs";
import { applyPayProbe } from "./pay-probe.mjs";
import { runV3Eval } from "./v3.mjs";
import { kassaFromEnv } from "./v3-pay.mjs";
import { mergeRuns, renderV3Final } from "./v3-final.mjs";
import { renderV3Report } from "./v3-report.mjs";
import {
  collectSql,
  evalCredits,
  evalIdentity,
  newEvalSession,
  newRunId,
  parseCollectOutput,
  parseSeedOutput,
  revokeSql,
  seedSql,
} from "./seed.mjs";

export const COMMANDS = ["seed", "run", "collect", "report", "cleanup", "final"];

export function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  const o = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`неизвестный аргумент ${a}`);
    const eq = a.indexOf("=");
    if (eq > 0) o[a.slice(2, eq)] = a.slice(eq + 1);
    else o[a.slice(2)] = rest[++i] ?? "";
  }
  if (!COMMANDS.includes(command)) throw new Error(`команда: ${COMMANDS.join(" | ")}`);
  return { command, o };
}

/**
 * Briefs of the measurement: "all" (default) — the ten mvp-* (V3-18: under the v3 threshold — the v3-* briefs);
 * otherwise ids, a short id «mvp-03» / «v3-02» is enough.
 */
export function selectBriefs(want = "all", set = "mvp") {
  const all = loadBriefs(set);
  if (!want || want === "all") return all;
  const ids = String(want)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const id of ids) {
    const b = all.find((x) => x.id === id || x.id.startsWith(`${id}-`));
    if (!b) throw new Error(`неизвестный бриф замера: ${id}`);
    if (!out.includes(b)) out.push(b);
  }
  return out;
}

const num = (v, name, def) => {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name}: положительное число`);
  return n;
};
const threshold = (v) => {
  if (v === undefined || v === "") return DEFAULTS.threshold;
  if (!THRESHOLDS.includes(v)) throw new Error(`--threshold: ${THRESHOLDS.join(" | ")}`);
  return v;
};
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { command, o } = parseArgs(argv);
  const out = deps.stdout ?? ((s) => process.stdout.write(s));
  const log = deps.log ?? ((s) => console.error(s));
  if (command === "seed") {
    if (!o["session-file"]) throw new Error("--session-file: куда сохранить токен сессии (0600)");
    const runid = o.runid || newRunId();
    const session = newEvalSession();
    const label = { d76: "D76", v3: "V3", "v3-final": "V3" }[threshold(o.threshold)] ?? "D67";
    const { email } = evalIdentity(runid, o.domain || undefined, label);
    const credits = o.credits
      ? num(o.credits, "credits")
      : evalCredits(num(o["max-cost-rub"], "max-cost-rub", 2000));
    writeFileSync(o["session-file"], JSON.stringify({ runid, email, ...session }), { mode: 0o600 });
    out(
      seedSql({
        runid,
        domain: o.domain || undefined,
        tokenHash: session.tokenHash,
        csrfHash: session.csrfHash,
        credits,
        label,
      }),
    );
    log(`учётка замера ${email}: ${credits} кредитов; токен — в ${o["session-file"]}`);
    return 0;
  }
  if (command === "collect") {
    const seed = parseSeedOutput(readFileSync(o["seed-output"], "utf8"));
    out(
      collectSql({
        orgId: seed.orgId,
        ...(o["b2-since"] ? { b2Since: o["b2-since"] } : {}),
        ...(isV3Threshold(threshold(o.threshold)) ? { v3: true } : {}),
        ...(threshold(o.threshold) === "v3-final" ? { fingerprints: true } : {}),
      }),
    );
    return 0;
  }
  if (command === "cleanup") {
    const s = readJson(o["session-file"]);
    if (o.base) {
      const client = platformClient({ base: o.base, session: s, fetch: deps.fetch });
      await client.post("/auth/logout").catch((e) => log(`выход по API не удался: ${e.message}`));
    }
    out(revokeSql({ tokenHash: s.tokenHash }));
    return 0;
  }
  if (command === "run") {
    if (!o.base) throw new Error("--base: адрес платформы, например https://borntobuild.ru");
    const s = readJson(o["session-file"]);
    const seed = o["seed-output"] ? parseSeedOutput(readFileSync(o["seed-output"], "utf8")) : {};
    const client = platformClient({ base: o.base, session: s, fetch: deps.fetch });
    const final = threshold(o.threshold) === "v3-final";
    const shots = o.screenshots
      ? previewScreenshots({
          client,
          dir: o.screenshots,
          log,
          ...(final ? { viewports: V3_FINAL_VIEWPORTS } : {}),
          ...(deps.launch ? { launch: deps.launch } : {}),
        })
      : null;
    const v3 = isV3Threshold(threshold(o.threshold));
    const doc = await (v3 ? runV3Eval : runEval)({
      client,
      briefs: selectBriefs(o.briefs, final ? "v3-final" : v3 ? "v3" : "mvp"),
      orgId: o["org-id"] || seed.orgId,
      ownerEmail: s.email,
      runId: s.runid,
      maxCostRub: num(
        o["max-cost-rub"],
        "max-cost-rub",
        threshold(o.threshold) === "d76" ? D76_MAX_COST_RUB : DEFAULTS.maxCostRub,
      ),
      concurrency: num(o.concurrency, "concurrency", DEFAULTS.concurrency),
      fixAttempts:
        o["fix-attempts"] === "0" ? 0 : num(o["fix-attempts"], "fix-attempts", DEFAULTS.fixAttempts),
      g2: o.g2 === "skip" ? "skip" : "publish",
      threshold: threshold(o.threshold),
      log,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.pollMs ? { pollMs: deps.pollMs } : {}),
      ...(shots ? { screenshot: shots.screenshot } : {}),
      // V3-23: the founder's ЮKassa test shop (env of the eval step) and Chromium for the purchase on the preview.
      ...(v3 ? { kassa: kassaFromEnv(deps.env ?? process.env), launch: deps.launch ?? launchChromium } : {}),
      ...(v3 && o.screenshots ? { kassaShots: o.screenshots } : {}),
    }).finally(() => shots?.close());
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    if (o.out) writeFileSync(o.out, text);
    else out(text);
    return 0;
  }
  if (command === "final") return finalReport(o, { out, log, ...deps });
  // report
  const doc = readJson(o.results);
  const db = o.collect ? parseCollectOutput(readFileSync(o.collect, "utf8")) : {};
  if (doc.kind === "v3" || isV3Threshold(doc.threshold)) {
    const { text, summary } = renderV3Report(doc, db);
    if (o.out) writeFileSync(o.out, text);
    else out(text);
    return summary.passed ? 0 : 1;
  }
  const { text, summary } = renderReport(doc, db, {
    ...(o["b2-budget-rub"] ? { b2BudgetRub: num(o["b2-budget-rub"], "b2-budget-rub") } : {}),
  });
  if (o.out) writeFileSync(o.out, text);
  else out(text);
  const photos = photosAnnotation(summary);
  if (photos) log(photos);
  return summary.passed ? 0 : 1;
}

const list = (v) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * V3-40 `final`: the report of the final measurement by §6 from the run(s) (the first and the retries), their collect,
 * the spend journal, the blind comparison and the diversity (the template gate's metric, through tsx). `deps.metric`
 * replaces the loaded metric (tests).
 */
async function finalReport(o, { out, log, metric = null, now = () => new Date() }) {
  const files = list(o.results);
  if (!files.length) throw new Error("--results: файлы прогонов финального замера через запятую");
  const collects = list(o.collect);
  const runs = files.map((file, i) => {
    const { db: own, ...doc } = readJson(file);
    if (doc.threshold !== "v3-final") log(`внимание: ${file} — прогон с порогом ${doc.threshold ?? "—"}, не v3-final`);
    const db = collects[i] ? parseCollectOutput(readFileSync(collects[i], "utf8")) : (own ?? {});
    return { doc, db };
  });
  const { doc, db, attempts } = mergeRuns(runs);
  // V3-40: the payment check of the same shops after a fix of the measurement's own automation (v3-probe --pay).
  for (const file of list(o.pay)) {
    const probe = readJson(file);
    if (probe.kind !== "wizard-v3-pay-probe") throw new Error("--pay: итог пробы оплаты v3-pay-….json");
    doc.results = applyPayProbe(doc.results, probe.results, { runid: probe.runid, g2: doc.g2 ?? "publish" });
  }
  let journal = null;
  try {
    journal = readJournal(o.spend || undefined);
  } catch (e) {
    log(`журнал трат: ${e.message}`);
  }
  const blind = o.blind ? readJson(o.blind) : null;
  if (blind && blind.kind !== "wizard-blind-summary")
    throw new Error("--blind: итог tools/eval/blind/cli.mjs aggregate --out …");
  const diversity = await measureDiversity(doc.results, db, metric ? { metric } : {});
  if (diversity.status !== "done") log(`разнообразие не посчитано: ${diversity.why}`);
  const date = o.date || now().toISOString().slice(0, 10);
  const { text, summary } = renderV3Final(
    { doc, db, journal, blind, diversity, attempts },
    { date, ...(o["shots-base"] ? { shotsBase: o["shots-base"] } : {}) },
  );
  if (o.out) writeFileSync(o.out, text);
  else out(text);
  return summary.verdict === "passed" ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`ошибка: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
