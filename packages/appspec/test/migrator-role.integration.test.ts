// M0-29 / L3-01: a migration runs as a role that is not a superuser and has no rights on schema platform
// (M0-M1: wizard_owner executes the whole script; M2: toDDL({migrationRole}) switches to sys_owner_<key>_<env>).
// Hostile default/rowFilter values ('); DROP SCHEMA platform; --, $$, \) change nothing in platform, and direct
// DDL in platform fails with a permission error. Runs in its own database, so a real `platform` schema exists
// without touching the shared one.
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type AppSpec, planMigration, quoteIdent, toDDL, validateSpec } from "../src/index.js";
import { miniSpec } from "./helpers.js";

const url =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
const suffix = randomBytes(4).toString("hex");
const dbName = `wz_appspec_migrator_${suffix}`;
const migrator = `wz_owner_test_${suffix}`; // plays wizard_owner
const sysOwner = `wz_sys_owner_test_${suffix}`; // plays sys_owner_<key>_<env> (M2)
const runtimeRole = `wz_rt_mig_${suffix}`;

const admin = postgres(url, { max: 1, onnotice: () => {} });
const dbUrl = (() => {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
})();
let sql: postgres.Sql;

const HOSTILE = [
  "'); DROP SCHEMA platform CASCADE; --",
  "$$; DROP SCHEMA platform; $$",
  "\\'; DROP TABLE platform.users; --",
];

function hostileSpec(): AppSpec {
  const spec = miniSpec();
  const task = spec.entities[0] as AppSpec["entities"][number];
  task.fields.push(
    { name: "note", label: "Заметка", type: "text", default: HOSTILE[0] },
    { name: "tag", label: "Метка", type: "string", default: HOSTILE[1] },
    { name: "extra", label: "Доп.", type: "json", default: { [HOSTILE[2] as string]: HOSTILE[0] } },
  );
  spec.permissions[0] = {
    role: "guest",
    entity: "task",
    ops: ["read"],
    rowFilter: { title: `x${HOSTILE[2]}` },
  };
  const v = validateSpec(spec);
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v.spec;
}

/** Everything in schema platform: tables with row counts, functions. */
async function platformSnapshot(): Promise<unknown> {
  const rels = await sql`
    select c.relname, c.relkind::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'platform' order by 1`;
  const [users] = await sql`select count(*)::int as n from platform.users`;
  const fns = await sql`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'platform'`;
  return { rels, users: users?.n, fns: fns.map((f) => f.proname) };
}

const ATTACKS = [
  "CREATE TABLE platform.injected (v text)",
  "DROP TABLE platform.users",
  "ALTER TABLE platform.users ADD COLUMN pwned text",
  "CREATE FUNCTION platform.f() RETURNS int LANGUAGE sql AS 'select 1'",
  "DROP SCHEMA platform CASCADE",
  "TRUNCATE platform.users",
];

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${quoteIdent(dbName)}`);
  for (const r of [migrator, sysOwner, runtimeRole])
    await admin.unsafe(
      `CREATE ROLE ${quoteIdent(r)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
  await admin.unsafe(`GRANT ${quoteIdent(sysOwner)} TO ${quoteIdent(migrator)}`);
  sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
  await sql.unsafe("REVOKE ALL ON SCHEMA public FROM PUBLIC");
  await sql.unsafe("CREATE SCHEMA platform");
  await sql.unsafe("CREATE TABLE platform.users (id int primary key, email text)");
  await sql.unsafe("INSERT INTO platform.users VALUES (1, 'owner@example.ru')");
  // wizard_owner may create app_* schemas in this database, nothing else.
  await sql.unsafe(`GRANT CREATE ON DATABASE ${quoteIdent(dbName)} TO ${quoteIdent(migrator)}`);
});

afterAll(async () => {
  await sql?.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`);
  for (const r of [migrator, sysOwner, runtimeRole])
    await admin.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(r)}`);
  await admin.end();
});

describe("migration role without rights on platform", () => {
  test("the migrator is not a superuser and has no privileges on schema platform", async () => {
    for (const r of [migrator, sysOwner]) {
      const [row] = await sql`
        select rolsuper, rolbypassrls, has_schema_privilege(${r}, 'platform', 'USAGE') as usage,
               has_schema_privilege(${r}, 'platform', 'CREATE') as create
        from pg_roles where rolname = ${r}`;
      expect(row).toEqual({ rolsuper: false, rolbypassrls: false, usage: false, create: false });
    }
  });

  test.each([
    ["M0-M1: wizard_owner runs the whole script", undefined],
    ["M2: toDDL({migrationRole}) switches to the per-system owner", sysOwner],
  ])("%s; hostile values leave platform intact", async (_name, migrationRole) => {
    const before = await platformSnapshot();
    const schema = `app_mig_${suffix}_${migrationRole ? "m2" : "m0"}_draft`;
    const statements = toDDL(planMigration(null, hostileSpec()), schema, { runtimeRole, migrationRole });
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(migrator)}`);
      for (const s of statements) await tx.unsafe(s).simple();
    });
    const [ns] =
      await sql`select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = ${schema}`;
    expect(ns?.owner).toBe(migrationRole ?? migrator);
    const [{ n } = { n: 0 }] = await sql.unsafe(
      `select count(*)::int as n from pg_tables where schemaname = $1 and tablename = 'task'`,
      [schema],
    );
    expect(n).toBe(1);
    expect(await platformSnapshot()).toEqual(before);
  });

  test.each([migrator, sysOwner])("DDL in platform as %s fails with a permission error", async (role) => {
    const before = await platformSnapshot();
    for (const attack of ATTACKS) {
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(role)}`);
          await tx.unsafe(attack);
        }),
        attack,
      ).rejects.toThrow(/permission denied|must be owner/);
    }
    expect(await platformSnapshot()).toEqual(before);
  });
});
