// Zod mirror of specs/appspec/appspec.schema.json. MUST accept exactly the same language:
// keep strict/loose object modes, patterns, bounds and unicode length semantics in sync.
// JSON Schema `default` annotations are NOT applied here (parsing never changes the spec).
import { z } from "zod";
import { fromZodIssues, type OpsError } from "./errors.js";
import { semanticErrors, type ValidateOptions } from "./semantic.js";

/** JSON Schema string lengths count code points, not UTF-16 units. */
function cpString(min: number, max?: number) {
  return z.string().check((ctx) => {
    const len = [...ctx.value].length;
    if (len < min) {
      ctx.issues.push({
        code: "too_small",
        origin: "string",
        minimum: min,
        inclusive: true,
        input: ctx.value,
        message: `Слишком мало символов: минимум ${min}`,
      });
    }
    if (max !== undefined && len > max) {
      ctx.issues.push({
        code: "too_big",
        origin: "string",
        maximum: max,
        inclusive: true,
        input: ctx.value,
        message: `Слишком много символов: максимум ${max}`,
      });
    }
  });
}

/** JSON Schema `integer`: any finite number without a fractional part (not limited to safe ints). */
function jsonInt() {
  return z.number().refine((n) => Number.isInteger(n), { message: "Ожидается целое число" });
}

function uniqueItems<T extends z.ZodType>(item: T) {
  return z.array(item).refine((arr) => new Set(arr.map((v) => JSON.stringify(v))).size === arr.length, {
    message: "Элементы массива должны быть уникальны",
  });
}

/** JSON Schema `{"type":"object"}` without further constraints. */
const anyObject = z.record(z.string(), z.unknown());

export const IDENT_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const identSchema = z.string().regex(IDENT_RE);
export const labelSchema = cpString(1, 80);

export const FIELD_TYPES = [
  "string",
  "text",
  "int",
  "decimal",
  "money",
  "bool",
  "date",
  "datetime",
  "enum",
  "ref",
  "file",
  "image",
  "json",
  "email",
  "phone",
  "url",
  "qr_token",
] as const;
/** Field types whose value is a fileId of an own upload (runtime.yaml#files): file — download, image — shown on pages. */
export const FILE_FIELD_TYPES = ["file", "image"] as const;
/** file and image fields hold fileIds (runtime.yaml#files, #files.image). */
export const isFileFieldType = (t: string): t is (typeof FILE_FIELD_TYPES)[number] =>
  t === "file" || t === "image";
/** Self-hosted font families of themes (ui-kit.yaml#tokens.fonts; catalog with licenses — packages/ui-kit/fonts). */
export const THEME_FONTS = [
  "Onest",
  "Inter Tight",
  "Manrope",
  "PT Sans",
  "IBM Plex Sans",
  "Golos Text",
  "PT Serif",
  "Lora",
  "Unbounded",
  // Themes v2 (B2-36): font pairs of the ten presets.
  "Cormorant Garamond",
  "Commissioner",
  "Piazzolla",
  "Source Sans 3",
  "Sofia Sans Extra Condensed",
  "Sofia Sans",
  "Alegreya Sans",
  "Alegreya",
  "Alumni Sans",
  "Literata",
  "Wix Madefor Display",
  "Wix Madefor Text",
] as const;
/** Theme presets v2 (specs/ui/themes.yaml, B2-36): one of ten looks the agent picks by niche. */
export const THEME_PRESETS = [
  "strict",
  "warm",
  "bright",
  "calm",
  "boutique",
  "bistro",
  "workshop",
  "academy",
  "poster",
  "care",
] as const;
export const PII_CATEGORIES = ["none", "basic", "special", "biometric"] as const;
export const PERMISSION_OPS = ["read", "create", "update", "delete"] as const;
export const ON_DELETE = ["restrict", "cascade", "set_null"] as const;

export const themeSchema = z.strictObject({
  accent: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  preset: z.enum(THEME_PRESETS).optional(),
  font: z.enum(THEME_FONTS).optional(),
  headingFont: z.enum(THEME_FONTS).optional(),
  radius: z.literal([0, 4, 8, 12, 16]).optional(),
  density: z.enum(["compact", "regular"]).optional(),
  mode: z.enum(["light", "dark", "auto"]).optional(),
  logoFile: z
    .string()
    .regex(/\.(png|webp)$/)
    .optional(),
});

export const fieldTypeSchema = z.enum(FIELD_TYPES);
export const piiSchema = z.enum(PII_CATEGORIES);
export const PII_KINDS = [
  "fio",
  "phone",
  "email",
  "address",
  "birthdate",
  "passport",
  "snils",
  "inn",
  "card",
  "free_text",
  "other",
] as const;
export const piiKindSchema = z.enum(PII_KINDS);

export const enumOptionSchema = z.strictObject({ value: identSchema, label: labelSchema });
export const fieldRefSchema = z.strictObject({ entity: identSchema, onDelete: z.enum(ON_DELETE).optional() });

