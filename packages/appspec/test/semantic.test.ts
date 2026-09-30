import { describe, expect, test } from "vitest";
import { type AppSpec, isReservedName, type OpsError, validateSpec } from "../src/index.js";
import { miniSpec } from "./helpers.js";

type Case = [name: string, mutate: (s: AppSpec) => void, code: OpsError["code"], path: string];

function errorsOf(spec: unknown, opts = {}): OpsError[] {
  const r = validateSpec(spec, opts);
  return r.ok ? [] : r.errors;
}

// One row per semantic rule of specs/appspec/ops.yaml (plus structural limits mapped to LIMIT_EXCEEDED).
const cases: Case[] = [
  // 1. unique names, not reserved
  [
    "duplicate entity",
    (s) => s.entities.push(structuredClone(s.entities[0] as never)),
    "DUPLICATE_NAME",
    "/entities/2/name",
  ],
  [
    "duplicate field",
    (s) => s.entities[0]?.fields.push({ name: "title", label: "Т", type: "text" }),
    "DUPLICATE_NAME",
    "/entities/0/fields/5/name",
  ],
  [
    "duplicate role",
    (s) => s.roles.push({ name: "worker", label: "Р", access: "login" }),
    "DUPLICATE_NAME",
    "/roles/2/name",
  ],
  [
    "duplicate enum value",
    (s) => s.entities[0]?.fields[2]?.enum?.push({ value: "todo", label: "Ещё" }),
    "DUPLICATE_NAME",
    "/entities/0/fields/2/enum/2/value",
  ],
  [
    "duplicate permission pair",
    (s) => s.permissions.push({ role: "guest", entity: "task", ops: [] }),
    "DUPLICATE_NAME",
    "/permissions/3",
  ],
  [
    "duplicate page route",
    (s) => s.pages?.push({ route: "/", title: "Т", file: "ui/X.tsx", roles: ["guest"] }),
    "DUPLICATE_NAME",
    "/pages/1/route",
  ],
  [
    "duplicate function",
    (s) => s.functions?.push({ name: "stats", kind: "action", file: "functions/x.ts" }),
    "DUPLICATE_NAME",
    "/functions/1/name",
  ],
  [
    "duplicate workflow",
    (s) => s.workflows?.push({ name: "wf", trigger: { type: "manual" }, steps: [{ type: "wait" }] }),
    "DUPLICATE_NAME",
    "/workflows/1/name",
  ],
  [
    "duplicate acceptance id",
    (s) => s.acceptance?.push({ id: "AC1", text: "x", check: { type: "scenario" } }),
    "DUPLICATE_NAME",
    "/acceptance/1/id",
  ],
  [
    "reserved entity (SQL keyword)",
    (s) => {
      (s.entities[1] as { name: string }).name = "order";
    },
    "RESERVED_NAME",
    "/entities/1/name",
  ],
  [
    "reserved entity users",
    (s) => {
      (s.entities[1] as { name: string }).name = "users";
    },
    "RESERVED_NAME",
    "/entities/1/name",
  ],
  [
    "reserved field (system column)",
    (s) => s.entities[0]?.fields.push({ name: "created_at", label: "С", type: "datetime" }),
    "RESERVED_NAME",
    "/entities/0/fields/5/name",
  ],
  [
    "reserved field (pg system column)",
    (s) => s.entities[0]?.fields.push({ name: "xmin", label: "С", type: "int" }),
    "RESERVED_NAME",
    "/entities/0/fields/5/name",
  ],
  [
    "reserved role",
    (s) => {
      (s.roles[1] as { name: string }).name = "user";
      s.permissions = s.permissions.filter((p) => p.role !== "worker");
      s.functions = [];
    },
    "RESERVED_NAME",
    "/roles/1/name",
  ],
  // 2. refs, ownerField
  [
    "ref target missing",
    (s) => {
      const f = s.entities[1]?.fields[0];
      if (f?.ref) f.ref.entity = "project";
    },
    "REF_TARGET_MISSING",
    "/entities/1/fields/0/ref/entity",
  ],
  [
    "ref without ref object",
    (s) => {
      delete s.entities[1]?.fields[0]?.ref;
    },
    "REF_TARGET_MISSING",
    "/entities/1/fields/0/ref",
  ],
  [
    "ownerField unknown",
    (s) => {
      (s.entities[0] as { ownerField?: string }).ownerField = "boss";
    },
    "UNKNOWN_FIELD",
    "/entities/0/ownerField",
  ],
  [
    "ownerField not a user ref",
    (s) => {
      (s.entities[0] as { ownerField?: string }).ownerField = "title";
    },
    "SCHEMA_INVALID",
    "/entities/0/ownerField",
  ],
  [
    "index on unknown field",
    (s) => {
      (s.entities[0] as { indexes?: unknown }).indexes = [{ fields: ["nope"] }];
    },
    "UNKNOWN_FIELD",
    "/entities/0/indexes/0/fields/0",
  ],
  [
    "retention anchor unknown",
    (s) => {
      (s.entities[0] as { retention?: unknown }).retention = { deleteAfterDays: 5, anchorField: "nope" };
    },
    "UNKNOWN_FIELD",
    "/entities/0/retention/anchorField",
  ],
  [
    "retention anchor not a date",
    (s) => {
      (s.entities[0] as { retention?: unknown }).retention = { deleteAfterDays: 5, anchorField: "title" };
    },
    "SCHEMA_INVALID",
    "/entities/0/retention/anchorField",
  ],
  [
    "enum field without values",
    (s) => {
      delete s.entities[0]?.fields[2]?.enum;
    },
    "SCHEMA_INVALID",
    "/entities/0/fields/2/enum",
  ],
  [
    "min on non-numeric",
    (s) => {
      const f = s.entities[0]?.fields[0];
      if (f) f.min = 1;
    },
    "SCHEMA_INVALID",
    "/entities/0/fields/0/min",
  ],
  [
    "min > max",
    (s) => {
      const f = s.entities[0]?.fields[3];
      if (f) f.min = 500;
    },
    "SCHEMA_INVALID",
    "/entities/0/fields/3/min",
  ],
  [
    "maxLength on int",
    (s) => {
      const f = s.entities[0]?.fields[3];
      if (f) f.maxLength = 5;
    },
    "SCHEMA_INVALID",
    "/entities/0/fields/3/maxLength",
  ],
  [
    "default of wrong type",
    (s) => {
      const f = s.entities[0]?.fields[3];
      if (f) f.default = "10";
    },
    "SCHEMA_INVALID",
    "/entities/0/fields/3/default",
  ],
  [
    "enum default outside values",
    (s) => {
      const f = s.entities[0]?.fields[2];
      if (f) f.default = "later";
    },
    "SCHEMA_INVALID",
    "/entities/0/fields/2/default",
  ],
  [
    "set_null on required ref",
    (s) => {
      const f = s.entities[1]?.fields[0];
      if (f?.ref) f.ref.onDelete = "set_null";
    },
    "SCHEMA_INVALID",
    "/entities/1/fields/0/ref/onDelete",
  ],
  // 3. permission role/entity/fields exist
  [
    "permission unknown role",
    (s) => {
      (s.permissions[0] as { role: string }).role = "boss";
    },
    "UNKNOWN_ROLE",
    "/permissions/0/role",
  ],
  [
    "permission unknown entity",
    (s) => {
      (s.permissions[0] as { entity: string }).entity = "project";
    },
    "UNKNOWN_ENTITY",
    "/permissions/0/entity",
  ],
  [
    "hiddenFields unknown",
    (s) => {
      (s.permissions[0] as { hiddenFields?: string[] }).hiddenFields = ["salary"];
    },
    "UNKNOWN_FIELD",
    "/permissions/0/hiddenFields/0",
  ],
  [
    "readonlyFields unknown",
    (s) => {
      (s.permissions[1] as { readonlyFields?: string[] }).readonlyFields = ["title", "salary"];
    },
    "UNKNOWN_FIELD",
    "/permissions/1/readonlyFields/1",
  ],
  // 4. rowFilter
  [
    "rowFilter unknown field",
    (s) => {
      (s.permissions[1] as { rowFilter?: unknown }).rowFilter = { boss: "$user.id" };
    },
    "INVALID_ROW_FILTER",
    "/permissions/1/rowFilter/boss",
  ],
  [
    "rowFilter bad reference",
    (s) => {
      (s.permissions[1] as { rowFilter?: unknown }).rowFilter = { owner: "$session.id" };
    },
    "INVALID_ROW_FILTER",
    "/permissions/1/rowFilter/owner",
  ],
  [
    "rowFilter literal type mismatch",
    (s) => {
      (s.permissions[1] as { rowFilter?: unknown }).rowFilter = { points: "ten" };
    },
    "INVALID_ROW_FILTER",
    "/permissions/1/rowFilter/points",
  ],
  [
    "rowFilter enum literal outside values",
    (s) => {
      (s.permissions[1] as { rowFilter?: unknown }).rowFilter = { state: "later" };
    },
    "INVALID_ROW_FILTER",
    "/permissions/1/rowFilter/state",
  ],
  [
    "rowFilter $user.display_name (user-editable, L3-20)",
    (s) => {
      (s.permissions[1] as { rowFilter?: unknown }).rowFilter = { title: "$user.display_name" };
    },
    "INVALID_ROW_FILTER",
    "/permissions/1/rowFilter/title",
  ],
  [
    "rowFilter literal with NUL (L3-01)",
    (s) => {
      (s.permissions[1] as { rowFilter?: unknown }).rowFilter = { title: "a\u0000b" };
    },
    "INVALID_ROW_FILTER",
    "/permissions/1/rowFilter/title",
  ],
  [
    "rowFilter ref literal is not a uuid",
    (s) => {
      (s.permissions[1] as { rowFilter?: unknown }).rowFilter = { owner: "'); drop schema platform; --" };
    },
    "INVALID_ROW_FILTER",
    "/permissions/1/rowFilter/owner",
  ],
  [
    "rowFilterOps without rowFilter",
    (s) => {
      Object.assign(s.permissions[2] as object, { rowFilterOps: ["read"] });
    },
    "INVALID_ROW_FILTER",
    "/permissions/2/rowFilterOps",
  ],
  [
    "rowFilterOps not a subset of ops",
    (s) => {
      Object.assign(s.permissions[1] as object, { rowFilterOps: ["update", "delete"] });
    },
    "INVALID_ROW_FILTER",
    "/permissions/1/rowFilterOps/1",
  ],
  [
    "public update not covered by rowFilterOps",
    (s) => {
      Object.assign(s.permissions[0] as object, {
        ops: ["read", "update"],
        rowFilter: { state: "todo" },
        rowFilterOps: ["read"],
      });
    },
    "INVALID_ROW_FILTER",
    "/permissions/0/ops",
  ],
  // SQL values (L3-01): whatever passes validation encodes with sqlLiteral
  [
    "int min is fractional",
    (s) => {
      const f = s.entities[0]?.fields[3];
      if (f) f.min = 0.5;
    },
    "SCHEMA_INVALID",
    "/entities/0/fields/3/min",
  ],
  [
    "string default with NUL",
    (s) => {
      const f = s.entities[0]?.fields[0];
      if (f) f.default = "x\u0000'; drop table x; --";
    },
    "SCHEMA_INVALID",
    "/entities/0/fields/0/default",
  ],
  [
    "date default is not a date",
    (s) => {
      s.entities[1]?.fields.push({ name: "due", label: "Срок", type: "date", default: "2026-02-30" });
    },
    "SCHEMA_INVALID",
    "/entities/1/fields/2/default",
  ],
  [
    "email default does not match the format",
    (s) => {
      const f = s.entities[0]?.fields[4];
      if (f) f.default = "not-an-email";
    },
    "SCHEMA_INVALID",
    "/entities/0/fields/4/default",
  ],
  // 5. public roles
  [
    "two public roles",
    (s) => s.roles.push({ name: "visitor", label: "Посетитель", access: "public" }),
    "LIMIT_EXCEEDED",
    "/roles/2/access",
  ],
  [
    "public update without rowFilter",
    (s) => {
      (s.permissions[0] as { ops: string[] }).ops = ["read", "update"];
    },
    "INVALID_ROW_FILTER",
    "/permissions/0/ops",
  ],
  [
    "public delete with empty rowFilter",
    (s) => {
      Object.assign(s.permissions[0] as object, { ops: ["delete"], rowFilter: {} });
    },
    "INVALID_ROW_FILTER",
    "/permissions/0/ops",
  ],
  // 6. PII
  [
    "pii special",
    (s) => {
      const f = s.entities[0]?.fields[4];
      if (f) f.pii = "special";
    },
    "PII_CATEGORY_FORBIDDEN",
    "/entities/0/fields/4/pii",
  ],
  [
    "pii biometric",
    (s) => {
      const f = s.entities[0]?.fields[4];
      if (f) f.pii = "biometric";
    },
    "PII_CATEGORY_FORBIDDEN",
    "/entities/0/fields/4/pii",
  ],
  // 8. roles referenced by pages/functions/acceptance, entities by workflows
  ["page unknown role", (s) => s.pages?.[0]?.roles.push("boss"), "UNKNOWN_ROLE", "/pages/0/roles/1"],
  [
    "function unknown role",
    (s) => {
      const f = s.functions?.[0];
      if (f) f.roles = ["boss"];
    },
    "UNKNOWN_ROLE",
    "/functions/0/roles/0",
  ],
  [
    "acceptance unknown role",
    (s) => {
      const a = s.acceptance?.[0];
      if (a) a.check.role = "boss";
    },
    "UNKNOWN_ROLE",
    "/acceptance/0/check/role",
  ],
  [
    "acceptance unknown entity",
    (s) => {
      const a = s.acceptance?.[0];
      if (a) a.check.entity = "project";
    },
    "UNKNOWN_ENTITY",
    "/acceptance/0/check/entity",
  ],
  [
    "workflow unknown entity",
    (s) => {
      const w = s.workflows?.[0];
      if (w) w.trigger.entity = "project";
    },
    "UNKNOWN_ENTITY",
    "/workflows/0/trigger/entity",
  ],
  [
    "workflow unknown field",
    (s) => {
      const w = s.workflows?.[0];
      if (w) w.trigger.field = "nope";
    },
    "UNKNOWN_FIELD",
    "/workflows/0/trigger/field",
  ],
  // 9. secrets only as declared refs
  [
    "secret value in config",
    (s) => {
      const i = s.integrations?.[0];
      if (i) i.config = { apiKey: "sk_live_123" };
    },
    "SCHEMA_INVALID",
    "/integrations/0/config/apiKey",
  ],
  [
    "undeclared secret ref",
    (s) => {
      const i = s.integrations?.[0];
      if (i) i.config = { password: "secret://other" };
    },
    "SCHEMA_INVALID",
    "/integrations/0/config/password",
  ],
  // 10. limits (structural maxItems reported as LIMIT_EXCEEDED)
  [
    "too many entities",
    (s) => {
      s.entities = Array.from({ length: 61 }, (_, i) => ({
        name: `e${i}`,
        label: "Е",
        fields: [{ name: "a", label: "А", type: "int" as const }],
      }));
    },
    "LIMIT_EXCEEDED",
    "/entities",
  ],
  [
    "too many fields",
    (s) => {
      (s.entities[1] as { fields: unknown[] }).fields = Array.from({ length: 81 }, (_, i) => ({
        name: `f${i}`,
        label: "П",
        type: "int",
      }));
    },
    "LIMIT_EXCEEDED",
    "/entities/1/fields",
  ],
  [
    "too many pages",
    (s) => {
      s.pages = Array.from({ length: 81 }, (_, i) => ({
        route: `/p${i}`,
        title: "С",
        file: "ui/P.tsx",
        roles: ["guest"],
      }));
    },
    "LIMIT_EXCEEDED",
    "/pages",
  ],
  [
    "too many functions",
    (s) => {
      s.functions = Array.from({ length: 201 }, (_, i) => ({
        name: `f${i}`,
        kind: "query" as const,
        file: `functions/f${i}.ts`,
      }));
    },
    "LIMIT_EXCEEDED",
    "/functions",
  ],
];

