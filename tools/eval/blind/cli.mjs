#!/usr/bin/env node
// V3-40: the blind comparison of the final v3 measurement (docs/ops/eval-pilot.md «Финальный замер v3»). Node 22, no
// dependencies, no network.
//   node tools/eval/blind/cli.mjs build --shots <artifact>/shots --competitor <dir> --out <dir> [--seed v3-40]
//        [--briefs all|v3-01,…] [--no-controls]
//        → <out>/index.html + <out>/img/ (the folder for the raters) and <out>-key.json (the key: never to the raters)
//   node tools/eval/blind/cli.mjs aggregate --key <out>-key.json --votes <folder of the raters' files | files,…>
//        [--out blind-summary.json]   (exit 0 — Wizard ≥ 70 % with enough raters and no «one template» of Wizard)
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBriefs } from "../lib/briefs.mjs";
import { aggregateVotes, blindLines } from "./aggregate.mjs";
import { blindLayout, collectSites, voteFiles } from "./layout.mjs";
import { renderBlindPage } from "./page.mjs";

export const COMMANDS = ["build", "aggregate"];
/** The seed of the final measurement's page unless another is given (the order of the pairs is fixed by it). */
export const DEFAULT_SEED = "v3-40";

export function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  const o = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`неизвестный аргумент ${a}`);
    const eq = a.indexOf("=");
    if (eq > 0) o[a.slice(2, eq)] = a.slice(eq + 1);
    else if (a === "--no-controls") o["no-controls"] = true;
    else o[a.slice(2)] = rest[++i] ?? "";
  }
  if (!COMMANDS.includes(command)) throw new Error(`команда: ${COMMANDS.join(" | ")}`);
  return { command, o };
}

/** The briefs of the page: the final set, or ids (short v3-02 is enough). */
export function pickBriefs(want = "all") {
  const all = loadBriefs("v3-final");
  if (!want || want === "all") return all;
  return String(want)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => {
      const b = all.find((x) => x.id === id || x.id.startsWith(`${id}-`));
      if (!b) throw new Error(`неизвестный бриф: ${id}`);
      return b;
    });
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { command, o } = parseArgs(argv);
  const log = deps.log ?? ((s) => console.error(s));
  const out = deps.stdout ?? ((s) => process.stdout.write(s));
  if (command === "build") {
    if (!o.shots || !o.competitor || !o.out)
      throw new Error("нужны --shots (снимки Wizard), --competitor (снимки конкурента) и --out (папка страницы)");
    const { sites, warnings } = collectSites({
      briefs: pickBriefs(o.briefs),
      wizardDir: o.shots,
      competitorDir: o.competitor,
    });
    const layout = blindLayout({ sites, seed: o.seed || DEFAULT_SEED, controls: !o["no-controls"] });
    if (layout.pairs.length === 0) throw new Error("ни одной пары: нет снимков Wizard и конкурента по одним брифам");
    const dir = resolve(o.out);
    mkdirSync(join(dir, "img"), { recursive: true });
    for (const f of layout.files) copyFileSync(f.from, join(dir, f.name));
    writeFileSync(join(dir, "index.html"), renderBlindPage(layout));
    const keyFile = `${dir.replace(/[\\/]+$/, "")}-key.json`;
    writeFileSync(keyFile, `${JSON.stringify(layout.key, null, 2)}\n`);
    const kinds = (k) => layout.key.pairs.filter((p) => p.kind === k).length;
    for (const w of warnings) log(`внимание: ${w}`);
    log(
      `страница ${join(dir, "index.html")}: пар ${layout.pairs.length} (Wizard — конкурент ${kinds("wc")}, Wizard — Wizard ${kinds("ww")}, конкурент — конкурент ${kinds("cc")}), seed «${layout.seed}», страница ${layout.layoutId}`,
    );
    log(`ключ ${keyFile} — оценщикам не отправлять; оценщикам — папка ${dir} целиком (index.html и img/)`);
    return 0;
  }
  // aggregate
  if (!o.key || !o.votes) throw new Error("нужны --key (ключ страницы) и --votes (папка или файлы ответов)");
  const key = JSON.parse(readFileSync(o.key, "utf8"));
  const files = voteFiles(String(o.votes).split(",").filter(Boolean)).map((name) => {
    try {
      return { name, data: JSON.parse(readFileSync(name, "utf8")) };
    } catch (e) {
      return { name, data: null, error: e };
    }
  });
  const summary = aggregateVotes(key, files);
  if (o.out) writeFileSync(o.out, `${JSON.stringify(summary, null, 2)}\n`);
  out(`${["## Слепое сравнение", "", ...blindLines(summary)].join("\n")}\n`);
  return summary.passed.blind && summary.passed.template ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`ошибка: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
