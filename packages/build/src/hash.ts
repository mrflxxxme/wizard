import { createHash } from "node:crypto";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with object keys sorted recursively: one spec → one string → one hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, o[k]]),
      );
    }
    return v;
  });
}

/** specHash of manifest.json and registry (runtime.yaml#system_loading): sha256 of canonical JSON. */
export function specHash(spec: unknown): string {
  return sha256Hex(canonicalJson(spec));
}
