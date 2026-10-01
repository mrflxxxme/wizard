// Shape of an aiAction (appspec.schema.json#/$defs/aiAction; runtime.yaml#ai_actions, M3-02). The schema keeps `input`
// and `output` open; this module fixes their meaning for the runtime, the platform and the semantic check:
//   input:  { entity, fields?: string[], instruction?: string }   — source fields (text-like or file) of one record
//   output: extract  → { fields: string[] | Record<string, unknown> } — target fields typed by the entity
//           generate → { field: string }                           — one string/text field receiving plain text
import type { AiAction, AppSpec, Entity, Field, FieldType } from "./schema.js";

/** Target types an extract action may fill (values are checked against the field after the call). */
export const AI_EXTRACT_TYPES: readonly FieldType[] = [
  "string",
  "text",
  "enum",
  "int",
  "decimal",
  "money",
  "bool",
  "date",
  "email",
  "phone",
  "url",
];
/** Target types of a generate action: plain text only (never HTML). */
export const AI_GENERATE_TYPES: readonly FieldType[] = ["string", "text"];
/** Source types: values sent as text, plus file fields (images/PDF, T0-only multimodal call). */
export const AI_INPUT_TYPES: readonly FieldType[] = [
  "string",
  "text",
  "enum",
  "int",
  "decimal",
  "money",
  "bool",
  "date",
  "datetime",
  "email",
  "phone",
  "url",
  "file",
];
/** Instruction length cap (the builder writes it; it goes into the prompt as is). */
export const AI_INSTRUCTION_MAX = 1000;

export interface ResolvedAiAction {
  name: string;
  kind: "extract" | "generate";
  monthlyLimit: number;
  entity: Entity;
  /** Source fields in spec order of input.fields (default: every text-like field that is not an output). */
  inputs: Field[];
  /** Target fields (generate: exactly one). */
  outputs: Field[];
  instruction: string | null;
}

export interface AiActionProblem {
  path: (string | number)[];
  kind: "entity" | "field" | "type" | "shape";
  message: string;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function outputNames(a: AiAction): string[] | null {
  const out = a.output as Record<string, unknown>;
  if (a.kind === "generate") return isStr(out.field) ? [out.field] : null;
  const f = out.fields;
  if (Array.isArray(f)) return f.every(isStr) ? (f as string[]) : null;
  if (f !== null && typeof f === "object") return Object.keys(f);
  return null;
}

/** The action with its fields resolved against the spec, or the problems that prevent it. */
export function resolveAiAction(
  spec: AppSpec,
  a: AiAction,
): { ok: true; action: ResolvedAiAction } | { ok: false; problems: AiActionProblem[] } {
  const problems: AiActionProblem[] = [];
  const input = a.input as Record<string, unknown>;
  const entityName = input.entity;
  const entity = isStr(entityName) ? spec.entities.find((e) => e.name === entityName) : undefined;
  if (!entity) {
    problems.push({
      path: ["input", "entity"],
      kind: "entity",
      message: "Не указан раздел данных ИИ-действия",
    });
    return { ok: false, problems };
  }
  const byName = new Map(entity.fields.map((f) => [f.name, f]));
  const outs = outputNames(a);
  if (!outs || outs.length === 0) {
    problems.push({
      path: ["output", a.kind === "generate" ? "field" : "fields"],
      kind: "shape",
      message:
        a.kind === "generate"
          ? "Укажите поле, куда ИИ запишет текст (output.field)"
          : "Укажите поля, которые ИИ заполнит (output.fields)",
    });
  }
  const outputs: Field[] = [];
  for (const [i, n] of (outs ?? []).entries()) {
    const f = byName.get(n);
    const path = a.kind === "generate" ? ["output", "field"] : ["output", "fields", i];
    if (!f) {
      problems.push({ path, kind: "field", message: `Поле «${n}» не найдено в «${entity.name}»` });
      continue;
    }
    const allowed = a.kind === "generate" ? AI_GENERATE_TYPES : AI_EXTRACT_TYPES;
    if (!allowed.includes(f.type)) {
      problems.push({
        path,
        kind: "type",
        message:
          a.kind === "generate"
            ? `ИИ пишет только текст: поле «${n}» должно быть строкой или текстом`
            : `ИИ не заполняет поля типа ${f.type} («${n}»)`,
      });
      continue;
    }
    outputs.push(f);
  }
  const outSet = new Set(outputs.map((f) => f.name));
  let inputs: Field[];
  if (input.fields === undefined) {
    inputs = entity.fields.filter(
      (f) => !outSet.has(f.name) && (f.type === "string" || f.type === "text" || f.type === "enum"),
    );
  } else if (Array.isArray(input.fields) && input.fields.every(isStr)) {
    inputs = [];
    for (const [i, n] of (input.fields as string[]).entries()) {
      const f = byName.get(n);
      if (!f) {
        problems.push({
          path: ["input", "fields", i],
          kind: "field",
          message: `Поле «${n}» не найдено в «${entity.name}»`,
        });
      } else if (!AI_INPUT_TYPES.includes(f.type)) {
        problems.push({
          path: ["input", "fields", i],
          kind: "type",
          message: `ИИ не читает поля типа ${f.type} («${n}»)`,
        });
      } else inputs.push(f);
    }
  } else {
    problems.push({ path: ["input", "fields"], kind: "shape", message: "input.fields — список имён полей" });
    inputs = [];
  }
  const instruction = input.instruction;
  if (
    instruction !== undefined &&
    (typeof instruction !== "string" || instruction.length > AI_INSTRUCTION_MAX)
  )
    problems.push({
      path: ["input", "instruction"],
      kind: "shape",
      message: `Инструкция ИИ-действия — строка до ${AI_INSTRUCTION_MAX} символов`,
    });
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    action: {
      name: a.name,
      kind: a.kind,
      monthlyLimit: a.monthlyLimit,
      entity,
      inputs,
      outputs,
      instruction: typeof instruction === "string" && instruction.trim() ? instruction.trim() : null,
    },
  };
}

/** Actions of the spec that fill fields of `entity` (RecordCard «заполнено ИИ» meta is read only for these). */
export function aiTargetFields(spec: AppSpec, entity: string): Set<string> {
  const out = new Set<string>();
  for (const a of spec.aiActions ?? []) {
    const r = resolveAiAction(spec, a);
    if (r.ok && r.action.entity.name === entity) for (const f of r.action.outputs) out.add(f.name);
  }
  return out;
}
