// OpenAPI 3.1 of a system's own API (V3-20; runtime.yaml#incoming_api) generated from the spec for one key: the
// entities and public functions of its scopes, cut by its role — operations the role has, fields it sees (hidden
// fields absent), fields it may write (read-only and system fields absent from request bodies). The owner gives
// this document to the developers of 1С and other external systems; nothing here is a value of the system's data.
import type { AppSpec, Entity, Field } from "@wizard/appspec";
import { type ApiDataOp, type ApiScope, scopeAllows, scopeAllowsFn } from "./scopes.js";

type Schema = Record<string, unknown>;

/** JSON Schema of a field value as the data API returns and accepts it (runtime.yaml#data_api.doc_shape). */
export function fieldSchema(f: Field): Schema {
  const s: Schema = { description: f.label };
  switch (f.type) {
    case "string":
    case "text":
    case "phone":
      s.type = "string";
      if (f.maxLength) s.maxLength = f.maxLength;
      break;
    case "email":
      Object.assign(s, { type: "string", format: "email" });
      break;
    case "url":
      Object.assign(s, { type: "string", format: "uri" });
      break;
    case "int":
      s.type = "integer";
      break;
    case "decimal":
    case "money":
      s.type = "number";
      break;
    case "bool":
      s.type = "boolean";
      break;
    case "date":
      Object.assign(s, { type: "string", format: "date" });
      break;
    case "datetime":
      Object.assign(s, { type: "string", format: "date-time" });
      break;
    case "enum":
      Object.assign(s, { type: "string", enum: (f.enum ?? []).map((o) => o.value) });
      break;
    case "ref":
      Object.assign(s, {
        type: "string",
        format: "uuid",
        description: `${f.label} (id записи «${f.ref?.entity ?? ""}»)`,
      });
      break;
    case "file":
    case "image":
      Object.assign(s, { type: "string", format: "uuid", description: `${f.label} (id файла)` });
      break;
    case "qr_token":
      Object.assign(s, { type: "string", readOnly: true });
      break;
    default:
      break;
  }
  if (f.min !== undefined && (f.type === "int" || f.type === "decimal" || f.type === "money"))
    s.minimum = f.min;
  if (f.max !== undefined && (f.type === "int" || f.type === "decimal" || f.type === "money"))
    s.maximum = f.max;
  return f.required ? s : { ...s, type: s.type ? [s.type, "null"] : undefined };
}

