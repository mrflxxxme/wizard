// V3-10 acceptance 2 (specs/agents/builder-v3.md §3 C5): extension operations — field, entity, role, function,
// automation — are data checked by applyExtensions on a compiled backend system: each kind has an allowed and a
// rejected case with a Russian reason; ПДн of a new field are marked as for module extra fields (B2-46); the result
// passes the ПДн, RLS and migration checks of the gates (no database here — backend.gates.test.ts applies it to one).
import {
  type AppSpec,
  applyExtensions,
  type ExtensionResult,
  planMigration,
  toRLS,
  validateSpec,
} from "@wizard/appspec";
import { checkCode, piiMarkup, piiRetention } from "@wizard/gates";
import { describe, expect, test } from "vitest";
import { ALLOWED, extendBase, LEAD_STATS_SOURCE, REJECTED } from "./extend-fixtures.js";

const base = extendBase();
const extend = (...ops: unknown[]): ExtensionResult => applyExtensions(base.spec, ops, { files: base.files });
const entity = (spec: AppSpec, name: string) => spec.entities.find((e) => e.name === name);
const perms = (spec: AppSpec, role: string) =>
  spec.permissions.filter((p) => p.role === role).map(({ role: _r, ...p }) => p);

/** Gates of the result without a database: schema and semantics, ПДн markup and retention, additive migration, RLS. */
function gatesPass(r: ExtensionResult): void {
  expect(validateSpec(r.spec).ok).toBe(true);
  expect(piiMarkup(r.spec)).toEqual([]);
  expect(piiRetention(r.spec)).toEqual([]);
  const plan = planMigration(base.spec, r.spec, { env: "prod" });
  expect(plan.errors).toEqual([]);
  expect(plan.additiveOnly).toBe(true);
  expect(toRLS(r.spec, "app_v310_check").length).toBeGreaterThan(0);
}

