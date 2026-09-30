// Materializes specs/runtime/examples as a generated system under test/.generated/<name>/
// (functions/, ui/, _generated/wizard.d.ts from forum.json, tsconfig.json) so tsc and vitest
// resolve "@wizard/sdk" to this package (package self-reference) exactly like generated code.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppSpec } from "@wizard/appspec";
import { generateTypes } from "../../src/codegen/index.js";

export const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const REPO_ROOT = resolve(SDK_ROOT, "../..");
export const EXAMPLES_DIR = join(REPO_ROOT, "specs/runtime/examples");
export const FORUM_PATH = join(REPO_ROOT, "specs/appspec/examples/forum.json");
export const TYPECHECK_FIXTURES = join(SDK_ROOT, "test/examples-typecheck");

export function loadForum(): AppSpec {
  return JSON.parse(readFileSync(FORUM_PATH, "utf8")) as AppSpec;
}

export function materializeApp(name: string, spec: AppSpec = loadForum()): string {
  const dir = join(SDK_ROOT, "test/.generated", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "_generated"), { recursive: true });
  cpSync(join(EXAMPLES_DIR, "functions"), join(dir, "functions"), { recursive: true });
  cpSync(join(EXAMPLES_DIR, "ui"), join(dir, "ui"), { recursive: true });
  writeFileSync(join(dir, "_generated/wizard.d.ts"), generateTypes(spec));
  const fixtures = relative(dir, TYPECHECK_FIXTURES);
  const tsconfig = {
    compilerOptions: {
      target: "ES2023",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2023", "DOM", "DOM.Iterable"],
      jsx: "react-jsx",
      strict: true,
      noUncheckedIndexedAccess: true,
      isolatedModules: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
    },
    include: ["functions", "ui", "_generated", `${fixtures}/*.ts`],
  };
  writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
  return dir;
}
