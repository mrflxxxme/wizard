// V3-20 test material built by code: an OpenAPI 3.1 document of a fictional CRM (api.partner-crm.ru, key in the
// X-Api-Key header) with lead operations among many others, $ref, allOf and nullable types; a Swagger 2.0 variant; a
// prose documentation page; a tiny documentation site for discover_docs.

type Json = Record<string, unknown>;

export const CRM_HOST = "api.partner-crm.ru";

const leadBase = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", maxLength: 120, description: "Имя клиента" },
    phone: { type: ["string", "null"], example: "+79990001122" },
    email: { type: "string", format: "email" },
    comment: { type: "string" },
    amount: { type: "number", minimum: 0 },
    status: { type: "string", enum: ["new", "in_work", "won", "lost"] },
    tags: { type: "array", items: { type: "string" }, maxItems: 10 },
    custom: { type: "object", additionalProperties: true },
  },
};

const resource = (name: string) => ({
  [`/${name}`]: {
    get: {
      operationId: `list${name.charAt(0).toUpperCase()}${name.slice(1)}`,
      summary: `List ${name}`,
      responses: {
        "200": {
          description: "ok",
          content: {
            "application/json": {
              schema: { type: "array", items: { type: "object", properties: { id: { type: "integer" } } } },
            },
          },
        },
      },
    },
  },
});

/** OpenAPI 3.1 of the CRM: 6 lead operations, an account endpoint and 14 unrelated resources. */
export function crmOpenApi(): Json {
  const others = [
    "webhooks",
    "users",
    "tasks",
    "pipelines",
    "notes",
    "calls",
    "files",
    "segments",
    "reports",
    "widgets",
    "templates",
    "tags",
    "roles",
    "events",
  ];
  return {
    openapi: "3.1.0",
    info: { title: "Partner CRM API", version: "2.4" },
    servers: [{ url: "https://api.partner-crm.ru/{version}", variables: { version: { default: "v2" } } }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-Api-Key" } },
      schemas: {
        LeadBase: leadBase,
        Lead: {
          allOf: [
            { $ref: "#/components/schemas/LeadBase" },
            {
              type: "object",
              required: ["id"],
              properties: { id: { type: "integer" }, created_at: { type: "string", format: "date-time" } },
            },
          ],
        },
        Account: {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "integer" },
            name: { type: "string" },
            plan: { type: "string", enum: ["free", "pro"] },
          },
        },
      },
      parameters: { LeadId: { name: "leadId", in: "path", required: true, schema: { type: "integer" } } },
    },
    paths: {
      "/account": {
        get: {
          operationId: "getAccount",
          summary: "Current account",
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Account" } } },
            },
          },
        },
      },
      "/leads": {
        get: {
          operationId: "listLeads",
          summary: "List leads (заявки)",
          parameters: [
            {
              name: "status",
              in: "query",
              schema: { type: "string", enum: ["new", "in_work", "won", "lost"] },
            },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          ],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["items", "total"],
                    properties: {
                      items: { type: "array", items: { $ref: "#/components/schemas/Lead" } },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: "createLead",
          summary: "Create a lead",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/LeadBase" } } },
          },
          responses: {
            "201": {
              description: "created",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Lead" } } },
            },
          },
        },
      },
      "/leads/{leadId}": {
        parameters: [{ $ref: "#/components/parameters/LeadId" }],
        get: {
          operationId: "getLead",
          summary: "A lead",
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Lead" } } },
            },
          },
        },
        patch: {
          operationId: "updateLead",
          summary: "Update a lead",
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/LeadBase" } } },
          },
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Lead" } } },
            },
          },
        },
        delete: {
          operationId: "deleteLead",
          summary: "Delete a lead",
          responses: { "204": { description: "deleted" } },
        },
      },
      "/leads/{leadId}/attachments": {
        post: {
          operationId: "uploadAttachment",
          parameters: [{ $ref: "#/components/parameters/LeadId" }],
          requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object" } } } },
          responses: { "201": { description: "ok" } },
        },
      },
      ...Object.assign({}, ...others.map(resource)),
    },
  };
}

/** The same API as Swagger 2.0 (bearer token through an apiKey Authorization header is mapped to the header kind). */
export function crmSwagger(): Json {
  return {
    swagger: "2.0",
    info: { title: "Partner CRM API", version: "1.0" },
    host: CRM_HOST,
    basePath: "/v1",
    schemes: ["https"],
    securityDefinitions: { token: { type: "apiKey", in: "query", name: "token" } },
    definitions: {
      Lead: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "integer" }, name: { type: "string" } },
      },
    },
    paths: {
      "/leads": {
        post: {
          operationId: "createLead",
          parameters: [
            {
              name: "body",
              in: "body",
              required: true,
              schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
            },
          ],
          responses: { "200": { description: "ok", schema: { $ref: "#/definitions/Lead" } } },
        },
        get: {
          operationId: "listLeads",
          responses: {
            "200": { description: "ok", schema: { type: "array", items: { $ref: "#/definitions/Lead" } } },
          },
        },
      },
    },
  };
}

/** Prose documentation of a delivery service (no OpenAPI). */
export const DELIVERY_DOC = `# API службы доставки «Быстрая посылка»

Базовый адрес: https://api.bystraya-posylka.ru/v1

Ключ передаётся в заголовке \`X-Token\`.

## Создать заказ на доставку

POST /orders — тело JSON: \`recipient_name\` (строка, обязательно), \`recipient_phone\` (строка), \`address\` (строка, обязательно).
Ответ: \`id\` (число), \`status\` (строка).

## Статус заказа

GET /orders/{id} — ответ: \`id\`, \`status\`.

## Тарифы

GET /tariffs — список тарифов.
`;

/** A documentation site of the CRM for discover_docs: /openapi.json, nothing else. */
export function crmSiteFetch(doc: Json = crmOpenApi()): (url: string) => Promise<Response> {
  return async (url: string) => {
    const u = new URL(url);
    if (u.hostname === "partner-crm.ru" && u.pathname === "/openapi.json")
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (u.hostname === "partner-crm.ru" && u.pathname === "/docs")
      return new Response(
        "<html><head><title>Docs</title></head><body><main><h1>Документация</h1><p>См. openapi.json</p></main></body></html>",
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    if (u.hostname === "bystraya-posylka.ru" && u.pathname === "/docs")
      return new Response(
        `<html><head><title>API</title></head><body><main><pre>${DELIVERY_DOC}</pre></main></body></html>`,
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };
}
