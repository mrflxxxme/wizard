// Forum baseline (specs/appspec/examples/forum.json + specs/runtime/examples) and a GateContext factory.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppSpec } from "@wizard/appspec";
import postgres from "postgres";
import type { GateContext } from "../src/index.js";

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(PKG_ROOT, "../..");
const EXAMPLES = join(REPO_ROOT, "specs/runtime/examples");

export function loadForum(): AppSpec {
  return JSON.parse(readFileSync(join(REPO_ROOT, "specs/appspec/examples/forum.json"), "utf8")) as AppSpec;
}

export function forumFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const top of ["ui", "functions"]) {
    for (const f of readdirSync(join(EXAMPLES, top), { recursive: true, encoding: "utf8" }).sort()) {
      if (/\.tsx?$/.test(f))
        files.set(`${top}/${f.split("\\").join("/")}`, readFileSync(join(EXAMPLES, top, f), "utf8"));
    }
  }
  return files;
}

export const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";

export function connect(): postgres.Sql {
  return postgres(DATABASE_URL, { max: 4, onnotice: () => {} });
}

export function uniqueKey(prefix = "g0"): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export function forumCtx(db: postgres.Sql, over: Partial<GateContext> = {}): GateContext {
  return {
    spec: loadForum(),
    prevSpec: null,
    specVersion: 1,
    files: forumFiles(),
    env: "draft",
    systemKey: uniqueKey(),
    db,
    milestone: "M0",
    ...over,
  };
}

/** YAML via tools/specs/validate.mjs (python3 + PyYAML, as the specs validator). */
export async function loadYaml(path: string): Promise<unknown> {
  // @ts-expect-error — plain ESM module without types
  const { parseYamlFiles } = await import("../../../tools/specs/validate.mjs");
  const r = (parseYamlFiles([path]) as Record<string, { ok?: unknown; error?: string }>)[path];
  if (!r || r.error !== undefined) throw new Error(`YAML ${path}: ${r?.error}`);
  return r.ok;
}
