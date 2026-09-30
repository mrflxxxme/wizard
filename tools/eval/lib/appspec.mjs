// AppSpec draft: схема (подмножество JSON Schema), валидатор без зависимостей и проверки согласованности.

export const FIELD_TYPES = [
  "string", "text", "number", "integer", "money", "boolean", "date", "datetime", "time",
  "enum", "email", "phone", "url", "file", "image", "reference", "json",
];
export const ACTIONS = ["create", "read", "update", "delete", "list", "approve", "export"];
export const INTEGRATIONS = ["yookassa", "telegram", "email", "sms", "qr", "calendar", "import", "webhook", "other"];

const str = (minLength = 1) => ({ type: "string", minLength });
const arr = (items, minItems = 0) => ({ type: "array", items, minItems });
const obj = (required, properties) => ({ type: "object", required, properties });

export const APP_SPEC_SCHEMA = obj(
  ["title", "summary", "roles", "entities", "permissions", "pages", "workflows", "integrations", "acceptance"],
  {
    title: str(3),
    summary: str(10),
    roles: arr(obj(["id", "name"], { id: str(), name: str(), description: { type: "string" } }), 1),
    entities: arr(
      obj(["name", "fields"], {
        name: str(),
        label: { type: "string" },
        fields: arr(
          obj(["name", "type"], {
            name: str(),
            label: { type: "string" },
            type: { type: "string", enum: FIELD_TYPES },
            required: { type: "boolean" },
            ref: { type: "string", description: "имя сущности для type=reference" },
            options: arr({ type: "string" }),
            pdn: { type: "string", enum: ["none", "common", "special", "biometric"] },
          }),
          1,
        ),
      }),
      1,
    ),
    permissions: arr(
      obj(["role", "entity", "actions"], {
        role: str(),
        entity: str(),
        actions: arr({ type: "string", enum: ACTIONS }, 1),
        scope: { type: "string", enum: ["all", "own", "assigned"] },
      }),
      1,
    ),
    pages: arr(obj(["id", "title", "roles"], { id: str(), title: str(), roles: arr({ type: "string" }, 1), purpose: { type: "string" } }), 1),
    workflows: arr(obj(["name", "trigger", "steps"], { name: str(), trigger: str(), steps: arr(str(), 1) })),
    integrations: arr(obj(["kind", "purpose"], { kind: { type: "string", enum: INTEGRATIONS }, purpose: str() })),
    acceptance: arr(str(5), 3),
  },
);

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** Мини-валидатор: type, required, properties, items, enum, minItems, minLength. */
export function validateSchema(value, schema, path = "$", errors = []) {
  const t = typeOf(value);
  if (schema.type) {
    const ok = schema.type === "integer" ? Number.isInteger(value) : schema.type === t;
    if (!ok) {
      errors.push(`${path}: ожидался ${schema.type}, получен ${t}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: значение ${JSON.stringify(value)} не из списка [${schema.enum.join(", ")}]`);
  }
  if (t === "string" && schema.minLength && value.trim().length < schema.minLength) {
    errors.push(`${path}: строка короче ${schema.minLength}`);
  }
  if (t === "array") {
    if (schema.minItems && value.length < schema.minItems) errors.push(`${path}: нужно минимум ${schema.minItems} элемент(а)`);
    if (schema.items) value.forEach((v, i) => validateSchema(v, schema.items, `${path}[${i}]`, errors));
  }
  if (t === "object") {
    for (const k of schema.required ?? []) if (!(k in value)) errors.push(`${path}: нет обязательного поля "${k}"`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) {
      if (value[k] !== undefined) validateSchema(value[k], s, `${path}.${k}`, errors);
    }
  }
  return errors;
}

/** Семантика: ссылки ролей, сущностей и reference-полей должны сходиться. */
export function checkConsistency(spec) {
  const errors = [];
  const roleIds = new Set();
  for (const r of spec.roles) {
    if (roleIds.has(r.id)) errors.push(`roles: дубликат id "${r.id}"`);
    roleIds.add(r.id);
  }
  const entityNames = new Set();
  for (const e of spec.entities) {
    if (entityNames.has(e.name)) errors.push(`entities: дубликат "${e.name}"`);
    entityNames.add(e.name);
  }
  for (const e of spec.entities) {
    for (const f of e.fields) {
      if (f.type === "reference" && !entityNames.has(f.ref)) {
        errors.push(`entities.${e.name}.${f.name}: reference на неизвестную сущность "${f.ref}"`);
      }
      if (f.type === "enum" && !(Array.isArray(f.options) && f.options.length)) {
        errors.push(`entities.${e.name}.${f.name}: enum без options`);
      }
    }
  }
  spec.permissions.forEach((p, i) => {
    if (!roleIds.has(p.role)) errors.push(`permissions[${i}]: неизвестная роль "${p.role}"`);
    if (!entityNames.has(p.entity)) errors.push(`permissions[${i}]: неизвестная сущность "${p.entity}"`);
  });
  spec.pages.forEach((p, i) => {
    for (const r of p.roles) if (!roleIds.has(r)) errors.push(`pages[${i}] "${p.id}": неизвестная роль "${r}"`);
  });
  return errors;
}

/** Достаёт JSON из текста модели: снимает ```-ограды, берёт от первой { до последней }. */
export function extractJson(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("пустой ответ");
  let s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b <= a) throw new Error("в ответе нет JSON-объекта");
  s = s.slice(a, b + 1);
  return JSON.parse(s);
}

/** Полная проверка: парсинг → схема → согласованность. */
export function validateAppSpec(raw) {
  let spec;
  try {
    spec = typeof raw === "string" ? extractJson(raw) : raw;
  } catch (e) {
    return { ok: false, spec: null, errors: [`невалидный JSON: ${e.message}`] };
  }
  const errors = validateSchema(spec, APP_SPEC_SCHEMA);
  if (errors.length) return { ok: false, spec, errors };
  const sem = checkConsistency(spec);
  return { ok: sem.length === 0, spec, errors: sem };
}
