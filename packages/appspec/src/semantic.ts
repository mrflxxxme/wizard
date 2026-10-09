// Semantic rules applied after the structural (zod) check. Source: specs/appspec/ops.yaml#semantic_rules.
// Only `import type` from ./schema.js here: schema.ts imports this module at runtime.
import { resolveAiAction } from "./ai-actions.js";
import { err, type OpsError } from "./errors.js";
import { isReservedName, SYSTEM_FIELDS, USERS_ENTITY } from "./reserved.js";
import type { AppSpec, Entity, Field, FieldType, PermissionOp } from "./schema.js";
import { literalProblem } from "./sql.js";

export interface ValidateOptions {
  /**
   * ops.yaml: entity with a pii=basic field MUST have retention or compliance.retentionWaiver — marked (M2),
   * so the rule is opt-in until M2.
   */
  enforcePiiRetention?: boolean;
}

export const USER_REF_RE = /^\$user\.([a-z][a-z0-9_]{0,39})$/;
/** Attributes of the implicit system entity users that `$user.<attr>` may reference (ops.yaml#semantic_rules). */
export const USER_ATTRS = ["id", "role", "phone", "email", "telegram_id", "display_name"] as const;
/**
 * `$user.<attr>` allowed in rowFilter (L3-20): attributes the end user cannot change himself — id, role and the
 * login identifiers verified by OTP/Telegram. display_name (and any future self-editable attribute) would let a
 * user impersonate another one's rows.
 */
export const ROW_FILTER_USER_ATTRS = ["id", "role", "phone", "email", "telegram_id"] as const;
/** Postgres INDEX_MAX_KEYS (error 54011 beyond it). */
export const MAX_INDEX_FIELDS = 32;
const NUMERIC_TYPES: ReadonlySet<FieldType> = new Set(["int", "decimal", "money"]);
const LENGTH_TYPES: ReadonlySet<FieldType> = new Set(["string", "text", "email", "phone", "url"]);
const TEMPORAL_TYPES: ReadonlySet<FieldType> = new Set(["date", "datetime"]);
// Config keys that hold a secret value: the key (case/separator-insensitive) ENDS with one of these words,
// so `botToken`/`secret_key` are secrets while `tokenField`/`secretRefs` are not.
const SECRET_KEY_RE =
  /(secret|token|password|passwd|apikey|privatekey|secretkey|signingkey|accesskey|credentials?)$/;
const isSecretKey = (key: string) => SECRET_KEY_RE.test(key.toLowerCase().replace(/[_-]/g, ""));

/** Type of a system column as seen by rowFilter/indexes/ownerField. */
export const SYSTEM_FIELD_TYPES: Record<(typeof SYSTEM_FIELDS)[number], "uuid" | "timestamptz"> = {
  id: "uuid",
  created_at: "timestamptz",
  updated_at: "timestamptz",
  created_by: "uuid",
};

export function allFieldNames(entity: Entity): string[] {
  return [...SYSTEM_FIELDS, ...entity.fields.map((f) => f.name)];
}

function isSystemField(name: string): name is (typeof SYSTEM_FIELDS)[number] {
  return (SYSTEM_FIELDS as readonly string[]).includes(name);
}

/** Reports every duplicate of `key(item)` (except the first occurrence). */
function duplicates<T>(
  items: readonly T[] | undefined,
  key: (item: T) => string,
  path: (i: number) => PropertyKey[],
  what: string,
  out: OpsError[],
): void {
  const seen = new Set<string>();
  (items ?? []).forEach((item, i) => {
    const k = key(item);
    if (seen.has(k)) out.push(err("DUPLICATE_NAME", path(i), `${what} «${k}» уже объявлено`));
    seen.add(k);
  });
}

function reserved(name: string, path: PropertyKey[], what: string, out: OpsError[]): void {
  if (!isReservedName(name)) return;
  const system = isSystemField(name);
  out.push(
    err("RESERVED_NAME", path, `${what} «${name}» зарезервировано`, {
      hint: system
        ? "Системные поля id, created_at, updated_at, created_by добавляются автоматически — не объявляйте их"
        : `Выберите другое имя, например «${name}_value»`,
    }),
  );
}

