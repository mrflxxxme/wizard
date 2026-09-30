// backlog M0-22: specs/runtime/examples/bakery (ui + functions) type-check against the real ui-kit and
// generateTypes(bakery.json) — the same check exports.test.ts runs for the forum examples.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { generateTypes } from "@wizard/sdk/codegen";
import { expect, test } from "vitest";
import { UI_KIT_ROOT } from "./helpers/demo.js";

const REPO = join(UI_KIT_ROOT, "../..");
const BAKERY = join(REPO, "specs/runtime/examples/bakery");

test("specs/runtime/examples/bakery pass tsc against ui-kit and generateTypes(bakery.json)", () => {
  const dir = join(UI_KIT_ROOT, "test/.generated/examples-bakery");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "_generated"), { recursive: true });
  cpSync(join(BAKERY, "ui"), join(dir, "ui"), { recursive: true });
  cpSync(join(BAKERY, "functions"), join(dir, "functions"), { recursive: true });
  const spec = JSON.parse(readFileSync(join(REPO, "specs/appspec/examples/bakery.json"), "utf8")) as AppSpec;
  writeFileSync(join(dir, "_generated/wizard.d.ts"), generateTypes(spec));
  const rel = (p: string) => relative(dir, p);
  const tsconfig = {
    compilerOptions: {
      strict: true,
      target: "ES2023",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2023", "DOM", "DOM.Iterable"],
      jsx: "react-jsx",
      jsxImportSource: "@wizard/sdk",
      noEmit: true,
      types: ["node"], // @wizard/appspec sources (type imports of ui-kit) use Buffer
      skipLibCheck: true,
      paths: {
        "@wizard/sdk": [rel(join(REPO, "packages/sdk/src/index.ts"))],
        "@wizard/sdk/*": [rel(join(REPO, "packages/sdk/src/*"))],
        "@wizard/ui-kit": [rel(join(UI_KIT_ROOT, "src/index.ts"))],
      },
    },
    include: ["ui", "functions", "_generated"],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  let out = "";
  try {
    out = execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json"), "--pretty", "false"], {
      encoding: "utf8",
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    out = `${err.stdout ?? ""}${err.stderr ?? ""}` || "tsc failed";
  }
  expect(out).toBe("");
}, 120_000);
