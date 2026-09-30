import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  type AppSpec,
  applyOps,
  FIELD_TYPES,
  type Field,
  generateTypes,
  type MigrationPlan,
  planMigration,
  type StepKind,
  toDDL,
  toRLS,
} from "../src/index.js";
import forumFixture from "./fixtures/forum.json" with { type: "json" };
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
      ["create_table", "add_fk", "add_index"],
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
      ["drop_fk", "create_table", "relax_not_null", "add_fk"],
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
    expect(create).toMatch(/"f_qr_token" text CONSTRAINT "uq_all_types_f_qr_token" UNIQUE/);
    const all = toDDL(planMigration(null, spec), S).join("\n");
    expect(all).toContain(`FOREIGN KEY ("f_ref") REFERENCES "${S}"."comment" ("id") ON DELETE SET NULL`);
  });

  test("refs to users get no FK; long constraint names are hashed to ≤63 chars", () => {
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
    expect(ddl).not.toMatch(/REFERENCES "[^"]+"\."users"/);
    for (const m of ddl.matchAll(/(?:CONSTRAINT|INDEX IF NOT EXISTS) "([^"]+)"/g))
      expect(m[1]?.length).toBeLessThanOrEqual(63);
  });

  test("rejects unsafe schema names", () => {
    expect(() => toDDL(planMigration(null, miniSpec()), 'x"; drop')).toThrow();
    expect(() => toRLS(miniSpec(), "Bad")).toThrow();
  });
});

describe("toRLS", () => {
  const rls = toRLS(miniSpec(), S, { runtimeRole: "rt" });

  test("enable + force on every table, stale wz_* policies dropped", () => {
    for (const t of ["task", "comment"]) {
      expect(rls).toContain(`ALTER TABLE "${S}"."${t}" ENABLE ROW LEVEL SECURITY`);
      expect(rls).toContain(`ALTER TABLE "${S}"."${t}" FORCE ROW LEVEL SECURITY`);
    }
    expect(rls.some((s) => s.startsWith("DO $wz$") && s.includes("DROP POLICY"))).toBe(true);
  });

  test("one policy per (role, op), role from wizard.role, $user.id from wizard.user_id", () => {
    const policies = rls.filter((s) => s.startsWith("CREATE POLICY"));
    expect(policies).toHaveLength(6);
    expect(policies).toContain(
      `CREATE POLICY "wz_worker_update" ON "${S}"."task" AS PERMISSIVE FOR UPDATE TO PUBLIC USING (current_setting('wizard.role', true) = 'worker' AND "owner" = nullif(current_setting('wizard.user_id', true), '')::uuid) WITH CHECK (current_setting('wizard.role', true) = 'worker' AND "owner" = nullif(current_setting('wizard.user_id', true), '')::uuid)`,
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
    expect(sql).toContain(`"state" = 'todo'::text`);
    expect(sql).toContain(`"points" = 5`);
    expect(sql).toContain(`"title" = nullif(current_setting('wizard.user_email', true), '')::text`);
  });

  test("grants for the runtime role", () => {
    expect(rls.at(-1)).toBe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${S}" TO "rt"`);
  });
});

describe("generateTypes", () => {
  test("emits row/input interfaces that typecheck", () => {
    const dts = generateTypes(forumFixture as AppSpec);
    expect(dts).toContain("export interface Topic extends SystemFields");
    expect(dts).toContain(`status: "open" | "closed";`);
    expect(dts).toContain("topic: { row: Topic; input: TopicInput };");
    const usage = `
      const t: Topic = { id: "1", created_at: "", updated_at: null, created_by: null, title: "x", body: null,
        author: "u", status: "open", pinned: null };
      const i: TopicInput = { title: "x", author: "u" };
      const e: EntityName = "ban";
      const r: RoleName = "guest";
      // @ts-expect-error unknown enum value
      const bad: Topic["status"] = "archived";
      type Row = DataModel["post"]["row"];
      export const all: [Topic, TopicInput, EntityName, RoleName, Row | null, string] = [t, i, e, r, null, bad];
    `;
    // Generated declarations and their usage in one module (the d.ts is plain type-only TS).
    const files: Record<string, string> = { "/m/usage.ts": `${dts}\n${usage}` };
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
      noLib: true,
    };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = (name, lang) => {
      const text = files[name];
      return text === undefined ? undefined : ts.createSourceFile(name, text, lang);
    };
    host.fileExists = (name) => name in files;
    host.readFile = (name) => files[name];
    const program = ts.createProgram(["/m/usage.ts"], options, host);
    const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.code !== 2318); // noLib: missing global types
    expect(diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  });
});
