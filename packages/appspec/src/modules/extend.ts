// Spec extensions of v3 (V3-10, specs/agents/builder-v3.md §3 C5; product.yaml#decisions.D77_v3 (5)): modules are the
// checked back end, and the agent extends a compiled spec with operations that are data — a field, an entity, a role,
// a function, an automation. Every operation is checked on its own and either applies in full or is rejected with a
// Russian reason: what the modules declared is never changed or removed, a role gets no more than the owner's matrix
// without an explicit rule, functions live in functions/custom/** without egress, automations use the allowed triggers
// and steps. After an operation: the semantic check (applyOps → validateSpec), ПДн of the new fields (markExtraPii,
// the G2-PII-02 criterion of B2-46) and the migration (additive only, DDL and RLS build).
import { z } from "zod";
import { fromZodIssues, type OpsError } from "../errors.js";
import { planMigration, toDDL, toRLS } from "../migrate.js";
import { applyOps, type Op } from "../ops.js";
import { fieldPiiCategory, isPiiSubject, piiKindFor, piiNameReason } from "../pii-names.js";
import { isReservedName, SYSTEM_FIELDS, USERS_ENTITY } from "../reserved.js";
import {
  type AppSpec,
  type Entity,
  entitySchema,
  type Field,
  type FieldType,
  fieldSchema,
  functionSchema,
  identSchema,
  type Permission,
  type PermissionOp,
  permissionSchema,
  type Role,
  roleSchema,
  validateSpec,
  type Workflow,
  workflowSchema,
} from "../schema.js";
import { EXTRA_FIELD_TYPES } from "./manifest.js";

/** Field types an extension may add: those of module extra fields plus links to other entities. */
export const EXTENSION_FIELD_TYPES = [...EXTRA_FIELD_TYPES, "ref"] as const satisfies readonly FieldType[];
/** Automation triggers an extension may use (webhook — incoming integrations, V3-20). */
export const EXTENSION_TRIGGERS = ["on_create", "on_update", "on_status", "schedule", "manual"] as const;
/** Automation steps an extension may use (connector — integrations V3-20; ai_* — AI actions with their own limits). */
export const EXTENSION_STEPS = ["update", "create", "notify", "function", "wait"] as const;
/** Folder of extension functions: functions/custom/**. */
export const CUSTOM_FUNCTIONS_DIR = "functions/custom/";
/** Source size limit of a function (G0 forbidden_api.limits). */
export const EXTENSION_SOURCE_LIMIT = 200 * 1024;
/** Retention of an entity that holds personal data only thanks to extra fields (B2-46, G2-PII-05). */
export const EXTRA_PII_RETENTION = { deleteAfterDays: 3650, mode: "anonymize" } as const;

const grantShape = {
  ops: permissionSchema.shape.ops,
  rowFilter: permissionSchema.shape.rowFilter,
  rowFilterOps: permissionSchema.shape.rowFilterOps,
  hiddenFields: permissionSchema.shape.hiddenFields,
  readonlyFields: permissionSchema.shape.readonlyFields,
  allowedValues: permissionSchema.shape.allowedValues,
};
/** A permission of a new role on an entity (the role is the operation's). */
export const extensionGrantSchema = z.strictObject({ entity: identSchema, ...grantShape });
/** A permission of an existing role on a new entity. */
export const entityGrantSchema = z.strictObject({ role: identSchema, ...grantShape });

