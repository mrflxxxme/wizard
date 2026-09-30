import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AppSpec, applyOps, emptySpec } from "../../../packages/appspec/src/index.ts";
import { batchOps, MAX_BATCH, OWNER_ONLY_COMPLIANCE_FIELDS, specToOps } from "../lib/spec-to-ops.mjs";
import { root, unordered } from "./helpers.ts";

const example = (name: string): AppSpec =>
  JSON.parse(readFileSync(join(root, "specs/appspec/examples", `${name}.json`), "utf8"));

/** emptySpec + what ops cannot express (app.template is set at system creation, ops.yaml#ops.set_app). */
function base(spec: AppSpec): AppSpec {
  const s = emptySpec(spec.app.name);
  if (spec.app.template !== undefined) s.app.template = spec.app.template;
  return s;
}

function replay(spec: AppSpec, author: "agent" | "system"): AppSpec {
  let cur = base(spec);
  batchOps(specToOps(spec, { author })).forEach((ops: unknown[], version: number) => {
    const r = applyOps(cur, ops, version, { currentVersion: version, author });
    if (!r.ok) throw new Error(`batch ${version}: ${JSON.stringify(r.errors, null, 1)}`);
    expect(r.version).toBe(version + 1);
    cur = r.spec;
  });
  return cur;
}

describe("specToOps", () => {
  for (const name of ["forum", "bakery"]) {
    it(`${name}.json → ops → applyOps(emptySpec) даёт эквивалентную спеку`, () => {
      const spec = example(name);
      expect(unordered(replay(spec, "system"))).toEqual(unordered(spec));
    });
  }

  it("батчи ≤ 50 и в порядке строителя (builder.yaml#loop.phases.ops)", () => {
    const ops = specToOps(example("forum"));
    for (const b of batchOps(ops)) expect(b.length).toBeLessThanOrEqual(MAX_BATCH);
    expect(batchOps(ops).flat()).toEqual(ops);
    const order = [
      "set_app",
      "set_theme",
      "add_role",
      "add_entity",
      "set_permission",
      "add_workflow",
      "add_integration",
      "add_function",
      "add_page",
      "set_acceptance",
      "set_compliance",
    ];
    const seen = [...new Set(ops.map((o: { op: string }) => o.op))];
    expect(seen).toEqual(order);
  });

  it("ref-цели идут раньше ссылающихся сущностей", () => {
    const spec = example("forum");
    spec.entities.reverse();
    const names = specToOps(spec)
      .filter((o: { op: string }) => o.op === "add_entity")
      .map((o: { name: string }) => o.name);
    for (const e of spec.entities)
      for (const f of e.fields)
        if (f.type === "ref" && f.ref && f.ref.entity !== "users")
          expect(names.indexOf(f.ref.entity)).toBeLessThan(names.indexOf(e.name));
  });

  it("author=agent: без полей владельца в set_compliance, applyOps от агента проходит", () => {
    const spec = example("forum");
    const ops = specToOps(spec, { author: "agent" });
    const c = ops.find((o: { op: string }) => o.op === "set_compliance");
    for (const k of OWNER_ONLY_COMPLIANCE_FIELDS) expect(c?.[k]).toBeUndefined();
    const got = replay(spec, "agent");
    const want = structuredClone(spec);
    for (const k of OWNER_ONLY_COMPLIANCE_FIELDS) delete (want.compliance as Record<string, unknown>)[k];
    expect(unordered(got)).toEqual(unordered(want));
  });

  it("не мутирует вход", () => {
    const spec = example("forum");
    const before = JSON.stringify(spec);
    specToOps(spec, { author: "agent" });
    expect(JSON.stringify(spec)).toBe(before);
  });
});