export const fieldSchema = z.strictObject({
  name: identSchema,
  label: labelSchema,
  type: fieldTypeSchema,
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  default: z.unknown().optional(),
  enum: z.array(enumOptionSchema).min(1).optional(),
  ref: fieldRefSchema.optional(),
  pii: piiSchema.optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxLength: jsonInt().min(1).max(100000).optional(),
  piiKind: piiKindSchema.optional(),
});

export const indexSchema = z.strictObject({
  fields: z.array(identSchema).min(1),
  unique: z.boolean().optional(),
});

export const retentionSchema = z.strictObject({
  deleteAfterDays: jsonInt().min(1).max(3650),
  anchorField: identSchema.optional(),
  mode: z.enum(["delete", "anonymize"]).optional(),
});

export const entitySchema = z.strictObject({
  name: identSchema,
  label: labelSchema,
  fields: z.array(fieldSchema).min(1).max(80),
  indexes: z.array(indexSchema).optional(),
  ownerField: identSchema.optional(),
  retention: retentionSchema.optional(),
});

export const LOGIN_METHODS = ["phone_otp", "email_otp", "telegram"] as const;

export const roleSchema = z.strictObject({
  name: identSchema,
  label: labelSchema,
  access: z.enum(["public", "login"]),
  loginMethods: z.array(z.enum(LOGIN_METHODS)).min(1).optional(),
  isAdmin: z.boolean().optional(),
  selfSignup: z.boolean().optional(),
});

export const rowFilterSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export const permissionSchema = z.strictObject({
  role: identSchema,
  entity: identSchema,
  ops: uniqueItems(z.enum(PERMISSION_OPS)),
  rowFilter: rowFilterSchema.optional(),
  hiddenFields: z.array(identSchema).optional(),
  readonlyFields: z.array(identSchema).optional(),
  rowFilterOps: uniqueItems(z.enum(PERMISSION_OPS)).optional(),
  /** Enum values the role may write into a field on create/update (V3-18: a visitor only cancels his booking). */
  allowedValues: z
    .record(
      identSchema,
      z
        .array(identSchema)
        .min(1)
        .refine((a) => new Set(a).size === a.length, { message: "Элементы массива должны быть уникальны" }),
    )
    .optional(),
});

export const TRIGGER_TYPES = [
  "on_create",
  "on_update",
  "on_status",
  "schedule",
  "webhook",
  "manual",
] as const;
export const STEP_TYPES = [
  "update",
  "create",
  "notify",
  "connector",
  "function",
  "ai_extract",
  "ai_generate",
  "wait",
] as const;

export const workflowSchema = z.strictObject({
  name: identSchema,
  label: labelSchema.optional(),
  trigger: z.strictObject({
    type: z.enum(TRIGGER_TYPES),
    entity: identSchema.optional(),
    field: identSchema.optional(),
    equals: z.unknown().optional(),
    cron: z.string().optional(),
    integration: identSchema.optional(),
    relative: z
      .looseObject({
        field: identSchema.optional(),
        offsetMinutes: jsonInt().optional(),
      })
      .optional(),
  }),
  steps: z
    .array(z.strictObject({ type: z.enum(STEP_TYPES), params: anyObject.optional() }))
    .min(1)
    .max(20),
});

export const CONNECTORS = ["yookassa", "telegram", "email", "qr", "webhook"] as const;
export const SECRET_REF_RE = /^secret:\/\/[a-z0-9_]+$/;

export const integrationSchema = z.strictObject({
  name: identSchema,
  connector: z.enum(CONNECTORS),
  config: anyObject.optional(),
  secretRefs: z.array(z.string().regex(SECRET_REF_RE)).optional(),
});

/** FQDN without IP, port or wildcard (L3-24). */
export const EGRESS_HOST_RE = /^(?!\d+\.)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export const functionSchema = z.strictObject({
  name: z.string().regex(/^[a-z][A-Za-z0-9]{0,59}$/),
  kind: z.enum(["query", "mutation", "action"]),
  file: z.string().regex(/^functions\/[A-Za-z0-9_/-]+\.ts$/),
  public: z.boolean().optional(),
  roles: z.array(identSchema).optional(),
  egress: z.array(z.string().regex(EGRESS_HOST_RE)).optional(),
  secretRefs: z.array(z.string().regex(SECRET_REF_RE)).optional(),
  collectsPii: z.boolean().optional(),
  systemDbReason: z.string().min(10).max(300).optional(),
});

export const pageSchema = z.strictObject({
  route: z.string().regex(/^\/[a-z0-9/:_-]*$/),
  title: labelSchema,
  file: z.string().regex(/^ui\/[A-Za-z0-9_/-]+\.tsx$/),
  roles: z.array(identSchema).min(1),
  nav: z.boolean().optional(),
});

export const aiActionSchema = z.strictObject({
  name: identSchema,
  kind: z.enum(["extract", "generate"]),
  input: anyObject,
  output: anyObject,
  monthlyLimit: jsonInt().min(1),
  tier: z.literal("T0").optional(),
});

/** Keys of a scenario step (quality/gates.yaml#scenario_dsl.Step): one action, plus `consent` for create/callFn. */
export const SCENARIO_STEP_KEYS = [
  "as",
  "create",
  "read",
  "update",
  "delete",
  "callFn",
  "simulate",
  "runWorkflows",
  "advanceTime",
  "expect",
  "consent",
] as const;
const STEP_KEY_SET: ReadonlySet<string> = new Set(SCENARIO_STEP_KEYS);