export const extensionOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add_field"), entity: identSchema, field: fieldSchema }),
  z.strictObject({
    op: z.literal("add_entity"),
    entity: entitySchema,
    grants: z.array(entityGrantSchema).max(20).optional(),
  }),
  z.strictObject({
    op: z.literal("add_role"),
    role: roleSchema,
    permissions: z.array(extensionGrantSchema).min(1).max(60),
  }),
  z.strictObject({
    op: z.literal("add_function"),
    name: functionSchema.shape.name,
    kind: functionSchema.shape.kind,
    source: z.string().min(1),
    file: z.string().optional(),
    public: z.boolean().optional(),
    roles: z.array(identSchema).optional(),
    collectsPii: z.boolean().optional(),
    // Accepted only to be refused with a reason: no egress, secrets or system access for extension functions yet.
    egress: z.array(z.string()).optional(),
    secretRefs: z.array(z.string()).optional(),
    systemDbReason: z.string().optional(),
  }),
  z.strictObject({ op: z.literal("add_automation"), ...workflowSchema.shape }),
]);

/** An operation extending a compiled spec: add_field | add_entity | add_role | add_function | add_automation. */
export type ExtensionOp = z.infer<typeof extensionOpSchema>;
export type ExtensionOpName = ExtensionOp["op"];
export type ExtensionGrant = z.infer<typeof extensionGrantSchema>;

export interface ExtendOptions {
  /** Files the system already has (ui/**, functions/**): the file of a new function must not be one of them. */
  files?: Readonly<Record<string, string>>;
}

export interface RejectedExtension {
  /** Index of the operation in the input. */
  index: number;
  op: unknown;
  /** Why the operation was not applied — for the agent and the owner. */
  reasonRu: string;
}

export interface ExtensionResult {
  /** The spec with every accepted operation: validateSpec passes, ПДн of new fields are marked. */
  spec: AppSpec;
  /** Sources of accepted add_function operations by path (functions/custom/**). */
  files: Record<string, string>;
  /** Indexes of the accepted operations, in order. */
  applied: number[];
  rejected: RejectedExtension[];
}

const OP_RU: Record<PermissionOp, string> = {
  read: "чтение",
  create: "создание",
  update: "изменение",
  delete: "удаление",
};
const opsRu = (ops: readonly PermissionOp[]) => ops.map((o) => `«${OP_RU[o]}»`).join(", ");

/**
 * B2-46: extra fields (names in `extras`) that look like personal data by the G2-PII-02 criterion (piiNameReason on the
 * final entity) are marked pii basic with piiKind when it is known; marking makes the entity a subject, so weak names
 * are re-checked until nothing changes. An entity that holds personal data only thanks to them and has no retention
 * keeps them ten years and then anonymizes them (G2-PII-05). Mutates and returns `entity`.
 */
export function markExtraPii(entity: Entity, extras: ReadonlySet<string>): Entity {
  const fields = entity.fields.filter((f) => extras.has(f.name));
  for (let changed = true; changed; ) {
    changed = false;
    const subject = isPiiSubject(entity);
    for (const f of fields) {
      if (fieldPiiCategory(f) !== "none") continue;
      const reason = piiNameReason(f, subject);
      if (!reason) continue;
      f.pii = "basic";
      const kind = piiKindFor(f, reason);
      if (kind) f.piiKind = kind;
      changed = true;
    }
  }
  if (!entity.retention && fields.some((f) => fieldPiiCategory(f) === "basic"))
    entity.retention = { ...EXTRA_PII_RETENTION };
  return entity;
}

const isAdmin = (spec: AppSpec, role: string) => spec.roles.some((r) => r.name === role && r.isAdmin);
const roleOf = (spec: AppSpec, name: string): Role | undefined => spec.roles.find((r) => r.name === name);
const entityOf = (spec: AppSpec, name: string): Entity | undefined =>
  spec.entities.find((e) => e.name === name);
const hasPii = (e: Entity) => e.fields.some((f) => fieldPiiCategory(f) !== "none");
const ownRows = (g: Pick<Permission, "rowFilter">) =>
  Object.values(g.rowFilter ?? {}).some((v) => typeof v === "string" && v.startsWith("$user."));
const covers = (big: readonly string[] | undefined, small: readonly string[] | undefined) =>
  (small ?? []).every((x) => (big ?? []).includes(x));

