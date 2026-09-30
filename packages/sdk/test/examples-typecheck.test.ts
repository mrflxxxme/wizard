// backlog M0-07: specs/runtime/examples type-check with tsconfig.system (sdk.md §1.1) against
// _generated/wizard.d.ts from forum.json; contract.test-d.ts covers §5; negative.test-d.ts must fail.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { materializeApp, SDK_ROOT, type SdkTarget } from "./helpers/app.js";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const TYPE_TESTS = ["test/contract.test-d.ts", "test/negative.test-d.ts"];

function runTsc(dir: string): { code: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [tsc, "-p", join(dir, "tsconfig.json"), "--pretty", "false"],
      {
        encoding: "utf8",
      },
    );
    return { code: 0, output };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("examples typecheck (strict)", () => {
  test.each<SdkTarget>(["system", "impl"])(
    "functions, ui and type tests pass tsc against %s types",
    (target) => {
      const r = runTsc(materializeApp(`typecheck-${target}`, { target, extraFiles: TYPE_TESTS }));
      expect(r.output).toBe("");
      expect(r.code).toBe(0);
    },
  );

  test("every negative case really fails without its @ts-expect-error", () => {
    const src = readFileSync(join(SDK_ROOT, "test/negative.test-d.ts"), "utf8");
    const lines = src.split("\n");
    const directive = (l: string) => l.trim().startsWith("// @ts-expect-error");
    const expectedLines = lines.map((l, i) => (directive(l) ? i + 2 : 0)).filter((n) => n > 0);
    expect(expectedLines.length).toBeGreaterThanOrEqual(30);
    const dir = materializeApp("typecheck-negative");
    writeFileSync(join(dir, "negative-stripped.ts"), lines.map((l) => (directive(l) ? "//" : l)).join("\n"));
    const tsconfig = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8")) as { include: string[] };
    tsconfig.include.push("negative-stripped.ts");
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
    const r = runTsc(dir);
    expect(r.code).not.toBe(0);
    const failing = new Set(
      [...r.output.matchAll(/negative-stripped\.ts\((\d+),\d+\): error/g)].map((m) => Number(m[1])),
    );
    expect(expectedLines.filter((n) => !failing.has(n))).toEqual([]);
    // Only the stripped file fails: the examples themselves stay clean.
    expect(
      r.output.split("\n").filter((l) => l.includes("error") && !l.includes("negative-stripped")),
    ).toEqual([]);
  });
});
