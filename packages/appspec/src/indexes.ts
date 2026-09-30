// Index model shared by codegen (IndexWhere types) and hosts (where → index resolution), sdk.md §2.4.
import type { Entity } from "./schema.js";

/** System columns every entity has (runtime.yaml#data_api.doc_shape). */
export const SYSTEM_FIELD_NAMES = ["id", "created_at", "updated_at", "created_by"] as const;

/**
 * Indexes usable in `where`, in declaration order: declared indexes first, then the implicit ones
 * created by toDDL (id, created_at, each unique field, each ref field, ownerField). Duplicates removed.
 */
export function entityIndexes(entity: Entity): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  const add = (fields: string[]) => {
    const key = fields.join(",");
    if (fields.length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push(fields);
  };
  for (const idx of entity.indexes ?? []) add(idx.fields);
  add(["id"]);
  add(["created_at"]);
  for (const f of entity.fields) if (f.unique) add([f.name]);
  for (const f of entity.fields) if (f.type === "ref") add([f.name]);
  if (entity.ownerField) add([entity.ownerField]);
  return out;
}

/** Fields usable with `getBy`: unique fields and single-field unique indexes. */
export function uniqueFields(entity: Entity): string[] {
  const out = entity.fields.filter((f) => f.unique).map((f) => f.name);
  for (const idx of entity.indexes ?? []) {
    const only = idx.fields[0];
    if (idx.unique && idx.fields.length === 1 && only !== undefined && !out.includes(only)) out.push(only);
  }
  return out;
}

/**
 * Picks the index whose prefix is exactly the set of `where` keys, the last key possibly a range.
 * Returns undefined when no index matches (the type system normally prevents this).
 */
export function resolveIndex(entity: Entity, whereKeys: readonly string[]): string[] | undefined {
  if (whereKeys.length === 0) return undefined;
  const keys = new Set(whereKeys);
  return entityIndexes(entity).find(
    (idx) => idx.length >= keys.size && idx.slice(0, keys.size).every((f) => keys.has(f)),
  );
}

export function isRangeValue(v: unknown): v is { gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => k === "gt" || k === "gte" || k === "lt" || k === "lte");
}
