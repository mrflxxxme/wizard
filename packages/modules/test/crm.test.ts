// B2-15: «Клиенты с историей» and «Воронка сделок» — compiled fragments (pii, retention, canonical stages, links to
// leads and each other, the person in charge with a staff stand-in), pages, metrics, and G1 with the goal scenarios
// that run as acceptance scenarios: a deal moves through the stages, the client's history shows his leads and deals.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleManifest, PlanErrorCode } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import { type GateReport, runGates } from "@wizard/gates";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type CompileResult,
  type CompileSuccess,
  compiledFingerprint,
  compilePlan,
  dealStages,
  historySources,
  leadSampleData,
  type MatrixRow,
  matrixPlan,
} from "../src/index.js";
import { testRegistry } from "./fixtures.js";

/** «Сотрудники и роли» stand-in (B2-16): the staff role with login, so deals with a person in charge compile. */
const staffStub: ModuleManifest = {
  id: "staff",
  version: 1,
  name: "Сотрудники (тестовая замена)",
  summary: "Роль сотрудника со входом",
  status: "ready",
  order: 8,
  origin: { kind: "new" },
  goals: ["team_work"],
  params: [],
  provides: { roles: ["staff"] },
  fragments: {
    roles: [{ value: { name: "staff", label: "Сотрудник", access: "login", loginMethods: ["email_otp"] } }],
  },
  screens: [
    {
      id: "staff",
      audience: "cabinet",
      route: "/cabinet",
      title: "Сотрудники",
      roles: ["$owner"],
      components: ["CabinetLayout"],
    },
  ],
  metrics: [],
  goalScenarios: [
    {
      id: "GS-staff-1",
      goal: "team_work",
      title: "Сотрудник входит",
      steps: [{ actor: "staff", text: "Входит по коду" }],
      expect: [{ kind: "page_text", text: "Видит рабочие разделы" }],
    },
  ],
  tests: { matrix: [{ name: "по умолчанию", params: {} }], gates: ["G0"] },
};

const registry = testRegistry();
const withStaff = testRegistry([{ manifest: staffStub }]);

const ok = (r: CompileResult): CompileSuccess => {
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
};
const codes = (r: CompileResult): PlanErrorCode[] => (r.ok ? [] : r.errors.map((e) => e.code));
const compile = (id: string, row: MatrixRow, reg = registry) =>
  compilePlan(matrixPlan(reg, id, row), reg, { appName: "Студия" });
const row = (params: Record<string, unknown>, withModules?: string[]): MatrixRow => ({
  name: "тест",
  params,
  ...(withModules ? { withModules } : {}),
});
const entity = (r: CompileSuccess, name: string) => r.spec.entities.find((e) => e.name === name);
const fieldNames = (r: CompileSuccess, name: string) => entity(r, name)?.fields.map((f) => f.name);
const ac = (r: CompileSuccess, text: string) => r.spec.acceptance?.find((a) => a.text.startsWith(text));