function checkDefault(field: Field, path: PropertyKey[], out: OpsError[]): void {
  if (!("default" in field) || field.default === undefined) return;
  const d = field.default;
  const bad = (msg: string, allowed?: string[]): void => {
    out.push(err("SCHEMA_INVALID", [...path, "default"], msg, allowed ? { allowed } : {}));
  };
  switch (field.type) {
    case "json":
      return;
    case "ref":
    case "file":
    case "image":
    case "qr_token":
      bad(`Значение по умолчанию не поддерживается для типа «${field.type}»`);
      return;
    case "int":
      if (typeof d !== "number" || !Number.isInteger(d))
        bad("Значение по умолчанию должно быть целым числом");
      return;
    case "decimal":
    case "money":
      if (typeof d !== "number") bad("Значение по умолчанию должно быть числом");
      return;
    case "bool":
      if (typeof d !== "boolean") bad("Значение по умолчанию должно быть true или false");
      return;
    case "enum": {
      const values = (field.enum ?? []).map((o) => o.value);
      if (typeof d !== "string" || !values.includes(d))
        bad("Значение по умолчанию должно быть одним из значений перечисления", values);
      return;
    }
    default:
      if (typeof d !== "string") bad("Значение по умолчанию должно быть строкой");
  }
}

/** Values that reach SQL (default, min, max) MUST encode with sqlLiteral for the field type (L3-01). */
function checkSqlValues(field: Field, path: PropertyKey[], out: OpsError[], defaultOk: boolean): void {
  const noDefault = ["ref", "file", "image", "qr_token"].includes(field.type);
  if (defaultOk && !noDefault && field.default !== undefined) {
    const p = literalProblem(field.default, field.type);
    if (p) out.push(err("SCHEMA_INVALID", [...path, "default"], `Значение по умолчанию: ${p}`));
  }
  if (!NUMERIC_TYPES.has(field.type)) return;
  for (const k of ["min", "max"] as const) {
    if (field[k] === undefined) continue;
    const p = literalProblem(field[k], field.type);
    if (p) out.push(err("SCHEMA_INVALID", [...path, k], `Свойство ${k}: ${p}`));
  }
}

function checkField(field: Field, fp: PropertyKey[], entityNames: readonly string[], out: OpsError[]): void {
  if (field.pii === "special" || field.pii === "biometric") {
    out.push(
      err("PII_CATEGORY_FORBIDDEN", [...fp, "pii"], `Категория ПДн «${field.pii}» запрещена в MVP`, {
        allowed: ["none", "basic"],
        hint: "Специальные и биометрические ПДн не обрабатываются (гейт G2)",
      }),
    );
  }
  if (field.type === "ref") {
    if (!field.ref) {
      out.push(err("REF_TARGET_MISSING", [...fp, "ref"], "Для поля-ссылки не указана целевая сущность"));
    } else {
      const targets = [...entityNames, USERS_ENTITY];
      if (!targets.includes(field.ref.entity)) {
        out.push(
          err(
            "REF_TARGET_MISSING",
            [...fp, "ref", "entity"],
            `Сущность «${field.ref.entity}» не существует`,
            {
              allowed: targets,
            },
          ),
        );
      }
      if (field.ref.onDelete === "set_null" && field.required) {
        out.push(
          err(
            "SCHEMA_INVALID",
            [...fp, "ref", "onDelete"],
            "onDelete=set_null несовместимо с required=true",
            {
              allowed: ["restrict", "cascade"],
            },
          ),
        );
      }
    }
  } else if (field.ref) {
    out.push(err("SCHEMA_INVALID", [...fp, "ref"], "Свойство ref допустимо только для поля типа «ref»"));
  }
  if (field.type === "enum") {
    if (!field.enum) {
      out.push(err("SCHEMA_INVALID", [...fp, "enum"], "Для поля-перечисления не заданы значения"));
    } else {
      duplicates(
        field.enum,
        (o) => o.value,
        (k) => [...fp, "enum", k, "value"],
        "Значение",
        out,
      );
    }
  } else if (field.enum) {
    out.push(err("SCHEMA_INVALID", [...fp, "enum"], "Свойство enum допустимо только для поля типа «enum»"));
  }
  for (const k of ["min", "max"] as const) {
    if (field[k] !== undefined && !NUMERIC_TYPES.has(field.type)) {
      out.push(
        err("SCHEMA_INVALID", [...fp, k], `Свойство ${k} допустимо только для числовых полей`, {
          allowed: [...NUMERIC_TYPES],
        }),
      );
    }
  }
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
    out.push(err("SCHEMA_INVALID", [...fp, "min"], "min больше max"));
  }
  if (field.maxLength !== undefined && !LENGTH_TYPES.has(field.type)) {
    out.push(
      err("SCHEMA_INVALID", [...fp, "maxLength"], "Свойство maxLength допустимо только для строковых полей", {
        allowed: [...LENGTH_TYPES],
      }),
    );
  }
  const before = out.length;
  checkDefault(field, fp, out);
  checkSqlValues(field, fp, out, out.length === before);
}