/** Why a field cannot be added (null — it can). `existing` — the entity is already in the spec (a module's). */
function fieldReason(spec: AppSpec, entity: Entity, f: Field, existing: boolean): string | null {
  const where = `«${f.label}» (${entity.label})`;
  if (!(EXTENSION_FIELD_TYPES as readonly string[]).includes(f.type))
    return `Поле ${where}: тип «${f.type}» расширению недоступен — можно ${EXTENSION_FIELD_TYPES.join(", ")}`;
  if ((SYSTEM_FIELDS as readonly string[]).includes(f.name) || isReservedName(f.name))
    return `Поле ${where}: имя «${f.name}» зарезервировано — выберите другое`;
  if (f.pii === "special" || f.pii === "biometric")
    return `Поле ${where}: особые категории ПДн (здоровье, биометрия) система не собирает`;
  const target = f.type === "ref" ? f.ref?.entity : undefined;
  const selfRef = !existing && target === entity.name;
  if (target && target !== USERS_ENTITY && !selfRef && !entityOf(spec, target))
    return `Поле ${where} ссылается на сущность «${target}», которой нет в системе`;
  if (existing && f.required && f.default === undefined)
    return `Поле ${where}: новое обязательное поле без значения по умолчанию сломает формы, функции и автоматизации модуля, которые создают записи «${entity.label}» — сделайте его необязательным или задайте default`;
  return null;
}

/** A grant is at least as narrow as `p`: the same rowFilter conditions, hidden and read-only fields, allowed values included. */
function narrowerThan(g: ExtensionGrant | Permission, p: Permission): boolean {
  const rf = g.rowFilter ?? {};
  return (
    Object.entries(p.rowFilter ?? {}).every(([k, v]) => rf[k] === v) &&
    covers(g.hiddenFields, p.hiddenFields) &&
    covers(g.readonlyFields, p.readonlyFields) &&
    Object.entries(p.allowedValues ?? {}).every(
      ([f, values]) =>
        g.readonlyFields?.includes(f) || (g.allowedValues?.[f]?.every((v) => values.includes(v)) ?? false),
    )
  );
}

/**
 * The owner's matrix bounds a new role (C5): its ops on an entity are among the owner's (isAdmin roles) and at least as
 * narrow as the owner's grant. Wider only by an explicit rule: the role's own rows (rowFilter by $user.*), never
 * delete, and only ops a module already grants some role on the entity, at least as narrowly as that grant.
 */
function boundReason(spec: AppSpec, role: Role, g: ExtensionGrant): string | null {
  const e = entityOf(spec, g.entity);
  if (!e) return `Сущности «${g.entity}» нет в системе`;
  if (!g.ops.length) return `Права роли «${role.label}» на «${e.label}»: не указано ни одного действия`;
  const owner = spec.permissions.filter((p) => p.entity === g.entity && isAdmin(spec, p.role));
  if (!owner.length)
    return `У владельца нет доступа к «${e.label}» — роль не может получить больше владельца`;
  const beyond = g.ops.filter((op) => !owner.some((p) => p.ops.includes(op)));
  if (!beyond.length) {
    if (owner.some((p) => narrowerThan(g, p))) return null;
    return `Права роли «${role.label}» на «${e.label}» шире, чем у владельца: повторите его ограничения (скрытые и только для чтения поля, условия строк)`;
  }
  const wider = `Роль «${role.label}» получает ${opsRu(beyond)} в «${e.label}» — шире, чем у владельца`;
  if (beyond.includes("delete")) return `${wider}; удаление шире владельца не даётся`;
  const filtered = new Set(g.rowFilterOps ?? g.ops);
  if (!ownRows(g) || beyond.some((op) => !filtered.has(op)))
    return `${wider}. Так можно только явным правилом «только свои записи»: условие строк по $user.id, $user.email или $user.phone`;
  const peers = spec.permissions.filter(
    (p) => p.entity === g.entity && !isAdmin(spec, p.role) && beyond.every((op) => p.ops.includes(op)),
  );
  if (!peers.length) return `${wider}: ни одна роль модулей не может этого в «${e.label}»`;
  if (!peers.some((p) => narrowerThan(g, p)))
    return `${wider}: повторите ограничения роли «${roleOf(spec, peers[0]?.role ?? "")?.label ?? peers[0]?.role}» (скрытые и только для чтения поля, условия строк)`;
  return null;
}

