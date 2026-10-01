// L3-01: spec values reach DDL/RLS only through sqlLiteral/quoteIdent (src/sql.ts). Property tests over hostile
// strings (quotes, backslashes, dollar quotes, E'' / U&'' prefixes, comments, semicolons, Unicode look-alikes),
// then end-to-end on real Postgres: statements are executed with the SIMPLE protocol (multi-statement allowed,
// standard_conforming_strings switched off beforehand) under a per-system migration role, and afterwards only
// the expected objects exist, the canary schema is intact and the hostile values round-trip byte for byte.

import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type AppSpec,
  dropSystemRoleDDL,
  literalProblem,
  planMigration,
  quoteIdent,
  SqlValueError,
  SYSTEM_TABLES,
  sqlLiteral,
  toDDL,
  toRLS,
  toSystemRoleDDL,
  validateSpec,
} from "../src/index.js";
import { rng } from "./fixtures/schema-cases.js";

const FRAGMENTS = [
  "'",
  "''",
  "\\",
  "\\'",
  "$$",
  "$wz$",
  "$wz0$",
  "E'",
  "U&'",
  "e'\\x27",
  ";",
  "--",
  "/*",
  "*/",
  '"',
  "%",
  "_",
  "\n",
  "\r\n",
  "\t",
  "ʼ", // modifier letter apostrophe
  "＇", // fullwidth apostrophe
  "’",
  " ",
  "‮", // RTL override
  "é",
  "😀",
  "$1",
  ":x",
  "'); DROP SCHEMA platform CASCADE; --",
  "'; COMMIT; DROP TABLE users; BEGIN; SELECT '",
  "$wz$; DROP SCHEMA platform; $wz$",
  "\\'; SELECT pg_sleep(10); --",
  " OR 1=1 ",
];

/** The fragments themselves (optional) plus random concatenations of 1-6 fragments. */
function hostileStrings(count: number, seed: number, withFragments = true): string[] {
  const rand = rng(seed);
  const out = withFragments ? [...FRAGMENTS] : [];
  while (out.length < count) {
    const n = 1 + Math.floor(rand() * 6);
    let s = "";
    for (let i = 0; i < n; i++) s += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
    out.push(s);
  }
  return out;
}

const HOSTILE = hostileStrings(300, 7);

