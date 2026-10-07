// B2-41 (mvp-09 of the D76 measurement): every entity with personal data of a compiled plan has a retention period —
// else G2-PII-05 stops the publication. Every CI matrix row of the modules and the plan of all modules, without a DB.
import type { AppSpec } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { compilePlan, MODULES_WITH_CODE, matrixPlan } from "../src/index.js";
import { allModulesPlan, testRegistry } from "./fixtures.js";

const registry = testRegistry();

/** Entities with a basic-PII field (a file field is basic by default, ops.yaml) and neither retention nor a waiver. */
function withoutRetention(spec: AppSpec): string[] {
  if (spec.compliance?.retentionWaiver) return [];
  return spec.entities
    .filter(
      (e) =>
        !e.retention && e.fields.some((f) => (f.pii ?? (f.type === "file" ? "basic" : "none")) === "basic"),
    )
    .map((e) => e.name);
}

function spec(plan: unknown): AppSpec {
  const r = compilePlan(plan, registry, { appName: "Проверка" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r.spec;
}

describe("personal data has a retention period in every module combination", () => {
  test("the plan of all modules", () => {
    expect(withoutRetention(spec(allModulesPlan()))).toEqual([]);
  });

  const rows = MODULES_WITH_CODE.flatMap((d) =>
    (d.manifest.tests?.matrix ?? []).map((row) => [d.manifest.id, row.name, row] as const),
  );
  test.each(rows)("matrix %s — %s", (id, _name, row) => {
    expect(withoutRetention(spec(matrixPlan(registry, id, row)))).toEqual([]);
  });
});
