// Typed operations over AppSpec and the atomic batch applier. Source: specs/appspec/ops.yaml.
import { z } from "zod";
import { err, fromZodIssues, type OpsError } from "./errors.js";
import {
  type AppSpec,
  acceptanceSchema,
  aiActionSchema,
  appSchema,
  CONNECTORS,
  complianceSchema,
  entitySchema,
  fieldSchema,
  functionSchema,
  identSchema,
  indexSchema,
  integrationSchema,
  LOGIN_METHODS,
  labelSchema,
  pageSchema,
  permissionSchema,
  piiSchema,
  retentionSchema,
  roleSchema,
  SECRET_REF_RE,
  themeSchema,
  validateSpec,
  workflowSchema,
} from "./schema.js";
import type { ValidateOptions } from "./semantic.js";

export const MAX_BATCH = 50;

const opSchemas = [
  z.strictObject({
    op: z.literal("set_app"),
    name: appSchema.shape.name.optional(),
    description: appSchema.shape.description,
    timezone: appSchema.shape.timezone,
  }),
  z.strictObject({ op: z.literal("set_theme"), ...themeSchema.shape }),
  z.strictObject({ op: z.literal("add_entity"), ...entitySchema.shape }),
  z.strictObject({
    op: z.literal("update_entity"),
    name: identSchema,
    label: labelSchema.optional(),
    indexes: z.array(indexSchema).optional(),
    ownerField: identSchema.nullable().optional(),
    retention: retentionSchema.nullable().optional(),
  }),
  z.strictObject({ op: z.literal("remove_entity"), name: identSchema }),
  z.strictObject({ op: z.literal("add_field"), entity: identSchema, field: fieldSchema }),
  z.strictObject({
    op: z.literal("update_field"),
    entity: identSchema,
    name: identSchema,
    patch: z.strictObject({
      label: labelSchema.optional(),
      required: z.boolean().optional(),
      unique: z.boolean().optional(),
      default: z.unknown().optional(),
      enum: fieldSchema.shape.enum,
      pii: piiSchema.optional(),
      min: z.number().nullable().optional(),
      max: z.number().nullable().optional(),
      maxLength: fieldSchema.shape.maxLength.unwrap().nullable().optional(),
    }),
  }),
  z.strictObject({ op: z.literal("remove_field"), entity: identSchema, name: identSchema }),
  z.strictObject({ op: z.literal("add_role"), ...roleSchema.shape }),
  z.strictObject({
    op: z.literal("update_role"),
    name: identSchema,
    patch: z.strictObject({
      label: labelSchema.optional(),
      access: z.enum(["public", "login"]).optional(),
      loginMethods: z.array(z.enum(LOGIN_METHODS)).min(1).optional(),
      isAdmin: z.boolean().optional(),
      selfSignup: z.boolean().optional(),
    }),
  }),
  z.strictObject({ op: z.literal("remove_role"), name: identSchema }),
  z.strictObject({ op: z.literal("set_permission"), ...permissionSchema.shape }),
  z.strictObject({ op: z.literal("remove_permission"), role: identSchema, entity: identSchema }),
  z.strictObject({ op: z.literal("add_workflow"), workflow: workflowSchema }),
  z.strictObject({ op: z.literal("update_workflow"), name: identSchema, workflow: workflowSchema }),
  z.strictObject({ op: z.literal("remove_workflow"), name: identSchema }),
  z.strictObject({ op: z.literal("add_integration"), integration: integrationSchema }),
  z.strictObject({
    op: z.literal("update_integration"),
    name: identSchema,
    patch: z.strictObject({
      connector: z.enum(CONNECTORS).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      secretRefs: z.array(z.string().regex(SECRET_REF_RE)).optional(),
    }),
  }),
  z.strictObject({ op: z.literal("remove_integration"), name: identSchema }),
  z.strictObject({ op: z.literal("add_function"), ...functionSchema.shape }),
  z.strictObject({ op: z.literal("remove_function"), name: functionSchema.shape.name }),
  z.strictObject({ op: z.literal("add_page"), ...pageSchema.shape }),
  z.strictObject({
    op: z.literal("update_page"),
    route: pageSchema.shape.route,
    patch: z.strictObject({
      route: pageSchema.shape.route.optional(),
      title: labelSchema.optional(),
      file: pageSchema.shape.file.optional(),
      roles: pageSchema.shape.roles.optional(),
      nav: z.boolean().optional(),
    }),
  }),
  z.strictObject({ op: z.literal("remove_page"), route: pageSchema.shape.route }),
  z.strictObject({ op: z.literal("add_ai_action"), aiAction: aiActionSchema }),
  z.strictObject({ op: z.literal("set_acceptance"), acceptance: z.array(acceptanceSchema) }),
  z.strictObject({
    op: z.literal("set_compliance"),
    consentTemplateId: complianceSchema.shape.consentTemplateId,
    consentText: complianceSchema.shape.consentText,
    operatorName: complianceSchema.shape.operatorName,
    operatorContact: complianceSchema.shape.operatorContact,
    operatorInn: complianceSchema.shape.operatorInn,
    operatorAddress: complianceSchema.shape.operatorAddress,
    retentionWaiver: complianceSchema.shape.retentionWaiver,
    policyPage: complianceSchema.shape.policyPage,
  }),
] as const;

