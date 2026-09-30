// Function fixtures: forum.json + specs/runtime/examples (+ extra test functions) built by @wizard/build into an
// artifact folder, migrated and pinned in a runtime with WIZARD_UNSAFE_LOCAL_EXEC=1.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { buildSystem, writeArtifact } from "@wizard/build";
import { closeExecutors } from "../src/exec/host.js";
import { migrateSystem, schemaName } from "../src/index.js";
import { forumSpec, type Harness, harness, newKey, repoRoot } from "./helpers.js";

const EXAMPLES = join(repoRoot, "specs/runtime/examples");

export interface ExtraFunction {
  name: string;
  kind: "query" | "mutation" | "action";
  roles?: string[];
  public?: boolean;
  source: string;
}

function exampleFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const top of ["ui", "functions"]) {
    for (const f of readdirSync(join(EXAMPLES, top), { recursive: true, encoding: "utf8" }).sort()) {
      if (/\.tsx?$/.test(f))
        files.set(`${top}/${f.split("\\").join("/")}`, readFileSync(join(EXAMPLES, top, f), "utf8"));
    }
  }
  return files;
}

/** @wizard/ui-kit stand-in exporting every name the example pages import (ui-kit is built by M0-08). */
function uiKitStub(dir: string, files: Map<string, string>): string {
  const names = new Set<string>();
  for (const src of files.values()) {
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@wizard\/ui-kit"/g)) {
      for (const n of (m[1] ?? "").split(",")) {
        const name = n.replace(/^\s*type\s+/, "").trim();
        if (name) names.add(name);
      }
    }
  }
  const path = join(dir, "ui-kit-stub.ts");
  writeFileSync(path, [...names].map((n) => `export const ${n} = (_p: unknown) => null;`).join("\n"));
  return path;
}

export interface ExecSystem {
  key: string;
  schema: string;
  host: string;
  spec: AppSpec;
  artifactDir: string;
}

export interface ExecHarness extends Harness {
  tmp: string;
  fnSystem(slug: string, extra?: ExtraFunction[], mutate?: (spec: AppSpec) => void): Promise<ExecSystem>;
}

export async function execHarness(unsafeLocalExec = true): Promise<ExecHarness> {
  const h = await harness({ unsafeLocalExec });
  const tmp = mkdtempSync(join(tmpdir(), "wz-exec-"));
  const schemas: string[] = [];
  return {
    ...h,
    tmp,
    async fnSystem(slug, extra = [], mutate) {
      const spec = forumSpec();
      const files = exampleFiles();
      for (const f of extra) {
        spec.functions = [
          ...(spec.functions ?? []),
          {
            name: f.name,
            kind: f.kind,
            file: `functions/${f.name}.ts`,
            public: f.public ?? true,
            ...(f.roles ? { roles: f.roles } : {}),
          },
        ];
        files.set(`functions/${f.name}.ts`, f.source);
      }
      mutate?.(spec);
      const result = await buildSystem({
        spec,
        files,
        env: "draft",
        hostModules: { uiKit: uiKitStub(tmp, files) },
      });
      if (!result.ok) throw new Error(`build failed: ${JSON.stringify(result.errors)}`);
      const key = newKey();
      const { dir } = writeArtifact(join(tmp, "artifacts"), key, 1, result);
      await migrateSystem(h.sql, { systemId: key, env: "draft", spec, runtimeRole: h.role });
      schemas.push(schemaName(key, "draft"));
      await h.rt.loadSystem({ systemKey: key, env: "draft", spec, slug, artifactDir: dir });
      return {
        key,
        schema: schemaName(key, "draft"),
        host: `${slug}--draft.localhost:4100`,
        spec,
        artifactDir: dir,
      };
    },
    async close() {
      closeExecutors();
      for (const s of schemas) await h.sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      await h.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
