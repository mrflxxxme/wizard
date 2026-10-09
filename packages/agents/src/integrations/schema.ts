// JSON Schema subset of an integration contract (V3-20; D77_v3 (15)): what OpenAPI 3.1 / Swagger 2.0 operations are
// reduced to — one type per node (nullable flag), objects with named properties, arrays, enums of scalars, formats and
// simple bounds; $ref is resolved by the importer, composition (oneOf/anyOf/allOf) is flattened or dropped. The same
// subset drives the validator of responses, the deterministic sample (mock) and the code generator of the client.
import { createHash } from "node:crypto";
import { z } from "zod";

export const API_SCHEMA_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
] as const;
export type ApiSchemaType = (typeof API_SCHEMA_TYPES)[number];

/** A node of the subset. `type` absent — any JSON value (free-form). */
export interface ApiSchema {
  type?: ApiSchemaType;
  nullable?: boolean;
  format?: string;
  enum?: (string | number | boolean)[];
  properties?: Record<string, ApiSchema>;
  required?: string[];
  items?: ApiSchema;
  description?: string;
  example?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
}

/** Caps of one schema tree: depth, properties per object, enum values, text. */
export const SCHEMA_LIMITS = { depth: 6, properties: 60, enum: 50, description: 200 } as const;

const PROP_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,63}$/;

export const apiSchemaSchema: z.ZodType<ApiSchema> = z.lazy(() =>
  z.strictObject({
    type: z.enum(API_SCHEMA_TYPES).optional(),
    nullable: z.boolean().optional(),
    format: z.string().max(40).optional(),
    enum: z
      .array(z.union([z.string().max(200), z.number(), z.boolean()]))
      .min(1)
      .max(SCHEMA_LIMITS.enum)
      .optional(),
    properties: z
      .record(z.string().regex(PROP_NAME_RE), apiSchemaSchema)
      .refine((p) => Object.keys(p).length <= SCHEMA_LIMITS.properties, {
        message: `Не больше ${SCHEMA_LIMITS.properties} полей в объекте`,
      })
      .optional(),
    required: z.array(z.string().regex(PROP_NAME_RE)).max(SCHEMA_LIMITS.properties).optional(),
    items: apiSchemaSchema.optional(),
    description: z.string().max(SCHEMA_LIMITS.description).optional(),
    example: z.unknown().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(0).optional(),
    maxItems: z.number().int().min(0).optional(),
  }),
);

/** Property names usable in the contract (and as quoted keys in the generated client). */
export const isPropName = (name: string): boolean => PROP_NAME_RE.test(name);

const typeOf = (v: unknown): ApiSchemaType =>
  v === null
    ? "null"
    : Array.isArray(v)
      ? "array"
      : typeof v === "number"
        ? Number.isInteger(v)
          ? "integer"
          : "number"
        : (typeof v as ApiSchemaType);

const FORMAT_RE: Record<string, RegExp> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  uri: /^[a-z][a-z0-9+.-]*:\S+$/i,
};

/** A mismatch of a value against a schema: JSON Pointer and a Russian text. */
export interface SchemaIssue {
  path: string;
  message_ru: string;
}

/**
 * Checks `value` against the subset (types, required properties, enums, formats, bounds). Extra properties are
 * allowed: providers add fields over time and a contract test must not break on them.
 */
