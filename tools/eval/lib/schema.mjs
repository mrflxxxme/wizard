// AppSpec validation for spec_only: the normative specs/appspec/appspec.schema.json (no schema of our own, L1-52)
// through the JSON Schema 2020-12 validator of tools/specs/validate.mjs, plus reference consistency.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSchema } from "../../specs/validate.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SCHEMA_PATH = join(ROOT, "specs", "appspec", "appspec.schema.json");

let cached;
/** The schema file as is. */
export function loadAppSpecSchema() {
  cached ??= JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  return cached;
}

/** The schema for a tool/response_format: without $schema/$id (some providers reject them). */
export function toolSchema(schema = loadAppSpecSchema()) {
  const { $schema: _s, $id: _i, ...rest } = schema;
  return rest;
}

/** Errors "<json pointer>: <message>" of `value` against the schema; unknown keywords are an error, not a pass. */
export function schemaErrors(value, schema = loadAppSpecSchema()) {
  const unsupported = new Set();
  const errors = validateSchema(schema, value, schema, "", [], unsupported).map(
    (e) => `${e.path}: ${e.message}`,
  );
  if (unsupported.size)
    throw new Error(
      `валидатор tools/specs не поддерживает ключевые слова схемы: ${[...unsupported].join(", ")}`,
    );
  return errors;
}

/** Cross-references the schema cannot express: roles, entities and ref targets exist; names are unique. */
export function checkConsistency(spec) {
  const errors = [];
  const roles = new Set();
  for (const r of spec.roles ?? []) {
    if (roles.has(r.name)) errors.push(`roles: дубликат "${r.name}"`);
    roles.add(r.name);
  }
  const entities = new Set();
  for (const e of spec.entities ?? []) {
    if (entities.has(e.name)) errors.push(`entities: дубликат "${e.name}"`);
    entities.add(e.name);
  }
  for (const e of spec.entities ?? [])
    for (const f of e.fields ?? []) {
      if (f.type === "ref" && !entities.has(f.ref?.entity) && f.ref?.entity !== "users")
        errors.push(`entities.${e.name}.${f.name}: ref на неизвестную сущность "${f.ref?.entity}"`);
      if (f.type === "enum" && !(Array.isArray(f.enum) && f.enum.length))
        errors.push(`entities.${e.name}.${f.name}: enum без вариантов`);
    }
  (spec.permissions ?? []).forEach((p, i) => {
    if (!roles.has(p.role)) errors.push(`permissions[${i}]: неизвестная роль "${p.role}"`);
    if (!entities.has(p.entity)) errors.push(`permissions[${i}]: неизвестная сущность "${p.entity}"`);
  });
  (spec.pages ?? []).forEach((p, i) => {
    for (const r of p.roles ?? [])
      if (!roles.has(r)) errors.push(`pages[${i}] "${p.route}": неизвестная роль "${r}"`);
  });
  (spec.acceptance ?? []).forEach((a, i) => {
    if (a.check?.role && !roles.has(a.check.role))
      errors.push(`acceptance[${i}]: неизвестная роль "${a.check.role}"`);
    if (a.check?.entity && !entities.has(a.check.entity))
      errors.push(`acceptance[${i}]: неизвестная сущность "${a.check.entity}"`);
  });
  return errors;
}

/** Extracts JSON from model text: strips ``` fences, takes the first { … last }. */
export function extractJson(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("пустой ответ");
  let s = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b <= a) throw new Error("в ответе нет JSON-объекта");
  s = s.slice(a, b + 1);
  return JSON.parse(s);
}

/** Parse → appspec.schema.json → consistency. */
export function validateAppSpec(raw) {
  let spec;
  try {
    spec = typeof raw === "string" ? extractJson(raw) : raw;
  } catch (e) {
    return { ok: false, spec: null, errors: [`невалидный JSON: ${e.message}`] };
  }
  const errors = schemaErrors(spec);
  if (errors.length) return { ok: false, spec, errors };
  const sem = checkConsistency(spec);
  return { ok: sem.length === 0, spec, errors: sem };
}