describe("V3-10: allowed extension operations apply under the gates", () => {
  test("add_field: a new field of a module entity", () => {
    const r = extend(ALLOWED.field);
    expect(r.rejected).toEqual([]);
    expect(r.applied).toEqual([0]);
    expect(entity(r.spec, "deal")?.fields.at(-1)).toMatchObject({ name: "channel", type: "enum" });
    expect(entity(r.spec, "deal")?.fields.slice(0, -1)).toEqual(entity(base.spec, "deal")?.fields);
    gatesPass(r);
  });

  test("add_field: ПДн of new fields are marked as module extra fields (B2-46), the entity gets a retention", () => {
    expect(entity(base.spec, "deal")?.retention).toBeUndefined();
    const r = extend(ALLOWED.piiPhone, ALLOWED.piiMessenger);
    expect(r.rejected).toEqual([]);
    const deal = entity(r.spec, "deal");
    expect(deal?.fields.find((f) => f.name === "contact_phone")).toMatchObject({
      pii: "basic",
      piiKind: "phone",
    });
    expect(deal?.fields.find((f) => f.name === "contact_messenger")).toMatchObject({
      pii: "basic",
      piiKind: "other",
    });
    expect(deal?.retention).toEqual({ deleteAfterDays: 3650, mode: "anonymize" });
    gatesPass(r);
  });

  test("add_entity: the owner gets the full matrix, existing roles get what the operation grants", () => {
    const r = extend(ALLOWED.entity);
    expect(r.rejected).toEqual([]);
    expect(entity(r.spec, "car")?.fields.map((f) => f.name)).toEqual(["plate", "model", "client"]);
    expect(r.spec.permissions.filter((p) => p.entity === "car")).toEqual([
      { role: "owner", entity: "car", ops: ["read", "create", "update", "delete"] },
      { role: "staff", entity: "car", ops: ["read", "create", "update"] },
    ]);
    // Module permissions do not change.
    expect(r.spec.permissions.filter((p) => p.entity !== "car")).toEqual(base.spec.permissions);
    gatesPass(r);
  });

  test("add_role: within the owner's matrix, with the owner's restrictions", () => {
    const r = extend(ALLOWED.role);
    expect(r.rejected).toEqual([]);
    expect(r.spec.roles.at(-1)).toEqual({
      name: "manager",
      label: "Менеджер",
      access: "login",
      loginMethods: ["email_otp"],
    });
    expect(perms(r.spec, "manager")).toEqual(ALLOWED.role.permissions);
    gatesPass(r);
  });

  test("add_role: wider than the owner only by an explicit rule — own rows, as narrow as a module's grant", () => {
    const r = extend(ALLOWED.ownRows);
    expect(r.rejected).toEqual([]);
    expect(perms(r.spec, "partner")).toEqual(ALLOWED.ownRows.permissions);
    gatesPass(r);
  });

  test("add_function: functions/custom/** with its source; G0 code checks pass", async () => {
    const r = extend(ALLOWED.fn);
    expect(r.rejected).toEqual([]);
    expect(r.files).toEqual({ "functions/custom/leadStats.ts": LEAD_STATS_SOURCE });
    expect(r.spec.functions?.at(-1)).toEqual({
      name: "leadStats",
      kind: "query",
      file: "functions/custom/leadStats.ts",
      public: true,
      roles: ["owner", "staff"],
    });
    gatesPass(r);
    const failed = await checkCode({
      spec: r.spec,
      files: new Map(Object.entries({ ...base.files, ...r.files })),
    });
    expect(failed.map((c) => `${c.id}: ${c.message_ru} ${c.evidence ?? ""}`)).toEqual([]);
  }, 120_000);

  test("add_automation: an allowed trigger and step", () => {
    const r = extend(ALLOWED.automation);
    expect(r.rejected).toEqual([]);
    const { op: _op, ...workflow } = ALLOWED.automation;
    expect(r.spec.workflows?.at(-1)).toEqual(workflow);
    gatesPass(r);
  });

  test("all of them together; the input spec is not changed", () => {
    const before = JSON.stringify(base.spec);
    const r = extend(...Object.values(ALLOWED));
    expect(r.rejected).toEqual([]);
    expect(r.applied).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(JSON.stringify(base.spec)).toBe(before);
    gatesPass(r);
  });
});

describe("V3-10: forbidden operations are rejected with a Russian reason, the spec stays as it was", () => {
  test.each(REJECTED.map((x) => [x.name, x] as const))("%s", (_name, x) => {
    const r = extend(x.op);
    expect(r.applied).toEqual([]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.index).toBe(0);
    expect(r.rejected[0]?.op).toEqual(x.op);
    expect(r.rejected[0]?.reasonRu).toMatch(x.reason);
    expect(r.rejected[0]?.reasonRu).toMatch(/[а-яё]/i);
    expect(r.spec).toEqual(base.spec);
    expect(r.files).toEqual({});
  });

  test("a rejected operation does not stop the others; one depending on it is rejected too", () => {
    const bad = REJECTED[0]?.op;
    const r = extend(
      ALLOWED.field,
      bad,
      { op: "add_field", entity: "courier", field: { name: "note", label: "Заметка", type: "text" } },
      ALLOWED.automation,
    );
    expect(r.applied).toEqual([0, 3]);
    expect(r.rejected.map((x) => x.index)).toEqual([1, 2]);
    expect(r.rejected[1]?.reasonRu).toMatch(/Сущности «courier» нет/);
    gatesPass(r);
  });

  test("the same function twice: the second is rejected, its file is not overwritten", () => {
    const r = extend(ALLOWED.fn, { ...ALLOWED.fn, source: "export default 1;\n" });
    expect(r.applied).toEqual([0]);
    expect(r.rejected[0]?.reasonRu).toMatch(/уже есть/);
    expect(r.files["functions/custom/leadStats.ts"]).toBe(LEAD_STATS_SOURCE);
  });
});
