// Prose documentation → contract (V3-20): when a service publishes no OpenAPI, one T0 «research» call
// (models.yaml#routes.research, data-boundary.yaml#call_types.research — documentation summary, no new callType) maps
// the client's need onto operations and fields of the page. Code keeps the model honest: the base URL's host and
// every path must literally appear in the documentation, the rest goes through the contract schema; a draft that
// fails is repaired at most twice and otherwise refused. The page is scrubbed of ПДн before the call.
import type { OrgPolicy, RouteContext } from "@wizard/llm";
import { scrub } from "@wizard/pii";
import { z } from "zod";
import { type CallStats, callTool, type RouteFn, type RunStepFn } from "../core/index.js";
import { defineTool, type ToolIssue } from "../core/tool.js";
import {
  CONTRACT_AUTH_KINDS,
  CONTRACT_FORMAT,
  CONTRACT_METHODS,
  type ContractOperation,
  defaultSecretRef,
  type IntegrationContract,
  OPERATION_ID_RE,
  parseContract,
} from "./contract.js";
import type { MappingEntity } from "./mapping.js";
import { camelIdent, pickCheck } from "./openapi.js";
import type { ApiSchema } from "./schema.js";

/** callType of the mapping (an existing T0 route: documentation summary). */
export const PROSE_CALL_TYPE = "research" as const;
/** Characters of the documentation page sent to the model. */
export const PROSE_MAX_CHARS = 40_000;

const FIELD_TYPES = ["string", "integer", "number", "boolean", "date", "date-time", "email"] as const;
const fieldSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
});

export const contractDraftSchema = z.strictObject({
  baseUrl: z.string().max(300).describe("https base URL of the API exactly as written in the documentation"),
  auth: z.strictObject({
    kind: z.enum(CONTRACT_AUTH_KINDS),
    name: z.string().max(64).nullable().describe("header or query parameter name for header/query keys"),
  }),
  operations: z
    .array(
      z.strictObject({
        id: z.string().regex(OPERATION_ID_RE).describe("camelCase id, e.g. createLead"),
        method: z.enum(CONTRACT_METHODS),
        path: z.string().max(300).describe("path from the documentation, parameters as {name}"),
        summary: z.string().max(200).describe("what the operation does, in Russian"),
        params: z.array(fieldSchema.extend({ in: z.enum(["path", "query"]) })).max(20),
        body: z.array(fieldSchema).max(40).nullable().describe("JSON body fields; null — no body"),
        response: z
          .array(fieldSchema.omit({ required: true }))
          .max(40)
          .describe("top-level fields of the JSON answer"),
      }),
    )
    .min(1)
    .max(12),
  mapping: z
    .array(
      z.strictObject({
        entity: z.string().max(120),
        field: z.string().max(120),
        operation: z.string().regex(OPERATION_ID_RE),
        apiField: z.string().max(64),
        direction: z.enum(["to_api", "from_api"]),
      }),
    )
    .max(60),
});
export type ContractDraft = z.output<typeof contractDraftSchema>;

const typeSchema = (t: (typeof FIELD_TYPES)[number]): ApiSchema =>
  t === "date" || t === "date-time" || t === "email" ? { type: "string", format: t } : { type: t };

/** The documentation's own hosts: the page URL and every https host the text names. */
function docHosts(markdown: string, url: string | null): Set<string> {
  const hosts = new Set<string>();
  if (url) {
    try {
      hosts.add(new URL(url).hostname.toLowerCase());
    } catch {
      // not a URL
    }
  }
  for (const m of markdown.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi))
    hosts.add((m[1] as string).toLowerCase());
  return hosts;
}

/** Semantic issues of a draft: invented hosts or paths, path params without a {name}. */
export function draftIssues(d: ContractDraft, markdown: string, url: string | null): ToolIssue[] {
  const out: ToolIssue[] = [];
  let host = "";
  try {
    const u = new URL(d.baseUrl);
    if (u.protocol !== "https:") out.push({ path: "baseUrl", message: "Base URL must be https" });
    host = u.hostname.toLowerCase();
  } catch {
    out.push({ path: "baseUrl", message: "Base URL is not a URL" });
  }
  if (host && !docHosts(markdown, url).has(host))
    out.push({
      path: "baseUrl",
      message: `Host ${host} does not appear in the documentation: use the documented API host`,
    });
  d.operations.forEach((op, i) => {
    const prefix = op.path.split("{")[0]?.replace(/\/+$/, "") ?? "";
    if (prefix && !markdown.includes(prefix))
      out.push({
        path: `operations.${i}.path`,
        message: `Path ${op.path} does not appear in the documentation`,
      });
    for (const p of op.params)
      if (p.in === "path" && !op.path.includes(`{${p.name}}`))
        out.push({
          path: `operations.${i}.params`,
          message: `Path parameter ${p.name} is missing from ${op.path}`,
        });
  });
  if ((d.auth.kind === "header" || d.auth.kind === "query") && !d.auth.name)
    out.push({ path: "auth.name", message: "Name the header or the query parameter of the key" });
  return out;
}