/** G0-SPEC-05 for a selfSignup role: each grant read-only or with rowFilter; on entities with ПДн — rowFilter only. */
function selfSignupReason(
  spec: AppSpec,
  role: Role,
  grants: readonly (ExtensionGrant | Permission)[],
): string | null {
  for (const g of grants) {
    const e = entityOf(spec, g.entity);
    const filtered = Object.keys(g.rowFilter ?? {}).length > 0;
    if (!filtered && (g.ops.some((op) => op !== "read") || (e && hasPii(e))))
      return `Роль «${role.label}» с самостоятельной регистрацией видит в «${e?.label ?? g.entity}» чужие записи — нужно условие «только свои записи»`;
  }
  return null;
}

/** A grant of an existing role on a new entity. */
function entityGrantReason(spec: AppSpec, e: Entity, g: z.infer<typeof entityGrantSchema>): string | null {
  const role = roleOf(spec, g.role);
  if (!role) return `Роли «${g.role}» нет в системе`;
  if (role.isAdmin)
    return `Владелец получает полный доступ к «${e.label}» сам — права ему указывать не нужно`;
  if (!g.ops.length) return `Права роли «${role.label}» на «${e.label}»: не указано ни одного действия`;
  if (role.access === "public") {
    const write = g.ops.filter((op) => op === "update" || op === "delete");
    if (write.length) return `Посетитель без входа не может получать ${opsRu(write)} в «${e.label}»`;
    if (g.ops.includes("read") && hasPii(e))
      return `«${e.label}» хранит персональные данные — посетителю без входа их не показывают`;
  }
  if (role.selfSignup) return selfSignupReason(spec, role, [{ ...g, entity: e.name }]);
  return null;
}

const NOTIFY_TO = /^\$owner$|^\$role:([a-z][a-z0-9_]{0,39})$/;
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?/g;

/** Allowed triggers and steps of an automation and the targets of its steps. */
function automationReason(spec: AppSpec, w: Workflow): string | null {
  const t = w.trigger;
  const name = `Автоматизация «${w.label ?? w.name}»`;
  if (!(EXTENSION_TRIGGERS as readonly string[]).includes(t.type))
    return t.type === "webhook"
      ? `${name}: запуск по входящему вебхуку появится с интеграциями — пока выберите событие записи или расписание`
      : `${name}: запуск «${t.type}» расширению недоступен`;
  const e = t.entity ? entityOf(spec, t.entity) : undefined;
  if (t.entity && !e) return `${name}: сущности «${t.entity}» нет в системе`;
  const record = t.type === "on_create" || t.type === "on_update" || t.type === "on_status";
  if (record && !e) return `${name}: для запуска по событию записи укажите сущность`;
  if (
    t.field &&
    e &&
    !e.fields.some((f) => f.name === t.field) &&
    !(SYSTEM_FIELDS as readonly string[]).includes(t.field)
  )
    return `${name}: у «${e.label}» нет поля «${t.field}»`;
  if (t.type === "on_status" && (!t.field || t.equals === undefined))
    return `${name}: для запуска по статусу укажите поле и значение`;
  if (t.type === "schedule" && !t.cron) {
    const at = e?.fields.find((f) => f.name === t.relative?.field);
    if (!at || (at.type !== "date" && at.type !== "datetime"))
      return `${name}: для расписания укажите cron или сущность с полем даты`;
  }
  for (const [i, s] of w.steps.entries()) {
    const step = `${name}, шаг ${i + 1}`;
    if (!(EXTENSION_STEPS as readonly string[]).includes(s.type))
      return s.type === "connector"
        ? `${step}: вызовы внешних сервисов появятся с интеграциями — пока используйте уведомление`
        : `${step}: шаг «${s.type}» расширению недоступен (ИИ-действия подключаются отдельно)`;
    const p = (s.params ?? {}) as Record<string, unknown>;
    const reason = stepReason(spec, e, s.type, p, step);
    if (reason) return reason;
  }
  return null;
}

