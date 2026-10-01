import { describe, expect, test } from "vitest";
import {
  type AppSpec,
  applyOps,
  dropSystemRoleDDL,
  FIELD_TYPES,
  type Field,
  type MigrationPlan,
  planMigration,
  type StepKind,
  SYSTEM_TABLES,
  systemRoleName,
  toDDL,
  toRLS,
  toSystemRoleDDL,
} from "../src/index.js";
import { forumSpec, miniSpec } from "./helpers.js";

const S = "app_unit_draft";

function next(spec: AppSpec, ops: unknown[]): AppSpec {
  const r = applyOps(spec, ops, 0);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}
const kinds = (p: MigrationPlan) => p.steps.map((s) => s.kind);
const destructiveKinds = (p: MigrationPlan) => p.destructive.map((s) => s.kind);

function withField(field: Field): AppSpec {
  return next(miniSpec(), [{ op: "add_field", entity: "task", field }]);
}

describe("planMigration", () => {
  test("fresh schema: create_schema first, tables before FKs, set_rls last, additive", () => {
    const plan = planMigration(null, forumSpec(), { env: "prod" });
    const k = kinds(plan);
    expect(k[0]).toBe("create_schema");
    expect(k.at(-1)).toBe("set_rls");
    expect(k.lastIndexOf("create_table")).toBeLessThan(k.indexOf("add_fk"));
    expect(plan).toMatchObject({ additiveOnly: true, destructive: [], errors: [] });
  });

  test("no changes → only set_rls", () => {
    expect(kinds(planMigration(miniSpec(), miniSpec()))).toEqual(["set_rls"]);
  });

  const diffs: [string, unknown[], StepKind[], boolean][] = [
    [
      "add optional field",
      [{ op: "add_field", entity: "task", field: { name: "due", label: "Срок", type: "date" } }],
      ["add_column"],
      true,
    ],
    [
      "add entity",
      [
        {
          op: "add_entity",
          name: "tag",
          label: "Метка",
          fields: [{ name: "task", label: "Задача", type: "ref", ref: { entity: "task" } }],
        },
      ],
      ["create_table", "add_fk", "add_index", "add_index"],
      true,
    ],
    ["remove field", [{ op: "remove_field", entity: "task", name: "email" }], ["drop_column"], false],
    ["remove entity", [{ op: "remove_entity", name: "comment" }], ["drop_table"], false],
    [
      "enum value added",
      [
        {
          op: "update_field",
          entity: "task",
          name: "state",
          patch: {
            enum: [
              { value: "todo", label: "К" },
              { value: "done", label: "Г" },
              { value: "wip", label: "В" },
            ],
          },
        },
      ],
      ["alter_enum_add_value"],
      true,
    ],
    [
      "enum value removed",
      [
        {
          op: "update_field",
          entity: "task",
          name: "state",
          patch: { enum: [{ value: "todo", label: "К" }] },
        },
      ],
      ["alter_check"],
      false,
    ],
    [
      "maxLength widened",
      [{ op: "update_field", entity: "task", name: "title", patch: { maxLength: 1000 } }],
      ["relax_check"],
      true,
    ],
    [
      "maxLength narrowed",
      [{ op: "update_field", entity: "task", name: "title", patch: { maxLength: 10 } }],
      ["alter_check"],
      false,
    ],
    [
      "max removed",
      [{ op: "update_field", entity: "task", name: "points", patch: { max: null } }],
      ["relax_check"],
      true,
    ],
    [
      "min raised",
      [{ op: "update_field", entity: "task", name: "points", patch: { min: 5 } }],
      ["alter_check"],
      false,
    ],
    [
      "required relaxed",
      [{ op: "update_field", entity: "task", name: "title", patch: { required: false } }],
      ["relax_not_null"],
      true,
    ],
    [
      "required tightened",
      [{ op: "update_field", entity: "task", name: "points", patch: { required: true } }],
      ["set_not_null"],
      false,
    ],
    [
      "unique added",
      [{ op: "update_field", entity: "task", name: "email", patch: { unique: true } }],
      ["add_unique"],
      true,
    ],
    [
      "default changed",
      [{ op: "update_field", entity: "task", name: "points", patch: { default: 3 } }],
      ["set_default"],
      true,
    ],
    [
      "index added",
      [{ op: "update_entity", name: "task", indexes: [{ fields: ["state", "created_at"] }] }],
      ["add_index"],
      true,
    ],
    [
      "type changed (remove+add)",
      [
        { op: "remove_field", entity: "task", name: "points" },
        { op: "add_field", entity: "task", field: { name: "points", label: "Баллы", type: "decimal" } },
      ],
      ["alter_column_type"],
      false,
    ],
    [
      "ref target changed",
      [
        {
          op: "add_entity",
          name: "project",
          label: "Проект",
          fields: [{ name: "title", label: "Н", type: "string" }],
        },
        { op: "remove_field", entity: "comment", name: "task" },
        {
          op: "add_field",
          entity: "comment",
          field: { name: "task", label: "Задача", type: "ref", ref: { entity: "project" } },
        },
      ],
      ["drop_fk", "create_table", "relax_not_null", "add_fk", "add_index"],
      false,
    ],
  ];

  test.each(diffs)("%s", (_name, ops, expected, additive) => {
    const plan = planMigration(miniSpec(), next(miniSpec(), ops), { env: "draft" });
    expect(kinds(plan).filter((k) => k !== "set_rls")).toEqual(expected);
    expect(plan.additiveOnly).toBe(additive);
    expect(plan.errors).toEqual([]);
    const prod = planMigration(miniSpec(), next(miniSpec(), ops), { env: "prod" });
    expect(prod.errors.every((e) => e.code === "DESTRUCTIVE_IN_PROD")).toBe(true);
    expect(prod.errors.length).toBe(additive ? 0 : prod.destructive.length);
    if (!additive) expect(() => toDDL(prod, S)).toThrow(/DESTRUCTIVE_IN_PROD/);
    else expect(toDDL(prod, S).length).toBeGreaterThan(1);
  });

  test("destructive steps are listed", () => {
    const plan = planMigration(
      miniSpec(),
      next(miniSpec(), [
        { op: "remove_entity", name: "comment" },
        { op: "remove_field", entity: "task", name: "email" },
      ]),
      { env: "prod" },
    );
    expect(destructiveKinds(plan).sort()).toEqual(["drop_column", "drop_table"]);
    expect(plan.errors.map((e) => e.code)).toEqual(["DESTRUCTIVE_IN_PROD", "DESTRUCTIVE_IN_PROD"]);
    expect(plan.errors[0]?.message_ru).toMatch(/запрещён в prod/);
  });

  test("invalid next spec surfaces validation errors and blocks toDDL", () => {
    const bad = structuredClone(miniSpec());
    (bad.permissions[0] as { role: string }).role = "boss";
    const plan = planMigration(miniSpec(), bad);
    expect(plan.errors[0]?.code).toBe("UNKNOWN_ROLE");
    expect(() => toDDL(plan, S)).toThrow(/UNKNOWN_ROLE/);
  });
});