describe("sqlLiteral / quoteIdent (no database)", () => {
  test("a text constant has no unpaired quote: it cannot terminate early", () => {
    for (const s of HOSTILE) {
      const lit = sqlLiteral(s, "text");
      expect(lit.startsWith("'") && lit.endsWith("'")).toBe(true);
      expect(lit.slice(1, -1).replace(/''/g, "")).not.toContain("'");
      expect(lit).not.toMatch(/^[EeUu]/);
    }
  });

  test("json constants are escaped the same way and carry an explicit cast", () => {
    for (const s of HOSTILE.slice(0, 50)) {
      const lit = sqlLiteral({ [s]: [s, 1, true, null] }, "json");
      expect(lit.endsWith("'::jsonb")).toBe(true);
      expect(lit.slice(1, -"'::jsonb".length).replace(/''/g, "")).not.toContain("'");
    }
  });

  test("NUL bytes and lone surrogates are rejected, never escaped", () => {
    for (const bad of ["a\0b", "\0", "x\uD800", "\uDC00y"]) {
      expect(() => sqlLiteral(bad, "text")).toThrow(SqlValueError);
      expect(() => sqlLiteral({ k: bad }, "json")).toThrow(SqlValueError);
      expect(() => sqlLiteral({ [bad]: 1 }, "json")).toThrow(SqlValueError);
      expect(() => quoteIdent(bad)).toThrow(SqlValueError);
    }
  });

  test("typed values are validated before encoding", () => {
    const rejects: [unknown, Parameters<typeof sqlLiteral>[1]][] = [
      ["1; DROP SCHEMA platform", "int"],
      [1.5, "int"],
      [2 ** 60, "int"],
      [Number.NaN, "decimal"],
      [Number.POSITIVE_INFINITY, "money"],
      ["1", "decimal"],
      ["true", "bool"],
      ["2026-02-30", "date"],
      ["2026-01-01'; --", "date"],
      ["2026-01-01T10:00:00", "datetime"],
      ["not-a-uuid", "ref"],
      ["00000000-0000-0000-0000-000000000000' OR '1'='1", "uuid"],
      [1, "text"],
      ["no-at-sign", "email"],
      ["+7 999", "phone"],
      ["javascript:alert(1)", "url"],
      [undefined, "json"],
      [() => 1, "json"],
      [BigInt(1), "json"],
    ];
    for (const [v, t] of rejects) {
      expect(literalProblem(v, t), `${String(v)} as ${t}`).toBeTypeOf("string");
      expect(() => sqlLiteral(v, t)).toThrow(SqlValueError);
    }
    expect(sqlLiteral(-5, "int")).toBe("(-5)");
    expect(sqlLiteral(1e-7, "decimal")).toBe("1e-7");
    expect(sqlLiteral(true, "bool")).toBe("TRUE");
    expect(sqlLiteral("2026-10-01", "date")).toBe("'2026-10-01'::date");
    expect(sqlLiteral("2026-10-01T10:00:00+03:00", "datetime")).toBe(
      "'2026-10-01T10:00:00+03:00'::timestamptz",
    );
    expect(sqlLiteral("A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11", "ref")).toBe(
      "'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid",
    );
  });

  test("quoteIdent doubles quotes and refuses names Postgres would truncate", () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(quoteIdent("a".repeat(63))).toBe(`"${"a".repeat(63)}"`);
    expect(() => quoteIdent("a".repeat(64))).toThrow(SqlValueError);
    expect(() => quoteIdent("я".repeat(32))).toThrow(SqlValueError); // 64 bytes in UTF-8
    expect(() => quoteIdent("")).toThrow(SqlValueError);
  });

  test("generated SQL never quotes spec values by hand (only src/sql.ts builds constants)", () => {
    const dir = new URL("../src/", import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "sql.ts")) {
      const text = readFileSync(new URL(file, dir), "utf8");
      expect(text, file).not.toMatch(/'\$\{/);
      expect(text, file).not.toMatch(/\breplace\(\/'\/g/);
    }
  });

  test("toDDL: every script sets standard_conforming_strings; a per-system migration role owns the schema", () => {
    const spec = hostileSpec(HOSTILE.slice(0, 8));
    const fresh = toDDL(planMigration(null, spec), "app_x_draft", { migrationRole: "sys_owner_x_draft" });
    expect(fresh.slice(0, 4)).toEqual([
      "SET LOCAL lock_timeout = '3s'",
      "SET LOCAL standard_conforming_strings = on",
      `CREATE SCHEMA IF NOT EXISTS "app_x_draft" AUTHORIZATION "sys_owner_x_draft"`,
      `SET LOCAL ROLE "sys_owner_x_draft"`,
    ]);
    expect(fresh.filter((s) => s.startsWith("CREATE SCHEMA"))).toHaveLength(1);
    const again = toDDL(planMigration(spec, spec), "app_x_draft", { migrationRole: "sys_owner_x_draft" });
    expect(again[2]).toBe(`SET LOCAL ROLE "sys_owner_x_draft"`);
    expect(again.some((s) => s.startsWith("CREATE SCHEMA"))).toBe(false);
    expect(() => toDDL(planMigration(null, spec), "app_x_draft", { migrationRole: 'x"; drop' })).toThrow();
    expect(() => toDDL(planMigration(null, spec), "app_x_draft", { lockTimeout: "3s'; drop" })).toThrow();
  });

  test("toRLS: rowFilter applies only to rowFilterOps", () => {
    const rls = toRLS(hostileSpec(HOSTILE.slice(0, 8)), "app_x_draft");
    const policy = (name: string) => rls.find((s) => s.startsWith(`CREATE POLICY "${name}"`)) ?? "";
    expect(policy("wz_writer_read")).not.toContain(`"owner"`);
    expect(policy("wz_writer_update")).toContain(`"owner" = (select nullif(current_setting('wizard.user_id'`);
    expect(policy("wz_reader_read")).toContain(`"title" = '`);
  });

  test("hostile default, min/max and rowFilter values do not change the number of SQL statements", () => {
    const benign = hostileSpec(Array.from({ length: 12 }, (_, i) => `v${i}`));
    const script = (s: AppSpec) => [
      ...toDDL(planMigration(null, s), "app_x_draft"),
      ...toRLS(s, "app_x_draft"),
    ];
    const expected = script(benign).length;
    for (let round = 0; round < 25; round++) {
      const statements = script(hostileSpec(hostileStrings(12, 500 + round, round === 0)));
      expect(statements).toHaveLength(expected);
      // The lexer sees exactly one statement per array element: no value can close a literal and add one.
      for (const s of statements) expect(countStatements(s), s).toBe(1);
      expect(countStatements(statements.join(";\n"))).toBe(expected);
    }
    // Non-numeric min/max/default of numeric fields never reach SQL: validation rejects them, toDDL refuses.
    for (const bad of ["'); DROP SCHEMA platform; --", "$$", "\\"]) {
      for (const key of ["min", "max", "default"] as const) {
        const spec = structuredClone(benign);
        const n = spec.entities[0]?.fields.find((f) => f.name === "n") as Record<string, unknown>;
        n[key] = bad;
        expect(validateSpec(spec).ok, `${key}=${bad}`).toBe(false);
        expect(() => toDDL(planMigration(null, spec), "app_x_draft")).toThrow();
      }
    }
  });
});

/**
 * Number of top-level SQL statements (standard_conforming_strings = on): `;` outside '…' constants, "…" idents,
 * $tag$…$tag$ bodies and comments separates statements.
 */
function countStatements(script: string): number {
  let count = 0;
  let current = "";
  let i = 0;
  const flush = () => {
    if (current.trim()) count++;
    current = "";
  };
  while (i < script.length) {
    const c = script[i] as string;
    const rest = script.slice(i);
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        const k = script.indexOf(c, j);
        if (k < 0) throw new Error(`unterminated ${c} in ${script}`);
        if (script[k + 1] === c) j = k + 2;
        else {
          j = k + 1;
          break;
        }
      }
      current += script.slice(i, j);
      i = j;
    } else if (dollar && !/[A-Za-z0-9_]/.test(script[i - 1] ?? "")) {
      const end = script.indexOf(dollar[0], i + dollar[0].length);
      if (end < 0) throw new Error(`unterminated ${dollar[0]} in ${script}`);
      current += script.slice(i, end + dollar[0].length);
      i = end + dollar[0].length;
    } else if (rest.startsWith("--")) {
      const end = script.indexOf("\n", i);
      i = end < 0 ? script.length : end;
    } else if (rest.startsWith("/*")) {
      const end = script.indexOf("*/", i + 2);
      if (end < 0) throw new Error(`unterminated comment in ${script}`);
      i = end + 2;
    } else if (c === ";") {
      flush();
      i++;
    } else {
      current += c;
      i++;
    }
  }
  flush();
  return count;
}

