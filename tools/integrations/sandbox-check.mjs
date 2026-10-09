// CLI of .github/workflows/integrations-sandbox.yml (V3-22, acceptance 2): the API passports against the providers'
// test contours — apps/platform-api/src/integrations-v3/sandbox.ts (the platform's key-check path, then safe
// operations; no model calls). One GitHub annotation per step (::notice / ::warning / ::error), the table into
// $GITHUB_STEP_SUMMARY when it is set. Keys come only from the env (CDEK_TEST_ACCOUNT, CDEK_TEST_SECURE,
// YOOKASSA_TEST_SHOP_ID, YOOKASSA_TEST_SECRET_KEY) and never reach the output.
//   node tools/integrations/sandbox-check.mjs [--passports=all|cdek,yookassa] [--cdek-order] [--direct]
// The requests go directly (as the platform outside the cloud), or through HTTPS_PROXY when it is set (--direct ignores
// it). --cdek-order (or CDEK_ORDER=true): a test order in api.edu.cdek.ru, read back and deleted.
// Exit: 0 — no errors (a skipped passport is a warning), 1 — a mismatch, a failure or an unreachable host, 2 — usage.
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..", "..");
const TITLE = "Паспорта API · тестовые контуры";

function usage(message) {
  console.log(`::error title=${TITLE}::${message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
for (const a of args)
  if (!/^--(passports=.*|cdek-order|direct)$/.test(a))
    usage(`неизвестный аргумент ${a.slice(0, 40)}: есть --passports=, --cdek-order, --direct`);
const passportsArg = (args.find((a) => a.startsWith("--passports=")) ?? "--passports=all").slice(12);

// TypeScript of the platform through tsx (architecture.yaml#stack.dev_exec), as tools/eval/run.mjs does.
let loader;
for (const base of [
  import.meta.url,
  pathToFileURL(join(ROOT, "apps", "platform-api", "package.json")).href,
]) {
  try {
    loader = createRequire(base).resolve("tsx");
    break;
  } catch {}
}
if (!loader) usage("не найден tsx: выполните pnpm install");
const { register } = await import(pathToFileURL(join(dirname(loader), "esm", "api", "index.mjs")).href);
register();
const sandbox = await import(
  pathToFileURL(join(ROOT, "apps", "platform-api", "src", "integrations-v3", "sandbox.ts")).href
);

const picked = sandbox.parsePassports(passportsArg);
if (!picked.ok) usage(picked.error_ru);
const env = process.env;
const proxyUrl = args.includes("--direct") ? null : env.HTTPS_PROXY || env.https_proxy || null;
const report = await sandbox.runSandboxCheck({
  passports: picked.ids,
  env,
  net: { proxyUrl },
  cdekOrder: args.includes("--cdek-order") || env.CDEK_ORDER === "true",
  // A re-run keeps the run id: the attempt keeps the number of the test order unique.
  runId: env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || 1}` : undefined,
});
for (const line of sandbox.sandboxAnnotations(report)) console.log(line);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, sandbox.sandboxSummary(report));
process.exit(report.ok ? 0 : 1);
