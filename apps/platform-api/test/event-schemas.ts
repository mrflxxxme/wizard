// JSON Schemas for run events derived from the compact notation of specs/platform/workflows.yaml#events.types.
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsCjs from "ajv-formats";
import { loadYaml } from "./helpers.js";

const addFormats = formatsCjs.default;

type Schema = Record<string, unknown>;

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "[" || ch === "{" || ch === "(") depth++;
    if (ch === "]" || ch === "}" || ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

const PRIM: Record<string, Schema> = {
  string: { type: "string" },
  integer: { type: "integer" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  bool: { type: "boolean" },
  null: { type: "null" },
  "string[]": { type: "array", items: { type: "string" } },
};

function one(p: string): Schema | { literal: string } {
  if (p.startsWith("[")) {
    const max = /≤\s*(\d+)/.exec(p)?.[1];
    return { type: "array", ...(max ? { maxItems: Number(max) } : {}) };
  }
  if (p.startsWith("{")) return { type: "object" };
  const word = p.split(/\s+/)[0] ?? "";
  return PRIM[word] ?? { literal: word };
}

export function propSchema(desc: string, failureCodes: string[]): Schema {
  let d = String(desc).split(" — ")[0]?.trim() ?? "";
  if (!d.startsWith("[") && !d.startsWith("{")) d = d.replace(/\s*\(.*\)\s*$/, "").trim();
  if (d === "run_lifecycle.failure_codes") return { enum: failureCodes };
  const parts = splitTop(d, "|");
  if (parts.some((p) => p.includes("…"))) return { type: "string" };
  // Prose instead of a type (e.g. build_metrics.stages: "метрики этапов …"): not constrained here.
  const first = parts[0] ?? "";
  if (parts.length === 1 && /\s/.test(first) && !/^[[{]/.test(first) && !PRIM[first.split(/\s+/)[0] ?? ""])
    return {};
  const schemas = parts.map(one);
  const lits = schemas.filter((s): s is { literal: string } => "literal" in s);
  if (lits.length === schemas.length) return { enum: lits.map((l) => l.literal) };
  if (lits.length > 0) throw new Error(`mixed union: ${desc}`);
  return schemas.length === 1 ? (schemas[0] as Schema) : { anyOf: schemas };
}

export interface EventSpec {
  internal?: boolean;
  required: string[];
  properties: Record<string, string>;
}

export function loadEventSchemas() {
  const wf = loadYaml("specs/platform/workflows.yaml") as {
    events: { types: Record<string, EventSpec> };
    run_lifecycle: { failure_codes: string[] };
  };
  const api = loadYaml("specs/platform/api.yaml") as { components: { schemas: Record<string, Schema> } };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const envelope = ajv.compile(api.components.schemas.RunEvent as Schema);
  const payloads = new Map<string, ReturnType<typeof ajv.compile>>();
  for (const [type, spec] of Object.entries(wf.events.types)) {
    const properties: Record<string, Schema> = {};
    for (const [k, v] of Object.entries(spec.properties))
      properties[k] = propSchema(v, wf.run_lifecycle.failure_codes);
    payloads.set(
      type,
      ajv.compile({ type: "object", required: spec.required, properties, additionalProperties: false }),
    );
  }
  const internal = new Set(
    Object.entries(wf.events.types)
      .filter(([, s]) => s.internal)
      .map(([t]) => t),
  );
  return {
    types: new Set(Object.keys(wf.events.types)),
    internal,
    /** Returns error text or null. */
    validate(e: { type: string; payload: unknown }): string | null {
      if (!envelope(e)) return `envelope: ${ajv.errorsText(envelope.errors)}`;
      const v = payloads.get(e.type);
      if (!v) return `unknown event type ${e.type}`;
      return v(e.payload) ? null : `${e.type}: ${ajv.errorsText(v.errors)} in ${JSON.stringify(e.payload)}`;
    },
  };
}
