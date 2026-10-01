#!/usr/bin/env node
// License check of the whole dependency tree against AGENTS.md (policy.json; L3-38). Exit 1 on any violation.
// Usage: node tools/supply-chain/licenses.mjs [--json]
import { checkTree, POLICY, pnpmLicenses } from "./lib.mjs";

const all = pnpmLicenses();
const prod = pnpmLicenses({ prod: true });
const { checked, violations } = checkTree(all, prod, POLICY);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ checked, prod: prod.length, violations }, null, 2));
} else {
  console.log(`license check: ${checked} packages (${prod.length} in the production tree)`);
  for (const v of violations) {
    console.log(`  x ${v.name}@${v.version} [${v.scope}] ${v.license ?? "no license"}: ${v.reason}`);
  }
  for (const [name, why] of Object.entries(POLICY.exceptions ?? {}))
    console.log(`  ! exception ${name}: ${why}`);
}
if (violations.length > 0) {
  console.error(
    `${violations.length} package(s) violate the license policy (AGENTS.md). Replace them or add a reviewed exception to tools/supply-chain/policy.json.`,
  );
  process.exit(1);
}
