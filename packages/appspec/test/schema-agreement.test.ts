import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { appSpecSchema, planMigration, toDDL, validateSpec } from "../src/index.js";
import { fuzzCases, schemaCases } from "./fixtures/schema-cases.js";
import { forumSpec, jsonSchemaValidator, miniSpec, repoRoot } from "./helpers.js";

const jsonSchemaValid = jsonSchemaValidator();
const cases = schemaCases();

describe("zod mirrors appspec.schema.json", () => {
  test("has 40+ labelled fixtures with both verdicts", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(cases.some((c) => c.valid)).toBe(true);
    expect(cases.some((c) => !c.valid)).toBe(true);
  });

  test.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const zodOk = appSpecSchema.safeParse(c.spec).success;
    expect({ ajv: jsonSchemaValid(c.spec), zod: zodOk }).toEqual({ ajv: c.valid, zod: c.valid });
  });

  test("fuzzed mutations: zod and JSON Schema agree", () => {
    const mismatches = fuzzCases(400)
      .filter((c) => appSpecSchema.safeParse(c.spec).success !== jsonSchemaValid(c.spec))
      .map((c) => c.name);
    expect(mismatches).toEqual([]);
  });

  test("specs/appspec/examples/*.json pass JSON Schema, zod + semantic rules and render DDL", () => {
    const dir = `${repoRoot}specs/appspec/examples/`;
    const names = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(names).toEqual(expect.arrayContaining(["forum.json", "bakery.json"]));
    for (const name of names) {
      const spec = JSON.parse(readFileSync(dir + name, "utf8"));
      expect(jsonSchemaValid(spec), name).toBe(true);
      const r = validateSpec(spec, { enforcePiiRetention: true });
      expect(r.ok ? [] : r.errors, name).toEqual([]);
      if (r.ok) expect(toDDL(planMigration(null, r.spec), "app_example_draft").length).toBeGreaterThan(0);
    }
  });

  test("forum and mini fixtures pass structural and semantic validation", () => {
    expect(validateSpec(forumSpec()).ok).toBe(true);
    const mini = validateSpec(miniSpec());
    expect(mini.ok ? [] : mini.errors).toEqual([]);
  });

  test("parsing does not inject defaults", () => {
    const spec = miniSpec();
    const r = appSpecSchema.parse(spec);
    expect(r).toEqual(spec);
    expect("required" in (r.entities[0]?.fields[1] ?? {})).toBe(false);
  });
});
