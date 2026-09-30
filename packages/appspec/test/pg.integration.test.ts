// M0-04 acceptance on real Postgres: forum spec → DDL+RLS in app_test_<random>_draft; RLS matrix (a role
// without read sees no rows even with a direct SELECT under the runtime DB role; rowFilter $user.id shows own
// rows only); an additive second revision applies in prod; a destructive one gives DESTRUCTIVE_IN_PROD.
// Assertions are derived from the spec's permissions, so they hold for specs/appspec/examples/forum.json and
// for the local fixture alike.
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type AppSpec,
  applyOps,
  DEFAULT_MAX_LENGTH,
  type Entity,
  type Field,
  type MigrationPlan,
  type Permission,
  planMigration,
  quoteIdent,
  toDDL,
  USERS_ENTITY,
} from "../src/index.js";
import forumFixture from "./fixtures/forum.json" with { type: "json" };
import { forumSpec } from "./helpers.js";

const url = process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
const sql = postgres(url, { max: 4, onnotice: () => {} });
const suffix = randomBytes(4).toString("hex");
const runtimeRole = `wz_rt_test_${suffix}`;
type Tx = postgres.TransactionSql;

const shared = forumSpec();
const specs: [string, AppSpec][] = [["forum (examples or fixture)", shared]];
if (JSON.stringify(shared) !== JSON.stringify(forumFixture)) specs.push(["forum (local fixture)", forumFixture as AppSpec]);

beforeAll(async () => {
  await sql.unsafe(`CREATE ROLE ${quoteIdent(runtimeRole)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
});

afterAll(async () => {
  const leftovers = await sql`select nspname from pg_namespace where nspname like ${`app_test_${suffix}%`}`;
  for (const { nspname } of leftovers) await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(nspname)} CASCADE`);
  await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(runtimeRole)}`);
  await sql.end();
});

// ------------------------------------------------------------------------------------------------
// Row generator: values that satisfy the generated CHECK/UNIQUE/FK constraints.

function valueFor(field: Field, i: number, users: string[], ids: Map<string, string[]>): unknown {
  const uniq = randomBytes(6).toString("hex");
  switch (field.type) {
    case "string":
    case "text": {
      const max = field.maxLength ?? DEFAULT_MAX_LENGTH[field.type] ?? 1000;
      return `v${i}_${uniq}`.slice(0, max);
    }
    case "int":
      return (field.min ?? 0) + i;
    case "decimal":
    case "money":
      return (field.min ?? 0) + i + 0.5;
    case "bool":
      return i % 2 === 0;
    case "date":
      return "2026-10-01";
    case "datetime":
      return new Date(Date.UTC(2026, 9, 1 + i)).toISOString();
    case "enum":
      return field.enum?.[i % field.enum.length]?.value;
    case "ref": {
      if (field.ref?.entity === USERS_ENTITY) return users[i % users.length];
      const target = ids.get(field.ref?.entity ?? "") ?? [];
      return target[i % Math.max(target.length, 1)] ?? null;
    }
    case "json":
      return JSON.stringify({ i });
    case "email":
      return `u${uniq}@example.ru`;
    case "phone":
      return `+7999${String(1000000 + Math.floor(Math.random() * 8999999))}`;
    case "url":
      return `https://example.ru/${uniq}`;
    default:
      return `${field.type}_${uniq}`;
  }
}

function rowFor(entity: Entity, i: number, users: string[], ids: Map<string, string[]>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const f of entity.fields) {
    const v = valueFor(f, i, users, ids);
    if (v !== null && v !== undefined) row[f.name] = v;
  }
  return row;
}

/** Entities in FK dependency order (refs to other entities first). */
function topoOrder(spec: AppSpec): Entity[] {
  const byName = new Map(spec.entities.map((e) => [e.name, e]));
  const out: Entity[] = [];
  const seen = new Set<string>();
  const visit = (e: Entity) => {
    if (seen.has(e.name)) return;
    seen.add(e.name);
    for (const f of e.fields) {
      const target = f.type === "ref" ? byName.get(f.ref?.entity ?? "") : undefined;
      if (target && target !== e) visit(target);
    }
    out.push(e);
  };
  for (const e of spec.entities) visit(e);
  return out;
}

function insertSql(schema: string, table: string, row: Record<string, unknown>): [string, string[]] {
  const cols = Object.keys(row);
  const text = `insert into ${quoteIdent(schema)}.${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")}) values (${cols
    .map((_, k) => `$${k + 1}`)
    .join(", ")}) returning id`;
  return [text, cols.map((c) => String(row[c]))];
}