/** Reader's rowFilter literal. A leading `$` marks a `$user.` reference, so literals never start with it. */
const filterLiteral = (h: string[]) => `x${h[6 % h.length]}`;

/** A spec whose defaults and rowFilter literals are hostile strings (all well-formed, so all valid). */
function hostileSpec(h: string[]): AppSpec {
  const at = (i: number) => h[i % h.length] as string;
  const spec: AppSpec = {
    specVersion: "1",
    app: { name: at(0).slice(0, 80) || "x", locale: "ru" },
    entities: [
      {
        name: "note",
        label: "Заметка",
        ownerField: "owner",
        fields: [
          { name: "title", label: "Заголовок", type: "string", maxLength: 1000, default: at(1) },
          { name: "body", label: "Текст", type: "text", default: at(2) },
          { name: "meta", label: "Мета", type: "json", default: { [at(3)]: [at(4), -1.5, true, null] } },
          { name: "n", label: "Число", type: "int", min: -5, max: 10, default: -3 },
          { name: "price", label: "Цена", type: "money", min: 0, default: 12.5 },
          { name: "due", label: "Срок", type: "date", default: "2026-10-01" },
          { name: "at", label: "Время", type: "datetime", default: "2026-10-01T10:00:00+03:00" },
          {
            name: "kind",
            label: "Вид",
            type: "enum",
            default: "b",
            enum: [
              { value: "a", label: at(5).slice(0, 80) || "a" },
              { value: "b", label: "Б" },
            ],
          },
          { name: "owner", label: "Автор", type: "ref", ref: { entity: "users" } },
        ],
      },
    ],
    roles: [
      { name: "reader", label: "Читатель", access: "login", loginMethods: ["email_otp"] },
      { name: "writer", label: "Автор", access: "login", loginMethods: ["email_otp"] },
    ],
    permissions: [
      { role: "reader", entity: "note", ops: ["read"], rowFilter: { title: filterLiteral(h) } },
      {
        role: "writer",
        entity: "note",
        ops: ["read", "create", "update"],
        rowFilter: { owner: "$user.id" },
        rowFilterOps: ["update"],
      },
    ],
  };
  const v = validateSpec(spec);
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v.spec;
}