function stepReason(
  spec: AppSpec,
  e: Entity | undefined,
  type: string,
  p: Record<string, unknown>,
  step: string,
): string | null {
  switch (type) {
    case "notify": {
      const integ = (spec.integrations ?? []).find((x) => x.name === p.integration);
      if (!integ)
        return `${step}: уведомление идёт через подключённый канал — «${String(p.integration)}» не найден`;
      const to = Array.isArray(p.to) ? p.to : [p.to];
      if (!to.length || to.length > 5) return `${step}: укажите от 1 до 5 получателей`;
      for (const x of to) {
        const m = typeof x === "string" ? NOTIFY_TO.exec(x) : null;
        if (!m)
          return `${step}: расширение уведомляет владельца ($owner) и роли команды ($role:<роль>); письма посетителям отправляют модули с согласием на рассылку`;
        const r = m[1] ? roleOf(spec, m[1]) : undefined;
        if (m[1] && r?.access !== "login") return `${step}: роли «${m[1]}» со входом нет в системе`;
      }
      if (integ.connector === "email") {
        const templates = ((integ.config ?? {}) as { templates?: Record<string, unknown> }).templates ?? {};
        if (typeof p.template !== "string" || !Object.hasOwn(templates, p.template))
          return `${step}: письмо отправляется по шаблону подключения «${integ.name}» — шаблона «${String(p.template)}» нет`;
        return null;
      }
      if (integ.connector === "telegram") {
        if (typeof p.text !== "string" || !p.text.trim()) return `${step}: укажите текст сообщения`;
        for (const m of p.text.matchAll(PLACEHOLDER)) {
          const f = e?.fields.find((x) => x.name === m[1]);
          const via = f?.type === "ref" && m[2] ? entityOf(spec, f.ref?.entity ?? "") : undefined;
          const target = via ? via.fields.find((x) => x.name === m[2]) : f;
          if (target && fieldPiiCategory(target) !== "none")
            return `${step}: в Telegram не отправляются персональные данные — уберите {{${m[2] ? `${m[1]}.${m[2]}` : m[1]}}}, дайте ссылку {{link}}`;
        }
        return null;
      }
      return `${step}: уведомления идут только по почте или в Telegram`;
    }
    case "function": {
      const fn = (spec.functions ?? []).find((f) => f.name === p.name);
      if (!fn) return `${step}: функции «${String(p.name)}» нет в системе`;
      if (!fn.file.startsWith(CUSTOM_FUNCTIONS_DIR))
        return `${step}: автоматизация расширения вызывает только свои функции (functions/custom/**); функции модулей запускают их собственные автоматизации`;
      return null;
    }
    case "update":
    case "create": {
      const target = typeof p.entity === "string" ? entityOf(spec, p.entity) : e;
      if (!target) return `${step}: сущности «${String(p.entity ?? "")}» нет в системе`;
      const set = p.set && typeof p.set === "object" && !Array.isArray(p.set) ? Object.keys(p.set) : null;
      if (!set?.length) return `${step}: укажите значения полей (set)`;
      const missing = set.filter((k) => !target.fields.some((f) => f.name === k));
      if (missing.length)
        return `${step}: у «${target.label}» нет полей ${missing.map((k) => `«${k}»`).join(", ")}`;
      return null;
    }
    case "wait":
      return typeof p.minutes === "number" &&
        Number.isInteger(p.minutes) &&
        p.minutes > 0 &&
        p.minutes <= 43_200
        ? null
        : `${step}: пауза — целое число минут от 1 до 43 200`;
    default:
      return null;
  }
}

