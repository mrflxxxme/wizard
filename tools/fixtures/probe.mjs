#!/usr/bin/env node
// V4-03 stage probe: `node tools/fixtures/probe.mjs --stage=<stage> [--inputs=a,b] [--model=<id>] [--cap-rub=15]`
// (tools/fixtures/probe/run.ts through tsx; needs provider keys in the environment — the stage-probe workflow has them).
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..", "..");
let loader;
for (const base of [import.meta.url, pathToFileURL(join(ROOT, "packages", "e2e", "package.json")).href]) {
  try {
    loader = createRequire(base).resolve("tsx");
    break;
  } catch {}
}
if (!loader) {
  console.error("не найден tsx: выполните pnpm install");
  process.exit(2);
}
const { register } = await import(pathToFileURL(join(dirname(loader), "esm", "api", "index.mjs")).href);
register();
const { probeCli } = await import(pathToFileURL(join(import.meta.dirname, "probe", "run.ts")).href);
// A long model call (Kimi K3, 150 s and more) leaves no referenced handle in the loop at times: Node then exits mid-await
// («unsettled top-level await», exit 13 — stage-probe on task/V4-07, 13.10.2026). A timer keeps the process up.
const keep = setInterval(() => {}, 60_000);
try {
  process.exitCode = await probeCli(process.argv.slice(2));
} finally {
  clearInterval(keep);
}
