// tsconfig.system (sdk.md §1.1): forum examples type-check in a revision copy against sdk.d.ts.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { generateTypes } from "@wizard/sdk/codegen";
import { describe, expect, test } from "vitest";
import { systemTsconfig } from "../src/index.js";
import { forumFiles, loadForum, PKG_ROOT } from "./helpers.js";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

function uiKitDts(files: Map<string, string>): string {
  const names = new Set<string>();
  for (const src of files.values()) {
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@wizard\/ui-kit"/g)) {
      for (const n of (m[1] ?? "").split(",")) if (n.trim()) names.add(n.trim());
    }
  }
  return [
    'import type { ReactNode } from "react";',
    "type Component = (props: { children?: ReactNode; [prop: string]: unknown }) => ReactNode;",
    ...[...names].sort().map((n) => `export declare const ${n}: Component;`),
    "",
  ].join("\n");
}

function tscIn(dir: string): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [tsc, "-p", dir, "--pretty", "false"], { encoding: "utf8" }),
    };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: err.stdout ?? "" };
  }
}

describe("tsconfig.system", () => {
  test("paths are absolute and sdk targets exist", () => {
    const c = systemTsconfig();
    expect(c.compilerOptions).toMatchObject({
      strict: true,
      module: "ESNext",
      moduleResolution: "Bundler",
      jsx: "react-jsx",
      jsxImportSource: "@wizard/sdk",
      noEmit: true,
      types: [],
    });
    for (const k of ["@wizard/sdk", "@wizard/sdk/jsx-runtime"]) {
      expect(existsSync(c.compilerOptions.paths[k]?.[0] ?? "")).toBe(true);
    }
    expect(c.compilerOptions.paths["@wizard/ui-kit"]?.[0]).toMatch(/ui-kit\/src\/ui-kit\.d\.ts$/);
  });

  test("forum examples pass tsc in a copy; a type error fails", () => {
    const dir = join(PKG_ROOT, "test/.generated/tsc-forum");
    rmSync(dir, { recursive: true, force: true });
    const files = forumFiles();
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    };
    for (const [p, t] of files) put(p, t);
    put("_generated/wizard.d.ts", generateTypes(loadForum()));
    put("ui-kit.d.ts", uiKitDts(files));
    const cfg = systemTsconfig({ "@wizard/ui-kit": join(dir, "ui-kit.d.ts") }, [
      "ui",
      "functions",
      "_generated",
    ]);
    put("tsconfig.json", JSON.stringify(cfg));
    const ok = tscIn(dir);
    expect(ok.out).toBe("");
    expect(ok.code).toBe(0);

    put("functions/lib/bad.ts", 'import { query } from "@wizard/sdk";\nexport const n: number = query;\n');
    const bad = tscIn(dir);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("functions/lib/bad.ts");
  }, 60_000);
});