export function validateValue(schema: ApiSchema, value: unknown, path = ""): SchemaIssue[] {
  const out: SchemaIssue[] = [];
  const at = path || "/";
  if (value === null) {
    if (schema.nullable || schema.type === "null" || schema.type === undefined) return out;
    out.push({ path: at, message_ru: "Пустое значение (null) там, где оно не разрешено" });
    return out;
  }
  if (schema.type === undefined) return out;
  const t = typeOf(value);
  const typeOk = t === schema.type || (schema.type === "number" && t === "integer");
  if (!typeOk) {
    out.push({ path: at, message_ru: `Ожидается ${TYPE_RU[schema.type]}, пришло ${TYPE_RU[t]}` });
    return out;
  }
  if (schema.enum && !schema.enum.includes(value as string | number | boolean))
    out.push({ path: at, message_ru: `Значение не из списка: ${schema.enum.slice(0, 5).join(", ")}` });
  if (typeof value === "string") {
    const re = schema.format ? FORMAT_RE[schema.format] : undefined;
    if (re && !re.test(value)) out.push({ path: at, message_ru: `Неверный формат ${schema.format}` });
    if (schema.minLength !== undefined && value.length < schema.minLength)
      out.push({ path: at, message_ru: `Строка короче ${schema.minLength} символов` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      out.push({ path: at, message_ru: `Строка длиннее ${schema.maxLength} символов` });
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      out.push({ path: at, message_ru: `Число меньше ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum)
      out.push({ path: at, message_ru: `Число больше ${schema.maximum}` });
  }
  if (Array.isArray(value) && schema.items) {
    value.slice(0, 200).forEach((item, i) => {
      out.push(...validateValue(schema.items as ApiSchema, item, `${path}/${i}`));
    });
  }
  if (t === "object" && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const name of schema.required ?? [])
      if (!Object.hasOwn(obj, name) || obj[name] === undefined)
        out.push({ path: `${path}/${escapePointer(name)}`, message_ru: `Нет обязательного поля «${name}»` });
    for (const [name, sub] of Object.entries(schema.properties))
      if (Object.hasOwn(obj, name) && obj[name] !== undefined)
        out.push(...validateValue(sub, obj[name], `${path}/${escapePointer(name)}`));
  }
  return out.slice(0, 50);
}

const TYPE_RU: Record<ApiSchemaType, string> = {
  string: "строка",
  number: "число",
  integer: "целое число",
  boolean: "да/нет",
  object: "объект",
  array: "список",
  null: "null",
};

const escapePointer = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

/** Deterministic PRNG (mulberry32) seeded by a string. */
function rng(seed: string): () => number {
  let a = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SAMPLE_WORDS = ["Пример", "Тест", "Заказ", "Клиент", "Сделка", "Товар", "Запись", "Услуга"];

/**
 * A value that passes `validateValue(schema, …)`: the schema's own example when it is valid, else one built from the
 * schema with a PRNG seeded by `seed` — the same contract and seed always give the same value (the mock is
 * deterministic). Optional properties are included, so the client sees every field it can get.
 */
export function sampleValue(schema: ApiSchema, seed: string): unknown {
  const r = rng(seed);
  const build = (s: ApiSchema, depth: number, key: string): unknown => {
    if (s.example !== undefined && validateValue(s, s.example).length === 0) return s.example;
    if (s.enum?.length) return s.enum[Math.floor(r() * s.enum.length)];
    switch (s.type) {
      case "string": {
        switch (s.format) {
          case "date":
            return `2026-${String(1 + Math.floor(r() * 12)).padStart(2, "0")}-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}`;
          case "date-time":
            return `2026-10-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}T${String(Math.floor(r() * 24)).padStart(2, "0")}:00:00Z`;
          case "email":
            return `user${Math.floor(r() * 1000)}@example.ru`;
          case "uuid": {
            const h = createHash("sha256").update(`${seed}:${key}`).digest("hex");
            return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
          }
          case "uri":
            return `https://example.ru/${Math.floor(r() * 1000)}`;
          default: {
            const word = `${SAMPLE_WORDS[Math.floor(r() * SAMPLE_WORDS.length)]} ${Math.floor(r() * 1000)}`;
            const min = s.minLength ?? 0;
            const max = s.maxLength ?? 120;
            const padded = word.length < min ? word.padEnd(min, "x") : word;
            return padded.slice(0, Math.max(min, Math.min(max, padded.length)));
          }
        }
      }
      case "integer":
      case "number": {
        const lo = s.minimum ?? 1;
        const hi = s.maximum ?? Math.max(lo, 1000);
        const n = lo + Math.floor(r() * (Math.max(hi - lo, 0) + 1));
        return s.type === "number" && s.maximum === undefined ? n + 0.5 : n;
      }
      case "boolean":
        return r() < 0.5;
      case "null":
        return null;
      case "array": {
        if (!s.items || depth >= SCHEMA_LIMITS.depth) return [];
        const n = Math.min(2, s.maxItems ?? 2);
        return Array.from({ length: n }, (_, i) => build(s.items as ApiSchema, depth + 1, `${key}[${i}]`));
      }
      case "object": {
        const out: Record<string, unknown> = {};
        if (depth >= SCHEMA_LIMITS.depth) return out;
        for (const [name, sub] of Object.entries(s.properties ?? {}))
          out[name] = build(sub, depth + 1, `${key}.${name}`);
        return out;
      }
      default:
        return s.nullable ? null : {};
    }
  };
  return build(schema, 0, "");
}

/** Depth of a schema tree (the importer cuts deeper nodes to free-form). */
export function schemaDepth(s: ApiSchema): number {
  const kids = [...Object.values(s.properties ?? {}), ...(s.items ? [s.items] : [])];
  return 1 + (kids.length ? Math.max(...kids.map(schemaDepth)) : 0);
}