/** A checked draft → contract (code fills ids of args, the key reference, the check operation). */
export function contractFromDraft(
  d: ContractDraft,
  o: { id: string; name: string; url: string | null; sha256: string | null; title?: string; secret?: string },
): IntegrationContract {
  const u = new URL(d.baseUrl);
  const baseUrl = `https://${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  const operations: ContractOperation[] = d.operations.map((op) => {
    const taken = new Set<string>(["body"]);
    const params = op.params.map((p) => {
      let arg = camelIdent(p.name, 36) ?? "arg";
      for (let n = 2; taken.has(arg); n++) arg = `${camelIdent(p.name, 34) ?? "arg"}${n}`;
      taken.add(arg);
      return {
        name: p.name,
        in: p.in,
        required: p.in === "path" || p.required,
        schema: typeSchema(p.type),
        arg,
      };
    });
    const props = (fields: readonly { name: string; type: (typeof FIELD_TYPES)[number] }[]) =>
      Object.fromEntries(fields.map((f) => [f.name, typeSchema(f.type)]));
    const body = op.body
      ? {
          required: true,
          schema: {
            type: "object" as const,
            properties: props(op.body),
            ...(op.body.some((f) => f.required)
              ? { required: op.body.filter((f) => f.required).map((f) => f.name) }
              : {}),
          },
        }
      : null;
    return {
      id: op.id,
      method: op.method,
      path: op.path,
      summary: op.summary.replace(/\s+/g, " ").trim(),
      params,
      body,
      response: {
        status: op.method === "POST" ? 201 : 200,
        schema: { type: "object", properties: props(op.response) },
      },
    };
  });
  // A POST answer is often 200: the contract tests accept any 2xx, the mock answers with the contract's status.
  const secret = d.auth.kind === "none" ? null : (o.secret ?? defaultSecretRef(o.id));
  const check = pickCheck(operations);
  return parseContract({
    format: CONTRACT_FORMAT,
    id: o.id,
    name: o.name.slice(0, 120),
    source: {
      kind: "prose",
      url: o.url,
      sha256: o.sha256,
      title: (o.title ?? "").slice(0, 200),
      version: "",
    },
    baseUrl,
    hosts: [u.hostname.toLowerCase()],
    auth: {
      kind: d.auth.kind,
      name: d.auth.kind === "header" || d.auth.kind === "query" ? d.auth.name : null,
      secret,
    },
    operations,
    check: check ? { operation: check } : null,
    mapping: d.mapping
      .filter((m) => operations.some((op) => op.id === m.operation))
      .map((m) => {
        const op = operations.find((x) => x.id === m.operation) as ContractOperation;
        const where =
          m.direction === "from_api"
            ? "response"
            : op.params.some((p) => p.in === "query" && p.name === m.apiField)
              ? "query"
              : "body";
        return {
          entity: m.entity,
          field: m.field,
          operation: m.operation,
          pointer: `/${where}/${m.apiField.replace(/\//g, "")}`,
          direction: m.direction,
          by: "model" as const,
        };
      }),
    notes: [
      "Контракт составлен по текстовой документации — операции и поля стоит проверить на тестовом ключе",
    ],
  });
}

export function proseMessages(o: {
  name: string;
  need: string;
  markdown: string;
  data: readonly MappingEntity[];
}): { role: "system" | "user"; content: string }[] {
  const data = o.data
    .slice(0, 20)
    .map((e) => `- ${e.entity}: ${e.fields.map((f) => f.name).join(", ")}`)
    .join("\n");
  return [
    {
      role: "system",
      content:
        "You turn an API documentation page into a contract for an integration of a small business system. Use only " +
        "what the page states: the https base URL, how the API key is passed, and the few operations the client's need " +
        "requires (at most 12), with their path and query parameters, JSON body fields and top-level answer fields. " +
        "Never invent hosts, paths or fields. Map the system's data fields onto the API fields where the meaning matches. " +
        "Summaries in Russian. Answer by calling submit_contract_draft.",
    },
    {
      role: "user",
      content: `Integration: ${o.name}\nClient's need: ${o.need}\nSystem data fields:\n${data || "-"}\n\nDocumentation (markdown):\n${o.markdown}`,
    },
  ];
}

export interface ProseResult {
  contract: IntegrationContract | null;
  /** Why there is no contract (Russian), null when there is one. */
  reason_ru: string | null;
  stats: CallStats | null;
}

/** Prose documentation → contract through one research call (≤ 2 repairs). */
export async function contractFromProse(o: {
  id: string;
  name: string;
  need: string;
  markdown: string;
  url: string | null;
  data?: readonly MappingEntity[];
  route: RouteFn;
  secret?: string;
  orgPolicy?: OrgPolicy | null;
  ctx?: RouteContext;
  runStep?: RunStepFn;
  signal?: AbortSignal;
}): Promise<ProseResult> {
  const text = scrub(o.markdown.slice(0, PROSE_MAX_CHARS)).text;
  const tool = defineTool({
    name: "submit_contract_draft",
    description:
      "API contract draft: base URL, key placement, operations with fields, mapping of the system's fields.",
    input: contractDraftSchema,
    check: (d) => draftIssues(d, text, o.url),
  });
  let r: Awaited<ReturnType<typeof callTool<typeof tool.input>>>;
  try {
    r = await callTool({
      route: o.route,
      callType: PROSE_CALL_TYPE,
      orgPolicy: o.orgPolicy ?? null,
      ctx: o.ctx ?? { orgId: "host" },
      ...(o.runStep ? { runStep: o.runStep } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      stepName: "integration_contract",
      messages: proseMessages({ name: o.name, need: o.need, markdown: text, data: o.data ?? [] }),
      tool,
    });
  } catch (e) {
    if (o.signal?.aborted) throw e;
    return {
      contract: null,
      reason_ru: "Модель не ответила — контракт по документации не составлен",
      stats: null,
    };
  }
  if (!r.ok)
    return {
      contract: null,
      reason_ru: "Документация не дала проверяемого контракта: хосты или адреса не совпали с текстом",
      stats: r.stats,
    };
  try {
    const contract = contractFromDraft(r.value, {
      id: o.id,
      name: o.name,
      url: o.url,
      sha256: null,
      ...(o.secret ? { secret: o.secret } : {}),
    });
    return { contract, reason_ru: null, stats: r.stats };
  } catch {
    return { contract: null, reason_ru: "Черновик контракта не прошёл проверку", stats: r.stats };
  }
}
