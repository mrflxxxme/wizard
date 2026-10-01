#!/usr/bin/env node
// PITR restore drill (deploy.yaml#cloud.postgres.restore_drill; docs/ops/deploy.md «Учение PITR»):
//   mark    --db <url> [--note text]                 control row in wizard_ops.drill_markers (prints id and time)
//   verify  --db <restored url> --present <id,…> [--absent <id,…>]   rows before T exist, rows after T do not
//   restore --env staging --at "<RFC 1123 UTC>" --source <cluster id> --spec <spec id> --subnet <subnet id>
//           new cluster from PITR via infra/tofu/<provider>/drills/pitr when the provider has PITR in IaC (Cloud.ru);
//           otherwise the restore is done in the provider's panel (Timeweb: from a backup) — docs/ops/deploy.md
//   destroy --env staging …same args…               removes the drill cluster
// Markers live in their own schema (wizard_ops), not in platform.*: the drill must not depend on app migrations.
// Uses psql (postgresql-client) — present on the runner and locally.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROVIDER, loadProvider, ROOT, tofuEnv, tofuInitArgs } from "./infra.mjs";

export const SCHEMA = "wizard_ops";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const o = {
    command,
    db: null,
    note: "pitr-drill",
    present: [],
    absent: [],
    env: "staging",
    at: null,
    schema: SCHEMA,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const v = () => rest[++i] ?? "";
    if (a === "--db") o.db = v();
    else if (a === "--note") o.note = v();
    else if (a === "--present") o.present = v().split(",").filter(Boolean);
    else if (a === "--absent") o.absent = v().split(",").filter(Boolean);
    else if (a === "--env") o.env = v();
    else if (a === "--at") o.at = v();
    else if (a === "--source") o.source = v();
    else if (a === "--spec") o.spec = v();
    else if (a === "--subnet") o.subnet = v();
    else if (a === "--schema") o.schema = v();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(o.schema)) throw new Error("bad --schema");
  for (const id of [...o.present, ...o.absent]) if (!UUID.test(id)) throw new Error(`not a marker id: ${id}`);
  return o;
}

/** psql with ON_ERROR_STOP; values only as psql variables (:'name'), identifiers fixed. */
export function psql(db, sql, vars = {}) {
  const args = [db, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"];
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  const r = spawnSync("psql", args, { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export function mark(db, note = "pitr-drill", schema = SCHEMA) {
  const out = psql(
    db,
    `CREATE SCHEMA IF NOT EXISTS ${schema};
     CREATE TABLE IF NOT EXISTS ${schema}.drill_markers (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       note text NOT NULL
     );
     INSERT INTO ${schema}.drill_markers (note) VALUES (:'note')
       RETURNING id || '|' || to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');`,
    { note },
  );
  const [id, at] = out.split("|");
  return { id, at };
}

export function verify(db, present, absent, schema = SCHEMA) {
  const ids = [...present, ...absent];
  if (ids.length === 0) throw new Error("nothing to verify");
  const found = new Set(
    psql(
      db,
      `SELECT id FROM ${schema}.drill_markers WHERE id = ANY (string_to_array(:'ids', ',')::uuid[]);`,
      {
        ids: ids.join(","),
      },
    )
      .split("\n")
      .filter(Boolean),
  );
  const missing = present.filter((id) => !found.has(id));
  const leaked = absent.filter((id) => found.has(id));
  return { ok: missing.length === 0 && leaked.length === 0, missing, leaked };
}

/** Drill root of the provider, or null when its PITR restore is not available through IaC. */
export function drillDir(provider) {
  const dir = `${provider.dir}/drills/pitr`;
  return existsSync(join(ROOT, dir, "main.tf")) ? dir : null;
}

function tofuDrill(o, action) {
  const vars = process.env;
  const provider = loadProvider(vars.WIZARD_PROVIDER || DEFAULT_PROVIDER);
  const dir = drillDir(provider);
  if (!dir) {
    throw new Error(
      `${provider.title}: восстановление на момент времени не описано в IaC — по runbook (docs/ops/deploy.md)`,
    );
  }
  const chdir = `-chdir=${dir}`;
  const env = { ...vars, ...tofuEnv(vars, provider) };
  const init = tofuInitArgs(o.env, vars, provider).map((a) => (a.startsWith("-chdir=") ? chdir : a));
  init.push(`-backend-config=key=wizard/drills/pitr-${o.env}.tfstate`);
  const tf = (args) => {
    const r = spawnSync("tofu", args, { cwd: ROOT, env, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tofu ${args[1]} failed`);
  };
  tf(init);
  tf([
    chdir,
    action,
    "-input=false",
    "-auto-approve",
    `-var=source_cluster_id=${o.source}`,
    `-var=pitr=${o.at}`,
    `-var=specification_id=${o.spec}`,
    `-var=subnet_id=${o.subnet}`,
  ]);
}

export function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.command === "mark") {
    if (!o.db) throw new Error("--db is required");
    const m = mark(o.db, o.note, o.schema);
    console.log(JSON.stringify(m));
    return 0;
  }
  if (o.command === "verify") {
    if (!o.db) throw new Error("--db is required");
    const r = verify(o.db, o.present, o.absent, o.schema);
    console.log(JSON.stringify(r));
    return r.ok ? 0 : 1;
  }
  if (o.command === "restore" || o.command === "destroy") {
    if (!o.at || !o.source || !o.spec || !o.subnet)
      throw new Error("--at, --source, --spec, --subnet are required");
    tofuDrill(o, o.command === "restore" ? "apply" : "destroy");
    if (o.command === "restore") {
      console.log(
        "Кластер восстановлен. Строка подключения: tofu -chdir=<drills/pitr провайдера> output -raw connection_string",
      );
    }
    return 0;
  }
  throw new Error("command: mark | verify | restore | destroy");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`pitr-drill: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
