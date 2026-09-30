// backlog M0-22: bakery.json + specs/runtime/examples/bakery build like the forum (draft and prod), deterministically.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { buildSystem } from "../src/index.js";
import type { BuildResult } from "../src/types.js";
import { PKG_ROOT, REPO_ROOT } from "./helpers.js";

const BAKERY = join(REPO_ROOT, "specs/runtime/examples/bakery");
const spec = JSON.parse(
  readFileSync(join(REPO_ROOT, "specs/appspec/examples/bakery.json"), "utf8"),
) as AppSpec;

function bakeryFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const top of ["ui", "functions"]) {
    for (const f of readdirSync(join(BAKERY, top), { recursive: true, encoding: "utf8" }).sort()) {
      if (/\.tsx?$/.test(f))
        files.set(`${top}/${f.split("\\").join("/")}`, readFileSync(join(BAKERY, top, f), "utf8"));
    }
  }
  return files;
}

/** ui-kit stand-in with every component the bakery pages import (same shape as helpers.ts uiKitStub). */
function uiKitStub(files: Map<string, string>): string {
  const names = new Set<string>();
  for (const src of files.values()) {
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@wizard\/ui-kit"/g)) {
      for (const n of (m[1] ?? "").split(",")) names.add(n.replace(/^\s*type\s+/, "").trim());
    }
  }
  names.delete("");
  const file = join(PKG_ROOT, "test/.generated/ui-kit-stub-bakery/index.tsx");
  mkdirSync(dirname(file), { recursive: true });
  const body = [...names]
    .sort()
    .map(
      (n) =>
        `export const ${n} = (p: { wzId?: string; children?: unknown; [k: string]: unknown }) => <div data-wz-component="${n}" data-wz-id={p.wzId ?? "demo:${n}:0"}>{p.children as never}</div>;`,
    );
  // The client entry template mounts WzProvider (ui-kit.yaml#data_binding.provider).
  body.push("export const WzProvider = (p: { children?: unknown }) => p.children as never;");
  writeFileSync(file, `${body.join("\n")}\n`);
  return file;
}

function build(env: "draft" | "prod"): Promise<BuildResult> {
  const files = bakeryFiles();
  return buildSystem({ spec, files, env, hostModules: { uiKit: uiKitStub(files) } });
}

describe("buildSystem: bakery", () => {
  test("draft: ui and functions bundles, wz-map over all four pages", async () => {
    const r = await build("draft");
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    const html = new TextDecoder().decode(r.client.get("index.html"));
    expect(html).toContain("<title>Кондитерская «Сахар»</title>");
    expect(r.manifest.functions.names).toEqual(["calcPrice", "freeSlots", "placeOrder"]);
    expect(r.serverFunctions).toContain("functions/lib/pricing.ts");
    expect(r.serverFunctions).toContain("functions/lib/load.ts");
    const imports = [...r.serverFunctions.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*"([^"]+)"/gm)].map(
      (m) => m[1],
    );
    expect(new Set(imports)).toEqual(new Set(["@wizard/sdk"]));
    const files = new Set(Object.values(r.wzMap ?? {}).map((e) => e.file));
    expect(files).toEqual(
      new Set(["ui/Configurator.tsx", "ui/MyOrders.tsx", "ui/Production.tsx", "ui/CatalogAdmin.tsx"]),
    );
  });

  test("functions bundle loads as ESM with a definition per spec function", async () => {
    const r = await build("draft");
    const file = join(PKG_ROOT, "test/.generated/bakery-functions.mjs");
    writeFileSync(file, r.serverFunctions);
    const mod = (await import(/* @vite-ignore */ file)) as { default: Record<string, { kind?: unknown }> };
    expect(Object.fromEntries(Object.entries(mod.default).map(([k, d]) => [k, d.kind]))).toEqual({
      calcPrice: "query",
      freeSlots: "query",
      placeOrder: "mutation",
    });
  });

  test("deterministic, and prod builds without wz-map", async () => {
    const [a, b] = [await build("draft"), await build("draft")];
    expect(a.serverFunctions).toBe(b.serverFunctions);
    expect([...a.client.keys()]).toEqual([...b.client.keys()]);
    const prod = await build("prod");
    expect(prod.ok).toBe(true);
    expect(prod.wzMap).toBeNull();
  });
});
