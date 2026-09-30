// tsconfig.system (sdk.md §1.1) with absolute paths, for tsc runs in a revision copy (G0-TS-01).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TSCONFIG_SYSTEM_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../tsconfig.system.json",
);

export interface SystemTsconfig {
  compilerOptions: Record<string, unknown> & { paths: Record<string, string[]> };
  include?: string[];
}

/** `overrides` replace path targets, e.g. {"@wizard/ui-kit": "/abs/ui-kit.d.ts"} while ui-kit ships none. */
export function systemTsconfig(overrides: Record<string, string> = {}, include?: string[]): SystemTsconfig {
  const raw = JSON.parse(readFileSync(TSCONFIG_SYSTEM_PATH, "utf8")) as SystemTsconfig;
  const base = dirname(TSCONFIG_SYSTEM_PATH);
  const paths: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw.compilerOptions.paths)) paths[k] = v.map((p) => resolve(base, p));
  for (const [k, v] of Object.entries(overrides)) paths[k] = [v];
  return { compilerOptions: { ...raw.compilerOptions, paths }, ...(include ? { include } : {}) };
}
