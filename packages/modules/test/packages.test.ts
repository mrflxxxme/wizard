// B2-18 «Абонементы и пакеты»: the compiled spec by parameters (entities by what is sold, the booking link, the
// visitor's own packages, members' materials, notify's messages) and the goal scenarios in a real runtime without
// models or a browser: a sold package is valid at once; a booking writes a visit off and its cancel gives it back; an
// expired package refuses the booking (packageCheck says no, a booking sent around it is cancelled); the browser run of
// the same goals is packages/gates/src/goals/programs/packages.ts (test goals-b218.browser.test.ts).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type CompileSuccess, compilePlan, matrixPlan, packagesManifest } from "../src/index.js";
import { testRegistry } from "./fixtures.js";
import { blockers, type G1Runtime, startG1Runtime, statusOf } from "./g1-runtime.js";

const registry = testRegistry();

function compiled(plan: unknown): CompileSuccess {
  const r = compilePlan(plan, registry, { appName: "Студия" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}

const row = (name: string) => {
  const r = packagesManifest.tests?.matrix.find((x) => x.name === name);
  if (!r) throw new Error(`no matrix row ${name}`);
  return r;
};
const plan = (name: string) => matrixPlan(registry, "packages", row(name));
const entity = (r: CompileSuccess, name: string) => r.spec.entities.find((e) => e.name === name);
const fields = (r: CompileSuccess, name: string) => entity(r, name)?.fields.map((f) => f.name) ?? [];
const perm = (r: CompileSuccess, role: string, e: string) =>
  r.spec.permissions.find((p) => p.role === role && p.entity === e);
const workflow = (r: CompileSuccess, name: string) => r.spec.workflows?.find((w) => w.name === name);

describe("compiled spec by parameters", () => {
  test("visits on a term with booking: the package, the booking link, write-off and refusal", () => {
    const r = compiled(plan("визиты на срок, списание по записи"));
    expect(fields(r, "client_package")).toEqual([
      "client",
      "plan",
      "status",
      "visits_left",
      "expires_on",
      "starts_on",
      "visits_total",
      "price",
      "phone",
      "email",
      "consent_messages",
      "ends_at",
      "note",
    ]);
    expect(
      entity(r, "client_package")
        ?.fields.find((f) => f.name === "status")
        ?.enum?.map((o) => o.value),
    ).toEqual(["active", "used_up", "expired"]);
    expect(fields(r, "package_plan")).toEqual(["name", "visits", "days", "price", "description", "active"]);
    expect(entity(r, "package_plan")?.fields.find((f) => f.name === "days")?.default).toBe(30);
    expect(entity(r, "package_material")).toBeUndefined();
    // The booking link: the package and its mark on the booking, read-only for the visitor without a login.
    expect(fields(r, "booking")).toEqual(expect.arrayContaining(["client_package", "package_status"]));
    expect(perm(r, "guest", "booking")?.readonlyFields).toEqual(
      expect.arrayContaining(["status", "client", "client_package", "package_status"]),
    );
    expect(perm(r, "guest", "client_package")).toBeUndefined();
    expect(r.spec.functions?.map((f) => [f.name, f.roles, Boolean(f.systemDbReason)])).toEqual(
      expect.arrayContaining([
        ["packageCheck", ["guest", "owner"], true],
        ["writeOffVisit", ["owner"], false],
      ]),
    );
    expect(workflow(r, "package_write_off")).toMatchObject({
      trigger: { type: "on_create", entity: "booking" },
      steps: [{ type: "function", params: { name: "writeOffVisit", args: { id: "$record.id" } } }],
    });
    expect(workflow(r, "package_return")?.trigger).toEqual({
      type: "on_status",
      entity: "booking",
      field: "status",
      equals: "cancelled",
    });
    expect(workflow(r, "package_expire")).toMatchObject({
      trigger: { type: "schedule", relative: { field: "ends_at", offsetMinutes: 0 } },
      steps: [{ type: "update", params: { if: { status: ["active"] }, set: { status: "expired" } } }],
    });
    // Notify: the expiry reminder 3 days before the end and on the last visit; the refusal letter.
    expect(workflow(r, "package_expiring")?.trigger).toEqual({
      type: "schedule",
      entity: "client_package",
      relative: { field: "ends_at", offsetMinutes: -3 * 1440 },
    });
    expect(workflow(r, "package_last_visit")?.steps[0]?.params).toMatchObject({
      to: "$record.email",
      consentField: "consent_messages",
      if: { status: ["active"], visits_left: [1] },
    });
    expect(workflow(r, "booking_no_package")?.steps[0]?.params).toMatchObject({
      template: "booking_no_package",
      if: { status: ["cancelled"] },
    });
    // The booking page asks packageCheck before it books.
    const page = r.files["ui/pages/BookingBooking.tsx"] ?? "";
    expect(page).toContain('useMutation("packageCheck")');
    expect(page).toContain("TEXT.noPackage");
    expect(r.files["functions/packages/writeOffVisit.ts"]).toContain('status: "cancelled", seat: null');
    expect(r.files["functions/packages/packageCheck.ts"]).toContain("ctx.systemDb");
    expect(r.metrics.map((m) => m.id)).toEqual(
      expect.arrayContaining(["packages_sold", "packages_renewed", "package_visits"]),
    );
    expect(r.scenarios.filter((s) => s.module === "packages").map((s) => s.id)).toEqual([
      "GS-packages-1",
      "GS-packages-2",
      "GS-packages-3",
      "GS-packages-4",
    ]);
    expect(r.spec.acceptance?.map((a) => a.text)).toEqual(
      expect.arrayContaining([
        "Запись по абонементу списывает визит, отмена записи возвращает его",
        "С закончившимся абонементом записаться нельзя: проверка отказывает, запись без абонемента отменяется",
      ]),
    );
  });

  test("a term only, freezing, no booking: no visits, the unfreeze moves the end date", () => {
    const r = compiled(plan("только срок, без записи, заморозка"));
    expect(fields(r, "client_package")).not.toContain("visits_left");
    expect(fields(r, "client_package")).toContain("frozen_at");
    expect(
      entity(r, "client_package")
        ?.fields.find((f) => f.name === "status")
        ?.enum?.map((o) => o.value),
    ).toEqual(["active", "frozen", "expired"]);
    expect(entity(r, "package_plan")?.fields.find((f) => f.name === "days")?.default).toBe(90);
    expect(workflow(r, "package_unfrozen")?.steps[0]?.params).toEqual({
      name: "unfreezePackage",
      args: { id: "$record.id" },
    });
    expect(workflow(r, "package_write_off")).toBeUndefined();
    expect(workflow(r, "package_last_visit")).toBeUndefined();
    expect(r.spec.functions?.map((f) => f.name)).not.toContain("packageCheck");
  });

  test("visits only, no reminder: no end date, no notify", () => {
    const r = compiled(plan("только визиты, без напоминаний"));
    expect(fields(r, "client_package")).not.toContain("expires_on");
    expect(fields(r, "client_package")).not.toContain("consent_messages");
    expect(entity(r, "client_package")?.label).toBe("Пакет");
    expect(r.spec.integrations).toBeUndefined();
    expect(workflow(r, "package_expire")).toBeUndefined();
  });

  test("a subscription with video lessons: materials for the team and the visitor's own packages", () => {
    const r = compiled(plan("подписка с видеоуроками и кабинетом ученика"));
    expect(entity(r, "package_material")?.label).toBe("Видеоурок");
    expect(perm(r, "visitor", "client_package")).toEqual({
      role: "visitor",
      entity: "client_package",
      ops: ["read"],
      rowFilter: { email: "$user.email" },
      hiddenFields: ["client", "note", "ends_at"],
    });
    expect(perm(r, "visitor", "package_material")).toBeUndefined();
    expect(perm(r, "guest", "package_material")).toBeUndefined();
    expect(r.spec.functions?.find((f) => f.name === "myMaterials")).toMatchObject({
      public: true,
      roles: ["owner", "visitor"],
    });
    expect(r.spec.pages?.find((p) => p.route === "/materials")?.roles).toEqual(["owner", "visitor"]);
    expect(r.files["functions/packages/myMaterials.ts"]).toContain(
      'const TEAM: readonly string[] = ["owner"]',
    );
    expect(r.scenarios.map((s) => s.id)).toContain("GS-packages-5");
  });

  test("visits by booking with the visitor cabinet and staff: the visitor's bookings keep the package fields", () => {
    const r = compiled(plan("визиты по записи, кабинет посетителя и сотрудники"));
    expect(perm(r, "visitor", "booking")?.readonlyFields).toEqual(
      expect.arrayContaining(["client_package", "package_status"]),
    );
    expect(perm(r, "staff", "client_package")?.ops).toEqual(["read", "create", "update"]);
    expect(perm(r, "staff", "package_usage")).toMatchObject({
      ops: ["read", "create"],
      readonlyFields: ["applied"],
    });
    expect(r.files["functions/packages/writeOffVisit.ts"]).not.toContain("r.expires_on < day");
  });

  test("deterministic output", () => {
    const a = compiled(plan("визиты на срок, списание по записи"));
    const b = compiled(structuredClone(plan("визиты на срок, списание по записи")));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("G1 scenarios of the goals (gates without models)", () => {
  let g: G1Runtime;
  beforeAll(async () => {
    g = await startG1Runtime("b218p");
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
    return { r, g1 };
  };

  test("a sold package is valid; a booking writes a visit off, its cancel gives it back; an expired one refuses", async () => {
    await run("визиты на срок, списание по записи", [
      "После продажи «Абонемент» сразу действует: остаток, срок и контакты клиента заполнены",
      "Срок закончился — «Абонемент» больше не действует, а клиент заранее получил напоминание",
      "Запись по абонементу списывает визит, отмена записи возвращает его",
      "С закончившимся абонементом записаться нельзя: проверка отказывает, запись без абонемента отменяется",
    ]);
  }, 180_000);

  test("a term only with freezing: the sale, the reminder and the expiry by the end of the last day", async () => {
    await run("только срок, без записи, заморозка", [
      "После продажи «Абонемент» сразу действует: остаток, срок и контакты клиента заполнены",
      "Срок закончился — «Абонемент» больше не действует, а клиент заранее получил напоминание",
    ]);
  }, 180_000);

  test("visits only with the visitor cabinet and staff: the same goals, the visitor's own packages", async () => {
    await run("визиты по записи, кабинет посетителя и сотрудники", [
      "Запись по абонементу списывает визит, отмена записи возвращает его",
      "С закончившимся абонементом записаться нельзя: проверка отказывает, запись без абонемента отменяется",
    ]);
  }, 180_000);

  test("a subscription without booking: the sale scenario, the visitor reads only his own packages", async () => {
    const { g1 } = await run("подписка с видеоуроками и кабинетом ученика", [
      "После продажи «Подписка» сразу действует: остаток, срок и контакты клиента заполнены",
      "Срок закончился — «Подписка» больше не действует, а клиент заранее получил напоминание",
    ]);
    expect(statusOf(g1, "PC-visitor-client_package-row")).toBe("pass");
  }, 180_000);
});