function fieldType(entity: Entity, name: string): FieldType | "uuid" | "timestamptz" | undefined {
  if (isSystemField(name)) return SYSTEM_FIELD_TYPES[name];
  return entity.fields.find((f) => f.name === name)?.type;
}

function checkEntity(entity: Entity, i: number, spec: AppSpec, opts: ValidateOptions, out: OpsError[]): void {
  const ep = ["entities", i];
  const entityNames = spec.entities.map((e) => e.name);
  reserved(entity.name, [...ep, "name"], "Имя сущности", out);
  duplicates(
    entity.fields,
    (f) => f.name,
    (j) => [...ep, "fields", j, "name"],
    "Поле",
    out,
  );
  entity.fields.forEach((field, j) => {
    const fp = [...ep, "fields", j];
    reserved(field.name, [...fp, "name"], "Имя поля", out);
    checkField(field, fp, entityNames, out);
  });
  const names = allFieldNames(entity);
  (entity.indexes ?? []).forEach((idx, k) => {
    if (idx.fields.length > MAX_INDEX_FIELDS) {
      out.push(
        err(
          "LIMIT_EXCEEDED",
          [...ep, "indexes", k, "fields"],
          `В индексе «${entity.name}» ${idx.fields.length} полей — база данных допускает не больше ${MAX_INDEX_FIELDS}`,
          { hint: `Оставьте в индексе до ${MAX_INDEX_FIELDS} полей: достаточно тех, по которым идёт отбор` },
        ),
      );
    }
    idx.fields.forEach((f, m) => {
      if (!names.includes(f)) {
        out.push(
          err(
            "UNKNOWN_FIELD",
            [...ep, "indexes", k, "fields", m],
            `Поле «${f}» не найдено в «${entity.name}»`,
            {
              allowed: names,
            },
          ),
        );
      }
    });
  });
  if (entity.ownerField !== undefined) {
    const of = entity.ownerField;
    const f = entity.fields.find((x) => x.name === of);
    if (!f && of !== "created_by") {
      out.push(
        err("UNKNOWN_FIELD", [...ep, "ownerField"], `Поле «${of}» не найдено в «${entity.name}»`, {
          allowed: names,
        }),
      );
    } else if (f && !(f.type === "ref" && f.ref?.entity === USERS_ENTITY)) {
      out.push(
        err("SCHEMA_INVALID", [...ep, "ownerField"], "ownerField должно ссылаться на пользователя", {
          hint: `Используйте поле типа ref на «${USERS_ENTITY}» или системное поле created_by`,
        }),
      );
    }
  }
  const anchor = entity.retention?.anchorField;
  if (anchor !== undefined) {
    const t = fieldType(entity, anchor);
    if (t === undefined) {
      out.push(
        err("UNKNOWN_FIELD", [...ep, "retention", "anchorField"], `Поле «${anchor}» не найдено`, {
          allowed: names,
        }),
      );
    } else if (t !== "timestamptz" && !TEMPORAL_TYPES.has(t as FieldType)) {
      out.push(
        err("SCHEMA_INVALID", [...ep, "retention", "anchorField"], "Якорь хранения должен быть датой", {
          hint: "Укажите поле типа date/datetime или created_at/updated_at",
        }),
      );
    }
  }
  const waived = spec.compliance?.retentionWaiver !== undefined;
  if (
    opts.enforcePiiRetention &&
    !entity.retention &&
    !waived &&
    entity.fields.some((f) => (f.pii ?? (f.type === "file" ? "basic" : "none")) === "basic")
  ) {
    out.push(
      err("SCHEMA_INVALID", [...ep, "retention"], "Сущность с ПДн должна иметь срок хранения", {
        hint: "Добавьте retention.deleteAfterDays или compliance.retentionWaiver с причиной",
      }),
    );
  }
}

