// backlog M0-07: specs/runtime/examples type-check (tsc --noEmit, strict) against _generated/wizard.d.ts
// from forum.json; negative cases (test/examples-typecheck/negative.ts) must fail via @ts-expect-error.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { materializeApp, TYPECHECK_FIXTURES } from "./helpers/app.js";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

function runTsc(dir: string): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json"), "--pretty", "false"], {
      encoding: "utf8",
    });
    return { code: 0, output };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("examples typecheck", () => {
  let dir: string;
  beforeAll(() => {
    dir = materializeApp("typecheck");
  });

  test("functions, ui, contract and negative cases pass tsc --noEmit (strict)", () => {
    const r = runTsc(dir);
    expect(r.output).toBe("");
    expect(r.code).toBe(0);
  });

  test("every negative case really fails without its @ts-expect-error", () => {
    const src = readFileSync(join(TYPECHECK_FIXTURES, "negative.ts"), "utf8");
    const expected = src.split("\n").filter((l) => l.trim().startsWith("// @ts-expect-error")).length;
    expect(expected).toBeGreaterThanOrEqual(30);
    const neg = materializeApp("typecheck-negative");
    // Same program, but the negative file copied in without directives: one error per stripped line.
    const lines = src.split("\n");
    const stripped = lines.map((l) => (l.trim().startsWith("// @ts-expect-error") ? "//" : l)).join("\n");
    writeFileSync(join(neg, "negative-stripped.ts"), stripped.replace(/^\/\/ Negative.*$/m, ""));
    const tsconfig = JSON.parse(readFileSync(join(neg, "tsconfig.json"), "utf8")) as { include: string[] };
    tsconfig.include = ["functions", "ui", "_generated", "negative-stripped.ts", tsconfig.include[3] as string];
    tsconfig.include[4] = tsconfig.include[4]?.replace("*.ts", "ui-kit.d.ts") as string;
    writeFileSync(join(neg, "tsconfig.json"), JSON.stringify(tsconfig));
    const r = runTsc(neg);
    expect(r.code).not.toBe(0);
    const failing = new Set(
      [...r.output.matchAll(/negative-stripped\.ts\((\d+),\d+\): error/g)].map((m) => Number(m[1])),
    );
    const directiveLines = lines
      .map((l, i) => (l.trim().startsWith("// @ts-expect-error") ? i + 2 : 0))
      .filter((n) => n > 0);
    const missing = directiveLines.filter((n) => !failing.has(n));
    expect(missing).toEqual([]);
    expect(r.output).not.toMatch(/(functions|ui)\/[^(]+\(\d+,\d+\): error/);
  });
});
