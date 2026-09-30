#!/usr/bin/env node
// Writes tools/fixtures/demo/<name>.jsonl from tools/fixtures/golden/<name>.yaml (specs/quality/eval.yaml#fixtures.golden).
// Usage: node tools/fixtures/gen-golden.mjs <name> [--out=<file>] [--check]
//   --check: do not write; exit 1 if the committed fixture differs from a fresh generation.
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

const { text, lines } = buildGolden(name, { root });

if (args.includes("--check")) {
  const same = existsSync(out) && readFileSync(out, "utf8") === text;
  if (!same) {
    console.error(`${out} устарел: запустите node tools/fixtures/gen-golden.mjs ${name}`);
    process.exit(1);
  }
  console.log(`${out}: актуален (${lines.length} вызовов)`);
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  const order = lines.map((l) => l.callType).join(", ");
  console.log(`${out}: ${lines.length} вызовов — ${order}`);
}
