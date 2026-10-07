// B2-46 (mvp-07 of the D76 measurement): extra fields of modules that look like personal data come out of compile
// marked pii — by the very criterion of G2-PII-02 (@wizard/appspec piiNameReason) — and their entity keeps a retention
// period (G2-PII-05). (a) per module with a `fields` parameter; (b) guard over every CI matrix row and the plan of all
// modules with such extra fields injected into every module that takes them.
import type { AppSpec, Entity, Field, SystemPlan } from "@wizard/appspec";
import { piiMarkup, piiRetention } from "@wizard/gates";
import { describe, expect, test } from "vitest";
import { compilePlan, MODULES_WITH_CODE, matrixPlan } from "../src/index.js";
import { allModulesPlan, testRegistry } from "./fixtures.js";

const registry = testRegistry();

interface Extra {
  name: string;
  label: string;
  type: Field["type"];
}

/** The pilot's extra fields (mvp-07) plus a phone, a government id and a plain comment. */
const EXTRAS: Extra[] = [
  { name: "extra_email", label: "Электронная почта", type: "email" },
  { name: "extra_messenger", label: "Мессенджер (Telegram/WhatsApp)", type: "string" },
  { name: "extra_phone", label: "Телефон", type: "phone" },
  { name: "extra_passport", label: "Паспорт", type: "string" },
  { name: "extra_comment", label: "Комментарий", type: "text" },
];
const EMAIL_AS_STRING: Extra = { name: "extra_email_text", label: "Электронная почта", type: "string" };

/** Modules with a `fields` parameter: id, parameter, its maxItems and the entity extra fields go to. */
const TARGETS = MODULES_WITH_CODE.flatMap((d) =>
  d.manifest.params
    .filter((p) => p.type === "fields")
    .map((p) => ({
      id: d.manifest.id,
      param: p.name,
      max: (p as { maxItems?: number }).maxItems ?? 8,
      entity: d.manifest.provides?.entities?.[0] ?? "",
    })),
);

function inject(plan: SystemPlan, extras: Extra[]): SystemPlan {
  return {
    ...plan,
    modules: plan.modules.map((m) => {
      const t = TARGETS.find((x) => x.id === m.id);
      if (!t) return m;
      return { ...m, params: { ...(m.params ?? {}), [t.param]: extras.slice(0, t.max) } };
    }),
  };
}

