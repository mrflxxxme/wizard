#!/usr/bin/env node
// V5-02: retakes the poehali.dev snapshots of references.json (first screen at 1440×900 and 390×844, PNG) into
// tools/fixtures/eval/v5/refs/<id>/. Only snapshots: no code, no texts are stored (GZ-03). Needs network and Chromium.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shootSites } from "../blind/shoot.mjs";
import { launchChromium } from "../server/screenshots.mjs";
import { REFS_DIR, loadRefs } from "./lib.mjs";

export async function main(log = (s) => console.error(s)) {
  const sites = loadRefs().filter((r) => r.demo).map((r) => ({ brief: r.id, url: r.demo }));
  const r = await shootSites({ sites, service: "poehali.dev", out: REFS_DIR, launch: launchChromium, log });
  log(`снято ${r.shot.length} из ${sites.length}`);
  return r.failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c), (e) => (console.error(String(e?.message ?? e)), process.exit(2)));
}
