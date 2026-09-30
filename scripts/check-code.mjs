// CI code checks (M0-27): PgBouncer-unsafe SQL (L3-21, security/isolation.yaml#db_access)
// and FSL/Convex-licensed sources (L3-40). Suppress a single hit with `wizard-allow-sql` on the same or previous line.
// Usage: node scripts/check-code.mjs [--root=DIR]
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const rootArg = process.argv.find((a) => a.startsWith("--root="));
const root = resolve(rootArg ? rootArg.slice(7) : join(import.meta.dirname, ".."));
const DIRS = ["packages", "apps", "scripts", "tools"];
const SKIP = new Set(["node_modules", "dist", ".data", ".git", "test-results", "playwright-report"]);
const EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sql)$/;
const ALLOW = "wizard-allow-sql";

const GUC_LOWER =
  "search_path|statement_timeout|lock_timeout|idle_in_transaction_session_timeout|role|session_authorization|application_name|work_mem|timezone|client_encoding|default_transaction_isolation|row_security";
const GUC = `${GUC_LOWER}|${GUC_LOWER.toUpperCase()}`;
const sqlRules = [
  {
    id: "set-without-local",
    re: new RegExp(
      `\\bSET\\s+(?:SESSION\\b|ROLE\\s+(?!=)|TIME\\s+ZONE\\b|(?:${GUC})\\s*(?:=|TO\\b)|[A-Za-z_]\\w*\\.[A-Za-z_]\\w*\\s*(?:=|TO\\b)|[A-Za-z_]\\w*\\s+TO\\b)`,
    ),
    msg: "SET без LOCAL — используйте SET LOCAL или set_config(…, true) в транзакции",
  },
  {
    id: "set-config-session",
    re: /\bset_config\s*\([^)]*,\s*false\s*\)/i,
    msg: "set_config(…, false) — только set_config(…, true)",
  },
  {
    id: "session-advisory-lock",
    re: /\bpg_(?:try_)?advisory_(?:lock|unlock)(?:_shared|_all)?\s*\(/i,
    msg: "сессионный advisory lock — только pg_advisory_xact_lock",
  },
  {
    id: "listen",
    re: /\bLISTEN\s+["A-Za-z_]|\.listen\s*\(\s*["'`]/,
    msg: "LISTEN несовместим с PgBouncer в режиме transaction",
  },
];
const licenseRules = [
  { id: "fsl-license", re: /FSL-1\.1/, msg: "код под лицензией FSL-1.1 запрещён" },
  {
    id: "convex-copyright",
    re: /Copyright[^\n]{0,40}Convex,? Inc/i,
    msg: "копирайт Convex Inc. — код get-convex/convex-backend копировать нельзя",
  },
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (EXT.test(e.name)) yield p;
  }
}

const hits = [];
for (const d of DIRS) {
  for (const file of walk(join(root, d))) {
    if (file === import.meta.filename) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const allowed = line.includes(ALLOW) || lines[i - 1]?.includes(ALLOW);
      for (const r of [...(allowed ? [] : sqlRules), ...licenseRules]) {
        if (r.re.test(line)) hits.push(`${relative(root, file)}:${i + 1} [${r.id}] ${r.msg}`);
      }
    });
  }
}

if (hits.length) {
  console.error(hits.join("\n"));
  console.error(`check-code: нарушений — ${hits.length}`);
  process.exit(1);
}
console.log("check-code: ok");