function compile(plan: SystemPlan): AppSpec {
  const r = compilePlan(plan, registry, { appName: "Проверка" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r.spec;
}

const entityOf = (spec: AppSpec, name: string): Entity => {
  const e = spec.entities.find((x) => x.name === name);
  if (!e) throw new Error(`no entity ${name}`);
  return e;
};

/** Would G2-PII-02 flag this field if it were left unmarked? */
function g2Flags(spec: AppSpec, entity: string, field: string): boolean {
  const copy = structuredClone(spec);
  const ei = copy.entities.findIndex((e) => e.name === entity);
  const e = copy.entities[ei] as Entity;
  const fi = e.fields.findIndex((f) => f.name === field);
  const { pii: _p, piiKind: _k, ...rest } = e.fields[fi] as Field;
  e.fields[fi] = rest;
  return piiMarkup(copy).some((x) => x.path === `/entities/${ei}/fields/${fi}`);
}

/** Batches of the extras that fit maxItems of the module (every extra is tried in some batch). */
const batches = (max: number, list: Extra[]): Extra[][] =>
  list.length <= max ? [list] : [list.slice(0, max), list.slice(list.length - max)];

describe("(a) extra fields that look like personal data are marked pii exactly where G2-PII-02 flags them", () => {
  const rows = TARGETS.flatMap((t) => {
    const row = registry.modules.find((d) => d.manifest.id === t.id)?.manifest.tests?.matrix?.[0];
    if (!row) throw new Error(`module ${t.id} has no CI matrix row`);
    return [...batches(t.max, EXTRAS), [EMAIL_AS_STRING], [EXTRAS[1] as Extra]].map(
      (b, i) => [t.id, i, t, matrixPlan(registry, t.id, row), b] as const,
    );
  });
  test.each(rows)("%s batch %i", (_id, _i, t, plan, batch) => {
    const spec = compile(inject(plan, batch));
    const e = entityOf(spec, t.entity);
    for (const x of batch) {
      const f = e.fields.find((y) => y.name === x.name) as Field;
      expect(f, x.name).toBeDefined();
      expect(f.pii === "basic", `${t.id}.${x.name}`).toBe(g2Flags(spec, t.entity, x.name));
      if (x.name === "extra_comment") expect(f.pii, "comment is not personal data").toBeUndefined();
      if (x.type === "email" || x.type === "phone") expect([f.pii, f.piiKind]).toEqual(["basic", x.type]);
      if (x.name === "extra_email_text") expect([f.pii, f.piiKind]).toEqual(["basic", "email"]);
      if (x.name === "extra_passport") expect([f.pii, f.piiKind]).toEqual(["basic", undefined]);
    }
    expect(piiMarkup(spec)).toEqual([]);
    expect(piiRetention(spec)).toEqual([]);
  });

  test("client_card (mvp-07): the client's e-mail and messenger are personal data, the comment is not", () => {
    const row = registry.modules.find((d) => d.manifest.id === "client_card")?.manifest.tests?.matrix?.[0];
    const spec = compile(inject(matrixPlan(registry, "client_card", row as never), EXTRAS));
    const pick = (n: string) => {
      const f = entityOf(spec, "client").fields.find((x) => x.name === n);
      return [f?.pii, f?.piiKind];
    };
    expect(pick("extra_email")).toEqual(["basic", "email"]);
    expect(pick("extra_messenger")).toEqual(["basic", "other"]);
    expect(pick("extra_phone")).toEqual(["basic", "phone"]);
    expect(pick("extra_passport")).toEqual(["basic", undefined]);
    expect(pick("extra_comment")).toEqual([undefined, undefined]);
  });

  test("a weak name alone does not make a non-subject entity personal data (catalog item, messenger only)", () => {
    const row = registry.modules.find((d) => d.manifest.id === "catalog")?.manifest.tests?.matrix?.[0];
    const spec = compile(inject(matrixPlan(registry, "catalog", row as never), [EXTRAS[1] as Extra]));
    const item = entityOf(spec, "service");
    expect(item.fields.find((f) => f.name === "extra_messenger")?.pii).toBeUndefined();
    expect(item.retention).toBeUndefined();
  });

  test("with a phone the catalog item becomes a subject: the messenger is marked too, the item gets retention", () => {
    const row = registry.modules.find((d) => d.manifest.id === "catalog")?.manifest.tests?.matrix?.[0];
    const spec = compile(
      inject(matrixPlan(registry, "catalog", row as never), [EXTRAS[1] as Extra, EXTRAS[2] as Extra]),
    );
    const item = entityOf(spec, "service");
    expect(item.fields.find((f) => f.name === "extra_messenger")?.pii).toBe("basic");
    expect(item.retention).toEqual({ deleteAfterDays: 3650, mode: "anonymize" });
  });
});

describe("(b) guard: G2-PII-02 and G2-PII-05 find nothing with ПДн-like extra fields in every module", () => {
  const plans: [string, SystemPlan][] = [["the plan of all modules", allModulesPlan()]];
  for (const d of MODULES_WITH_CODE)
    for (const row of d.manifest.tests?.matrix ?? [])
      plans.push([`matrix ${d.manifest.id} — ${row.name}`, matrixPlan(registry, d.manifest.id, row)]);
  test.each(plans)("%s", (_name, plan) => {
    const spec = compile(inject(plan, EXTRAS));
    expect(piiMarkup(spec)).toEqual([]);
    expect(piiRetention(spec)).toEqual([]);
  });
});