/** A permission whose rowFilter is exactly `{<user-ref field>: "$user.id"}` (the owner pattern). */
function ownerFilter(spec: AppSpec, p: Permission): string | undefined {
  const entries = Object.entries(p.rowFilter ?? {});
  if (entries.length !== 1) return undefined;
  const [key, value] = entries[0] as [string, unknown];
  const entity = spec.entities.find((e) => e.name === p.entity);
  const f = entity?.fields.find((x) => x.name === key);
  const isUserRef = key === "created_by" || (f?.type === "ref" && f.ref?.entity === USERS_ENTITY);
  return value === "$user.id" && isUserRef ? key : undefined;
}

// ------------------------------------------------------------------------------------------------

describe.each(specs.map((s, i) => [...s, i] as const))("%s on real Postgres", (_label, rev1, n) => {
  const schema = `app_test_${suffix}${n}_draft`;
  const t = (table: string) => `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const users = [randomUUID(), randomUUID()];
  const [alice, bob] = users as [string, string];
  const ids = new Map<string, string[]>();
  const roles = rev1.roles.map((r) => r.name);
  const perm = (role: string, entity: string) => rev1.permissions.find((p) => p.role === role && p.entity === entity);
  let rev2: AppSpec;
  const target = rev1.entities[0] as Entity;

  async function migrate(plan: MigrationPlan): Promise<void> {
    const statements = toDDL(plan, schema, { runtimeRole });
    await sql.begin(async (tx) => {
      for (const s of statements) await tx.unsafe(s);
    });
  }

  /** Runs `fn` as the non-superuser runtime role with RLS context set via set_config(..., true). */
  function as<T>(role: string | null, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(runtimeRole)}`);
      if (role !== null) await tx`select set_config('wizard.role', ${role}, true)`;
      if (userId !== null) await tx`select set_config('wizard.user_id', ${userId}, true)`;
      return fn(tx);
    }) as Promise<T>;
  }
  const count = async (tx: Tx, table: string) =>
    Number((await tx.unsafe(`select count(*)::int as n from ${t(table)}`))[0]?.n);

  beforeAll(async () => {
    await migrate(planMigration(null, rev1, { env: "draft" }));
    // Seed two rows per entity (row 0 owned by alice, row 1 by bob) as the migration owner (bypasses RLS).
    for (const e of topoOrder(rev1)) {
      const created: string[] = [];
      for (const i of [0, 1]) {
        const [text, params] = insertSql(schema, e.name, rowFor(e, i, users, ids));
        const [row] = await sql.unsafe(text, params);
        created.push(String(row?.id));
      }
      ids.set(e.name, created);
    }
  });

  test("tables exist with RLS enabled and forced; runtime role does not bypass RLS", async () => {
    const tables = await sql`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace where ns.nspname = ${schema} and c.relkind = 'r'`;
    expect(tables.map((r) => r.relname).sort()).toEqual(rev1.entities.map((e) => e.name).sort());
    expect(tables.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
    const [who] = await as(roles[0] ?? null, alice, (tx) =>
      tx`select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as b`,
    );
    expect(who).toEqual({ u: runtimeRole, b: false });
  });

  test("read matrix: no read → 0 rows even with a direct SELECT; read without filter → all rows", async () => {
    const mismatches: string[] = [];
    for (const e of rev1.entities) {
      for (const role of roles) {
        const p = perm(role, e.name);
        const n = await as(role, alice, (tx) => count(tx, e.name));
        const canRead = p?.ops.includes("read") ?? false;
        const unfiltered = canRead && Object.keys(p?.rowFilter ?? {}).length === 0;
        if (!canRead && n !== 0) mismatches.push(`${role}×${e.name}: expected 0, got ${n}`);
        if (unfiltered && n !== 2) mismatches.push(`${role}×${e.name}: expected 2, got ${n}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("deny by default without context or with an unknown role", async () => {
    for (const e of rev1.entities) {
      expect(await as(null, null, (tx) => count(tx, e.name))).toBe(0);
      expect(await as("nobody", alice, (tx) => count(tx, e.name))).toBe(0);
    }
  });

  test("rowFilter $user.id: own rows only for read and write", async () => {
    const owned = rev1.permissions.filter((p) => p.ops.includes("read") && ownerFilter(rev1, p));
    expect(owned.length).toBeGreaterThan(0);
    for (const p of owned) {
      const key = ownerFilter(rev1, p) as string;
      for (const user of [alice, bob]) {
        const rows = await as(p.role, user, (tx) => tx.unsafe(`select ${quoteIdent(key)} as o from ${t(p.entity)}`));
        expect(rows.map((r) => r.o)).toEqual([user]);
      }
      if (p.ops.includes("update")) {
        const res = await as(p.role, alice, (tx) =>
          tx.unsafe(`update ${t(p.entity)} set ${quoteIdent(key)} = ${quoteIdent(key)} where ${quoteIdent(key)} = $1`, [bob]),
        );
        expect(res.count).toBe(0);
      }
    }
  });

  test("create: allowed with own owner value (created_by filled from context), denied otherwise", async () => {
    const creatable = rev1.permissions.find(
      (p) => p.ops.includes("create") && (Object.keys(p.rowFilter ?? {}).length === 0 || ownerFilter(rev1, p)),
    );
    expect(creatable).toBeDefined();
    const p = creatable as Permission;
    const entity = rev1.entities.find((e) => e.name === p.entity) as Entity;
    const [text, params] = insertSql(schema, entity.name, rowFor(entity, 0, [alice], ids));
    const [row] = await as(p.role, alice, (tx) => tx.unsafe(text, params));
    const [stored] = await sql.unsafe(`select created_by from ${t(entity.name)} where id = $1`, [String(row?.id)]);
    expect(stored?.created_by).toBe(alice);

    const key = ownerFilter(rev1, p);
    if (key) {
      const [foreign, fparams] = insertSql(schema, entity.name, { ...rowFor(entity, 0, [alice], ids), [key]: bob });
      await expect(as(p.role, alice, (tx) => tx.unsafe(foreign, fparams))).rejects.toThrow(/row-level security/);
    }
    const denied = roles.find((r) => !perm(r, entity.name)?.ops.includes("create")) as string;
    await expect(as(denied, alice, (tx) => tx.unsafe(text, params))).rejects.toThrow(/row-level security/);
  });

  test("revision 2 adds fields and applies as additive in prod", async () => {
    const r = applyOps(
      rev1,
      [
        { op: "add_field", entity: target.name, field: { name: "extra_views", label: "Просмотры", type: "int", required: true, default: 0, min: 0 } },
        { op: "add_field", entity: target.name, field: { name: "extra_tag", label: "Метка", type: "string", maxLength: 40 } },
      ],
      1,
      { currentVersion: 1, env: "prod" },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    rev2 = r.spec;
    const plan = planMigration(rev1, rev2, { env: "prod" });
    expect(plan).toMatchObject({ additiveOnly: true, errors: [] });
    await migrate(plan);
    const cols = await sql`
      select column_name, is_nullable from information_schema.columns
      where table_schema = ${schema} and table_name = ${target.name} and column_name like 'extra_%' order by 1`;
    expect(cols).toEqual([
      { column_name: "extra_tag", is_nullable: "YES" },
      { column_name: "extra_views", is_nullable: "NO" },
    ]);
    const existing = await sql.unsafe(`select extra_views from ${t(target.name)} where id = $1`, [ids.get(target.name)?.[0] ?? ""]);
    expect(existing).toEqual([{ extra_views: "0" }]);
    await expect(sql.unsafe(`update ${t(target.name)} set extra_views = -1`)).rejects.toThrow(/ck_extra_views_min/);
    // RLS survives re-application
    const reader = roles.find((role) => perm(role, target.name)?.ops.includes("read") && !perm(role, target.name)?.rowFilter);
    if (reader) expect(await as(reader, alice, (tx) => count(tx, target.name))).toBeGreaterThanOrEqual(2);
  });

  test("destructive revision: DESTRUCTIVE_IN_PROD in prod, applies in draft and drops stale policies", async () => {
    const byOps = applyOps(rev2, [{ op: "remove_field", entity: target.name, name: "extra_tag" }], 2, {
      currentVersion: 2,
      env: "prod",
    });
    expect(byOps.ok ? [] : byOps.errors.map((e) => e.code)).toEqual(["DESTRUCTIVE_IN_PROD"]);

    const reader = rev2.permissions.find((p) => p.entity === target.name && p.ops.includes("read")) as Permission;
    const draft = applyOps(
      rev2,
      [
        { op: "remove_field", entity: target.name, name: "extra_tag" },
        { op: "remove_permission", role: reader.role, entity: target.name },
      ],
      2,
      { currentVersion: 2, env: "draft" },
    );
    if (!draft.ok) throw new Error(JSON.stringify(draft.errors));
    const prodPlan = planMigration(rev2, draft.spec, { env: "prod" });
    expect(prodPlan.errors.map((e) => e.code)).toEqual(["DESTRUCTIVE_IN_PROD"]);
    expect(() => toDDL(prodPlan, schema)).toThrow(/DESTRUCTIVE_IN_PROD/);

    await migrate(planMigration(rev2, draft.spec, { env: "draft" }));
    const cols = await sql`select 1 from information_schema.columns where table_schema = ${schema} and table_name = ${target.name} and column_name = 'extra_tag'`;
    expect(cols).toHaveLength(0);
    expect(await as(reader.role, alice, (tx) => count(tx, target.name))).toBe(0);
  });
});