/** Policy of one operation over the current spec; the AppSpec ops that carry it out, or the reason it cannot apply. */
function plan(
  spec: AppSpec,
  op: ExtensionOp,
  files: ReadonlySet<string>,
): { ops: Op[]; extras: [string, string[]][]; file?: [string, string] } | { reason: string } {
  switch (op.op) {
    case "add_field": {
      const e = entityOf(spec, op.entity);
      if (!e) return { reason: `Сущности «${op.entity}» нет в системе — сначала добавьте её (add_entity)` };
      if (e.fields.some((f) => f.name === op.field.name))
        return {
          reason: `Поле «${op.field.name}» уже есть у «${e.label}» — поля модулей не меняются и не удаляются; выберите другое имя`,
        };
      const why = fieldReason(spec, e, op.field, true);
      if (why) return { reason: why };
      return {
        ops: [{ op: "add_field", entity: op.entity, field: op.field }],
        extras: [[op.entity, [op.field.name]]],
      };
    }
    case "add_entity": {
      const e = op.entity;
      if (entityOf(spec, e.name))
        return {
          reason: `Сущность «${e.name}» уже есть в системе — сущности модулей не меняются; выберите другое имя`,
        };
      if (isReservedName(e.name))
        return { reason: `Имя сущности «${e.name}» зарезервировано — выберите другое` };
      for (const f of e.fields) {
        const why = fieldReason(spec, e, f, false);
        if (why) return { reason: why };
      }
      const admins = spec.roles.filter((r) => r.isAdmin).map((r) => r.name);
      const ops: Op[] = [
        { op: "add_entity", ...e },
        ...admins.map(
          (role): Op => ({
            op: "set_permission",
            role,
            entity: e.name,
            ops: ["read", "create", "update", "delete"],
          }),
        ),
        ...(op.grants ?? []).map((g): Op => ({ op: "set_permission", ...g, entity: e.name })),
      ];
      return { ops, extras: [[e.name, e.fields.map((f) => f.name)]] };
    }
    case "add_role": {
      const r = op.role;
      if (roleOf(spec, r.name))
        return {
          reason: `Роль «${r.name}» уже есть в системе — роли модулей не меняются; выберите другое имя`,
        };
      if (isReservedName(r.name)) return { reason: `Имя роли «${r.name}» зарезервировано — выберите другое` };
      if (r.isAdmin)
        return {
          reason: "Администратор у системы один — владелец; новая роль не может быть администратором",
        };
      if (r.access !== "login")
        return {
          reason: "Посетитель без входа в системе уже есть — новая роль работает со входом (access: login)",
        };
      if (!r.loginMethods?.length) return { reason: `Роли «${r.label}» нужен способ входа (loginMethods)` };
      const seen = new Set<string>();
      for (const g of op.permissions) {
        if (seen.has(g.entity)) return { reason: `Права роли «${r.label}» на «${g.entity}» указаны дважды` };
        seen.add(g.entity);
        const why = boundReason(spec, r, g);
        if (why) return { reason: why };
      }
      if (r.selfSignup) {
        const why = selfSignupReason(spec, r, op.permissions);
        if (why) return { reason: why };
      }
      return {
        ops: [
          { op: "add_role", ...r },
          ...op.permissions.map((g): Op => ({ op: "set_permission", ...g, role: r.name })),
        ],
        extras: [],
      };
    }
    case "add_function": {
      const fn = `Функция «${op.name}»`;
      if ((spec.functions ?? []).some((f) => f.name === op.name))
        return { reason: `${fn} уже есть в системе — функции модулей не меняются; выберите другое имя` };
      const file = op.file ?? `${CUSTOM_FUNCTIONS_DIR}${op.name}.ts`;
      if (!file.startsWith(CUSTOM_FUNCTIONS_DIR) || !functionSchema.shape.file.safeParse(file).success)
        return {
          reason: `${fn}: код расширения лежит только в ${CUSTOM_FUNCTIONS_DIR}**.ts — «${file}» не подходит`,
        };
      if (files.has(file) || (spec.functions ?? []).some((f) => f.file === file))
        return { reason: `${fn}: файл «${file}» уже есть — выберите другое имя` };
      if (op.egress?.length)
        return {
          reason: `${fn}: обращения к внешним адресам (egress) появятся с интеграциями — пока функция работает только с данными системы`,
        };
      if (op.secretRefs?.length)
        return { reason: `${fn}: секреты получают только интеграции — функции расширения они недоступны` };
      if (op.systemDbReason !== undefined || /\bsystemDb\b/.test(op.source))
        return {
          reason: `${fn} работает с правами вызывающей роли (ctx.db): системный доступ ctx.systemDb обходит права и расширению недоступен`,
        };
      if (new TextEncoder().encode(op.source).length > EXTENSION_SOURCE_LIMIT)
        return { reason: `${fn}: исходник больше 200 КБ` };
      const missing = (op.roles ?? []).filter((r) => !roleOf(spec, r));
      if (missing.length)
        return { reason: `${fn}: ролей ${missing.map((r) => `«${r}»`).join(", ")} нет в системе` };
      return {
        ops: [
          {
            op: "add_function",
            name: op.name,
            kind: op.kind,
            file,
            ...(op.public ? { public: true } : {}),
            ...(op.roles?.length ? { roles: op.roles } : {}),
            ...(op.collectsPii ? { collectsPii: true } : {}),
          },
        ],
        extras: [],
        file: [file, op.source],
      };
    }
    case "add_automation": {
      const { op: _, ...w } = op;
      if ((spec.workflows ?? []).some((x) => x.name === w.name))
        return {
          reason: `Автоматизация «${w.name}» уже есть в системе — автоматизации модулей не меняются; выберите другое имя`,
        };
      const why = automationReason(spec, w);
      if (why) return { reason: why };
      return { ops: [{ op: "add_workflow", workflow: w }], extras: [] };
    }
  }
}