describe("client_card", () => {
  const alone = ok(compile("client_card", row({})));

  test("client with personal data marked and retention; notes; no public access", () => {
    const client = entity(alone, "client");
    expect(client?.label).toBe("Клиент");
    expect(client?.fields.map((f) => [f.name, f.pii ?? "none"])).toEqual([
      ["name", "basic"],
      ["phone", "basic"],
      ["email", "basic"],
    ]);
    expect(client?.retention).toEqual({ deleteAfterDays: 1095, anchorField: "updated_at" });
    expect(client?.indexes).toEqual([{ fields: ["phone"] }, { fields: ["email"] }]);
    expect(entity(alone, "client_note")?.fields.find((f) => f.name === "text")?.pii).toBe("basic");
    expect(entity(alone, "client_note")?.retention?.deleteAfterDays).toBe(1095);
    expect(alone.spec.permissions.filter((p) => p.role === "guest")).toEqual([]);
    expect(alone.spec.permissions.map((p) => [p.role, p.entity, p.ops])).toEqual([
      ["owner", "client", ["read", "create", "update", "delete"]],
      ["owner", "client_note", ["read", "create", "update", "delete"]],
    ]);
  });

  test("pages: the role cabinet and «Клиенты и история»; without other modules the history is notes only", () => {
    expect(alone.spec.pages?.map((p) => [p.route, p.roles])).toEqual([
      ["/clients", ["owner"]],
      ["/cabinet", ["owner"]],
      ["/", ["guest", "owner"]],
    ]);
    const page = alone.files["ui/pages/ClientCardHistory.tsx"] ?? "";
    expect(page).toContain('<DataTable entity="client_note" query={{ filter: { client: props.id } }}');
    expect(page).not.toContain('entity="lead"');
    expect(alone.spec.workflows).toBeUndefined();
    expect(alone.spec.functions).toBeUndefined();
    expect(alone.metrics.map((m) => m.id)).toEqual(["new_clients"]);
  });

  test("label, tags as an enum, extra fields, no notes", () => {
    const r = ok(
      compile(
        "client_card",
        row({
          client_label: "Пациент",
          tags: ["Постоянный", "Важный"],
          notes: false,
          extra_fields: [{ name: "company", label: "Компания", type: "string" }],
        }),
      ),
    );
    expect(entity(r, "client")?.label).toBe("Пациент");
    expect(fieldNames(r, "client")).toEqual(["name", "phone", "email", "tag", "company"]);
    expect(entity(r, "client")?.fields.find((f) => f.name === "tag")?.enum).toEqual([
      { value: "tag_1", label: "Постоянный" },
      { value: "tag_2", label: "Важный" },
    ]);
    expect(entity(r, "client_note")).toBeUndefined();
    expect(r.files["ui/pages/ClientCardHistory.tsx"]).not.toContain("client_note");
  });

  test("an extra field named like a module field is rejected before the build", () => {
    const r = compile(
      "client_card",
      row({ extra_fields: [{ name: "phone", label: "Телефон 2", type: "string" }] }),
    );
    expect(codes(r)).toEqual(["FIELD_NAME_CONFLICT"]);
  });

  test("with leads: lead.client, readonly for the visitor, the workflow with match_by, function, scenario", () => {
    const r = ok(compile("client_card", row({ match_by: "email" }, ["leads", "notify"])));
    expect(entity(r, "lead")?.fields.find((f) => f.name === "client")).toEqual({
      name: "client",
      label: "Клиент",
      type: "ref",
      ref: { entity: "client", onDelete: "set_null" },
    });
    expect(r.spec.permissions.find((p) => p.role === "guest" && p.entity === "lead")?.readonlyFields).toEqual(
      ["status", "client"],
    );
    expect(r.spec.workflows?.find((w) => w.name === "client_from_lead")?.steps).toEqual([
      {
        type: "function",
        params: { name: "clientFromLead", args: { id: "$record.id", matchBy: "email", create: true } },
      },
    ]);
    expect(r.spec.functions?.map((f) => [f.name, f.roles])).toEqual([["clientFromLead", ["owner"]]]);
    expect(r.files["functions/client_card/clientFromLead.ts"]).toContain("ctx.db.client.first");
    // The lead form has a phone only (default fields), so the scenario matches by phone.
    expect(JSON.stringify(ac(r, "Две заявки")?.check.steps)).toContain('"where":{"phone":"+79990000001"}');
    expect(r.metrics.map((m) => m.id)).toEqual([
      "new_clients",
      "repeat_lead_clients",
      "leads_count",
      "leads_handled",
    ]);
    expect(historySources(r.spec, "owner").map((s) => [s.entity, s.title])).toEqual([["lead", "Заявки"]]);
    expect(r.scenarios.map((s) => s.id)).toContain("GS-client_card-2");
  });

  test("a required extra field of the client: the lead only finds clients, no scenario, a warning", () => {
    const r = ok(
      compile(
        "client_card",
        row(
          { extra_fields: [{ name: "inn_org", label: "ИНН организации", type: "string", required: true }] },
          ["leads", "notify"],
        ),
      ),
    );
    expect(JSON.stringify(r.spec.workflows)).toContain('"create":false');
    expect(ac(r, "Две заявки")).toBeUndefined();
    expect(r.warnings.join("\n")).toContain("обязательные дополнительные поля");
  });

  test("lead sample data follows the lead form", () => {
    expect(leadSampleData({ form_fields: ["name", "phone", "comment"], contact: "any" })).toEqual({
      name: "Пример клиента",
      phone: "+79990000001",
    });
    expect(leadSampleData({ form_fields: ["comment"], contact: "email" })).toEqual({
      email: "client.sample@example.com",
    });
    expect(
      leadSampleData({
        form_fields: ["name"],
        contact: "any",
        extra_fields: [{ name: "photo", label: "Фото", type: "image", required: true }],
      }),
    ).toBeNull();
  });
});