const SYSTEM_DOC: Record<string, Schema> = {
  id: { type: "string", format: "uuid", readOnly: true },
  created_at: { type: "string", format: "date-time", readOnly: true },
  updated_at: { type: "string", format: "date-time", readOnly: true },
  created_by: { type: ["string", "null"], format: "uuid", readOnly: true },
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Schema, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const errors = (...codes: string[]) =>
  Object.fromEntries(codes.map((c) => [c, { $ref: "#/components/responses/Error" }]));

/** Component name of an entity's schemas (Ticket, TicketWrite). */
const component = (e: Entity) => e.name.replace(/(^|_)([a-z0-9])/g, (_, __, ch: string) => ch.toUpperCase());

export interface SystemOpenApiOptions {
  /** https://<system host>/api/v1 */
  serverUrl: string;
  role: string;
  scopes: readonly ApiScope[];
  /** Version of the document (the spec hash or the revision). */
  version?: string;
}

/** The OpenAPI 3.1 document of what one key can do. */
export function systemOpenApi(spec: AppSpec, o: SystemOpenApiOptions): Schema {
  const paths: Record<string, Schema> = {};
  const schemas: Record<string, Schema> = {
    Error: {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message", "requestId"],
          properties: {
            code: { type: "string", examples: ["FORBIDDEN", "VALIDATION_FAILED", "RATE_LIMITED"] },
            message: { type: "string", description: "Текст ошибки по-русски" },
            details: { type: "object" },
            requestId: { type: "string" },
          },
        },
      },
    },
  };
  for (const e of spec.entities) {
    const perm = spec.permissions.find((p) => p.role === o.role && p.entity === e.name);
    const ops = (perm?.ops ?? []).filter((op) => scopeAllows(o.scopes, e.name, op as ApiDataOp));
    if (!ops.length) continue;
    const hidden = new Set(perm?.hiddenFields ?? []);
    const readonly = new Set(perm?.readonlyFields ?? []);
    const visible = e.fields.filter((f) => !hidden.has(f.name));
    const writable = visible.filter((f) => !readonly.has(f.name) && f.type !== "qr_token");
    const C = component(e);
    schemas[C] = {
      type: "object",
      description: e.label,
      required: ["id", "created_at", "updated_at"],
      properties: { ...SYSTEM_DOC, ...Object.fromEntries(visible.map((f) => [f.name, fieldSchema(f)])) },
    };
    schemas[`${C}Write`] = {
      type: "object",
      description: `${e.label}: поля для записи`,
      additionalProperties: false,
      properties: {
        ...Object.fromEntries(writable.map((f) => [f.name, fieldSchema(f)])),
        _consent: {
          type: "object",
          description:
            "Согласие на обработку ПДн (policyVersion, textHash) — когда запись содержит ПДн и роль ключа не администратор",
          properties: { policyVersion: { type: "string" }, textHash: { type: "string" } },
        },
      },
    };
    const required = writable.filter((f) => f.required && f.default === undefined).map((f) => f.name);
    const list: Schema = {};
    const one: Schema = {};
    if (ops.includes("read")) {
      list.get = {
        operationId: `list_${e.name}`,
        summary: `${e.label}: список`,
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
          {
            name: "sort",
            in: "query",
            schema: { type: "string" },
            description: "До 3 полей через запятую, минус — по убыванию",
          },
        ],
        responses: {
          "200": json(
            {
              type: "object",
              required: ["items", "page", "limit", "total", "hasMore"],
              properties: {
                items: { type: "array", items: ref(C) },
                page: { type: "integer" },
                limit: { type: "integer" },
                total: { type: "integer" },
                hasMore: { type: "boolean" },
                totalCapped: { type: "boolean" },
              },
            },
            "Записи",
          ),
          ...errors("401", "403", "422", "429"),
        },
      };
      one.get = {
        operationId: `get_${e.name}`,
        summary: `${e.label}: запись`,
        responses: {
          "200": json({ type: "object", properties: { item: ref(C) } }, "Запись"),
          ...errors("401", "403", "404", "429"),
        },
      };
    }
    if (ops.includes("create"))
      list.post = {
        operationId: `create_${e.name}`,
        summary: `${e.label}: создать`,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: required.length ? { allOf: [ref(`${C}Write`), { required }] } : ref(`${C}Write`),
            },
          },
        },
        responses: {
          "201": json({ type: "object", properties: { item: ref(C) } }, "Создано"),
          ...errors("401", "403", "409", "422", "429"),
        },
      };
    if (ops.includes("update"))
      one.patch = {
        operationId: `update_${e.name}`,
        summary: `${e.label}: изменить`,
        requestBody: { required: true, content: { "application/json": { schema: ref(`${C}Write`) } } },
        responses: {
          "200": json({ type: "object", properties: { item: ref(C) } }, "Изменено"),
          ...errors("401", "403", "404", "409", "422", "429"),
        },
      };
    if (ops.includes("delete"))
      one.delete = {
        operationId: `delete_${e.name}`,
        summary: `${e.label}: удалить`,
        responses: { "204": { description: "Удалено" }, ...errors("401", "403", "404", "429") },
      };
    if (Object.keys(list).length) paths[`/data/${e.name}`] = list;
    if (Object.keys(one).length)
      paths[`/data/${e.name}/{id}`] = {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        ...one,
      };
  }
  const admins = spec.roles.filter((r) => r.isAdmin).map((r) => r.name);
  for (const f of spec.functions ?? []) {
    if (f.public !== true || !scopeAllowsFn(o.scopes, f.name) || !(f.roles ?? admins).includes(o.role))
      continue;
    paths[`/fn/${f.name}`] = {
      post: {
        operationId: `fn_${f.name}`,
        summary: `Функция ${f.name} (${f.kind})`,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["args"], properties: { args: { type: "object" } } },
            },
          },
        },
        responses: {
          "200": json(
            {
              type: "object",
              properties: { result: {}, deps: { type: "array", items: { type: "string" } } },
            },
            "Результат",
          ),
          ...errors("401", "403", "422", "429", "503"),
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: `API системы «${spec.app.name}»`,
      version: o.version ?? "1",
      description:
        "Доступ по ключу: заголовок Authorization: Bearer wzk_…. Ключ действует от имени роли системы — её права и ограничения строк соблюдаются. Не больше заданного числа запросов в минуту (429 с Retry-After).",
    },
    servers: [{ url: o.serverUrl }],
    security: [{ apiKey: [] }],
    paths,
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", bearerFormat: "wzk_…" } },
      schemas,
      responses: { Error: json(ref("Error"), "Ошибка") },
    },
  };
}
