// M0-18: spec_only validates against specs/appspec/appspec.schema.json (no schema of its own, L1-52); --dry-run end to end.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { loadBriefs } from "../lib/briefs.mjs";
import { loadAppSpecSchema, ROOT, SCHEMA_PATH, toolSchema, validateAppSpec } from "../lib/schema.mjs";
import { buildSpec } from "../lib/stub.mjs";

const example = (name) =>
  JSON.parse(readFileSync(join(ROOT, "specs", "appspec", "examples", `${name}.json`), "utf8"));

describe("AppSpec validation", () => {
  test("the eval tool has no schema of its own", () => {
    expect(existsSync(join(ROOT, "tools", "eval", "lib", "appspec.mjs"))).toBe(false);
    expect(loadAppSpecSchema()).toEqual(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));
    const t = toolSchema();
    expect(t.$schema).toBeUndefined();
    expect(t.properties).toEqual(loadAppSpecSchema().properties);
  });

  test("the normative examples are valid", () => {
    for (const name of ["forum", "bakery"]) expect(validateAppSpec(example(name)).errors, name).toEqual([]);
  });

  test("schema and consistency errors are reported", () => {
    const spec = example("forum");
    const noVersion = structuredClone(spec);
    delete noVersion.specVersion;
    expect(validateAppSpec(noVersion).ok).toBe(false);
    const badRole = structuredClone(spec);
    badRole.permissions[0].role = "ghost";
    expect(validateAppSpec(badRole).errors.join("\n")).toMatch(/неизвестная роль "ghost"/);
    expect(validateAppSpec('```json\n{"specVersion": "1"').errors[0]).toMatch(/невалидный JSON|нет JSON/);
  });

  test("dry-run stub specs are schema-valid for every brief", () => {
    for (const b of loadBriefs()) expect(validateAppSpec(buildSpec(b)).errors, b.id).toEqual([]);
  });
});

describe("node tools/eval/run.mjs --dry-run", () => {
  const out = mkdtempSync(join(tmpdir(), "wz-eval-so-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  test("writes results; canary briefs never go to T1", () => {
    const stdout = execFileSync(
      process.execPath,
      [
        join(ROOT, "tools", "eval", "run.mjs"),
        "--dry-run",
        "--briefs=ev-01-forum-registration,hz-01-purchase-requests",
        `--out=${out}`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(stdout).toContain("pii_leaks");
    const file = readdirSync(out).find((f) => f.endsWith("-spec_only-dry.json"));
    const res = JSON.parse(readFileSync(join(out, file), "utf8"));
    expect(res.mode).toBe("spec_only");
    expect(res.runs.every((r) => r.valid && r.pii_leaks === 0)).toBe(true);
    expect(res.skipped).toEqual([
      { brief: "hz-01-purchase-requests", model: "glm-5.3", reason: "canaries_not_sent_to_T1" },
    ]);
    expect(res.runs.some((r) => r.brief === "hz-01-purchase-requests" && r.tier === "T0")).toBe(true);
  });
});