describe("deals", () => {
  const alone = ok(compile("deals", row({})));

  test("canonical stages: stage_1…N from the plan, then won and lost; an empty list gives one stage", () => {
    expect(entity(alone, "deal")?.fields.find((f) => f.name === "status")?.enum).toEqual([
      { value: "stage_1", label: "Новая" },
      { value: "stage_2", label: "В работе" },
      { value: "stage_3", label: "Предложение" },
      { value: "won", label: "Успешно" },
      { value: "lost", label: "Отказ" },
    ]);
    expect(dealStages([]).map((s) => s.value)).toEqual(["stage_1", "won", "lost"]);
    const one = ok(compile("deals", row({ stages: [] })));
    expect(entity(one, "deal")?.fields.find((f) => f.name === "status")?.default).toBe("stage_1");
    expect(JSON.stringify(ac(one, "Сделка переходит")?.check.steps)).toContain('"status":"won"');
  });

  test("amount and tasks by parameters; no client or lead without their modules", () => {
    expect(fieldNames(alone, "deal")).toEqual(["title", "status", "amount"]);
    expect(fieldNames(alone, "deal_task")).toEqual(["deal", "title", "due_at", "done"]);
    const bare = ok(compile("deals", row({ with_amount: false, with_tasks: false, deal_label: "Проект" })));
    expect(fieldNames(bare, "deal")).toEqual(["title", "status"]);
    expect(entity(bare, "deal")?.label).toBe("Проект");
    expect(entity(bare, "deal_task")).toBeUndefined();
    expect(bare.metrics.map((m) => m.id)).toEqual(["deals_new", "deals_stage_conversion", "deals_won_share"]);
    expect(bare.files["ui/pages/DealsBoard.tsx"]).not.toContain("deal_task");
  });

  test("board page on the StatusBoard with stage actions; funnel function for the goal panel", () => {
    const page = alone.files["ui/pages/DealsBoard.tsx"] ?? "";
    expect(page).toContain('<StatusBoard entity="deal" statusField="status"');
    expect(page).toContain('label: "Перенести: Успешно"');
    expect(page).toContain('<DataTable entity="deal_task" query={{ filter: { deal: selected } }}');
    expect(alone.spec.pages?.map((p) => p.route)).toEqual(["/deals", "/cabinet", "/"]);
    expect(alone.spec.functions?.map((f) => [f.name, f.kind, f.roles])).toEqual([
      ["dealFunnel", "query", ["owner"]],
    ]);
    expect(alone.metrics.find((m) => m.id === "deals_stage_conversion")?.compute).toEqual({
      kind: "function",
      name: "dealFunnel",
    });
    expect(alone.scenarios.map((s) => s.id)).toEqual(["GS-deals-1", "GS-deals-4"]);
  });

  test("a person in charge needs the staff module", () => {
    expect(codes(compile("deals", row({ assignees: true })))).toEqual(["MISSING_REQUIRED_MODULE"]);
  });

  test("with staff: the person in charge, a staff member sees and moves only own deals", () => {
    const r = ok(compile("deals", row({ assignees: true }, ["staff"]), withStaff));
    expect(entity(r, "deal")?.fields.find((f) => f.name === "assignee")?.ref).toEqual({
      entity: "users",
      onDelete: "set_null",
    });
    expect(fieldNames(r, "deal_task")).toContain("assignee");
    expect(r.spec.permissions.find((p) => p.role === "staff" && p.entity === "deal")).toEqual({
      role: "staff",
      entity: "deal",
      ops: ["read", "create", "update"],
      rowFilter: { assignee: "$user.id" },
      rowFilterOps: ["read", "update"],
    });
    expect(
      r.spec.permissions.find((p) => p.role === "owner" && p.entity === "deal")?.rowFilter,
    ).toBeUndefined();
    expect(r.scenarios.map((s) => s.id)).toContain("GS-deals-2");
    expect(r.spec.pages?.find((p) => p.route === "/deals")?.roles).toEqual(["owner", "staff"]);
  });

  test("the whole CRM: deal.client and deal.lead, deal from a lead, history with leads and deals", () => {
    const r = ok(compile("deals", row({}, ["landing", "leads", "notify", "client_card"])));
    expect(fieldNames(r, "deal")).toEqual(["title", "status", "amount", "client", "lead"]);
    expect(r.spec.workflows?.map((w) => w.name)).toEqual([
      "client_from_lead",
      "lead_notify",
      "deal_from_lead",
    ]);
    expect(r.spec.workflows?.find((w) => w.name === "deal_from_lead")?.trigger).toEqual({
      type: "on_status",
      entity: "lead",
      field: "status",
      equals: "in_work",
    });
    expect(historySources(r.spec, "owner").map((s) => s.entity)).toEqual(["lead", "deal"]);
    const history = r.files["ui/pages/ClientCardHistory.tsx"] ?? "";
    expect(history).toContain('<DataTable entity="deal" query={{ filter: { client: props.id } }}');
    expect(history).toContain('<h2>{"Сделки"}</h2>');
    expect(r.metrics.map((m) => m.id)).toContain("deals_repeat_clients");
    expect(ac(r, "Заявка, взятая в работу")).toBeDefined();
    expect(r.links.map((l) => `${l.from}→${l.to}`)).toEqual([
      "notify→leads",
      "client_card→deals",
      "client_card→leads",
      "leads→client_card",
      "leads→deals",
      "deals→client_card",
      "deals→leads",
      "deals→notify",
    ]);
  });

  test("determinism: the same plan gives byte-identical output", () => {
    const plan = matrixPlan(registry, "deals", row({}, ["landing", "leads", "notify", "client_card"]));
    const a = ok(compilePlan(plan, registry));
    const b = ok(compilePlan(structuredClone(plan), registry));
    expect(compiledFingerprint(b)).toBe(compiledFingerprint(a));
  });
});

