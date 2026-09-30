import { describe, expect, test } from "vitest";
import {
  type ApplyOpsResult,
  type AppSpec,
  applyOps,
  emptySpec,
  LruIdempotencyStore,
  MAX_BATCH,
  OP_NAMES,
  type OpsError,
} from "../src/index.js";
import { miniSpec } from "./helpers.js";

function ok(r: ApplyOpsResult): AppSpec {
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r.spec;
}
function errs(r: ApplyOpsResult): OpsError[] {
  if (r.ok) throw new Error("expected errors");
  return r.errors;
}
const run = (ops: unknown[], spec: AppSpec = miniSpec()) => applyOps(spec, ops, 0);

type OpCase = {
  success: { ops: unknown[]; check: (s: AppSpec) => void };
  failure: { ops: unknown[]; code: OpsError["code"]; path: string };
};

const field = { name: "due", label: "Срок", type: "date" };

// Every op from specs/appspec/ops.yaml: one success and one error case.
const opCases: Record<string, OpCase> = {
  set_app: {
    success: {
      ops: [{ op: "set_app", name: "Новое", description: "Описание" }],
      check: (s) => expect(s.app).toMatchObject({ name: "Новое", description: "Описание", locale: "ru" }),
    },
    failure: { ops: [{ op: "set_app", name: "" }], code: "SCHEMA_INVALID", path: "/ops/0/name" },
  },
  set_theme: {
    success: {
      ops: [{ op: "set_theme", accent: "#112233", radius: 16 }],
      check: (s) => expect(s.theme).toEqual({ accent: "#112233", radius: 16 }),
    },
    failure: { ops: [{ op: "set_theme", radius: 3 }], code: "SCHEMA_INVALID", path: "/ops/0/radius" },
  },
  add_entity: {
    success: {
      ops: [
        {
          op: "add_entity",
          name: "project",
          label: "Проект",
          fields: [{ name: "title", label: "Название", type: "string" }],
        },
      ],
      check: (s) => expect(s.entities.map((e) => e.name)).toContain("project"),
    },
    failure: {
      ops: [
        { op: "add_entity", name: "task", label: "Дубль", fields: [{ name: "a", label: "А", type: "int" }] },
      ],
      code: "DUPLICATE_NAME",
      path: "/ops/0/name",
    },
  },
  update_entity: {
    success: {
      ops: [
        {
          op: "update_entity",
          name: "task",
          label: "Задание",
          ownerField: null,
          retention: { deleteAfterDays: 90 },
        },
      ],
      check: (s) =>
        expect(s.entities[0]).toMatchObject({ label: "Задание", retention: { deleteAfterDays: 90 } }),
    },
    failure: {
      ops: [{ op: "update_entity", name: "project", label: "Х" }],
      code: "UNKNOWN_ENTITY",
      path: "/ops/0/name",
    },
  },
  remove_entity: {
    success: {
      ops: [{ op: "remove_entity", name: "comment" }],
      check: (s) => {
        expect(s.entities.map((e) => e.name)).toEqual(["task"]);
        expect(s.permissions.some((p) => p.entity === "comment")).toBe(false);
      },
    },
    failure: {
      ops: [{ op: "remove_entity", name: "task" }],
      code: "REF_TARGET_MISSING",
      path: "/entities/0/fields/0/ref/entity",
    },
  },
  add_field: {
    success: {
      ops: [{ op: "add_field", entity: "task", field }],
      check: (s) => expect(s.entities[0]?.fields.at(-1)).toEqual(field),
    },
    failure: {
      ops: [{ op: "add_field", entity: "project", field }],
      code: "UNKNOWN_ENTITY",
      path: "/ops/0/entity",
    },
  },
  update_field: {
    success: {
      ops: [
        {
          op: "update_field",
          entity: "task",
          name: "points",
          patch: { label: "Очки", max: null, required: true, default: 1 },
        },
      ],
      check: (s) =>
        expect(s.entities[0]?.fields[3]).toEqual({
          name: "points",
          label: "Очки",
          type: "int",
          min: 0,
          required: true,
          default: 1,
        }),
    },
    failure: {
      ops: [{ op: "update_field", entity: "task", name: "nope", patch: { label: "Х" } }],
      code: "UNKNOWN_FIELD",
      path: "/ops/0/name",
    },
  },
  remove_field: {
    success: {
      ops: [{ op: "remove_field", entity: "task", name: "email" }],
      check: (s) => expect(s.entities[0]?.fields.map((f) => f.name)).not.toContain("email"),
    },
    failure: {
      ops: [{ op: "remove_field", entity: "task", name: "owner" }],
      code: "UNKNOWN_FIELD",
      path: "/entities/0/ownerField",
    },
  },
  add_role: {
    success: {
      ops: [{ op: "add_role", name: "boss", label: "Руководитель", access: "login", isAdmin: true }],
      check: (s) => expect(s.roles.map((r) => r.name)).toContain("boss"),
    },
    failure: {
      ops: [{ op: "add_role", name: "visitor", label: "Посетитель", access: "public" }],
      code: "LIMIT_EXCEEDED",
      path: "/roles/2/access",
    },
  },
  update_role: {
    success: {
      ops: [{ op: "update_role", name: "worker", patch: { label: "Работник", loginMethods: ["telegram"] } }],
      check: (s) => expect(s.roles[1]).toMatchObject({ label: "Работник", loginMethods: ["telegram"] }),
    },
    failure: {
      ops: [{ op: "update_role", name: "boss", patch: { label: "Х" } }],
      code: "UNKNOWN_ROLE",
      path: "/ops/0/name",
    },
  },
  remove_role: {
    success: {
      ops: [
        { op: "remove_role", name: "guest" },
        { op: "update_page", route: "/", patch: { roles: ["worker"] } },
        { op: "set_acceptance", acceptance: [] },
      ],
      check: (s) => {
        expect(s.roles.map((r) => r.name)).toEqual(["worker"]);
        expect(s.permissions.some((p) => p.role === "guest")).toBe(false);
      },
    },
    failure: {
      ops: [{ op: "remove_role", name: "worker" }],
      code: "UNKNOWN_ROLE",
      path: "/functions/0/roles/0",
    },
  },
  set_permission: {
    success: {
      ops: [
        { op: "set_permission", role: "guest", entity: "comment", ops: ["read"] },
        { op: "set_permission", role: "worker", entity: "task", ops: ["read"] },
      ],
      check: (s) => {
        expect(s.permissions).toHaveLength(4);
        expect(s.permissions[1]).toEqual({ role: "worker", entity: "task", ops: ["read"] });
      },
    },
    failure: {
      ops: [{ op: "set_permission", role: "guest", entity: "comment", ops: ["delete"] }],
      code: "INVALID_ROW_FILTER",
      path: "/permissions/3/ops",
    },
  },
  remove_permission: {
    success: {
      ops: [{ op: "remove_permission", role: "worker", entity: "comment" }],
      check: (s) => expect(s.permissions).toHaveLength(2),
    },
    failure: {
      ops: [{ op: "remove_permission", role: "boss", entity: "task" }],
      code: "UNKNOWN_ROLE",
      path: "/ops/0/role",
    },
  },
  add_workflow: {
    success: {
      ops: [
        {
          op: "add_workflow",
          workflow: {
            name: "daily",
            trigger: { type: "schedule", cron: "0 9 * * *" },
            steps: [{ type: "notify" }],
          },
        },
      ],
      check: (s) => expect(s.workflows?.map((w) => w.name)).toEqual(["wf", "daily"]),
    },
    failure: {
      ops: [
        {
          op: "add_workflow",
          workflow: { name: "wf", trigger: { type: "manual" }, steps: [{ type: "wait" }] },
        },
      ],
      code: "DUPLICATE_NAME",
      path: "/ops/0/workflow/name",
    },
  },
  update_workflow: {
    success: {
      ops: [
        {
          op: "update_workflow",
          name: "wf",
          workflow: { name: "wf", trigger: { type: "manual" }, steps: [{ type: "wait" }] },
        },
      ],
      check: (s) => expect(s.workflows?.[0]?.trigger).toEqual({ type: "manual" }),
    },
    failure: {
      ops: [
        {
          op: "update_workflow",
          name: "nope",
          workflow: { name: "nope", trigger: { type: "manual" }, steps: [{ type: "wait" }] },
        },
      ],
      code: "SCHEMA_INVALID",
      path: "/ops/0/name",
    },
  },
  remove_workflow: {
    success: { ops: [{ op: "remove_workflow", name: "wf" }], check: (s) => expect(s.workflows).toEqual([]) },
    failure: { ops: [{ op: "remove_workflow", name: "nope" }], code: "SCHEMA_INVALID", path: "/ops/0/name" },
  },
  add_integration: {
    success: {
      ops: [
        {
          op: "add_integration",
          integration: {
            name: "pay",
            connector: "yookassa",
            config: { shopId: "1", secretKey: "secret://yk" },
            secretRefs: ["secret://yk"],
          },
        },
      ],
      check: (s) => expect(s.integrations).toHaveLength(2),
    },
    failure: {
      ops: [
        {
          op: "add_integration",
          integration: { name: "pay", connector: "yookassa", config: { secretKey: "live_abc" } },
        },
      ],
      code: "SCHEMA_INVALID",
      path: "/integrations/1/config/secretKey",
    },
  },
  update_integration: {
    success: {
      ops: [{ op: "update_integration", name: "mail", patch: { config: { from: "c@d.ru" } } }],
      check: (s) => expect(s.integrations?.[0]?.config).toEqual({ from: "c@d.ru" }),
    },
    failure: {
      ops: [{ op: "update_integration", name: "nope", patch: {} }],
      code: "SCHEMA_INVALID",
      path: "/ops/0/name",
    },
  },
  remove_integration: {
    success: {
      ops: [{ op: "remove_integration", name: "mail" }],
      check: (s) => expect(s.integrations).toEqual([]),
    },
    failure: {
      ops: [{ op: "remove_integration", name: "nope" }],
      code: "SCHEMA_INVALID",
      path: "/ops/0/name",
    },
  },
  add_function: {
    success: {
      ops: [
        {
          op: "add_function",
          name: "closeTask",
          kind: "mutation",
          file: "functions/closeTask.ts",
          public: true,
          roles: ["worker"],
        },
      ],
      check: (s) => expect(s.functions?.map((f) => f.name)).toEqual(["stats", "closeTask"]),
    },
    failure: {
      ops: [
        {
          op: "add_function",
          name: "closeTask",
          kind: "mutation",
          file: "functions/closeTask.ts",
          roles: ["boss"],
        },
      ],
      code: "UNKNOWN_ROLE",
      path: "/functions/1/roles/0",
    },
  },
  remove_function: {
    success: {
      ops: [{ op: "remove_function", name: "stats" }],
      check: (s) => expect(s.functions).toEqual([]),
    },
    failure: { ops: [{ op: "remove_function", name: "nope" }], code: "SCHEMA_INVALID", path: "/ops/0/name" },
  },
  add_page: {
    success: {
      ops: [
        {
          op: "add_page",
          route: "/tasks/:id",
          title: "Задача",
          file: "ui/Task.tsx",
          roles: ["worker"],
          nav: false,
        },
      ],
      check: (s) => expect(s.pages).toHaveLength(2),
    },
    failure: {
      ops: [{ op: "add_page", route: "/", title: "Дубль", file: "ui/X.tsx", roles: ["guest"] }],
      code: "DUPLICATE_NAME",
      path: "/ops/0/route",
    },
  },
  update_page: {
    success: {
      ops: [{ op: "update_page", route: "/", patch: { route: "/home", title: "Дом" } }],
      check: (s) => expect(s.pages?.[0]).toMatchObject({ route: "/home", title: "Дом" }),
    },
    failure: {
      ops: [{ op: "update_page", route: "/nope", patch: { title: "Х" } }],
      code: "SCHEMA_INVALID",
      path: "/ops/0/route",
    },
  },
  remove_page: {
    success: { ops: [{ op: "remove_page", route: "/" }], check: (s) => expect(s.pages).toEqual([]) },
    failure: { ops: [{ op: "remove_page", route: "/nope" }], code: "SCHEMA_INVALID", path: "/ops/0/route" },
  },
  add_ai_action: {
    success: {
      ops: [
        {
          op: "add_ai_action",
          aiAction: {
            name: "summary",
            kind: "generate",
            input: { entity: "task" },
            output: { field: "title" },
            tier: "T0",
          },
        },
      ],
      check: (s) => expect(s.aiActions).toHaveLength(1),
    },
    failure: {
      ops: [
        {
          op: "add_ai_action",
          aiAction: { name: "summary", kind: "generate", input: { entity: "project" }, output: {} },
        },
      ],
      code: "UNKNOWN_ENTITY",
      path: "/aiActions/0/input/entity",
    },
  },
  set_acceptance: {
    success: {
      ops: [
        {
          op: "set_acceptance",
          acceptance: [
            {
              id: "AC7",
              text: "Сотрудник создаёт задачу",
              check: { type: "permission", role: "worker", entity: "task", op: "create", expect: "allow" },
            },
          ],
        },
      ],
      check: (s) => expect(s.acceptance?.map((a) => a.id)).toEqual(["AC7"]),
    },
    failure: {
      ops: [{ op: "set_acceptance", acceptance: [{ id: "A1", text: "x", check: { type: "scenario" } }] }],
      code: "SCHEMA_INVALID",
      path: "/ops/0/acceptance/0/id",
    },
  },
  set_compliance: {
    success: {
      ops: [{ op: "set_compliance", operatorName: "ООО «Ромашка»" }],
      check: (s) => expect(s.compliance).toEqual({ consentText: "Согласен", operatorName: "ООО «Ромашка»" }),
    },
    failure: {
      ops: [{ op: "set_compliance", policyPage: "/privacy" }],
      code: "SCHEMA_INVALID",
      path: "/ops/0/policyPage",
    },
  },
};