describe("semantic rules (ops.yaml#semantic_rules)", () => {
  test.each(cases)("%s → %s", (_name, mutate, code, path) => {
    const spec = miniSpec();
    mutate(spec);
    const errors = errorsOf(spec);
    expect(errors.map((e) => `${e.code} ${e.path}`)).toContain(`${code} ${path}`);
    for (const e of errors) {
      expect(e.message_ru).toMatch(/[а-яё]/i);
      expect(e.path === "" || e.path.startsWith("/")).toBe(true);
    }
  });

  test("allowed lists are provided where applicable", () => {
    const spec = miniSpec();
    (spec.permissions[0] as { role: string }).role = "boss";
    const e = errorsOf(spec).find((x) => x.code === "UNKNOWN_ROLE");
    expect(e?.allowed).toEqual(["guest", "worker"]);
    const s2 = miniSpec();
    const f = s2.entities[0]?.fields[4];
    if (f) f.pii = "special";
    expect(errorsOf(s2)[0]?.allowed).toEqual(["none", "basic"]);
  });

  test("ref to system entity users is allowed, and created_by can be ownerField", () => {
    const spec = miniSpec();
    (spec.entities[1] as { ownerField?: string }).ownerField = "created_by";
    expect(errorsOf(spec)).toEqual([]);
  });

  test("$user.<attr> and literals in rowFilter are accepted", () => {
    const spec = miniSpec();
    (spec.permissions[1] as { rowFilter?: unknown }).rowFilter = {
      owner: "$user.id",
      state: "todo",
      points: 5,
      title: "$user.email",
    };
    expect(errorsOf(spec)).toEqual([]);
  });

  test("secret heuristic: key names ending with a secret word only", () => {
    const flagged = (config: Record<string, unknown>) => {
      const spec = miniSpec();
      const i = spec.integrations?.[0];
      if (i) i.config = config;
      return errorsOf(spec).map((e) => e.path);
    };
    expect(flagged({ tokenField: "qr_token", secretRefsNote: "x", keyId: "1", from: "a@b.ru" })).toEqual([]);
    expect(flagged({ botToken: "123:abc", nested: { client_secret: "x" }, list: [{ apiKey: 5 }] })).toEqual([
      "/integrations/0/config/botToken",
      "/integrations/0/config/nested/client_secret",
      "/integrations/0/config/list/0/apiKey",
    ]);
    expect(flagged({ botToken: "secret://smtp" })).toEqual([]);
  });

  test("login roles need loginMethods, public roles must not have them", () => {
    const spec = miniSpec();
    delete spec.roles[1]?.loginMethods;
    (spec.roles[0] as { loginMethods?: string[] }).loginMethods = ["telegram"];
    expect(errorsOf(spec).map((e) => `${e.code} ${e.path}`)).toEqual([
      "SCHEMA_INVALID /roles/0/loginMethods",
      "SCHEMA_INVALID /roles/1/loginMethods",
    ]);
  });

  test("selfSignup is incompatible with isAdmin", () => {
    const spec = miniSpec();
    Object.assign(spec.roles[1] as object, { selfSignup: true, isAdmin: true });
    expect(errorsOf(spec).map((e) => `${e.code} ${e.path}`)).toEqual(["SCHEMA_INVALID /roles/1/selfSignup"]);
    Object.assign(spec.roles[1] as object, { isAdmin: false });
    expect(errorsOf(spec)).toEqual([]);
  });

  test("SQL-standard words that Postgres does not reserve (session, date) are allowed as names", () => {
    const spec = miniSpec();
    spec.entities.push({
      name: "session",
      label: "Сессия",
      fields: [{ name: "date", label: "Дата", type: "date" }],
    });
    expect(errorsOf(spec)).toEqual([]);
  });

  test("$user.<attr> must be an attribute of the system entity users", () => {
    const spec = miniSpec();
    (spec.permissions[1] as { rowFilter?: unknown }).rowFilter = { title: "$user.salary" };
    const [e] = errorsOf(spec);
    expect(e).toMatchObject({ code: "INVALID_ROW_FILTER", path: "/permissions/1/rowFilter/title" });
    expect(e?.allowed).toContain("$user.telegram_id");
  });

  test("rowFilterOps: a valid subset passes; public update filtered via rowFilterOps passes", () => {
    const spec = miniSpec();
    Object.assign(spec.permissions[1] as object, { rowFilterOps: ["update"] });
    Object.assign(spec.permissions[0] as object, {
      ops: ["read", "update"],
      rowFilter: { state: "todo" },
      rowFilterOps: ["update"],
    });
    expect(errorsOf(spec)).toEqual([]);
  });

  test("hostile but well-formed string values are valid (they are escaped, not rejected)", () => {
    const spec = miniSpec();
    const f = spec.entities[0]?.fields[0];
    if (f) f.default = `'); DROP SCHEMA platform; -- $$ $wz$ \\ E'x' /* ʼ＇ */`;
    (spec.permissions[1] as { rowFilter?: unknown }).rowFilter = { owner: "$user.id", title: `a'b"c;--` };
    expect(errorsOf(spec)).toEqual([]);
  });

  test("public role may update with a rowFilter", () => {
    const spec = miniSpec();
    Object.assign(spec.permissions[0] as object, { ops: ["read", "update"], rowFilter: { state: "todo" } });
    expect(errorsOf(spec)).toEqual([]);
  });

  test("7. pii=basic without retention: opt-in (M2) rule", () => {
    expect(errorsOf(miniSpec())).toEqual([]);
    const errors = errorsOf(miniSpec(), { enforcePiiRetention: true });
    expect(errors.map((e) => `${e.code} ${e.path}`)).toEqual(["SCHEMA_INVALID /entities/0/retention"]);
    const spec = miniSpec();
    (spec.entities[0] as { retention?: unknown }).retention = { deleteAfterDays: 365 };
    expect(errorsOf(spec, { enforcePiiRetention: true })).toEqual([]);
    const waived = miniSpec();
    waived.compliance = { retentionWaiver: { reason: "Храним до отзыва согласия" } };
    expect(errorsOf(waived, { enforcePiiRetention: true })).toEqual([]);
  });

  test("structural errors carry JSON Pointer paths and allowed values", () => {
    const spec = miniSpec() as unknown as { theme: unknown; entities: { fields: { type: string }[] }[] };
    spec.theme = { radius: 5, font: "Arial" };
    const errors = errorsOf(spec);
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_INVALID",
        path: "/theme/radius",
        allowed: ["0", "4", "8", "12", "16"],
      }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ path: "/theme/font", allowed: expect.arrayContaining(["Onest"]) }),
    );
  });

  test("reserved list covers SQL keywords and system fields", () => {
    for (const n of [
      "select",
      "table",
      "group",
      "order",
      "user",
      "role",
      "id",
      "created_by",
      "ctid",
      "pg_x",
    ]) {
      expect(isReservedName(n)).toBe(true);
    }
    for (const n of ["title", "date", "status", "session"]) expect(isReservedName(n)).toBe(false);
  });
});
