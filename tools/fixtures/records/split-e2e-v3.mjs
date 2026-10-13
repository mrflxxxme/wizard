#!/usr/bin/env node
// V4-19: splits a whole-run e2e v3 record file (tools/fixtures/records/e2e-v3.jsonl) into the stage books
// tools/fixtures/records/e2e-v3/<callType>.jsonl and removes it — the one-off migration, kept for a branch that still
// carries the old file after a merge.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname);
const src = join(dir, "e2e-v3.jsonl");
if (!existsSync(src)) {
  console.log("нет e2e-v3.jsonl — делить нечего");
  process.exit(0);
}
const by = new Map();
for (const l of readFileSync(src, "utf8").split("\n").filter((x) => x.trim())) {
  const ct = JSON.parse(l).callType;
  by.set(ct, [...(by.get(ct) ?? []), l]);
}
mkdirSync(join(dir, "e2e-v3"), { recursive: true });
for (const [ct, lines] of by) writeFileSync(join(dir, "e2e-v3", `${ct}.jsonl`), `${lines.join("\n")}\n`);
rmSync(src);
console.log(`разложено по этапам: ${[...by.keys()].join(", ")}`);