export const opSchema = z.discriminatedUnion("op", opSchemas);
export type Op = z.infer<typeof opSchema>;
export type OpName = Op["op"];
export const OP_NAMES: readonly OpName[] = opSchemas.map((s) => s.shape.op.value);

/** Ops allowed only in draft (ops.yaml: remove_entity/remove_field/remove_role «только draft»). */
export const DESTRUCTIVE_OPS: ReadonlySet<OpName> = new Set<OpName>([
  "remove_entity",
  "remove_field",
  "remove_role",
]);

/**
 * set_compliance fields only the owner (author user/system) may set (ops.yaml#ops.set_compliance, L3-06):
 * the agent may only pick a lawyer's consent template and the policy page.
 */
export const OWNER_ONLY_COMPLIANCE_FIELDS = [
  "consentText",
  "operatorName",
  "operatorContact",
  "operatorInn",
  "operatorAddress",
  "retentionWaiver",
] as const;

export interface Revision {
  version: number;
  parentVersion: number;
  /** applyOps always produces "ops"; files/style/revert revisions are created by platform-api. */
  kind: "ops" | "files" | "style" | "revert";
  author: "user" | "agent" | "system";
  runId?: string;
  ops: Op[];
  createdAt: string;
}

export interface ApplyOpsSuccess {
  ok: true;
  spec: AppSpec;
  version: number;
  /** Revision record the caller MUST persist (ops.yaml#apply.rules). */
  revision: Revision;
}
export interface ApplyOpsFailure {
  ok: false;
  errors: OpsError[];
}
export type ApplyOpsResult = ApplyOpsSuccess | ApplyOpsFailure;

/** Remembers successful results by idempotency key. Keys are global: namespace them per system. */
export interface IdempotencyStore {
  get(key: string): ApplyOpsSuccess | undefined;
  set(key: string, result: ApplyOpsSuccess): void;
}

export class LruIdempotencyStore implements IdempotencyStore {
  readonly #map = new Map<string, ApplyOpsSuccess>();
  constructor(readonly capacity = 1000) {}
  get(key: string): ApplyOpsSuccess | undefined {
    const v = this.#map.get(key);
    if (v !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, v);
    }
    return v;
  }
  set(key: string, result: ApplyOpsSuccess): void {
    this.#map.delete(key);
    this.#map.set(key, result);
    while (this.#map.size > this.capacity) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }
  get size(): number {
    return this.#map.size;
  }
}

const defaultStore = new LruIdempotencyStore();

export interface ApplyOpsOptions extends ValidateOptions {
  env?: "draft" | "prod";
  /** Version of `spec` as stored by the caller; `expectedVersion` must equal it. Default 0 (new spec). */
  currentVersion?: number;
  idempotencyKey?: string;
  store?: IdempotencyStore;
  author?: "user" | "agent" | "system";
  runId?: string;
}

/** Minimal starting point for the first batch; not valid on its own (roles must be non-empty). */
export function emptySpec(name: string): AppSpec {
  return { specVersion: "1", app: { name, locale: "ru" }, entities: [], roles: [], permissions: [] };
}

type Ctx = { spec: AppSpec; errors: OpsError[]; i: number };

function findIndex<T>(items: T[] | undefined, pred: (t: T) => boolean): number {
  return items ? items.findIndex(pred) : -1;
}

function notFound(
  ctx: Ctx,
  code: OpsError["code"],
  key: string,
  what: string,
  value: string,
  allowed: string[],
): undefined {
  ctx.errors.push(err(code, ["ops", ctx.i, key], `${what} «${value}» не найдено`, { allowed }));
}

function duplicate(ctx: Ctx, path: PropertyKey[], what: string, value: string): undefined {
  ctx.errors.push(err("DUPLICATE_NAME", ["ops", ctx.i, ...path], `${what} «${value}» уже существует`));
}

function assignDefined<T extends object>(target: T, patch: Record<string, unknown>): void {
  const t = target as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete t[k];
    else t[k] = v;
  }
}