function checkRowFilter(
  filter: Record<string, string | number | boolean>,
  entity: Entity,
  pp: PropertyKey[],
  out: OpsError[],
): void {
  const names = allFieldNames(entity);
  for (const [key, value] of Object.entries(filter)) {
    const kp = [...pp, "rowFilter", key];
    const t = fieldType(entity, key);
    if (t === undefined) {
      out.push(
        err("INVALID_ROW_FILTER", kp, `Поле «${key}» не найдено в «${entity.name}»`, { allowed: names }),
      );
      continue;
    }
    if (t === "json") {
      out.push(err("INVALID_ROW_FILTER", kp, "Фильтр по json-полю не поддерживается"));
      continue;
    }
    if (typeof value === "string" && value.startsWith("$")) {
      const attr = USER_REF_RE.exec(value)?.[1];
      if (!attr || !(ROW_FILTER_USER_ATTRS as readonly string[]).includes(attr)) {
        out.push(
          err("INVALID_ROW_FILTER", kp, `Недопустимая ссылка «${value}»`, {
            allowed: ROW_FILTER_USER_ATTRS.map((a) => `$user.${a}`),
            hint: "Используйте $user.id или атрибут, который пользователь не меняет сам (телефон, email, Telegram)",
          }),
        );
      }
      continue;
    }
    const field = entity.fields.find((f) => f.name === key);
    const expect =
      t === "bool" ? "boolean" : NUMERIC_TYPES.has(t as FieldType) ? "number" : ("string" as const);
    if (typeof value !== expect) {
      out.push(err("INVALID_ROW_FILTER", kp, `Значение фильтра должно иметь тип ${expect}`));
    } else if (field?.type === "enum") {
      const values = (field.enum ?? []).map((o) => o.value);
      if (!values.includes(value as string)) {
        out.push(err("INVALID_ROW_FILTER", kp, "Значение не входит в перечисление", { allowed: values }));
      }
    } else if (field?.type === "int" && !Number.isInteger(value)) {
      out.push(err("INVALID_ROW_FILTER", kp, "Значение фильтра должно быть целым числом"));
    } else {
      const p = literalProblem(value, t);
      if (p) out.push(err("INVALID_ROW_FILTER", kp, `Значение фильтра: ${p}`));
    }
  }
}

function checkSecrets(
  value: unknown,
  declared: ReadonlySet<string>,
  path: PropertyKey[],
  out: OpsError[],
): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      checkSecrets(v, declared, [...path, i], out);
    });
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    const p = [...path, k];
    if (typeof v === "string" && v.startsWith("secret://")) {
      if (!declared.has(v)) {
        out.push(
          err("SCHEMA_INVALID", p, `Секрет «${v}» не объявлен в secretRefs`, { allowed: [...declared] }),
        );
      }
    } else if (isSecretKey(k) && (typeof v === "string" || typeof v === "number")) {
      out.push(
        err("SCHEMA_INVALID", p, "Значение секрета нельзя хранить в спеке", {
          hint: "Передайте ссылку вида secret://name и объявите её в secretRefs",
        }),
      );
    } else {
      checkSecrets(v, declared, p, out);
    }
  }
}