const errorsRu = (errors: readonly OpsError[]) =>
  [...new Set(errors.map((e) => `${e.message_ru}${e.hint ? ` (${e.hint})` : ""}`))].slice(0, 3).join("; ");

/**
 * Gates over a candidate: ПДн of the touched entities (every field that looks like ПДн is marked — G2-PII-02; new ПДн
 * are not open to the public role or to a self sign-up role without «only own rows» — G2-PERM-05, G0-SPEC-05) and an
 * additive migration whose DDL and RLS build (G0-MIG-01).
 */
function gateReason(
  base: AppSpec,
  next: AppSpec,
  touched: readonly (readonly [string, readonly string[]])[],
): string | null {
  for (const [name, added] of touched) {
    const e = entityOf(next, name);
    if (!e) continue;
    const subject = isPiiSubject(e);
    const bare = e.fields.find((f) => fieldPiiCategory(f) === "none" && piiNameReason(f, subject));
    if (bare)
      return `После правки «${e.label}» хранит персональные данные, и поле «${bare.label}» тоже становится ПДн — поля модулей не меняются; уберите или переименуйте новое поле`;
    const pii = e.fields.filter((f) => added.includes(f.name) && fieldPiiCategory(f) !== "none");
    for (const p of next.permissions.filter((x) => x.entity === name)) {
      const r = roleOf(next, p.role);
      const open =
        (r?.access === "public" && p.ops.includes("read")) ||
        (r?.selfSignup === true && !Object.keys(p.rowFilter ?? {}).length);
      const shown = open ? pii.find((f) => !(p.hiddenFields ?? []).includes(f.name)) : undefined;
      if (shown)
        return `Поле «${shown.label}» — персональные данные, а записи «${e.label}» ${r?.access === "public" ? "видны посетителям без входа" : `открыты роли «${r?.label}» целиком`}: такое поле сюда добавлять нельзя`;
    }
  }
  const plan = planMigration(base, next, { env: "prod" });
  if (plan.errors.length) return `Миграция не проходит: ${errorsRu(plan.errors)}`;
  try {
    toDDL(plan, "app_extension_check");
    toRLS(next, "app_extension_check");
  } catch (e) {
    return `Миграция или права доступа не строятся: ${(e as Error).message}`;
  }
  return null;
}