describe("every op has a success and an error test", () => {
  test("case table covers all ops", () => {
    expect(Object.keys(opCases).sort()).toEqual([...OP_NAMES].sort());
  });

  describe.each(Object.entries(opCases))("%s", (_name, c) => {
    test("success", () => {
      const r = run(c.success.ops);
      c.success.check(ok(r));
      if (r.ok) expect(r.version).toBe(1);
    });
    test("error", () => {
      const e = errs(run(c.failure.ops));
      expect(e.map((x) => `${x.code} ${x.path}`)).toContain(`${c.failure.code} ${c.failure.path}`);
      for (const x of e) expect(x.message).toMatch(/[а-яё]/i);
    });
  });
});

describe("applyOps batch semantics", () => {
  test("atomic: a failing op leaves nothing applied and the input untouched", () => {
    const spec = miniSpec();
    const before = structuredClone(spec);
    const e = errs(
      applyOps(
        spec,
        [
          { op: "set_app", name: "Изменено" },
          { op: "remove_workflow", name: "nope" },
        ],
        0,
      ),
    );
    expect(e[0]?.path).toBe("/ops/1/name");
    expect(spec).toEqual(before);
  });

  test("atomic: invalid final spec rejects the whole batch", () => {
    const spec = miniSpec();
    const e = errs(
      applyOps(
        spec,
        [
          { op: "add_field", entity: "task", field },
          { op: "add_role", name: "order", label: "Х", access: "login" },
        ],
        0,
      ),
    );
    expect(e).toEqual([expect.objectContaining({ code: "RESERVED_NAME", path: "/roles/2/name" })]);
    expect(spec.entities[0]?.fields).toHaveLength(5);
  });

  test("ops within a batch see earlier ops", () => {
    const s = ok(
      run([
        {
          op: "add_entity",
          name: "project",
          label: "Проект",
          fields: [{ name: "title", label: "Название", type: "string" }],
        },
        {
          op: "add_field",
          entity: "task",
          field: { name: "project", label: "Проект", type: "ref", ref: { entity: "project" } },
        },
        { op: "set_permission", role: "worker", entity: "project", ops: ["read"] },
      ]),
    );
    expect(s.entities.map((e) => e.name)).toEqual(["task", "comment", "project"]);
  });

  test("first batch from emptySpec", () => {
    const r = applyOps(
      emptySpec("Пусто"),
      [{ op: "add_role", name: "member", label: "Участник", access: "login" }],
      0,
    );
    expect(ok(r).roles).toHaveLength(1);
    expect(errs(applyOps(emptySpec("Пусто"), [], 0))[0]).toMatchObject({
      code: "SCHEMA_INVALID",
      path: "/roles",
    });
  });

  test("VERSION_CONFLICT when expectedVersion differs", () => {
    const e = errs(applyOps(miniSpec(), [{ op: "set_app", name: "Х" }], 2, { currentVersion: 3 }));
    expect(e).toEqual([expect.objectContaining({ code: "VERSION_CONFLICT", path: "" })]);
    const r = applyOps(miniSpec(), [{ op: "set_app", name: "Х" }], 3, {
      currentVersion: 3,
      author: "user",
      runId: "run1",
    });
    expect(r.ok && r.version).toBe(4);
    expect(r.ok && r.revision).toMatchObject({
      version: 4,
      parentVersion: 3,
      author: "user",
      runId: "run1",
      ops: [{ op: "set_app", name: "Х" }],
    });
  });

  test("BATCH_TOO_LARGE above 50 ops", () => {
    const ops = Array.from({ length: MAX_BATCH + 1 }, () => ({ op: "set_app", name: "Х" }));
    expect(errs(run(ops))).toEqual([expect.objectContaining({ code: "BATCH_TOO_LARGE", path: "/ops" })]);
    expect(run(ops.slice(0, MAX_BATCH)).ok).toBe(true);
  });

  test("unknown op lists allowed op names", () => {
    const e = errs(run([{ op: "rename_entity", name: "task" }]));
    expect(e[0]).toMatchObject({ code: "SCHEMA_INVALID", path: "/ops/0/op" });
    expect(e[0]?.allowed).toEqual(expect.arrayContaining(["add_entity", "set_compliance"]));
  });

  test("update_field cannot change type", () => {
    const e = errs(run([{ op: "update_field", entity: "task", name: "points", patch: { type: "decimal" } }]));
    expect(e[0]).toMatchObject({
      code: "SCHEMA_INVALID",
      path: "/ops/0/patch/type",
      hint: expect.stringContaining("remove_field"),
    });
  });

  test("DESTRUCTIVE_IN_PROD for remove_entity/remove_field/remove_role in prod", () => {
    for (const op of [
      { op: "remove_entity", name: "comment" },
      { op: "remove_field", entity: "task", name: "email" },
      { op: "remove_role", name: "guest" },
    ]) {
      const e = errs(applyOps(miniSpec(), [op], 0, { env: "prod" }));
      expect(e).toEqual([expect.objectContaining({ code: "DESTRUCTIVE_IN_PROD", path: "/ops/0/op" })]);
    }
    expect(
      applyOps(miniSpec(), [{ op: "remove_field", entity: "task", name: "email" }], 0, { env: "draft" }).ok,
    ).toBe(true);
    expect(applyOps(miniSpec(), [{ op: "add_field", entity: "task", field }], 0, { env: "prod" }).ok).toBe(
      true,
    );
  });

  test("idempotency: same key returns the previous result, even though the version moved", () => {
    const store = new LruIdempotencyStore(2);
    const first = applyOps(miniSpec(), [{ op: "set_app", name: "Один" }], 0, { idempotencyKey: "k1", store });
    const again = applyOps(miniSpec(), [{ op: "set_app", name: "Один" }], 0, {
      idempotencyKey: "k1",
      store,
      currentVersion: 1,
    });
    expect(again).toBe(first);
    // failures are not cached
    const bad = applyOps(miniSpec(), [{ op: "remove_page", route: "/x" }], 0, {
      idempotencyKey: "k2",
      store,
    });
    expect(bad.ok).toBe(false);
    expect(store.get("k2")).toBeUndefined();
    // LRU eviction
    applyOps(miniSpec(), [{ op: "set_app", name: "Два" }], 0, { idempotencyKey: "k3", store });
    applyOps(miniSpec(), [{ op: "set_app", name: "Три" }], 0, { idempotencyKey: "k4", store });
    expect(store.size).toBe(2);
    expect(store.get("k1")).toBeUndefined();
  });

  test("default in-memory store is used when none is injected", () => {
    const key = `k-${Math.random()}`;
    const a = applyOps(miniSpec(), [{ op: "set_app", name: "А" }], 0, { idempotencyKey: key });
    expect(applyOps(miniSpec(), [], 5, { idempotencyKey: key })).toBe(a);
  });
});
