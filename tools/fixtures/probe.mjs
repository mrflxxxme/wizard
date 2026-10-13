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
// The router's retry pauses never keep a process alive (unref'd timers): the probe keeps itself alive until it is done.
const alive = setInterval(() => {}, 60_000);
try {
  process.exitCode = await probeCli(process.argv.slice(2));
} finally {
  clearInterval(alive);
}