// ------------------------------------------------------------------------------------------------
// Real Postgres

const url =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
const sql = postgres(url, { max: 2, onnotice: () => {} });
const suffix = randomBytes(4).toString("hex");
const owner = `wz_sys_owner_test_${suffix}`;
const runtimeRole = `wz_rt_inj_${suffix}`;
const systemRole = `wz_sys_inj_${suffix}_system`;
const canary = `wz_canary_${suffix}`;
const schemas: string[] = [];

/**
 * Everything the per-system migration role owns. After `SET LOCAL ROLE <owner>` every statement (including any
 * injected one) runs as that role, so this is exactly what a migration can create. The database is shared with
 * other test runs, so global snapshots of schemas/roles are not stable; ownership is.
 */
async function ownedByMigrationRole(): Promise<string[]> {
  const rows = await sql`
    select 'schema ' || n.nspname as o from pg_namespace n where n.nspowner = ${owner}::regrole
    union all
    select 'rel ' || n.nspname || '.' || c.relname || ' ' || c.relkind::text from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relowner = ${owner}::regrole and c.relkind in ('r', 'p', 'v', 'm', 'f')
    union all
    select 'fn ' || n.nspname || '.' || p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where p.proowner = ${owner}::regrole
    union all
    select 'role ' || r.rolname from pg_auth_members m join pg_roles r on r.oid = m.member
      where m.roleid = ${owner}::regrole and r.rolname <> current_user`;
  return rows.map((r) => r.o as string).sort();
}

