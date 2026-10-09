// Small builders of the JSON Schema subset and of contract operations: passports are data, these keep them readable.
import type { ContractMethod, ContractOperation, ContractParam } from "../contract.js";
import type { ApiSchema } from "../schema.js";

type Extra = Omit<ApiSchema, "type">;
const node = (type: ApiSchema["type"], description: string | undefined, x: Extra): ApiSchema => ({
  type,
  ...(description ? { description } : {}),
  ...x,
});

export const str = (description?: string, x: Extra = {}): ApiSchema => node("string", description, x);
export const int = (description?: string, x: Extra = {}): ApiSchema => node("integer", description, x);
export const num = (description?: string, x: Extra = {}): ApiSchema => node("number", description, x);
export const bool = (description?: string, x: Extra = {}): ApiSchema => node("boolean", description, x);
/** String enum. */
export const oneOf = (values: readonly string[], description?: string, x: Extra = {}): ApiSchema =>
  node("string", description, { enum: [...values], ...x });
/** Object with named properties; `required` — names of required ones. */
export const obj = (
  properties: Record<string, ApiSchema>,
  required: readonly string[] = [],
  x: Extra = {},
): ApiSchema =>
  node("object", x.description, {
    properties,
    ...(required.length ? { required: [...required] } : {}),
    ...x,
  });
export const arr = (items: ApiSchema, x: Extra = {}): ApiSchema =>
  node("array", x.description, { items, ...x });
/** Free-form object (the subset keeps it as a Record and leaves it out of function arguments). */
export const anyObj = (description?: string): ApiSchema => node("object", description, {});

/** Query parameter (optional unless `required`). */
export const query = (name: string, arg: string, schema: ApiSchema, required = false): ContractParam => ({
  name,
  in: "query",
  required,
  schema,
  arg,
});
/** Path parameter (always required). */
export const path = (name: string, arg: string, schema: ApiSchema): ContractParam => ({
  name,
  in: "path",
  required: true,
  schema,
  arg,
});
/** Header parameter. */
export const header = (name: string, arg: string, schema: ApiSchema, required = false): ContractParam => ({
  name,
  in: "header",
  required,
  schema,
  arg,
});

export interface OpInput {
  id: string;
  method: ContractMethod;
  path: string;
  summary: string;
  params?: ContractParam[];
  body?: ApiSchema;
  bodyRequired?: boolean;
  status?: number;
  response: ApiSchema;
  /** Realistic answer from the documentation (the mock serves it). */
  example: unknown;
}

/** A contract operation from the short form. */
export function op(o: OpInput): ContractOperation {
  return {
    id: o.id,
    method: o.method,
    path: o.path,
    summary: o.summary,
    params: o.params ?? [],
    body: o.body ? { required: o.bodyRequired ?? true, schema: o.body } : null,
    response: { status: o.status ?? 200, schema: o.response, example: o.example },
  };
}
