import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..");
const CHECK = join(REPO, "scripts", "check-code.mjs");
// Fixtures are assembled from parts so this file itself passes the check.
const j = (...parts: string[]) => parts.join("");

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function check(files: Record<string, string>): { status: number | null; out: string } {
  const root = mkdtempSync(join(tmpdir(), "wizard-check-"));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const r = spawnSync(process.execPath, [CHECK, `--root=${root}`], { encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

const bad: [string, string][] = [
  ["set-without-local", j("await sql`SET", " search_path TO app_x`;")],
  ["set-without-local", j("SET", " app.user_id = '1';")],
  ["set-without-local", j("SET", " ROLE wizard_runtime;")],
  ["set-without-local", j("SET", " SESSION statement_timeout = 0;")],
  ["set-without-local", j("SET", " statement_timeout TO 1000;")],
  ["set-config-session", j("select set_", "config('app.user', $1, false)")],
  ["session-advisory-lock", j("select pg_", "advisory_lock(42)")],
  ["session-advisory-lock", j("select pg_try_", "advisory_lock(42)")],
  ["listen", j("LIS", "TEN wizard_events;")],
  ["listen", j("await sql.lis", "ten('events', fn);")],
  ["fsl-license", j("// License: FSL", "-1.1-Apache-2.0")],
  ["convex-copyright", j("// Copyright 2024 Con", "vex, Inc.")],
];

const good = [
  "await sql`SET LOCAL statement_timeout = 1000`;",
  "select set_config('app.user_id', $1, true);",
  "select pg_advisory_xact_lock(42);",
  "UPDATE app.orders SET status = 'paid', role = 'x' WHERE id = $1;",
  "server.listen(4000, '127.0.0.1');",
  "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;",
  "// set timeout to 5s",
  j("// wizard-allow-sql\nSET", " ROLE wizard_owner;"),
].join("\n");

describe("scripts/check-code.mjs", () => {
  test.each(bad)("%s: %s → ошибка", (rule, line) => {
    const r = check({ "packages/x/src/a.ts": `${line}\n` });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`[${rule}]`);
    expect(r.out).toContain("packages/x/src/a.ts:1");
  });

  test("безопасные конструкции и npm-пакет convex в node_modules не ловятся", () => {
    const r = check({
      "apps/y/src/ok.ts": good,
      "apps/y/migrations/001.sql": "SET LOCAL search_path TO platform;\n",
      "node_modules/convex/LICENSE.js": j("// Copyright Con", "vex, Inc. FSL", "-1.1"),
    });
    expect(r.out).toContain("check-code: ok");
    expect(r.status).toBe(0);
  });

  test("репозиторий проходит проверку", () => {
    const r = spawnSync(process.execPath, [CHECK], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toContain("check-code: ok");
    expect(r.status).toBe(0);
  });
});
