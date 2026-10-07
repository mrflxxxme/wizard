// B2-18 «Учёт выдачи и ресурсов»: the compiled spec by parameters (items with or without quantities, the unique open
// issue, the overdue mark, deposit, the client link, notify's due and overdue messages, the list import page) and the
// goal scenarios in a real runtime without models or a browser: issue and return, the overdue mark, a second issue of
// an item on hand refused, the client's contacts on the issue. The browser run is
// packages/gates/src/goals/programs/resources.ts (test goals-b218.browser.test.ts).
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type CompileSuccess,
  compilePlan,
  importColumns,
  matrixPlan,
  resourcesManifest,
} from "../src/index.js";
import { testRegistry } from "./fixtures.js";
import { blockers, type G1Runtime, startG1Runtime, statusOf } from "./g1-runtime.js";

const registry = testRegistry();

function compiled(plan: unknown): CompileSuccess {
  const r = compilePlan(plan, registry, { appName: "Библиотека" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}

const row = (name: string) => {
  const r = resourcesManifest.tests?.matrix.find((x) => x.name === name);
  if (!r) throw new Error(`no matrix row ${name}`);
  return r;
};
const plan = (name: string) => matrixPlan(registry, "resources", row(name));
const entity = (r: CompileSuccess, name: string) => r.spec.entities.find((e) => e.name === name);
const fields = (r: CompileSuccess, name: string) => entity(r, name)?.fields.map((f) => f.name) ?? [];
const perm = (r: CompileSuccess, role: string, e: string) =>
  r.spec.permissions.find((p) => p.role === role && p.entity === e);
const workflow = (r: CompileSuccess, name: string) => r.spec.workflows?.find((w) => w.name === name);

const LIBRARY = "библиотека: книги с автором, клиенты, загрузка списка";
const RENTAL = "прокат: количество и залог, без напоминаний";

describe("compiled spec by parameters", () => {
  test("by default: one open issue per item, the overdue mark, due and overdue messages", () => {
    const r = compiled(plan("по умолчанию: напоминания о просрочке"));
    expect(fields(r, "resource_issue")).toEqual([
      "resource",
      "holder",
      "status",
      "due_at",
      "issued_at",
      "returned_at",
      "phone",
      "email",
      "consent_messages",
      "was_overdue",
      "note",
      "open",
    ]);
    expect(entity(r, "resource_issue")?.indexes).toContainEqual({
      fields: ["resource", "open"],
      unique: true,
    });
    expect(perm(r, "owner", "resource_issue")).toMatchObject({
      hiddenFields: ["open"],
      readonlyFields: ["was_overdue"],
    });
    expect(perm(r, "guest", "resource_issue")).toBeUndefined();
    expect(workflow(r, "resource_overdue")).toEqual({
      name: "resource_overdue",
      label: "Срок возврата прошёл",
      trigger: {
        type: "schedule",
        entity: "resource_issue",
        relative: { field: "due_at", offsetMinutes: 0 },
      },
      steps: [
        {
          type: "update",
          params: { if: { status: ["issued"] }, set: { status: "overdue", was_overdue: true } },
        },
      ],
    });
    expect(workflow(r, "resource_due_reminder")).toMatchObject({
      trigger: { type: "schedule", relative: { field: "due_at", offsetMinutes: -1440 } },
      steps: [
        { params: { to: "$record.email", consentField: "consent_messages", if: { status: ["issued"] } } },
      ],
    });
    const overdue = workflow(r, "resource_overdue_notify");
    expect(overdue?.trigger).toEqual({
      type: "on_status",
      entity: "resource_issue",
      field: "status",
      equals: "overdue",
    });
    expect(overdue?.steps.map((s) => (s.params as { to?: string }).to)).toEqual(["$owner", "$record.email"]);
    expect(r.files["functions/resources/issueResource.ts"]).toContain("const DEFAULT_DAYS = 7;");
    expect(r.files["functions/resources/returnResource.ts"]).toContain("patch.open = null");
    expect(r.files["ui/pages/Cabinet.tsx"]).toContain('label: "Выдача"');
    expect(r.metrics.map((m) => m.id)).toEqual(["issued_count", "overdue_share"]);
    expect(r.scenarios.filter((s) => s.module === "resources").map((s) => s.id)).toEqual([
      "GS-resources-1",
      "GS-resources-2",
      "GS-resources-3",
      "GS-resources-4",
    ]);
  });

  test("a library: extra fields of the book, the client link, the list import page", () => {
    const r = compiled(plan(LIBRARY));
    expect(entity(r, "resource")?.label).toBe("Книга");
    expect(fields(r, "resource")).toEqual(expect.arrayContaining(["author", "year"]));
    expect(fields(r, "resource_issue")).toContain("client");
    expect(r.files["functions/resources/issueResource.ts"]).toContain("const DEFAULT_DAYS = 14;");
    expect(r.files["functions/resources/issueResource.ts"]).toContain("ctx.db.client.get");
    const page = r.spec.pages?.find((p) => p.route === "/resources-import");
    expect(page?.roles).toEqual(["owner"]);
    expect(r.files[page?.file ?? ""]).toContain('useEntityMutation("resource")');
    expect(r.spec.acceptance?.map((a) => a.text)).toContain(
      "Выдача клиенту видна в его истории и берёт его почту для напоминаний",
    );
  });

  test("the import page parses rows pasted from a spreadsheet", () => {
    const r = compiled(plan(LIBRARY));
    expect(importColumns({ spec: r.spec, params: row(LIBRARY).params }).map((c) => c.name)).toEqual([
      "name",
      "author",
      "year",
      "inventory_no",
    ]);
    const src = r.files[r.spec.pages?.find((p) => p.route === "/resources-import")?.file ?? ""] ?? "";
    const body = src.slice(src.indexOf("type Column"), src.indexOf("const show ="));
    const out = ts.transpileModule(`${body}\nexport { parse };`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const exports: { parse?: (text: string) => Record<string, unknown>[] } = {};
    new Function("exports", out.outputText)(exports);
    const parse = exports.parse as (text: string) => Record<string, unknown>[];
    expect(
      parse("Название\tАвтор\tГод издания\nВойна и мир\tЛ. Толстой\t1869\n\nМуму\tИ. Тургенев\t\n"),
    ).toEqual([
      { name: "Война и мир", author: "Л. Толстой", year: 1869 },
      { name: "Муму", author: "И. Тургенев" },
    ]);
    expect(parse("Азбука;А. Пушкин;1990;И-12")).toEqual([
      { name: "Азбука", author: "А. Пушкин", year: 1990, inventory_no: "И-12" },
    ]);
  });

  test("rental: quantities and deposit, no index of one open issue, no messages", () => {
    const r = compiled(plan(RENTAL));
    expect(fields(r, "resource")).toEqual(expect.arrayContaining(["quantity", "in_stock", "deposit"]));
    expect(fields(r, "resource_issue")).toEqual(
      expect.arrayContaining(["quantity", "deposit", "deposit_returned"]),
    );
    expect(fields(r, "resource_issue")).not.toContain("open");
    expect(fields(r, "resource_issue")).not.toContain("consent_messages");
    expect(entity(r, "resource_issue")?.indexes?.some((i) => i.unique)).toBe(false);
    expect(perm(r, "owner", "resource")?.readonlyFields).toEqual(["in_stock"]);
    expect(r.spec.integrations).toBeUndefined();
    expect(r.files["functions/resources/issueResource.ts"]).toContain(
      "const inStock = Math.max(0, total - out)",
    );
    expect(r.scenarios.map((s) => s.id)).toEqual(["GS-resources-1"]);
  });

  test("deterministic output", () => {
    const a = compiled(plan(LIBRARY));
    const b = compiled(structuredClone(plan(LIBRARY)));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("G1 scenarios of the goals (gates without models)", () => {
  let g: G1Runtime;
  beforeAll(async () => {
    g = await startG1Runtime("b218r");
  }, 60_000);
  afterAll(async () => {
    await g?.close();
  });
  const run = async (name: string, texts: string[]) => {
    const r = compiled(plan(name));
    const { g0, g1 } = await g.gates(r.spec, r.files);
    expect(blockers(g0), "G0").toEqual([]);
    expect(blockers(g1), "G1").toEqual([]);
    const sc = (text: string) => `SC-${r.spec.acceptance?.find((a) => a.text === text)?.id ?? text}`;
    for (const text of texts) expect(statusOf(g1, sc(text)), text).toBe("pass");
  };

  test("issue and return, overdue at the due time, no second issue on hand, the client's contacts", async () => {
    await run(LIBRARY, [
      "Выдача делает предмет «Выдан» со сроком возврата, возврат возвращает его в наличие",
      "Срок возврата прошёл — выдача становится просроченной, владельцу ушло письмо",
      "За сутки до срока получатель, согласившийся на письма, получает напоминание",
      "Пока предмет не вернули, второй раз его не выдать",
      "Выдача клиенту видна в его истории и берёт его почту для напоминаний",
    ]);
  }, 180_000);

  test("rental with quantities: pieces in stock follow the issues", async () => {
    await run(RENTAL, [
      "Выдача делает предмет «в наличии на 1 меньше» со сроком возврата, возврат возвращает его в наличие",
      "Срок возврата прошёл — выдача становится просроченной",
    ]);
  }, 180_000);
});
