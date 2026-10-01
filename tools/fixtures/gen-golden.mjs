#!/usr/bin/env node
// Writes tools/fixtures/demo/<name>.jsonl from tools/fixtures/golden/<name>.yaml (specs/quality/eval.yaml#fixtures.golden),
// and demo/<name>.point_edit.jsonl when the golden has a point_edit section (M3-01).
// Usage: node tools/fixtures/gen-golden.mjs <name> [--out=<file>] [--check]
//   --check: do not write; exit 1 if a committed fixture differs from a fresh generation.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildGolden } from "./lib/golden.mjs";

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
if (!name || !/^[a-z0-9-]+$/.test(name)) {
  console.error("Использование: node tools/fixtures/gen-golden.mjs <name> [--out=<file>] [--check]");
  process.exit(2);
}
const root = resolve(import.meta.dirname, "..", "..");
const outArg = args.find((a) => a.startsWith("--out="));
const out = outArg ? resolve(outArg.slice(6)) : join(root, "tools/fixtures/demo", `${name}.jsonl`);

const { text, lines, pointEdit } = buildGolden(name, { root });
const outputs = [{ out, text, lines }];
if (pointEdit)
  outputs.push({ out: out.replace(/(\.jsonl)?$/, ".point_edit.jsonl"), text: pointEdit.text, lines: pointEdit.lines });

let stale = false;
for (const o of outputs) {
  if (args.includes("--check")) {
    const same = existsSync(o.out) && readFileSync(o.out, "utf8") === o.text;
    if (!same) {
      console.error(`${o.out} устарел: запустите node tools/fixtures/gen-golden.mjs ${name}`);
      stale = true;
    } else console.log(`${o.out}: актуален (${o.lines.length} вызовов)`);
  } else {
    mkdirSync(dirname(o.out), { recursive: true });
    writeFileSync(o.out, o.text);
    const order = o.lines.map((l) => l.callType).join(", ");
    console.log(`${o.out}: ${o.lines.length} вызовов — ${order}`);
  }
}
if (stale) process.exit(1);
