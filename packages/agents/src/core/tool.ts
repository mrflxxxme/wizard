// Tools defined once in zod: the same schema validates arguments and becomes the model's JSON Schema
// (specs/agents/models.yaml#call_policy.tool_schemas).
import type { LlmTool, ToolCall } from "@wizard/llm";
import { z } from "zod";

/** Structured problem returned to the model as a tool result (and usable in Russian UI messages). */
export interface ToolIssue {
  path: string;
  message: string;
  code?: string;
}

export interface ToolErrorResult {
  ok: false;
  error: { code: string; message: string; issues?: ToolIssue[] };
}

export interface ToolSpec<S extends z.ZodType, R = unknown> {
  /** snake_case latin (call_policy.tool_schemas). */
  name: string;
  /** English, short (token economy). */
  description: string;
  input: S;
  /** Semantic checks after zod parsing; any issue makes the call invalid. */
  check?: (value: z.output<S>) => ToolIssue[];
  /** Handler for tool loops; a thrown ToolFailure becomes a structured error result. */
  run?: (value: z.output<S>, call: ToolCall) => R | Promise<R>;
}

export interface Tool<S extends z.ZodType = z.ZodType, R = unknown> extends ToolSpec<S, R> {
  readonly definition: LlmTool;
  parse(args: unknown): { ok: true; value: z.output<S> } | { ok: false; issues: ToolIssue[] };
}

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** zod 4 → JSON Schema (input side: defaults make fields optional for the model). */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

export function zodIssues(error: z.ZodError): ToolIssue[] {
  return error.issues.map((i) => ({
    path: i.path.map(String).join("."),
    message: i.message,
    code: i.code,
  }));
}

/**
 * A copy of `args` where the values zod expected as an array or object but got as a string holding that JSON are
 * decoded; null when there is nothing to decode.
 */
export function decodeJsonStrings(args: unknown, error: z.ZodError): unknown | null {
  const copy: unknown = structuredClone(args);
  let changed = false;
  for (const i of error.issues) {
    const expected = (i as { expected?: unknown }).expected;
    if (i.code !== "invalid_type" || (expected !== "array" && expected !== "object")) continue;
    if (i.path.length === 0) continue;
    let parent: unknown = copy;
    for (const k of i.path.slice(0, -1))
      parent = (parent as Record<PropertyKey, unknown> | null)?.[k as PropertyKey];
    const key = i.path.at(-1) as PropertyKey;
    if (parent === null || typeof parent !== "object") continue;
    const v = (parent as Record<PropertyKey, unknown>)[key];
    if (typeof v !== "string") continue;
    try {
      const decoded: unknown = JSON.parse(v);
      if (
        decoded !== null &&
        typeof decoded === "object" &&
        Array.isArray(decoded) === (expected === "array")
      ) {
        (parent as Record<PropertyKey, unknown>)[key] = decoded;
        changed = true;
      }
    } catch {
      // Not JSON: the issue stays for the model.
    }
  }
  return changed ? copy : null;
}

export function defineTool<S extends z.ZodType, R = unknown>(spec: ToolSpec<S, R>): Tool<S, R> {
  if (!TOOL_NAME_RE.test(spec.name)) throw new Error(`tool name must be snake_case latin: ${spec.name}`);
  const definition: LlmTool = {
    name: spec.name,
    description: spec.description,
    parameters: toJsonSchema(spec.input),
  };
  return {
    ...spec,
    definition,
    parse(args) {
      let r = spec.input.safeParse(args);
      // Open models often send a nested array or object as a JSON string ("acceptance": "[{…}]"): such fields are
      // decoded and the arguments checked again (≤ 3 passes); anything else stays an issue for the model.
      for (let pass = 0; !r.success && pass < 3; pass++) {
        const fixed = decodeJsonStrings(args, r.error);
        if (fixed === null) break;
        args = fixed;
        r = spec.input.safeParse(args);
      }
      if (!r.success) return { ok: false, issues: zodIssues(r.error) };
      const issues = spec.check?.(r.data) ?? [];
      return issues.length > 0 ? { ok: false, issues } : { ok: true, value: r.data };
    },
  };
}

/** Throw from a tool handler to return a structured error to the model (e.g. OpsError[] from applyOps). */
export class ToolFailure extends Error {
  readonly code: string;
  readonly issues: ToolIssue[] | undefined;
  readonly data: unknown;
  constructor(code: string, message: string, issues?: ToolIssue[], data?: unknown) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
    this.issues = issues;
    this.data = data;
  }
}

export function toolError(code: string, message: string, issues?: ToolIssue[]): ToolErrorResult {
  return { ok: false, error: { code, message, ...(issues && issues.length > 0 ? { issues } : {}) } };
}
