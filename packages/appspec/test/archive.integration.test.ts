// M2-72 (product.yaml#decisions.D56_destructive_changes, D72) on real Postgres: a confirmed destructive prod plan moves
// removed data into app_<…>_archive instead of dropping it (column, entity, type change text → int with values that do
// not convert), counts consequences under FORCE RLS as the system role, keeps the archive away from the runtime and
// system roles, and an undo plan restores everything. The migrator is a non-superuser role, as wizard_owner in prod.
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type AppSpec,
  applyOps,
  archiveSchemaName,
  archiveTableName,
  archiveTables,
  destructiveChanges,
  destructiveCountSql,
  dropSystemRoleDDL,
  type MigrationPlan,
  type Op,
  planMigration,
  quoteIdent,
  systemRoleName,
  toDDL,
  toSystemRoleDDL,
} from "../src/index.js";
import { miniSpec } from "./helpers.js";

const url =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
const sql = postgres(url, { max: 2, onnotice: () => {} });
const suffix = randomBytes(4).toString("hex");
const schema = `app_arch${suffix}_prod`;
const archive = archiveSchemaName(schema);
const migrator = `wz_arch_mig_${suffix}`;
const runtimeRole = `wz_arch_rt_${suffix}`;
const systemRole = systemRoleName(schema);
const t = (table: string) => `${quoteIdent(schema)}.${quoteIdent(table)}`;
const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID() };

function edit(spec: AppSpec, ops: unknown[]): AppSpec {
  const r = applyOps(spec, ops as Op[], 1, { currentVersion: 1, env: "draft" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}

const v1 = edit(miniSpec(), [
  { op: "add_field", entity: "task", field: { name: "phone", label: "Телефон", type: "string" } },
  { op: "add_field", entity: "task", field: { name: "code", label: "Код", type: "string" } },
]);
const v2 = edit(v1, [
  { op: "remove_field", entity: "task", name: "phone" },
  { op: "remove_field", entity: "task", name: "code" },
  { op: "add_field", entity: "task", field: { name: "code", label: "Код", type: "int", min: 0 } },
  { op: "remove_entity", name: "comment" },
]);

async function apply(statements: string[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(migrator)}`);
    for (const s of statements) await tx.unsafe(s);
  });
}

function asRole<T>(role: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(role)}`);
    return fn(tx);
  }) as Promise<T>;
}