export const scenarioStepSchema = anyObject
  .refine((o) => Object.keys(o).length >= 1 && Object.keys(o).length <= 2, {
    message: "Шаг сценария — ровно одно действие (и consent для create/callFn)",
  })
  .refine((o) => Object.keys(o).every((k) => STEP_KEY_SET.has(k)), {
    message: `Допустимые ключи шага: ${SCENARIO_STEP_KEYS.join(", ")}`,
  })
  .refine((o) => !("consent" in o) || o.consent === true, { message: "consent может быть только true" })
  .refine((o) => !("consent" in o) || "create" in o || "callFn" in o, {
    message: "consent допустим только в шаге create или callFn",
  })
  .refine((o) => Object.keys(o).length < 2 || "consent" in o, {
    message: "Шаг сценария — ровно одно действие",
  });

export const acceptanceSchema = z.strictObject({
  id: z.string().regex(/^AC[0-9]{1,3}$/),
  text: z.string(),
  check: z.strictObject({
    type: z.enum(["permission", "scenario", "constraint"]),
    role: identSchema.optional(),
    entity: identSchema.optional(),
    op: z.enum(PERMISSION_OPS).optional(),
    expect: z.enum(["allow", "deny"]).optional(),
    steps: z.array(scenarioStepSchema).min(1).max(40).optional(),
    actors: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.looseObject({ role: identSchema })).optional(),
    seed: z.enum(["default", "none"]).optional(),
    milestone: z.enum(["M0", "M1", "M2", "M3", "M4"]).optional(),
  }),
});

export const complianceSchema = z.strictObject({
  consentTemplateId: identSchema.optional(),
  consentText: z.string().optional(),
  policyPage: z.string().optional(),
  operatorName: z.string().optional(),
  operatorContact: z.string().optional(),
  operatorAddress: cpString(0, 300).optional(),
  operatorInn: z
    .string()
    .regex(/^[0-9]{10}([0-9]{2})?$/)
    .optional(),
  /** ОГРН (13 digits, an organization) or ОГРНИП (15, an individual entrepreneur): the seller's requisite (V3-18). */
  operatorOgrn: z
    .string()
    .regex(/^[0-9]{13}([0-9]{2})?$/)
    .optional(),
  retentionWaiver: z.strictObject({ reason: cpString(10) }).optional(),
});

export const appSchema = z.strictObject({
  name: cpString(1, 80),
  description: cpString(0, 2000).optional(),
  locale: z.literal("ru"),
  template: z.string().optional(),
  timezone: z.string().optional(),
});

export const LIMITS = {
  entities: 60,
  fieldsPerEntity: 80,
  roles: 20,
  workflows: 100,
  functions: 200,
  pages: 80,
};

export const appSpecSchema = z.strictObject({
  specVersion: z.literal("1"),
  app: appSchema,
  theme: themeSchema.optional(),
  entities: z.array(entitySchema).max(LIMITS.entities),
  roles: z.array(roleSchema).min(1).max(LIMITS.roles),
  permissions: z.array(permissionSchema),
  workflows: z.array(workflowSchema).max(LIMITS.workflows).optional(),
  integrations: z.array(integrationSchema).optional(),
  functions: z.array(functionSchema).max(LIMITS.functions).optional(),
  pages: z.array(pageSchema).max(LIMITS.pages).optional(),
  aiActions: z.array(aiActionSchema).optional(),
  acceptance: z.array(acceptanceSchema).optional(),
  compliance: complianceSchema.optional(),
});

export type AppSpec = z.infer<typeof appSpecSchema>;
export type Theme = z.infer<typeof themeSchema>;
export type Entity = z.infer<typeof entitySchema>;
export type Field = z.infer<typeof fieldSchema>;
export type FieldType = z.infer<typeof fieldTypeSchema>;
export type EntityIndex = z.infer<typeof indexSchema>;
export type Role = z.infer<typeof roleSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type PermissionOp = (typeof PERMISSION_OPS)[number];
export type Workflow = z.infer<typeof workflowSchema>;
export type Integration = z.infer<typeof integrationSchema>;
export type AppFunction = z.infer<typeof functionSchema>;
export type Page = z.infer<typeof pageSchema>;
export type AiAction = z.infer<typeof aiActionSchema>;
export type Acceptance = z.infer<typeof acceptanceSchema>;
export type Compliance = z.infer<typeof complianceSchema>;

export type ValidateResult = { ok: true; spec: AppSpec } | { ok: false; errors: OpsError[] };

/** Structural check (zod, 1:1 with appspec.schema.json) followed by semantic rules (ops.yaml). */
export function validateSpec(input: unknown, opts: ValidateOptions = {}): ValidateResult {
  const parsed = appSpecSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: fromZodIssues(parsed.error.issues) };
  const errors = semanticErrors(parsed.data, opts);
  return errors.length ? { ok: false, errors } : { ok: true, spec: parsed.data };
}
