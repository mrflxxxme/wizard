// The registry against the spec (specs/modules/modules.yaml#catalog): draft.ts is the generated copy of the catalog,
// manifests in code keep id, goals, params, requires, links and provides of their catalog entry, the registry passes
// checkRegistry and screens use real ui-kit exports.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { moduleManifestSchema } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { CATALOG, checkRegistry, DRAFT_MANIFESTS, MODULES, MODULES_WITH_CODE } from "../src/index.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
// @ts-expect-error — plain ESM module without types
const { parseYamlFiles } = await import("../../../tools/specs/validate.mjs");
const specPath = join(root, "specs/modules/modules.yaml");
const loaded = (
  parseYamlFiles([specPath]) as Record<string, { ok?: { catalog: Record<string, unknown>[] } }>
)[specPath];
const catalog = loaded?.ok?.catalog ?? [];

describe("registry vs specs/modules/modules.yaml#catalog", () => {
  test("draft.ts is up to date (node packages/modules/scripts/gen-draft.mjs)", () => {
    expect(catalog.length).toBeGreaterThan(0);
    expect(DRAFT_MANIFESTS.map((m) => moduleManifestSchema.parse(m))).toEqual(catalog);
  });

  test("the registry lists every catalog module in the spec's order", () => {
    expect(MODULES.map((d) => d.manifest.id)).toEqual(catalog.map((m) => m.id));
  });

  test.each(MODULES_WITH_CODE.map((d) => [d.manifest.id, d] as const))(
    "%s: the manifest in code matches its catalog entry",
    (id, d) => {
      const spec = catalog.find((m) => m.id === id) as Record<string, unknown> | undefined;
      expect(spec, `${id} нет в каталоге спеки`).toBeDefined();
      const m = d.manifest;
      const pick = (x: Record<string, unknown>) => ({
        id: x.id,
        goals: x.goals,
        params: x.params,
        requires: x.requires ?? [],
        links: ((x.links ?? []) as { module: string; effect: string }[]).map((l) => ({
          module: l.module,
          effect: l.effect,
        })),
        provides: x.provides ?? {},
      });
      expect(pick(m as unknown as Record<string, unknown>)).toEqual(pick(spec ?? {}));
      expect(m.status).toBe("ready");
    },
  );

  test("the default registry has no catalog or code errors", () => {
    expect(checkRegistry(CATALOG)).toEqual([]);
  });

  test("screens are built from ui-kit exports", () => {
    const index = readFileSync(join(root, "packages/ui-kit/src/index.ts"), "utf8");
    const exported = new Set([...index.matchAll(/\b([A-Z][A-Za-z0-9]+)\b/g)].map((x) => x[1]));
    for (const d of MODULES_WITH_CODE)
      for (const s of d.manifest.screens ?? [])
        for (const c of s.components) expect(exported.has(c), `${d.manifest.id}/${s.id}: ${c}`).toBe(true);
  });
});
