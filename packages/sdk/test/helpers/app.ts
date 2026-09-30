// Materializes specs/runtime/examples as a generated system under test/.generated/<name>/
// (functions/, ui/, _generated/wizard.d.ts from forum.json, tsconfig.json) so tsc and vitest
// resolve "@wizard/sdk" to this package (package self-reference) exactly like generated code.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppSpec } from "@wizard/appspec";
import { generateTypes } from "../../src/codegen/index.js";

export const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const REPO_ROOT = resolve(SDK_ROOT, "../..");
export const EXAMPLES_DIR = join(REPO_ROOT, "specs/runtime/examples");
export const FORUM_PATH = join(REPO_ROOT, "specs/appspec/examples/forum.json");

export function loadForum(): AppSpec {
  return JSON.parse(readFileSync(FORUM_PATH, "utf8")) as AppSpec;
}

/**
 * Stand-in for @wizard/ui-kit types (M0-08 pending): every component the example pages import, with
 * permissive props. Generated from the imports so example edits need no fixture update.
 */
function uiKitStub(uiDir: string): string {
  const names = new Set<string>();
  for (const f of readdirSync(uiDir, { recursive: true, encoding: "utf8" })) {
    if (!f.endsWith(".tsx")) continue;
    const src = readFileSync(join(uiDir, f), "utf8");
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@wizard\/ui-kit"/g)) {
      for (const n of (m[1] ?? "").split(",")) {
        const name = n.replace(/^\s*type\s+/, "").trim();
        if (name) names.add(name);
      }
    }
  }
  return [
    'import type { ReactNode } from "react";',
    "type Props = { children?: ReactNode; [prop: string]: unknown };",
    "type Component = (props: Props) => ReactNode;",
    ...[...names].sort().map((n) => `export declare const ${n}: Component;`),
    "",
  ].join("\n");
}

/**
 * `system`: tsconfig.system of sdk.md §1.1 — "@wizard/sdk" → src/sdk.d.ts (what G0 compiles against).
 * `impl`: "@wizard/sdk" → src/index.ts, i.e. the implementation the runtime bundles.
 */
export type SdkTarget = "system" | "impl";

export function materializeApp(
  name: string,
  opts: { spec?: AppSpec; target?: SdkTarget; extraFiles?: string[] } = {},
): string {
  const dir = join(SDK_ROOT, "test/.generated", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "_generated"), { recursive: true });
  cpSync(join(EXAMPLES_DIR, "functions"), join(dir, "functions"), { recursive: true });
  cpSync(join(EXAMPLES_DIR, "ui"), join(dir, "ui"), { recursive: true });
  writeFileSync(join(dir, "_generated/wizard.d.ts"), generateTypes(opts.spec ?? loadForum()));
  writeFileSync(join(dir, "ui-kit.d.ts"), uiKitStub(join(dir, "ui")));
  const rel = (p: string) => relative(dir, join(SDK_ROOT, p));
  const sdk = opts.target === "impl" ? "src/index.ts" : "src/sdk.d.ts";
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
      types: [],
      skipLibCheck: true,
      paths: { "@wizard/sdk": [rel(sdk)], "@wizard/ui-kit": ["./ui-kit.d.ts"] },
    },
    include: ["functions", "ui", "_generated", ...(opts.extraFiles ?? []).map(rel)],
  };
  writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
  return dir;
}