beforeAll(async () => {
  for (const r of [migrator, runtimeRole])
    await sql.unsafe(`CREATE ROLE ${quoteIdent(r)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  const [{ db }] = (await sql`select current_database() as db`) as unknown as [{ db: string }];
  await sql.unsafe(`GRANT CREATE ON DATABASE ${quoteIdent(db)} TO ${quoteIdent(migrator)}`);
  for (const s of toSystemRoleDDL(schema, { members: [runtimeRole] })) await sql.unsafe(s);
  await apply(toDDL(planMigration(null, v1, { env: "prod" }), schema, { runtimeRole, systemRole }));
  const users = [randomUUID()];
  await sql.unsafe(`insert into ${t("users")} (id, role) values ($1, 'worker')`, users);
  const rows: [string, string, string | null, string | null][] = [
    [ids.a, "Первая", "+79990000001", "12"],
    [ids.b, "Вторая", "+79990000002", "abc"],
    [ids.c, "Третья", null, null],
  ];
  for (const [id, title, phone, code] of rows)
    await sql.unsafe(`insert into ${t("task")} (id, title, phone, code) values ($1, $2, $3, $4)`, [
      id,
      title,
      phone,
      code,
    ]);
  for (const body of ["к первой", "ещё к первой"])
    await sql.unsafe(`insert into ${t("comment")} (task, body) values ($1, $2)`, [ids.a, body]);
});

afterAll(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(archive)} CASCADE`);
  for (const s of dropSystemRoleDDL(schema)) await sql.unsafe(s);
  for (const r of [migrator, runtimeRole]) {
    await sql.unsafe(`DROP OWNED BY ${quoteIdent(r)}`);
    await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(r)}`);
  }
  await sql.end();
});

describe("destructive prod plan with archive", () => {
  let forward: MigrationPlan;

  test("unconfirmed → DESTRUCTIVE_IN_PROD; confirmed lists what the owner sees", () => {
    const blocked = planMigration(v1, v2, { env: "prod" });
    expect(blocked.errors.map((e) => e.code)).toContain("DESTRUCTIVE_IN_PROD");
    forward = planMigration(v1, v2, { env: "prod", destructiveConfirmed: true });
    expect(forward.errors).toEqual([]);
    expect(() => toDDL(forward, schema)).toThrow(/archive is required/);
    const changes = destructiveChanges(forward);
    expect(changes.map((c) => [c.kind, c.entity, c.field ?? null, c.fieldLabel ?? null])).toEqual([
      ["drop_column", "task", "phone", "Телефон"],
      ["alter_column_type", "task", "code", "Код"],
      ["drop_table", "comment", null, null],
    ]);
    expect(changes[2]?.entityLabel).toBe("Комментарий");
    expect(changes[1]).toMatchObject({ fromType: "string", toType: "int", archived: true });
  });

  test("consequences are counted on live rows as the system role (FORCE RLS)", async () => {
    const counts = await asRole(systemRole, async (tx) => {
      const out: unknown[] = [];
      for (const c of destructiveChanges(forward)) {
        const [r] = await tx.unsafe(destructiveCountSql(forward, c, schema));
        out.push([c.kind, r?.affected, r?.unconvertible]);
      }
      return out;
    });
    expect(counts).toEqual([
      ["drop_column", 2, 0],
      ["alter_column_type", 2, 1],
      ["drop_table", 2, 0],
    ]);
  });

  test("apply: data moves to the archive, convertible values carried over, RLS forced again", async () => {
    await apply(toDDL(forward, schema, { runtimeRole, systemRole, archive: { schema: archive, tag: "c1" } }));
    const cols = await sql`
      select column_name from information_schema.columns where table_schema = ${schema} and table_name = 'task'`;
    expect(cols.map((c) => c.column_name)).not.toContain("phone");
    const [gone] = await sql`select to_regclass(${`${schema}.comment`}) as r`;
    expect(gone?.r).toBeNull();
    const codes = await sql.unsafe(`select id, code from ${t("task")} order by title`);
    expect(Object.fromEntries(codes.map((r) => [r.id, r.code]))).toEqual({
      [ids.a]: "12", // bigint comes back as a string from postgres.js
      [ids.b]: null,
      [ids.c]: null,
    });
    const phone = await sql.unsafe(
      `select id, value from ${quoteIdent(archive)}.${quoteIdent(archiveTableName("c1", "task", "phone"))} order by value`,
    );
    expect(phone.map((r) => r.value)).toEqual(["+79990000001", "+79990000002"]);
    const oldCodes = await sql.unsafe(
      `select value from ${quoteIdent(archive)}.${quoteIdent(archiveTableName("c1", "task", "code"))} order by value`,
    );
    expect(oldCodes.map((r) => r.value)).toEqual(["12", "abc"]);
    const [{ n }] = (await sql.unsafe(
      `select count(*)::int as n from ${quoteIdent(archive)}.${quoteIdent(archiveTableName("c1", "comment"))}`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(2);
    const [force] = await sql`
      select c.relforcerowsecurity as f from pg_class c join pg_namespace s on s.oid = c.relnamespace
      where s.nspname = ${schema} and c.relname = 'task'`;
    expect(force?.f).toBe(true);
    expect(archiveTables(forward, "c1")).toHaveLength(3);
  });

  test("the archive is not readable by the runtime and system roles", async () => {
    const table = `${quoteIdent(archive)}.${quoteIdent(archiveTableName("c1", "task", "phone"))}`;
    for (const role of [runtimeRole, systemRole]) {
      const err = await asRole(role, (tx) => tx.unsafe(`select * from ${table}`)).catch(
        (e: { code?: string }) => e,
      );
      expect((err as { code?: string }).code, role).toBe("42501");
    }
  });

  test("undo restores the column, the entity and the original values of the type change", async () => {
    const back = planMigration(v2, v1, { env: "prod", destructiveConfirmed: true });
    await apply(
      toDDL(back, schema, {
        runtimeRole,
        systemRole,
        archive: { schema: archive, tag: "u1", restore: { tag: "c1", tables: archiveTables(forward, "c1") } },
      }),
    );
    const rows = await asRole(systemRole, (tx) =>
      tx.unsafe(`select id, phone, code from ${t("task")} order by phone nulls last`),
    );
    expect(rows.map((r) => [r.id, r.phone, r.code])).toEqual([
      [ids.a, "+79990000001", "12"],
      [ids.b, "+79990000002", "abc"],
      [ids.c, null, null],
    ]);
    const comments = await asRole(systemRole, (tx) =>
      tx.unsafe(`select task, body from ${t("comment")} order by body`),
    );
    expect(comments.map((c) => [c.task, c.body])).toEqual([
      [ids.a, "ещё к первой"],
      [ids.a, "к первой"],
    ]);
    // The int column the undo replaced is kept under the undo tag.
    const [{ n }] = (await sql.unsafe(
      `select count(*)::int as n from ${quoteIdent(archive)}.${quoteIdent(archiveTableName("u1", "task", "code"))}`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(1);
    const fk = await sql`
      select conname from pg_constraint where conrelid = to_regclass(${`${schema}.comment`}) and contype = 'f'`;
    expect(fk).toHaveLength(1);
  });
});