/**
 * Applies extension operations to a compiled spec one by one (V3-10, C5): each one is checked by its rules, carried out
 * by applyOps (validateSpec), its new fields get ПДн marking (markExtraPii) and the result passes the ПДн and migration
 * gates against the input spec; otherwise it is rejected with a Russian reason and the spec stays as before it.
 */
export function applyExtensions(
  spec: AppSpec,
  ops: readonly unknown[],
  opts: ExtendOptions = {},
): ExtensionResult {
  const base = structuredClone(spec);
  let current = structuredClone(spec);
  const files: Record<string, string> = {};
  const known = new Set(Object.keys(opts.files ?? {}));
  let extras = new Map<string, Set<string>>();
  const applied: number[] = [];
  const rejected: RejectedExtension[] = [];
  for (const [index, raw] of ops.entries()) {
    const r = extendOne(base, current, raw, extras, known);
    if ("reason" in r) {
      rejected.push({ index, op: raw, reasonRu: r.reason });
      continue;
    }
    current = r.spec;
    extras = r.extras;
    if (r.file) {
      files[r.file[0]] = r.file[1];
      known.add(r.file[0]);
    }
    applied.push(index);
  }
  return { spec: current, files, applied, rejected };
}

/** One operation over `current`: the new spec and extension fields, or why it is rejected. */
function extendOne(
  base: AppSpec,
  current: AppSpec,
  raw: unknown,
  extras: ReadonlyMap<string, ReadonlySet<string>>,
  known: ReadonlySet<string>,
): { spec: AppSpec; extras: Map<string, Set<string>>; file?: [string, string] } | { reason: string } {
  const parsed = extensionOpSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = fromZodIssues(parsed.error.issues)
      .slice(0, 3)
      .map((e) => `${e.path || "/"}: ${e.message_ru}${e.allowed ? ` (можно: ${e.allowed.join(", ")})` : ""}`);
    return {
      reason: `Операция не по схеме расширения — ${issues.join("; ")}. Расширение только добавляет; менять и удалять части модулей нельзя`,
    };
  }
  const op = parsed.data;
  const step = plan(current, op, known);
  if ("reason" in step) return step;
  const r = applyOps(current, step.ops, 0);
  if (!r.ok) return { reason: errorsRu(r.errors) };
  const next = r.spec;
  const nextExtras = new Map([...extras].map(([k, v]) => [k, new Set(v)]));
  for (const [entity, names] of step.extras) {
    const set = new Set([...(nextExtras.get(entity) ?? []), ...names]);
    nextExtras.set(entity, set);
    const e = entityOf(next, entity);
    if (e) markExtraPii(e, set);
  }
  if (op.op === "add_entity") {
    const e = entityOf(next, op.entity.name);
    for (const g of op.grants ?? []) {
      const why = e && entityGrantReason(next, e, g);
      if (why) return { reason: why };
    }
  }
  const checked = validateSpec(next);
  if (!checked.ok) return { reason: errorsRu(checked.errors) };
  const why = gateReason(base, checked.spec, step.extras);
  if (why) return { reason: why };
  return { spec: checked.spec, extras: nextExtras, ...(step.file ? { file: step.file } : {}) };
}