beforeAll(async () => {
  await sql.unsafe(`CREATE ROLE ${quoteIdent(owner)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await sql.unsafe(`CREATE ROLE ${quoteIdent(runtimeRole)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  for (const st of toSystemRoleDDL("x", { systemRole, members: [runtimeRole] })) await sql.unsafe(st);
  await sql.unsafe(`CREATE SCHEMA ${quoteIdent(canary)}`);
  await sql.unsafe(`CREATE TABLE ${quoteIdent(canary)}.t (v text)`);
  await sql.unsafe(`INSERT INTO ${quoteIdent(canary)}.t VALUES ('alive')`);
});

afterAll(async () => {
  for (const s of [...schemas, canary]) await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(s)} CASCADE`);
  await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(owner)}`);
  for (const st of dropSystemRoleDDL("x", systemRole)) await sql.unsafe(st);
  await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(runtimeRole)}`);
  await sql.end();
});

describe("hostile values on real Postgres", () => {
  test("every hostile text/json constant round-trips unchanged through the simple protocol", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL standard_conforming_strings = on").simple();
      for (const s of HOSTILE) {
        const rows = await tx.unsafe(`SELECT ${sqlLiteral(s, "text")} AS v`).simple();
        expect(rows).toEqual([{ v: s }]);
      }
      for (const s of HOSTILE.slice(0, 60)) {
        const value = { [s]: [s, 1.25, false, null] };
        const rows = await tx.unsafe(`SELECT ${sqlLiteral(value, "json")} AS v`).simple();
        expect(rows).toEqual([{ v: value }]);
      }
    });
  });

  test.each([0, 1, 2, 3, 4])(
    "round %i: DDL+RLS with hostile defaults and rowFilter creates only the expected objects",
    async (round) => {
      const h = hostileStrings(12, 100 + round, false);
      const spec = hostileSpec(h);
      const schema = `app_inj_${suffix}_${round}_draft`;
      schemas.push(schema);
      const statements = toDDL(planMigration(null, spec), schema, {
        runtimeRole,
        systemRole,
        migrationRole: owner,
      });
      await sql.begin(async (tx) => {
        // Adversarial session: backslash escapes on. The preamble MUST switch them off again.
        await tx.unsafe("SET LOCAL standard_conforming_strings = off").simple();
        for (const s of statements) await tx.unsafe(s).simple();
      });
      const expectedOwned = schemas.flatMap((sch) => [
        `schema ${sch}`,
        `fn ${sch}.wz_touch_updated_at`,
        ...[...Object.keys(SYSTEM_TABLES), "note"].map((tbl) => `rel ${sch}.${tbl} r`),
      ]);
      expect(await ownedByMigrationRole()).toEqual(expectedOwned.sort());

      const tables = await sql`
        select c.relname, pg_get_userbyid(c.relowner) as owner from pg_class c
        join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${schema} and c.relkind = 'r'`;
      expect(tables.map((r) => r.relname).sort()).toEqual([...Object.keys(SYSTEM_TABLES), "note"].sort());
      expect(new Set(tables.map((r) => r.owner))).toEqual(new Set([owner]));
      const [ns] =
        await sql`select pg_get_userbyid(nspowner) as o from pg_namespace where nspname = ${schema}`;
      expect(ns?.o).toBe(owner);
      const fns = await sql`
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = ${schema}`;
      expect(fns.map((r) => r.proname)).toEqual(["wz_touch_updated_at"]);
      const policies = await sql`select policyname from pg_policies where schemaname = ${schema}`;
      expect(policies.map((r) => r.policyname as string).sort()).toEqual(
        [
          ...Array(Object.keys(SYSTEM_TABLES).length + 1).fill("wz__system"),
          "wz_reader_read",
          "wz_writer_create",
          "wz_writer_read",
          "wz_writer_update",
        ].sort(),
      );
      expect(await sql`select v from ${sql(canary)}.t`).toEqual([{ v: "alive" }]);

      // Defaults round-trip byte for byte; the reader's rowFilter literal matches exactly the hostile title.
      const t = `${quoteIdent(schema)}."note"`;
      const [alice, bob] = [randomUUID(), randomUUID()];
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(systemRole)}`);
        await tx.unsafe(
          `insert into ${quoteIdent(schema)}."users" (id, role) values ($1, 'writer'), ($2, 'writer')`,
          [alice, bob],
        );
        await tx.unsafe(`insert into ${t} (owner) values ($1)`, [alice]);
        await tx.unsafe(`insert into ${t} (owner, title) values ($1, $2)`, [bob, filterLiteral(h)]);
      });
      const [row] = await sql.unsafe(`select title, body, meta, n, kind from ${t} where owner = $1`, [alice]);
      const fields = spec.entities[0]?.fields ?? [];
      const def = (name: string) => fields.find((f) => f.name === name)?.default;
      expect(row).toEqual({ title: def("title"), body: def("body"), meta: def("meta"), n: "-3", kind: "b" });

      const as = <T>(role: string, user: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
        sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(runtimeRole)}`);
          await tx`select set_config('wizard.role', ${role}, true), set_config('wizard.user_id', ${user}, true)`;
          return fn(tx);
        }) as Promise<T>;
      const readerRows = await as("reader", alice, (tx) => tx.unsafe(`select owner from ${t}`));
      const expected = [alice, bob].filter(
        (_, i) => (i === 0 ? def("title") : filterLiteral(h)) === filterLiteral(h),
      );
      expect(readerRows.map((r) => r.owner).sort()).toEqual(expected.sort());

      // rowFilterOps = [update]: writer reads every row but updates only own rows.
      expect(await as("writer", alice, (tx) => tx.unsafe(`select count(*)::int as n from ${t}`))).toEqual([
        { n: 2 },
      ]);
      const upd = await as("writer", alice, (tx) =>
        tx.unsafe(`update ${t} set n = 1 where owner = $1`, [bob]),
      );
      expect(upd.count).toBe(0);
      const own = await as("writer", alice, (tx) =>
        tx.unsafe(`update ${t} set n = 1 where owner = $1`, [alice]),
      );
      expect(own.count).toBe(1);
    },
  );

  test("the per-system migration role cannot touch objects outside its schema", async () => {
    const statements = [`SET LOCAL ROLE ${quoteIdent(owner)}`];
    for (const attack of [
      `CREATE TABLE ${quoteIdent(canary)}.x (v text)`,
      `DROP TABLE ${quoteIdent(canary)}.t`,
      `DROP SCHEMA ${quoteIdent(canary)} CASCADE`,
      `CREATE SCHEMA ${quoteIdent(`${canary}_2`)}`,
    ]) {
      await expect(
        sql.begin(async (tx) => {
          for (const s of [...statements, attack]) await tx.unsafe(s);
        }),
      ).rejects.toThrow(/permission denied|must be owner/);
    }
    expect(await sql`select v from ${sql(canary)}.t`).toEqual([{ v: "alive" }]);
  });
});
