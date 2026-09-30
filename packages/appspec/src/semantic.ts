// Semantic rules applied after the structural (zod) check. Source: specs/appspec/ops.yaml#semantic_rules.
// Only `import type` from ./schema.js here: schema.ts imports this module at runtime.
import { err, type OpsError } from "./errors.js";
import { isReservedName, SYSTEM_FIELDS, USERS_ENTITY } from "./reserved.js";
import type { AppSpec, Entity, Field, FieldType } from "./schema.js";

export interface ValidateOptions {
  /**
   * ops.yaml: entity with a pii=basic field MUST have retention or compliance.retentionWaiver — marked (M2).
   * `compliance.retentionWaiver` is not in the M0 schema yet, so the rule is opt-in until M2.
   */
  enforcePiiRetention?: boolean;
}

export const USER_REF_RE = /^\$user\.([a-z][a-z0-9_]{0,39})$/;
const NUMERIC_TYPES: ReadonlySet<FieldType> = new Set(["int", "decimal", "money"]);
const LENGTH_TYPES: ReadonlySet<FieldType> = new Set(["string", "text", "email", "phone", "url"]);
const TEMPORAL_TYPES: ReadonlySet<FieldType> = new Set(["date", "datetime"]);
const SECRET_KEY_RE = /(secret|token|password|passwd|api_?key|private_?key|credential)/i;

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
    case "qr_token":
      return bad(`Значение по умолчанию не поддерживается для типа «${field.type}»`);
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
  checkDefault(field, fp, out);
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
  if (opts.enforcePiiRetention && !entity.retention && entity.fields.some((f) => f.pii === "basic")) {
    out.push(
      err("SCHEMA_INVALID", [...ep, "retention"], "Сущность с ПДн должна иметь срок хранения", {
        hint: "Добавьте retention.deleteAfterDays",
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
      if (!USER_REF_RE.test(value)) {
        out.push(
          err("INVALID_ROW_FILTER", kp, `Недопустимая ссылка «${value}»`, {
            hint: "Используйте $user.id или $user.<атрибут>",
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
    value.forEach((v, i) => checkSecrets(v, declared, [...path, i], out));
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
    } else if (SECRET_KEY_RE.test(k) && (typeof v === "string" || typeof v === "number")) {
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
  spec.entities.forEach((e, i) => checkEntity(e, i, spec, opts, out));

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
    }
    const hasFilter = p.rowFilter !== undefined && Object.keys(p.rowFilter).length > 0;
    if (publicRoles.has(p.role) && !hasFilter && (p.ops.includes("update") || p.ops.includes("delete"))) {
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
    (f.roles ?? []).forEach((r, j) => unknownRole(r, ["functions", i, "roles", j]));
  });
  duplicates(
    spec.pages,
    (p) => p.route,
    (i) => ["pages", i, "route"],
    "Страница",
    out,
  );
  (spec.pages ?? []).forEach((p, i) => {
    p.roles.forEach((r, j) => unknownRole(r, ["pages", i, "roles", j]));
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
    if (typeof a.input.entity === "string")
      unknownEntity(a.input.entity, ["aiActions", i, "input", "entity"]);
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
