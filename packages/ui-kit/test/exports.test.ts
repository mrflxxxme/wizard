// Public API: every M0 component of ui-kit.yaml is exported with its props type; one demo story per component;
// the demo builds with vite; specs/runtime/examples/ui type-check against ui-kit + generateTypes(forum.json).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { generateTypes } from "@wizard/sdk/codegen";
import { build } from "vite";
import { describe, expect, test } from "vitest";
import type * as K from "../src/index.js";
import * as kit from "../src/index.js";
import { specComponents, UI_KIT_ROOT } from "./helpers/demo.js";

const REPO = join(UI_KIT_ROOT, "../..");
const SPEC_TEXT = readFileSync(join(REPO, "specs/ui/ui-kit.yaml"), "utf8");
const COMPONENTS = specComponents(SPEC_TEXT);

// Compile-time: the props types of all M0 components are exported under their spec names.
type PropsOf = {
  AppShell: K.AppShellProps;
  Catalog: K.CatalogProps;
  ItemCard: K.ItemCardProps;
  RecordForm: K.RecordFormProps;
  DataTable: K.DataTableProps;
  RecordCard: K.RecordCardProps;
  StatusBoard: K.StatusBoardProps;
  QrTicket: K.QrTicketProps;
  QrScanner: K.QrScannerProps;
  CabinetLayout: K.CabinetLayoutProps;
  StatsReport: K.StatsReportProps;
  ConsentCheckbox: K.ConsentCheckboxProps;
  Button: K.ButtonProps;
  Badge: K.BadgeProps;
  Field: K.FieldProps;
};
const wzBase: Pick<K.ButtonProps, "wzId" | "testId" | "className"> = {
  wzId: "x:1",
  testId: "t",
  className: "c",
};

describe("public API", () => {
  test("spec lists the M0 components", () => {
    expect(COMPONENTS).toEqual(
      expect.arrayContaining(["AppShell", "Catalog", "DataTable", "QrScanner", "ConsentCheckbox", "Field"]),
    );
    expect(COMPONENTS).not.toContain("FileField");
  });

  test("every M0 component is an exported function with a props type", () => {
    const names: (keyof PropsOf)[] = COMPONENTS as (keyof PropsOf)[];
    for (const n of names) expect(typeof (kit as unknown as Record<string, unknown>)[n], n).toBe("function");
    expect(Object.keys({} as Record<keyof PropsOf, 1>)).toBeDefined();
    expect(wzBase.wzId).toBe("x:1");
    expect(typeof kit.AppShell.Login).toBe("function");
    expect(typeof kit.WzProvider).toBe("function");
    expect(typeof kit.sdkDataSource).toBe("function");
  });

  test("exactly one demo story per component", () => {
    const stories = readdirSync(join(UI_KIT_ROOT, "demo/stories"))
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => f.replace(/\.tsx$/, ""))
      .sort();
    expect(stories).toEqual([...COMPONENTS].sort());
    for (const s of stories) {
      const src = readFileSync(join(UI_KIT_ROOT, "demo/stories", `${s}.tsx`), "utf8");
      expect(src, s).toContain(`component: "${s}"`);
    }
  });

  test("demo builds from demo/stories/*.tsx (glob)", async () => {
    const outDir = join(UI_KIT_ROOT, "test/.generated/demo-build");
    await build({
      configFile: join(UI_KIT_ROOT, "demo/vite.config.ts"),
      root: join(UI_KIT_ROOT, "demo"),
      logLevel: "error",
      build: { outDir, emptyOutDir: true },
    });
    expect(existsSync(join(outDir, "index.html"))).toBe(true);
    const assets = readdirSync(join(outDir, "assets"));
    expect(assets.some((a) => a.endsWith(".js"))).toBe(true);
    expect(assets.some((a) => a.endsWith(".css"))).toBe(true);
    const js = assets
      .filter((a) => a.endsWith(".js"))
      .map((a) => readFileSync(join(outDir, "assets", a), "utf8"));
    for (const c of COMPONENTS) expect(js.join("\n"), c).toContain(`component:"${c}"`);
  }, 120_000);
});

describe("examples typecheck", () => {
  test("specs/runtime/examples/ui pass tsc against ui-kit and generateTypes(forum.json)", () => {
    const dir = join(UI_KIT_ROOT, "test/.generated/examples-ui");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "_generated"), { recursive: true });
    cpSync(join(REPO, "specs/runtime/examples/ui"), join(dir, "ui"), { recursive: true });
    cpSync(join(REPO, "specs/runtime/examples/functions"), join(dir, "functions"), { recursive: true });
    const forum = JSON.parse(
      readFileSync(join(REPO, "specs/appspec/examples/forum.json"), "utf8"),
    ) as AppSpec;
    writeFileSync(join(dir, "_generated/wizard.d.ts"), generateTypes(forum));
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
      out =
        `${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}` ||
        "tsc failed";
    }
    expect(out).toBe("");
  }, 120_000);
});
