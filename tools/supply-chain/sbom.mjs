#!/usr/bin/env node
// CycloneDX 1.5 SBOM of the workspace dependency tree (platform/deploy.yaml#cloud.ci_cd, L3-38).
// Usage: node tools/supply-chain/sbom.mjs [--out sbom.cdx.json]  (stdout without --out)
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cyclonedx, pnpmLicenses, ROOT } from "./lib.mjs";

const i = process.argv.indexOf("--out");
const out = i > 0 ? process.argv[i + 1] : null;
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const bom = cyclonedx(pnpmLicenses(), pnpmLicenses({ prod: true }), {
  name: pkg.name,
  version: process.env.WIZARD_VERSION || pkg.version || "0.0.0",
  serial: `urn:uuid:${randomUUID()}`,
  timestamp: new Date().toISOString(),
});
const text = `${JSON.stringify(bom, null, 2)}\n`;
if (out) {
  writeFileSync(out, text);
  console.log(`sbom: ${bom.components.length} components -> ${out}`);
} else process.stdout.write(text);