function applyOne(ctx: Ctx, op: Op): undefined {
  const { spec } = ctx;
  const entityNames = () => spec.entities.map((e) => e.name);
  const roleNames = () => spec.roles.map((r) => r.name);
  const entityOr = (name: string, key = "entity") => {
    const e = spec.entities.find((x) => x.name === name);
    if (!e) notFound(ctx, "UNKNOWN_ENTITY", key, "Сущность", name, entityNames());
    return e;
  };
  const { op: kind, ...params } = op;
  switch (op.op) {
    case "set_app":
      assignDefined(spec.app, { name: op.name, description: op.description, timezone: op.timezone });
      return;
    case "set_theme": {
      spec.theme = { ...(spec.theme ?? {}) };
      assignDefined(spec.theme, params);
      return;
    }
    case "add_entity": {
      if (spec.entities.some((e) => e.name === op.name)) return duplicate(ctx, ["name"], "Сущность", op.name);
      const { op: _, ...entity } = op;
      spec.entities.push(entity);
      return;
    }
    case "update_entity": {
      const e = entityOr(op.name, "name");
      if (e)
        assignDefined(e, {
          label: op.label,
          indexes: op.indexes,
          ownerField: op.ownerField,
          retention: op.retention,
        });
      return;
    }
    case "remove_entity": {
      if (!entityOr(op.name, "name")) return;
      spec.entities = spec.entities.filter((e) => e.name !== op.name);
      // Permissions are meaningless without the entity; refs from other entities stay and fail validation.
      spec.permissions = spec.permissions.filter((p) => p.entity !== op.name);
      return;
    }
    case "add_field": {
      const e = entityOr(op.entity);
      if (!e) return;
      if (e.fields.some((f) => f.name === op.field.name))
        return duplicate(ctx, ["field", "name"], "Поле", op.field.name);
      e.fields.push(op.field);
      return;
    }
    case "update_field": {
      const e = entityOr(op.entity);
      if (!e) return;
      const f = e.fields.find((x) => x.name === op.name);
      if (!f)
        return notFound(
          ctx,
          "UNKNOWN_FIELD",
          "name",
          "Поле",
          op.name,
          e.fields.map((x) => x.name),
        );
      assignDefined(f, op.patch);
      if ("default" in op.patch && op.patch.default !== undefined) f.default = op.patch.default;
      return;
    }
    case "remove_field": {
      const e = entityOr(op.entity);
      if (!e) return;
      const j = e.fields.findIndex((x) => x.name === op.name);
      if (j < 0)
        return notFound(
          ctx,
          "UNKNOWN_FIELD",
          "name",
          "Поле",
          op.name,
          e.fields.map((x) => x.name),
        );
      e.fields.splice(j, 1);
      return;
    }
    case "add_role": {
      if (spec.roles.some((r) => r.name === op.name)) return duplicate(ctx, ["name"], "Роль", op.name);
      const { op: _, ...role } = op;
      spec.roles.push(role);
      return;
    }
    case "update_role": {
      const r = spec.roles.find((x) => x.name === op.name);
      if (!r) return notFound(ctx, "UNKNOWN_ROLE", "name", "Роль", op.name, roleNames());
      assignDefined(r, op.patch);
      return;
    }
    case "remove_role": {
      if (!spec.roles.some((x) => x.name === op.name))
        return notFound(ctx, "UNKNOWN_ROLE", "name", "Роль", op.name, roleNames());
      spec.roles = spec.roles.filter((r) => r.name !== op.name);
      spec.permissions = spec.permissions.filter((p) => p.role !== op.name);
      return;
    }
    case "set_permission": {
      const { op: _, ...perm } = op;
      const k = spec.permissions.findIndex((p) => p.role === op.role && p.entity === op.entity);
      if (k >= 0) spec.permissions[k] = perm;
      else spec.permissions.push(perm);
      return;
    }
    case "remove_permission": {
      if (!spec.roles.some((x) => x.name === op.role))
        return notFound(ctx, "UNKNOWN_ROLE", "role", "Роль", op.role, roleNames());
      if (!entityOr(op.entity)) return;
      spec.permissions = spec.permissions.filter((p) => !(p.role === op.role && p.entity === op.entity));
      return;
    }
    case "add_workflow": {
      if (spec.workflows?.some((w) => w.name === op.workflow.name))
        return duplicate(ctx, ["workflow", "name"], "Процесс", op.workflow.name);
      spec.workflows = [...(spec.workflows ?? []), op.workflow];
      return;
    }
    case "update_workflow":
    case "remove_workflow": {
      const k = findIndex(spec.workflows, (w) => w.name === op.name);
      if (k < 0 || !spec.workflows)
        return notFound(
          ctx,
          "SCHEMA_INVALID",
          "name",
          "Процесс",
          op.name,
          (spec.workflows ?? []).map((w) => w.name),
        );
      if (op.op === "update_workflow") spec.workflows[k] = op.workflow;
      else spec.workflows.splice(k, 1);
      return;
    }
    case "add_integration": {
      if (spec.integrations?.some((x) => x.name === op.integration.name))
        return duplicate(ctx, ["integration", "name"], "Интеграция", op.integration.name);
      spec.integrations = [...(spec.integrations ?? []), op.integration];
      return;
    }
    case "update_integration":
    case "remove_integration": {
      const k = findIndex(spec.integrations, (x) => x.name === op.name);
      const item = spec.integrations?.[k];
      if (!item || !spec.integrations)
        return notFound(
          ctx,
          "SCHEMA_INVALID",
          "name",
          "Интеграция",
          op.name,
          (spec.integrations ?? []).map((x) => x.name),
        );
      if (op.op === "update_integration") assignDefined(item, op.patch);
      else spec.integrations.splice(k, 1);
      return;
    }
    case "add_function": {
      if (spec.functions?.some((f) => f.name === op.name))
        return duplicate(ctx, ["name"], "Функция", op.name);
      const { op: _, ...fn } = op;
      spec.functions = [...(spec.functions ?? []), fn];
      return;
    }
    case "remove_function": {
      const k = findIndex(spec.functions, (f) => f.name === op.name);
      if (k < 0 || !spec.functions)
        return notFound(
          ctx,
          "SCHEMA_INVALID",
          "name",
          "Функция",
          op.name,
          (spec.functions ?? []).map((f) => f.name),
        );
      spec.functions.splice(k, 1);
      return;
    }
    case "add_page": {
      if (spec.pages?.some((p) => p.route === op.route))
        return duplicate(ctx, ["route"], "Страница", op.route);
      const { op: _, ...page } = op;
      spec.pages = [...(spec.pages ?? []), page];
      return;
    }
    case "update_page":
    case "remove_page": {
      const k = findIndex(spec.pages, (p) => p.route === op.route);
      const page = spec.pages?.[k];
      if (!page || !spec.pages)
        return notFound(
          ctx,
          "SCHEMA_INVALID",
          "route",
          "Страница",
          op.route,
          (spec.pages ?? []).map((p) => p.route),
        );
      if (op.op === "update_page") assignDefined(page, op.patch);
      else spec.pages.splice(k, 1);
      return;
    }
    case "add_ai_action": {
      if (spec.aiActions?.some((a) => a.name === op.aiAction.name))
        return duplicate(ctx, ["aiAction", "name"], "ИИ-действие", op.aiAction.name);
      spec.aiActions = [...(spec.aiActions ?? []), op.aiAction];
      return;
    }
    case "set_acceptance":
      spec.acceptance = op.acceptance;
      return;
    case "set_compliance": {
      const { op: _, ...patch } = op;
      spec.compliance = { ...(spec.compliance ?? {}) };
      assignDefined(spec.compliance, patch);
      return;
    }
    default: {
      const never: never = op;
      throw new Error(`unhandled op ${String(kind)} ${String(never)}`);
    }
  }
}

