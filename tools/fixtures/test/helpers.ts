import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const root = join(import.meta.dirname, "..", "..", "..");

/** Deep-equal without order: object keys sorted, arrays compared as multisets. */
export function unordered(v: unknown): unknown {
  if (Array.isArray(v))
    return v.map(unordered).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, unordered((v as Record<string, unknown>)[k])]),
    );
  return v;
}

export function genGolden(...args: string[]) {
  return spawnSync(process.execPath, [join(root, "tools/fixtures/gen-golden.mjs"), ...args], {
    encoding: "utf8",
  });
}