export function semanticErrors(spec: AppSpec, opts: ValidateOptions = {}): OpsError[] {
  const out: OpsError[] = [];
  const entityNames = spec.entities.map((e) => e.name);
  const roleNames = spec.roles.map((r) => r.name);
  const entityByName = new Map(spec.entities.map((e) => [e.name, e]));
  const unknownRole = (name: string, path: PropertyKey[]) => {
    if (!roleNames.includes(name))
      out.push(err("UNKNOWN_ROLE", path, `Роль «${name}» не существует`, { allowed: roleNames }));
  };
  const unknownEntity = (name: string, path: PropertyKey[]): Entity | undefined => {
    const e = entityByName.get(name);
    if (!e)
      out.push(err("UNKNOWN_ENTITY", path, `Сущность «${name}» не существует`, { allowed: entityNames }));
    return e;
  };

  // Entities & fields
  duplicates(
    spec.entities,
    (e) => e.name,
    (i) => ["entities", i, "name"],
    "Сущность",
    out,
  );
  spec.entities.forEach((e, i) => {
    checkEntity(e, i, spec, opts, out);
  });

  // Roles
  duplicates(
    spec.roles,
    (r) => r.name,
    (i) => ["roles", i, "name"],
    "Роль",
    out,
  );
  let publicSeen = false;
  spec.roles.forEach((r, i) => {
    reserved(r.name, ["roles", i, "name"], "Имя роли", out);
    if (r.access === "login" && !r.loginMethods?.length) {
      out.push(
        err("SCHEMA_INVALID", ["roles", i, "loginMethods"], "Для роли с входом укажите способы входа", {
          allowed: ["phone_otp", "email_otp", "telegram"],
        }),
      );
    }
    if (r.selfSignup && r.isAdmin) {
      out.push(
        err(
          "SCHEMA_INVALID",
          ["roles", i, "selfSignup"],
          "Самостоятельная регистрация несовместима с ролью администратора",
        ),
      );
    }
    if (r.access === "public" && r.loginMethods !== undefined) {
      out.push(
        err("SCHEMA_INVALID", ["roles", i, "loginMethods"], "Публичная роль не может иметь способов входа"),
      );
    }
    if (r.access === "public") {
      if (publicSeen) {
        out.push(
          err("LIMIT_EXCEEDED", ["roles", i, "access"], "Допускается не более одной публичной роли", {
            allowed: ["login"],
          }),
        );
      }
      publicSeen = true;
    }
  });
  const publicRoles = new Set(spec.roles.filter((r) => r.access === "public").map((r) => r.name));

  // Permissions
  duplicates(
    spec.permissions,
    (p) => `${p.role}/${p.entity}`,
    (i) => ["permissions", i],
    "Право для пары роль/сущность",
    out,
  );
  spec.permissions.forEach((p, i) => {
    const pp = ["permissions", i];
    unknownRole(p.role, [...pp, "role"]);
    const entity = unknownEntity(p.entity, [...pp, "entity"]);
    if (entity) {
      const names = allFieldNames(entity);
      for (const key of ["hiddenFields", "readonlyFields"] as const) {
        (p[key] ?? []).forEach((f, j) => {
          if (!names.includes(f))
            out.push(
              err("UNKNOWN_FIELD", [...pp, key, j], `Поле «${f}» не найдено в «${entity.name}»`, {
                allowed: names,
              }),
            );
        });
      }
      if (p.rowFilter) checkRowFilter(p.rowFilter, entity, pp, out);
      // V3-18: allowedValues — an enum field the role writes, values from its enum.
      for (const [f, values] of Object.entries(p.allowedValues ?? {})) {
        const field = entity.fields.find((x) => x.name === f);
        const path = [...pp, "allowedValues", f];
        if (field?.type !== "enum" || p.readonlyFields?.includes(f)) {
          out.push(
            err(
              "UNKNOWN_FIELD",
              path,
              `allowedValues: поле «${f}» — не изменяемое роли enum-поле «${entity.name}»`,
              {
                allowed: entity.fields
                  .filter((x) => x.type === "enum" && !p.readonlyFields?.includes(x.name))
                  .map((x) => x.name),
              },
            ),
          );
          continue;
        }
        const options = (field.enum ?? []).map((o) => o.value);
        values.forEach((v, j) => {
          if (!options.includes(v))
            out.push(
              err("SCHEMA_INVALID", [...path, j], `Значения «${v}» нет в поле «${f}»`, { allowed: options }),
            );
        });
      }
    }
    const hasFilter = p.rowFilter !== undefined && Object.keys(p.rowFilter).length > 0;
    if (p.rowFilterOps !== undefined) {
      if (!hasFilter)
        out.push(
          err("INVALID_ROW_FILTER", [...pp, "rowFilterOps"], "rowFilterOps задан без rowFilter", {
            hint: "Добавьте rowFilter или уберите rowFilterOps",
          }),
        );
      p.rowFilterOps.forEach((op, j) => {
        if (!p.ops.includes(op))
          out.push(
            err("INVALID_ROW_FILTER", [...pp, "rowFilterOps", j], `Операция «${op}» не разрешена этой роли`, {
              allowed: p.ops,
              hint: "rowFilterOps — подмножество ops",
            }),
          );
      });
    }
    // An op is row-restricted when the permission has a rowFilter and rowFilterOps (default: all ops) lists it.
    const filtered = (op: PermissionOp) => hasFilter && (p.rowFilterOps ?? p.ops).includes(op);
    if (
      publicRoles.has(p.role) &&
      ["update", "delete"].some((op) => p.ops.includes(op as PermissionOp) && !filtered(op as PermissionOp))
    ) {
      out.push(
        err(
          "INVALID_ROW_FILTER",
          [...pp, "ops"],
          "Публичная роль не может изменять или удалять строки без rowFilter",
          {
            allowed: ["read", "create"],
            hint: "Добавьте rowFilter или уберите update/delete",
          },
        ),
      );
    }
  });

  // Workflows
  duplicates(
    spec.workflows,
    (w) => w.name,
    (i) => ["workflows", i, "name"],
    "Процесс",
    out,
  );
  (spec.workflows ?? []).forEach((w, i) => {
    const tp = ["workflows", i, "trigger"];
    const entity =
      w.trigger.entity !== undefined ? unknownEntity(w.trigger.entity, [...tp, "entity"]) : undefined;
    if (!entity) return;
    const names = allFieldNames(entity);
    const fields: [string | undefined, PropertyKey[]][] = [
      [w.trigger.field, [...tp, "field"]],
      [w.trigger.relative?.field, [...tp, "relative", "field"]],
    ];
    for (const [f, path] of fields) {
      if (f !== undefined && !names.includes(f))
        out.push(err("UNKNOWN_FIELD", path, `Поле «${f}» не найдено в «${entity.name}»`, { allowed: names }));
    }
  });

  // Integrations: secrets only as declared secret:// refs
  duplicates(
    spec.integrations,
    (x) => x.name,
    (i) => ["integrations", i, "name"],
    "Интеграция",
    out,
  );
  (spec.integrations ?? []).forEach((x, i) => {
    duplicates(
      x.secretRefs,
      (s) => s,
      (j) => ["integrations", i, "secretRefs", j],
      "Секрет",
      out,
    );
    checkSecrets(x.config, new Set(x.secretRefs ?? []), ["integrations", i, "config"], out);
  });

  // Functions & pages
  duplicates(
    spec.functions,
    (f) => f.name,
    (i) => ["functions", i, "name"],
    "Функция",
    out,
  );
  (spec.functions ?? []).forEach((f, i) => {
    for (const [j, r] of (f.roles ?? []).entries()) unknownRole(r, ["functions", i, "roles", j]);
  });
  duplicates(
    spec.pages,
    (p) => p.route,
    (i) => ["pages", i, "route"],
    "Страница",
    out,
  );
  (spec.pages ?? []).forEach((p, i) => {
    for (const [j, r] of p.roles.entries()) unknownRole(r, ["pages", i, "roles", j]);
  });

  // AI actions & acceptance
  duplicates(
    spec.aiActions,
    (a) => a.name,
    (i) => ["aiActions", i, "name"],
    "ИИ-действие",
    out,
  );
  (spec.aiActions ?? []).forEach((a, i) => {
    if (
      typeof a.input.entity === "string" &&
      !unknownEntity(a.input.entity, ["aiActions", i, "input", "entity"])
    )
      return;
    // M3-02: input/output shape of ai-actions.ts (fields exist, output types the runtime can fill).
    const r = resolveAiAction(spec, a);
    if (r.ok) return;
    for (const p of r.problems)
      out.push(
        err(p.kind === "field" ? "UNKNOWN_FIELD" : "SCHEMA_INVALID", ["aiActions", i, ...p.path], p.message),
      );
  });
  duplicates(
    spec.acceptance,
    (a) => a.id,
    (i) => ["acceptance", i, "id"],
    "Критерий",
    out,
  );
  (spec.acceptance ?? []).forEach((a, i) => {
    if (a.check.role !== undefined) unknownRole(a.check.role, ["acceptance", i, "check", "role"]);
    if (a.check.entity !== undefined) unknownEntity(a.check.entity, ["acceptance", i, "check", "entity"]);
  });

  return out;
}