function typeChangeHint(errors: OpsError[]): OpsError[] {
  return errors.map((e) =>
    /^\/ops\/\d+\/patch\/type$/.test(e.path)
      ? {
          ...e,
          message: "Смена типа поля запрещена",
          hint: "Удалите поле (remove_field) и добавьте заново (add_field)",
        }
      : e,
  );
}

/**
 * Applies a batch atomically: either all ops apply and the result passes validateSpec, or nothing changes.
 * Per-op errors point into the batch (`/ops/<i>/...`); validation errors point into the resulting spec.
 * The input spec is never mutated.
 */
export function applyOps(
  spec: AppSpec,
  ops: readonly unknown[],
  expectedVersion: number,
  opts: ApplyOpsOptions = {},
): ApplyOpsResult {
  const store = opts.store ?? defaultStore;
  if (opts.idempotencyKey !== undefined) {
    const prev = store.get(opts.idempotencyKey);
    if (prev) return prev;
  }
  const currentVersion = opts.currentVersion ?? 0;
  if (expectedVersion !== currentVersion) {
    return {
      ok: false,
      errors: [
        err(
          "VERSION_CONFLICT",
          "",
          `Спека изменилась: ожидалась версия ${expectedVersion}, текущая ${currentVersion}`,
          {
            hint: "Перечитайте спеку и повторите батч",
          },
        ),
      ],
    };
  }
  if (!Array.isArray(ops)) {
    return { ok: false, errors: [err("SCHEMA_INVALID", "/ops", "Ожидается массив операций")] };
  }
  if (ops.length > MAX_BATCH) {
    return {
      ok: false,
      errors: [
        err("BATCH_TOO_LARGE", "/ops", `Слишком много операций: ${ops.length}, максимум ${MAX_BATCH}`),
      ],
    };
  }

  const parsed: Op[] = [];
  const errors: OpsError[] = [];
  ops.forEach((raw, i) => {
    const r = opSchema.safeParse(raw);
    if (!r.success) {
      errors.push(...typeChangeHint(fromZodIssues(r.error.issues, ["ops", i])));
      return;
    }
    if (opts.env === "prod" && DESTRUCTIVE_OPS.has(r.data.op)) {
      errors.push(
        err("DESTRUCTIVE_IN_PROD", ["ops", i, "op"], `Операция ${r.data.op} запрещена в prod`, {
          hint: "Удаление выполняется только в черновике (draft)",
        }),
      );
      return;
    }
    if (r.data.op === "set_compliance" && (opts.author ?? "agent") === "agent") {
      const data = r.data as Record<string, unknown>;
      const forbidden = OWNER_ONLY_COMPLIANCE_FIELDS.filter((k) => data[k] !== undefined);
      if (forbidden.length) {
        for (const k of forbidden)
          errors.push(
            err("OWNER_ONLY_FIELD", ["ops", i, k], "Это поле заполняет только владелец системы", {
              allowed: ["consentTemplateId", "policyPage"],
              hint: "Выберите шаблон согласия (consentTemplateId); данные оператора владелец вводит сам",
            }),
          );
        return;
      }
    }
    parsed.push(r.data);
  });
  if (errors.length) return { ok: false, errors };

  const ctx: Ctx = { spec: structuredClone(spec), errors: [], i: 0 };
  parsed.forEach((op, i) => {
    ctx.i = i;
    applyOne(ctx, structuredClone(op));
  });
  if (ctx.errors.length) return { ok: false, errors: ctx.errors };

  const validated = validateSpec(ctx.spec, opts);
  if (!validated.ok) return validated;

  const version = currentVersion + 1;
  const result: ApplyOpsSuccess = {
    ok: true,
    spec: validated.spec,
    version,
    revision: {
      version,
      parentVersion: currentVersion,
      kind: "ops",
      author: opts.author ?? "agent",
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      ops: parsed,
      createdAt: new Date().toISOString(),
    },
  };
  if (opts.idempotencyKey !== undefined) store.set(opts.idempotencyKey, result);
  return result;
}
