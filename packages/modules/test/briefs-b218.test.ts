// B2-18 acceptance: the briefs mvp-09 (school library) and mvp-10 (yoga subscription) are covered by the modules — the
// plans validate, compile without custom code, carry what the briefs expect (entities, roles, features) and pass G0
// and G1 without models; mvp-10's card payment is an honest out-of-scope item with a replacement.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSystemPlan } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type CompileSuccess, compilePlan, planCatalog } from "../src/index.js";
import { testRegistry } from "./fixtures.js";
import { libraryPlan, yogaPlan } from "./fixtures-b218.js";
import { blockers, type G1Runtime, startG1Runtime } from "./g1-runtime.js";

const registry = testRegistry();
const root = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

interface Brief {
  id: string;
  expected: { roles: string[]; entities: string[]; must_have_features: string[] };
}
const brief = (file: string): Brief =>
  JSON.parse(readFileSync(join(root, "tools/eval/briefs", file), "utf8")) as Brief;

function compiled(plan: unknown): CompileSuccess {
  const r = compilePlan(plan, registry, { appName: "Проверка брифа" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}

/** «Название :: стем|стем» of the brief → the stems as a case-insensitive pattern. */
const stems = (item: string) => new RegExp((item.split("::")[1] ?? item).trim(), "i");
/** Names and labels of entities, roles, pages and workflows: what a brief's expectation may be found in. */
const haystack = (r: CompileSuccess) =>
  [
    ...r.spec.entities.flatMap((e) => [e.name, e.label, ...e.fields.map((f) => f.label)]),
    ...r.spec.roles.flatMap((x) => [x.name, x.label]),
    ...(r.spec.pages ?? []).flatMap((p) => [p.route, p.title]),
    ...(r.spec.workflows ?? []).flatMap((w) => [w.name, w.label ?? ""]),
  ].join("\n");

const cases = [
  { file: "mvp-09-school-library.json", plan: libraryPlan },
  { file: "mvp-10-yoga-subscription.json", plan: yogaPlan },
] as const;

describe("briefs mvp-09 and mvp-10 are covered by the modules (no custom code)", () => {
  test.each(cases)(
    "$file: the plan validates with ready modules and compiles without custom",
    ({ file, plan }) => {
      const v = validateSystemPlan(plan(), planCatalog(registry), { requireReady: true });
      expect(v.ok ? [] : v.errors).toEqual([]);
      const r = compiled(plan());
      expect(r.plan.custom).toEqual([]);
      expect(r.customSlots).toEqual([]);
      const text = haystack(r);
      const b = brief(file);
      for (const item of [...b.expected.entities, ...b.expected.roles, ...b.expected.must_have_features])
        expect(text, `${b.id}: ${item}`).toMatch(stems(item));
    },
  );

  test("mvp-09: books with the author, issues to students with the due date, the reminder letter, list import", () => {
    const r = compiled(libraryPlan());
    expect(r.spec.entities.find((e) => e.name === "resource")?.label).toBe("Книга");
    expect(r.spec.entities.find((e) => e.name === "client")?.label).toBe("Ученик");
    expect(r.spec.workflows?.map((w) => w.name)).toEqual(
      expect.arrayContaining(["resource_overdue", "resource_due_reminder", "resource_overdue_notify"]),
    );
    expect(r.spec.pages?.map((p) => p.route)).toContain("/resources-import");
    // Students do not book or sign in («ученики сами ничего не бронируют»): no public access to the library's data.
    expect(r.spec.permissions.filter((p) => p.role === "guest")).toEqual([]);
  });

  test("mvp-10: lessons only for students with a valid subscription; the payment is out of scope with a replacement", () => {
    const r = compiled(yogaPlan());
    expect(r.spec.entities.find((e) => e.name === "package_material")?.label).toBe("Видеоурок");
    expect(r.spec.permissions.some((p) => p.entity === "package_material" && p.role === "guest")).toBe(false);
    expect(r.spec.pages?.find((p) => p.route === "/materials")?.roles).not.toContain("guest");
    expect(r.files["ui/pages/VisitorCabinetMe.tsx"]).toContain('label: "Мои абонементы"');
    expect(r.plan.outOfScope.map((o) => o.category)).toEqual(["payments"]);
  });
});

describe("the brief systems pass G0 and G1 without models", () => {
  let g: G1Runtime;
  beforeAll(async () => {
    g = await startG1Runtime("b218b");
  }, 60_000);
  afterAll(async () => {
    await g?.close();
  });

  test.each(cases)(
    "$file",
    async ({ plan }) => {
      const r = compiled(plan());
      const { g0, g1 } = await g.gates(r.spec, r.files);
      expect(blockers(g0), "G0").toEqual([]);
      expect(blockers(g1), "G1").toEqual([]);
    },
    180_000,
  );
});