// ------------------------------------------------------------------ G1: goal scenarios as acceptance scenarios

const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
const keyPrefix = `b215${randomBytes(3).toString("hex")}`;

beforeAll(async () => {
  db = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  role = `wz_crm_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-crm-test-"));
  const qrKeyring = serializeQrKeyring(newQrKeyring());
  rt = createRuntimeApp({
    db,
    registry: new MemoryRegistry(),
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    connectors: "outbox",
    secrets: () => staticSecretReader({ [QR_SECRET]: qrKeyring }),
    env: {
      authModeDev: true,
      devLogin: false,
      unsafeLocalExec: true,
      publicScheme: "http",
      platformOrigin: "http://localhost:5173",
      systemsDomain: "localhost",
      nodeEnv: "test",
      kubernetes: false,
    },
  });
});

afterAll(async () => {
  await closeExecutors();
  await db?.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
  await db?.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await db?.end();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function g1(r: CompileSuccess): Promise<GateReport> {
  return runGates("G1", {
    spec: r.spec,
    prevSpec: null,
    specVersion: 1,
    files: new Map(Object.entries(r.files)),
    env: "draft",
    systemKey: `${keyPrefix}_${randomBytes(4).toString("hex")}`,
    db,
    milestone: "M1",
    runtime: rt,
    runtimeRole: role,
  });
}

/** Status of the acceptance scenario whose text starts with `text`. */
function scenarioStatus(report: GateReport, r: CompileSuccess, text: string): string[] {
  const id = ac(r, text)?.id;
  expect(id, text).toBeDefined();
  return report.checks.filter((c) => c.acId === id).map((c) => c.status);
}

describe("G1: goal scenarios of the CRM run without models", () => {
  test("a deal moves through the stages; the client's history holds both leads; a lead in work becomes a deal", async () => {
    const r = ok(compile("client_card", row({}, ["landing", "leads", "notify", "deals"])));
    const report = await g1(r);
    expect(scenarioStatus(report, r, "Сделка переходит")).toEqual(["pass"]);
    expect(scenarioStatus(report, r, "Две заявки")).toEqual(["pass"]);
    expect(scenarioStatus(report, r, "Заявка, взятая в работу")).toEqual(["pass"]);
    expect(report.checks.find((c) => c.id === "G1-RENDER-01")?.status).toBe("pass");
    expect(report.passed).toBe(true);
  }, 180_000);

  test("with a person in charge and the staff role (stand-in): G1 passes", async () => {
    const report = await g1(ok(compile("deals", row({ assignees: true }, ["staff"]), withStaff)));
    expect(
      report.checks.filter((c) => c.severity === "blocker" && c.status === "fail").map((c) => c.message_ru),
    ).toEqual([]);
  }, 180_000);
});
