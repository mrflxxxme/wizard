#!/usr/bin/env node
// D67 measurement on the pilot server (docs/ops/eval-d67.md). Node 22, no dependencies. The GitHub action
// `bootstrap-pilot → eval` (tools/deploy/pilot.mjs) runs the same steps; by hand:
//   node tools/eval/server/cli.mjs seed --session-file s.json [--runid id] [--max-cost-rub 2000] > seed.sql
//        → psql on the platform database < seed.sql > seed.out   (the raw token stays in s.json, mode 0600)
//   node tools/eval/server/cli.mjs run --base https://borntobuild.ru --session-file s.json --seed-output seed.out \
//        [--briefs all|mvp-01-…,…] [--max-cost-rub 2000] [--concurrency 2] [--g2 publish|skip] [--out results.json]
//   node tools/eval/server/cli.mjs collect --seed-output seed.out > collect.sql → psql < collect.sql > collect.out
//   node tools/eval/server/cli.mjs report --results results.json [--collect collect.out] [--out report.md]
//   node tools/eval/server/cli.mjs cleanup --session-file s.json [--base URL] > revoke.sql (logout + revoke SQL)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadBriefs } from "../lib/briefs.mjs";
import { platformClient } from "./client.mjs";
import { DEFAULTS, runEval } from "./driver.mjs";
import { renderReport } from "./report.mjs";
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

export const COMMANDS = ["seed", "run", "collect", "report", "cleanup"];

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

/** Briefs of the measurement: "all" (default) — the ten mvp-*; otherwise ids, a short id «mvp-03» is enough. */
export function selectBriefs(want = "all") {
  const all = loadBriefs("mvp");
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
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { command, o } = parseArgs(argv);
  const out = deps.stdout ?? ((s) => process.stdout.write(s));
  const log = deps.log ?? ((s) => console.error(s));
  if (command === "seed") {
    if (!o["session-file"]) throw new Error("--session-file: куда сохранить токен сессии (0600)");
    const runid = o.runid || newRunId();
    const session = newEvalSession();
    const { email } = evalIdentity(runid, o.domain || undefined);
    const credits = o.credits ? num(o.credits, "credits") : evalCredits(num(o["max-cost-rub"], "max-cost-rub", 2000));
    writeFileSync(o["session-file"], JSON.stringify({ runid, email, ...session }), { mode: 0o600 });
    out(seedSql({ runid, domain: o.domain || undefined, tokenHash: session.tokenHash, csrfHash: session.csrfHash, credits }));
    log(`учётка замера ${email}: ${credits} кредитов; токен — в ${o["session-file"]}`);
    return 0;
  }
  if (command === "collect") {
    const seed = parseSeedOutput(readFileSync(o["seed-output"], "utf8"));
    out(collectSql({ orgId: seed.orgId }));
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
    const doc = await runEval({
      client,
      briefs: selectBriefs(o.briefs),
      orgId: o["org-id"] || seed.orgId,
      ownerEmail: s.email,
      runId: s.runid,
      maxCostRub: num(o["max-cost-rub"], "max-cost-rub", DEFAULTS.maxCostRub),
      concurrency: num(o.concurrency, "concurrency", DEFAULTS.concurrency),
      fixAttempts: o["fix-attempts"] === "0" ? 0 : num(o["fix-attempts"], "fix-attempts", DEFAULTS.fixAttempts),
      g2: o.g2 === "skip" ? "skip" : "publish",
      log,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.pollMs ? { pollMs: deps.pollMs } : {}),
    });
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    if (o.out) writeFileSync(o.out, text);
    else out(text);
    return 0;
  }
  // report
  const doc = readJson(o.results);
  const db = o.collect ? parseCollectOutput(readFileSync(o.collect, "utf8")) : {};
  const { text, summary } = renderReport(doc, db);
  if (o.out) writeFileSync(o.out, text);
  else out(text);
  return summary.passed ? 0 : 1;
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