describe("toDDL", () => {
  test("new required column: nullable + DEFAULT backfill + SET NOT NULL only with a default", () => {
    const withDefault = toDDL(
      planMigration(
        miniSpec(),
        withField({ name: "score", label: "Оценка", type: "int", required: true, default: 0 }),
        { env: "prod" },
      ),
      S,
    );
    expect(withDefault).toContain(`ALTER TABLE "${S}"."task" ADD COLUMN "score" bigint DEFAULT 0`);
    expect(withDefault).toContain(`ALTER TABLE "${S}"."task" ALTER COLUMN "score" SET NOT NULL`);
    const noDefault = toDDL(
      planMigration(miniSpec(), withField({ name: "score", label: "Оценка", type: "int", required: true }), {
        env: "prod",
      }),
      S,
    );
    expect(noDefault.some((s) => s.includes("SET NOT NULL"))).toBe(false);
  });

  test("starts with SET LOCAL lock_timeout and uses fully qualified names only", () => {
    const ddl = toDDL(planMigration(null, forumSpec()), S, { runtimeRole: "rt" });
    expect(ddl[0]).toBe("SET LOCAL lock_timeout = '3s'");
    for (const stmt of ddl) {
      expect(stmt).not.toMatch(/\b(TABLE|ON|REFERENCES|INTO|UPDATE)\s+"[^"]+"(?!\.)/);
      expect(stmt).not.toMatch(/\b(BEGIN|COMMIT);?$/);
    }
  });

  test("system columns and type mapping", () => {
    const fields: Field[] = FIELD_TYPES.map((type) => ({
      name: `f_${type}`,
      label: type,
      type,
      ...(type === "enum" ? { enum: [{ value: "a", label: "А" }] } : {}),
      ...(type === "ref" ? { ref: { entity: "comment", onDelete: "set_null" as const } } : {}),
    }));
    const spec = next(miniSpec(), [{ op: "add_entity", name: "all_types", label: "Все типы", fields }]);
    const create =
      toDDL(planMigration(null, spec), S).find((s) => s.startsWith(`CREATE TABLE "${S}"."all_types"`)) ?? "";
    expect(create).toContain(`"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()`);
    expect(create).toContain(`"created_at" timestamptz NOT NULL DEFAULT now()`);
    expect(create).toContain(`"updated_at" timestamptz`);
    expect(create).toContain(`"created_by" uuid`);
    const expected: Record<string, string> = {
      string: "text",
      text: "text",
      int: "bigint",
      decimal: "numeric(18,6)",
      money: "numeric(14,2)",
      bool: "boolean",
      date: "date",
      datetime: "timestamptz",
      enum: "text",
      ref: "uuid",
      file: "text",
      json: "jsonb",
      email: "text",
      phone: "text",
      url: "text",
      qr_token: "text",
    };
    for (const [type, sql] of Object.entries(expected)) expect(create).toContain(`"f_${type}" ${sql}`);
    expect(create).toContain(`CHECK (char_length("f_string") <= 255)`);
    expect(create).not.toContain(`char_length("f_text")`);
    expect(create).toContain(`CHECK ("f_enum" IN ('a'))`);
    for (const t of ["email", "phone", "url"])
      expect(create).toMatch(new RegExp(`"ck_f_${t}_fmt" CHECK \\("f_${t}" ~ '`));
    expect(create).toMatch(/"f_qr_token" text CONSTRAINT "uq_all_types\$f_qr_token" UNIQUE/);
    const all = toDDL(planMigration(null, spec), S).join("\n");
    expect(all).toContain(`FOREIGN KEY ("f_ref") REFERENCES "${S}"."comment" ("id") ON DELETE SET NULL`);
  });

  test("refs to users reference the system users table; long constraint names are hashed to ≤63 chars", () => {
    const long = `a${"b".repeat(39)}`;
    const spec = next(miniSpec(), [
      {
        op: "add_entity",
        name: long,
        label: "Длинное",
        fields: [{ name: long, label: "Поле", type: "string", unique: true }],
        indexes: [{ fields: [long, "created_at"], unique: true }],
      },
    ]);
    const ddl = toDDL(planMigration(null, spec), S).join("\n");
    expect(ddl).toContain(`FOREIGN KEY ("owner") REFERENCES "${S}"."users" ("id") ON DELETE RESTRICT`);
    for (const m of ddl.matchAll(/(?:CONSTRAINT|INDEX IF NOT EXISTS) "([^"]+)"/g))
      expect(m[1]?.length).toBeLessThanOrEqual(63);
  });

  test("implicit indexes on ref fields, ownerField and created_at", () => {
    const spec = next(miniSpec(), [{ op: "update_entity", name: "comment", ownerField: "created_by" }]);
    const ddl = toDDL(planMigration(null, spec), S);
    for (const [table, col] of [
      ["task", "owner"],
      ["task", "created_at"],
      ["comment", "task"],
      ["comment", "created_by"],
      ["comment", "created_at"],
    ]) {
      expect(ddl).toContain(
        `CREATE INDEX IF NOT EXISTS "ix_${table}$${col}" ON "${S}"."${table}" ("${col}")`,
      );
    }
    const plan = planMigration(miniSpec(), spec);
    expect(plan.steps.filter((x) => x.kind === "add_index")).toEqual([
      expect.objectContaining({ entity: "comment", fields: ["created_by"] }),
    ]);
  });

  test("index and unique names cannot collide across tables (ticket+type_x vs ticket_type+x)", () => {
    const spec = next(miniSpec(), [
      {
        op: "add_entity",
        name: "ticket",
        label: "Билет",
        fields: [{ name: "type_x", label: "Т", type: "string", unique: true }],
        indexes: [{ fields: ["type_x"] }],
      },
      {
        op: "add_entity",
        name: "ticket_type",
        label: "Тип",
        fields: [{ name: "x", label: "Т", type: "string", unique: true }],
        indexes: [{ fields: ["x"] }],
      },
    ]);
    const names = toDDL(planMigration(null, spec), S)
      .flatMap((x) => [...x.matchAll(/(?:CONSTRAINT|INDEX IF NOT EXISTS) "((?:ix|ux|uq)_[^"]+)"/g)])
      .map((m) => m[1]);
    expect(names).toEqual(
      expect.arrayContaining(["ix_ticket$type_x", "ix_ticket_type$x", "uq_ticket$type_x"]),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  test("retention.mode=anonymize keeps pii columns nullable in the database", () => {
    const base = next(miniSpec(), [
      { op: "update_field", entity: "task", name: "email", patch: { required: true } },
      { op: "update_field", entity: "task", name: "title", patch: { pii: "basic" } },
    ]);
    const anon = next(base, [
      { op: "update_entity", name: "task", retention: { deleteAfterDays: 30, mode: "anonymize" } },
    ]);
    const create =
      toDDL(planMigration(null, anon), S).find((x) => x.startsWith(`CREATE TABLE "${S}"."task"`)) ?? "";
    expect(create).toMatch(/"title" text CONSTRAINT/);
    expect(create).toMatch(/"email" text CONSTRAINT/);
    expect(create).not.toMatch(/"email" text NOT NULL/);
    const toAnon = planMigration(base, anon, { env: "prod" });
    expect(
      toAnon.steps.filter((x) => x.kind === "relax_not_null").map((x) => "field" in x && x.field),
    ).toEqual(["title", "email"]);
    expect(toAnon.additiveOnly).toBe(true);
    expect(planMigration(anon, base).steps.filter((x) => x.kind === "set_not_null")).toHaveLength(2);
  });

  test("rejects unsafe schema names", () => {
    expect(() => toDDL(planMigration(null, miniSpec()), 'x"; drop')).toThrow();
    expect(() => toRLS(miniSpec(), "Bad")).toThrow();
  });
});

describe("system role (isolation.yaml#db_access, L3-20)", () => {
  test("name: sys_<key>_<env>_system for app_<key>_<env>, hashed past 63 bytes, invalid names rejected", () => {
    expect(systemRoleName("app_abcdef012345_prod")).toBe("sys_abcdef012345_prod_system");
    expect(systemRoleName("shadow_x")).toBe("sys_shadow_x_system");
    const long = systemRoleName(`app_${"a".repeat(58)}`);
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).not.toBe(systemRoleName(`app_${"a".repeat(57)}b`));
    expect(() => systemRoleName('x"; drop')).toThrow();
  });

  test("no GUC grants system access; without systemRole there is no system policy at all", () => {
    const all = [...toRLS(miniSpec(), S), ...toDDL(planMigration(null, miniSpec()), S)].join("\n");
    expect(all).not.toContain("__system'");
    expect(all).not.toContain('"wz__system"');
    const withRole = toRLS(miniSpec(), S, { systemRole: "sys_x_draft_system" });
    expect(
      withRole
        .filter((x) => x.includes('"wz__system"'))
        .every((x) => x.includes('TO "sys_x_draft_system" USING (true)')),
    ).toBe(true);
    expect(withRole).toContain(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${S}" TO "sys_x_draft_system"`,
    );
    expect(withRole).toContain(`GRANT USAGE ON SCHEMA "${S}" TO "sys_x_draft_system"`);
  });

  test("toSystemRoleDDL: idempotent NOLOGIN NOINHERIT NOBYPASSRLS role, members WITH INHERIT FALSE, SET TRUE", () => {
    const ddl = toSystemRoleDDL("app_k_draft", { members: ["wizard_runtime"] });
    expect(ddl[0]).toContain(`CREATE ROLE "sys_k_draft_system" NOLOGIN NOINHERIT`);
    expect(ddl[0]).toContain("NOBYPASSRLS");
    expect(ddl[0]).toContain("IF NOT EXISTS");
    expect(ddl[1]).toBe(`GRANT "sys_k_draft_system" TO "wizard_runtime" WITH INHERIT FALSE, SET TRUE`);
    expect(() => toSystemRoleDDL("app_k_draft", { members: ['x"; drop'] })).toThrow();
    expect(() => toRLS(miniSpec(), S, { systemRole: "Bad Role" })).toThrow();
    expect(dropSystemRoleDDL("app_k_draft")[0]).toContain(`DROP ROLE "sys_k_draft_system"`);
  });
});

describe("toRLS", () => {
  const rls = toRLS(miniSpec(), S, { runtimeRole: "rt", systemRole: "sys_x_draft_system" });

  test("enable + force on every table, stale wz_* policies dropped", () => {
    for (const t of ["task", "comment"]) {
      expect(rls).toContain(`ALTER TABLE "${S}"."${t}" ENABLE ROW LEVEL SECURITY`);
      expect(rls).toContain(`ALTER TABLE "${S}"."${t}" FORCE ROW LEVEL SECURITY`);
    }
    expect(rls.some((s) => s.startsWith("DO $wz$") && s.includes("DROP POLICY"))).toBe(true);
  });

  test("system tables: created with the schema, RLS forced, only the system DB role may access (L3-20)", () => {
    const ddl = toDDL(planMigration(null, miniSpec()), S);
    for (const table of Object.keys(SYSTEM_TABLES)) {
      expect(ddl.some((x) => x.startsWith(`CREATE TABLE IF NOT EXISTS "${S}"."${table}"`))).toBe(true);
      expect(rls).toContain(`ALTER TABLE "${S}"."${table}" FORCE ROW LEVEL SECURITY`);
      expect(rls).toContain(
        `CREATE POLICY "wz__system" ON "${S}"."${table}" AS PERMISSIVE FOR ALL TO "sys_x_draft_system" USING (true) WITH CHECK (true)`,
      );
    }
    expect(ddl.findIndex((x) => x.includes(`"${S}"."users" (`))).toBeLessThan(
      ddl.findIndex((x) => x.startsWith(`CREATE TABLE "${S}"."task"`)),
    );
  });

  test("one policy per (role, op), role from wizard.role, $user.id from wizard.user_id", () => {
    const policies = rls.filter((s) => s.startsWith("CREATE POLICY") && !s.includes("wz__system"));
    expect(policies).toHaveLength(6);
    expect(policies).toContain(
      `CREATE POLICY "wz_worker_update" ON "${S}"."task" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (current_setting('wizard.role', true) = 'worker' AND "owner" = (select nullif(current_setting('wizard.user_id', true), '')::uuid)) WITH CHECK (current_setting('wizard.role', true) = 'worker' AND "owner" = (select nullif(current_setting('wizard.user_id', true), '')::uuid))`,
    );
    expect(policies.some((p) => p.includes("wz_guest_delete"))).toBe(false);
  });

  test("literals and $user.<attr> map to typed predicates", () => {
    const spec = miniSpec();
    (spec.permissions[1] as { rowFilter?: unknown }).rowFilter = {
      state: "todo",
      points: 5,
      title: "$user.email",
    };
    const sql = toRLS(spec, S).join("\n");
    expect(sql).toContain(`"state" = 'todo'`);
    expect(sql).toContain(`"points" = 5`);
    expect(sql).toContain(
      `"title" = (select (nullif(current_setting('wizard.user_attrs', true), '')::jsonb ->> 'email')::text)`,
    );
  });

  test("grants for the runtime role", () => {
    expect(rls.slice(-6, -3)).toEqual([
      `GRANT USAGE ON SCHEMA "${S}" TO "rt"`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${S}" TO "rt"`,
      `GRANT USAGE ON ALL SEQUENCES IN SCHEMA "${S}" TO "rt"`,
    ]);
  });
});
