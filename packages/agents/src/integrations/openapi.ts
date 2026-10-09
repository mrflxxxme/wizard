// OpenAPI 3.x / Swagger 2.0 document → integration contract, by code (V3-20; algorithms ahead of models, D77 (11)):
// the first https server, the security scheme → where the secret://name goes, the operations the client's need
// matches (Russian words of the brief → English API words by a small dictionary; all of them when the document is
// small), their parameters, JSON bodies and the first 2xx JSON answer reduced to the schema subset ($ref resolved,
// allOf merged, oneOf/anyOf with null → nullable), and a safe GET for the key check. No network and no model.
import { createHash } from "node:crypto";
import {
  ARG_RE,
  CONTRACT_FORMAT,
  CONTRACT_LIMITS,
  type ContractMethod,
  type ContractOperation,
  type ContractParam,
  defaultSecretRef,
  type IntegrationContract,
  OPERATION_ID_RE,
  parseContract,
} from "./contract.js";
import { type ApiSchema, type ApiSchemaType, isPropName, SCHEMA_LIMITS } from "./schema.js";

type Json = Record<string, unknown>;

/** Operations taken by default when the need does not narrow the document. */
export const DEFAULT_OPERATIONS = 12;

export interface FromOpenApiOptions {
  /** Brief integration id and name. */
  id: string;
  name: string;
  /** The client's need in words (brief integration name, scenarios): selects the operations. */
  need?: string;
  /** Explicit operation ids (operationId or «METHOD /path»); win over `need`. */
  operations?: readonly string[];
  /** Where the document came from (relative servers resolve against it). */
  url?: string | null;
  /** Key reference; default secret://<id>_key. */
  secret?: string;
  /** Cap of operations (≤ CONTRACT_LIMITS.operations). */
  max?: number;
}

export class OpenApiImportError extends Error {
  constructor(
    readonly code: "NOT_OPENAPI" | "NO_HTTPS_SERVER" | "NO_OPERATIONS",
    readonly message_ru: string,
  ) {
    super(`${code}: ${message_ru}`);
  }
}

const METHODS: readonly ContractMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Russian stems of the brief → English words of API paths and summaries. */
const SYNONYMS: Record<string, string[]> = {
  заявк: ["lead", "request", "application", "ticket"],
  лид: ["lead"],
  сделк: ["deal", "lead", "opportunit"],
  клиент: ["client", "customer", "contact"],
  покупател: ["customer", "buyer"],
  контакт: ["contact"],
  компан: ["compan", "organization", "account"],
  заказ: ["order"],
  товар: ["product", "item", "good", "offer"],
  каталог: ["catalog", "product", "categor"],
  оплат: ["payment", "pay"],
  плат: ["payment"],
  счет: ["invoice", "bill", "account"],
  счёт: ["invoice", "bill", "account"],
  доставк: ["deliver", "shipment", "shipping"],
  отправк: ["shipment", "send", "parcel"],
  посылк: ["parcel", "package"],
  склад: ["warehouse", "stock", "store"],
  остат: ["stock", "inventor", "balance"],
  запис: ["appointment", "booking", "record", "visit"],
  бронир: ["booking", "reservation"],
  расписан: ["schedule", "slot", "calendar"],
  сообщен: ["message", "send"],
  уведомл: ["notif", "message"],
  задач: ["task", "todo"],
  сотрудник: ["employee", "user", "staff"],
  пользоват: ["user", "account"],
  документ: ["document", "file"],
  цен: ["price"],
  статус: ["status"],
  отчет: ["report"],
  отчёт: ["report"],
  чек: ["receipt", "check"],
};

/** Need text → lowercase search words (Russian stems expanded to English API words). */
export function needWords(need: string): string[] {
  const words = new Set<string>();
  for (const raw of need.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3) continue;
    words.add(raw.length > 6 ? raw.slice(0, 6) : raw);
    for (const [stem, en] of Object.entries(SYNONYMS))
      if (raw.startsWith(stem)) for (const w of en) words.add(w);
  }
  return [...words];
}

/** camelCase identifier of free text («GET /deals/{id}» → getDealsId); null when nothing is left. */
export function camelIdent(text: string, max = 40): string | null {
  const parts = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  if (!parts.length) return null;
  let id = parts.map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1))).join("");
  if (!/^[a-z]/.test(id)) id = `op${id.charAt(0).toUpperCase()}${id.slice(1)}`;
  return id.slice(0, max);
}

/** Resolves a local $ref (#/components/schemas/X, #/definitions/X, #/components/parameters/Y). */
function deref(
  doc: Json,
  node: unknown,
  seen: Set<string> = new Set(),
): { node: unknown; ref: string | null } {
  let cur = node;
  let ref: string | null = null;
  for (let i = 0; i < 10 && isObj(cur) && typeof cur.$ref === "string"; i++) {
    ref = cur.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) return { node: {}, ref };
    seen.add(ref);
    let target: unknown = doc;
    for (const part of ref.slice(2).split("/"))
      target = isObj(target) ? target[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
    cur = target ?? {};
  }
  return { node: cur, ref };
}

/** OpenAPI/JSON Schema node → the subset (depth-capped; cycles become free-form). */
export function toSubset(
  doc: Json,
  raw: unknown,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): ApiSchema {
  const path = new Set(seen);
  const { node, ref } = deref(doc, raw, path);
  if (ref && seen.has(ref)) return {};
  if (!isObj(node) || depth >= SCHEMA_LIMITS.depth) return {};
  const s = node;
  // allOf: merge the parts' properties and required lists.
  if (Array.isArray(s.allOf)) {
    const merged: ApiSchema = { type: "object", properties: {}, required: [] };
    for (const part of s.allOf) {
      const sub = toSubset(doc, part, depth, path);
      Object.assign(merged.properties as object, sub.properties ?? {});
      merged.required = [...new Set([...(merged.required ?? []), ...(sub.required ?? [])])];
    }
    const own = toSubset(doc, { ...s, allOf: undefined }, depth, path);
    Object.assign(merged.properties as object, own.properties ?? {});
    merged.required = [...new Set([...(merged.required ?? []), ...(own.required ?? [])])];
    if (!merged.required?.length) delete merged.required;
    return merged;
  }
  // oneOf / anyOf: the first non-null option; a null option makes it nullable.
  for (const key of ["oneOf", "anyOf"] as const) {
    const opts = s[key];
    if (!Array.isArray(opts) || !opts.length) continue;
    const isNull = (o: unknown) =>
      isObj(o) &&
      (o.type === "null" || (Array.isArray(o.type) && o.type.length === 1 && o.type[0] === "null"));
    const first = opts.find((o) => !isNull(o));
    const sub = first ? toSubset(doc, first, depth, path) : {};
    if (opts.some(isNull) || s.nullable === true) sub.nullable = true;
    return sub;
  }
  const out: ApiSchema = {};
  let type: unknown = s.type;
  if (Array.isArray(type)) {
    if (type.includes("null")) out.nullable = true;
    type = type.find((t) => t !== "null");
  }
  if (s.nullable === true) out.nullable = true;
  if (
    typeof type === "string" &&
    (["string", "number", "integer", "boolean", "object", "array", "null"] as string[]).includes(type)
  )
    out.type = type as ApiSchemaType;
  else if (isObj(s.properties)) out.type = "object";
  else if (s.items !== undefined) out.type = "array";
  if (typeof s.format === "string" && s.format.length <= 40) out.format = s.format;
  if (Array.isArray(s.enum)) {
    const vals = s.enum
      .filter((v) => ["string", "number", "boolean"].includes(typeof v))
      .slice(0, SCHEMA_LIMITS.enum);
    if (vals.length) out.enum = vals as (string | number | boolean)[];
  }
  const desc = str(s.description) || str(s.title);
  if (desc) out.description = desc.replace(/\s+/g, " ").trim().slice(0, SCHEMA_LIMITS.description);
  for (const k of ["minimum", "maximum"] as const) if (typeof s[k] === "number") out[k] = s[k] as number;
  for (const k of ["minLength", "maxLength", "maxItems"] as const)
    if (Number.isInteger(s[k]) && (s[k] as number) >= 0) out[k] = s[k] as number;
  if (s.example !== undefined) out.example = s.example;
  else if (Array.isArray(s.examples) && s.examples.length) out.example = s.examples[0];
  if (out.type === "array") out.items = toSubset(doc, s.items, depth + 1, path);
  if (out.type === "object" && isObj(s.properties)) {
    const props: Record<string, ApiSchema> = {};
    for (const [name, sub] of Object.entries(s.properties)) {
      if (!isPropName(name) || Object.keys(props).length >= SCHEMA_LIMITS.properties) continue;
      props[name] = toSubset(doc, sub, depth + 1, path);
    }
    out.properties = props;
    const req = Array.isArray(s.required)
      ? s.required.filter((r): r is string => typeof r === "string" && r in props)
      : [];
    if (req.length) out.required = req;
  }
  return out;
}

interface Candidate {
  op: Omit<ContractOperation, "id">;
  rawId: string;
  text: string;
}

const JSON_MEDIA_RE = /^application\/([a-z0-9.+-]*\+)?json\b|^\*\/\*$/i;

function jsonContent(content: unknown): unknown {
  if (!isObj(content)) return undefined;
  for (const [media, v] of Object.entries(content))
    if (JSON_MEDIA_RE.test(media) && isObj(v)) return v.schema ?? {};
  return undefined;
}

function argName(name: string, taken: Set<string>): string {
  let base = camelIdent(name, 36) ?? "arg";
  if (!ARG_RE.test(base)) base = "arg";
  if (base === "body") base = "bodyParam";
  let arg = base;
  for (let n = 2; taken.has(arg); n++) arg = `${base}${n}`;
  taken.add(arg);
  return arg;
}

function readOperations(doc: Json, swagger: boolean, notes: string[]): Candidate[] {
  const out: Candidate[] = [];
  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(doc, rawItem).node;
    if (!isObj(item) || !path.startsWith("/")) continue;
    for (const method of METHODS) {
      const op = item[method.toLowerCase()];
      if (!isObj(op) || op.deprecated === true) continue;
      const taken = new Set<string>();
      const params: ContractParam[] = [];
      let body: ContractOperation["body"] = null;
      const all = [
        ...(Array.isArray(item.parameters) ? item.parameters : []),
        ...(Array.isArray(op.parameters) ? op.parameters : []),
      ];
      const byKey = new Map<string, Json>();
      for (const raw of all) {
        const p = deref(doc, raw).node;
        if (isObj(p) && typeof p.name === "string" && typeof p.in === "string")
          byKey.set(`${p.in}:${p.name}`, p);
      }
      let skip = false;
      for (const p of byKey.values()) {
        const where = p.in as string;
        if (where === "body" && swagger) {
          body = { required: p.required === true, schema: toSubset(doc, p.schema) };
          continue;
        }
        if (where === "cookie" || where === "formData") {
          if (p.required === true) skip = true;
          continue;
        }
        if (where !== "path" && where !== "query" && where !== "header") continue;
        const name = p.name as string;
        if (!isPropName(name)) {
          if (where === "path" || p.required === true) skip = true;
          continue;
        }
        // The key goes by the contract's auth; a header named like it is not an argument.
        if (where === "header" && /^(authorization|x-api-key|api-key|apikey)$/i.test(name)) continue;
        const schema = swagger
          ? toSubset(doc, { ...p, in: undefined, name: undefined, required: undefined })
          : toSubset(doc, p.schema);
        if (!schema.type) schema.type = "string";
        params.push({
          name,
          in: where,
          required: where === "path" || p.required === true,
          schema,
          arg: argName(name, taken),
        });
      }
      if (skip) continue;
      if (!swagger && op.requestBody !== undefined) {
        const rb = deref(doc, op.requestBody).node;
        const schema = isObj(rb) ? jsonContent(rb.content) : undefined;
        if (schema === undefined) {
          if (isObj(rb) && rb.required === true) continue; // form or binary bodies are not supported
        } else body = { required: isObj(rb) && rb.required === true, schema: toSubset(doc, schema) };
      }
      const responses = isObj(op.responses) ? op.responses : {};
      const ok = Object.keys(responses)
        .filter((k) => /^2\d\d$/.test(k))
        .sort()[0];
      let response: ContractOperation["response"] = { status: 200, schema: {} };
      if (ok) {
        const r = deref(doc, responses[ok]).node;
        const schema = isObj(r) ? (swagger ? r.schema : jsonContent(r.content)) : undefined;
        response = { status: Number(ok), schema: schema === undefined ? {} : toSubset(doc, schema) };
        const ex =
          isObj(r) && !swagger && isObj(r.content) ? Object.values(r.content).find(isObj) : undefined;
        if (isObj(ex) && ex.example !== undefined) response.example = ex.example;
      }
      const summary = (str(op.summary) || str(op.description)).replace(/\s+/g, " ").trim().slice(0, 200);
      out.push({
        op: { method, path, summary, params, body, response },
        rawId: str(op.operationId) || `${method} ${path}`,
        text: `${str(op.operationId)} ${path} ${summary} ${Array.isArray(op.tags) ? op.tags.join(" ") : ""}`.toLowerCase(),
      });
    }
  }
  if (out.length === 0) notes.push("В документе нет операций с JSON, которые умеет клиент");
  return out;
}

function pickServer(doc: Json, swagger: boolean, url: string | null): string | null {
  const candidates: string[] = [];
  if (swagger) {
    const host = str(doc.host) || (url ? new URL(url).host : "");
    const schemes = Array.isArray(doc.schemes) ? (doc.schemes as unknown[]).map(str) : ["https"];
    if (host && schemes.includes("https")) candidates.push(`https://${host}${str(doc.basePath)}`);
  } else if (Array.isArray(doc.servers)) {
    for (const s of doc.servers) {
      if (!isObj(s) || typeof s.url !== "string") continue;
      let u = s.url;
      const vars = isObj(s.variables) ? s.variables : {};
      u = u.replace(/\{([^}]+)\}/g, (_, v: string) => {
        const d = isObj(vars[v]) ? (vars[v] as Json).default : undefined;
        return typeof d === "string" ? d : "";
      });
      try {
        candidates.push(new URL(u, url ?? undefined).href);
      } catch {
        // relative server without a document URL
      }
    }
  } else if (url) candidates.push(new URL(url).origin);
  const https = candidates.find((c) => c.startsWith("https://"));
  if (!https) return null;
  const u = new URL(https);
  const path = u.pathname.replace(/\/+$/, "");
  return `https://${u.hostname.toLowerCase()}${path}`;
}

function pickAuth(doc: Json, swagger: boolean, secret: string, notes: string[]): IntegrationContract["auth"] {
  const schemes = swagger
    ? isObj(doc.securityDefinitions)
      ? doc.securityDefinitions
      : {}
    : isObj(doc.components) && isObj(doc.components.securitySchemes)
      ? doc.components.securitySchemes
      : {};
  const used = Array.isArray(doc.security)
    ? doc.security.flatMap((r) => (isObj(r) ? Object.keys(r) : []))
    : [];
  const names = [...new Set([...used, ...Object.keys(schemes)])];
  for (const n of names) {
    const s = deref(doc, schemes[n]).node;
    if (!isObj(s)) continue;
    const type = str(s.type).toLowerCase();
    if (type === "apikey" && (s.in === "header" || s.in === "query") && isPropName(str(s.name)))
      return { kind: s.in, name: str(s.name), secret };
    if (type === "http" && str(s.scheme).toLowerCase() === "bearer")
      return { kind: "bearer", name: null, secret };
    if (type === "oauth2" || type === "openidconnect") {
      notes.push("OAuth в документе: ключом служит готовый токен доступа (Bearer)");
      return { kind: "bearer", name: null, secret };
    }
    if ((type === "http" && str(s.scheme).toLowerCase() === "basic") || type === "basic") {
      notes.push("Basic-авторизация: ключ — значение заголовка Authorization целиком («Basic …»)");
      return { kind: "header", name: "Authorization", secret };
    }
  }
  if (names.length === 0) {
    notes.push("В документе не описана авторизация: ключ передаётся как Bearer-токен");
    return { kind: "bearer", name: null, secret };
  }
  notes.push("Вид авторизации из документа не поддерживается: ключ передаётся как Bearer-токен");
  return { kind: "bearer", name: null, secret };
}

const CHECK_HINT_RE = /\b(me|account|accounts|profile|user|users|ping|health|status|info|whoami)\b/;

/** Safe GET for the key check: no required parameters, «me/account/ping…» first, else the shortest path. */
export function pickCheck(ops: readonly ContractOperation[]): string | null {
  const safe = ops.filter((o) => o.method === "GET" && !o.params.some((p) => p.required));
  if (!safe.length) return null;
  const hinted = safe.find((o) => CHECK_HINT_RE.test(o.path.toLowerCase().replace(/[/{}_-]+/g, " ")));
  return (hinted ?? [...safe].sort((a, b) => a.path.length - b.path.length)[0])?.id ?? null;
}

/** OpenAPI 3.x / Swagger 2.0 (JSON text or parsed) → a validated contract. */
export function contractFromOpenApi(input: string | Json, o: FromOpenApiOptions): IntegrationContract {
  let doc: Json;
  const text = typeof input === "string" ? input : JSON.stringify(input);
  try {
    doc = typeof input === "string" ? (JSON.parse(input) as Json) : input;
  } catch {
    throw new OpenApiImportError("NOT_OPENAPI", "Документ не JSON — нужен OpenAPI в формате JSON");
  }
  const swagger = isObj(doc) && typeof doc.swagger === "string";
  if (!isObj(doc) || (!swagger && typeof doc.openapi !== "string"))
    throw new OpenApiImportError("NOT_OPENAPI", "Это не описание API в формате OpenAPI или Swagger");
  const notes: string[] = [];
  const baseUrl = pickServer(doc, swagger, o.url ?? null);
  if (!baseUrl)
    throw new OpenApiImportError(
      "NO_HTTPS_SERVER",
      "В описании API нет адреса сервера с https — без него система не сможет обращаться к API",
    );
  const secret = o.secret ?? defaultSecretRef(o.id);
  const auth = pickAuth(doc, swagger, secret, notes);
  const all = readOperations(doc, swagger, notes);
  if (!all.length)
    throw new OpenApiImportError("NO_OPERATIONS", "В описании API нет операций, которые умеет клиент");

  const max = Math.min(o.max ?? DEFAULT_OPERATIONS, CONTRACT_LIMITS.operations);
  let chosen: Candidate[];
  if (o.operations?.length) {
    const want = new Set(o.operations.map((x) => x.toLowerCase()));
    chosen = all.filter(
      (c) => want.has(c.rawId.toLowerCase()) || want.has(`${c.op.method} ${c.op.path}`.toLowerCase()),
    );
  } else if (all.length <= max) chosen = all;
  else {
    const words = needWords(`${o.need ?? ""} ${o.name}`);
    const scored = all
      .map((c, i) => ({ c, i, score: words.reduce((s, w) => s + (c.text.includes(w) ? 1 : 0), 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i);
    chosen = scored.slice(0, max).map((x) => x.c);
    if (!chosen.length) {
      chosen = all.slice(0, max);
      notes.push(
        "Операции не совпали с задачей по словам — взяты первые из документа; уточните, какие нужны",
      );
    } else notes.push(`Из ${all.length} операций документа выбрано ${chosen.length} по задаче интеграции`);
    // The key check needs a safe GET: keep one even when the need did not match it.
    const ids = new Set(chosen);
    if (!chosen.some((c) => c.op.method === "GET" && !c.op.params.some((p) => p.required))) {
      const extra = all.find(
        (c) => !ids.has(c) && c.op.method === "GET" && !c.op.params.some((p) => p.required),
      );
      if (extra) chosen = [...chosen.slice(0, max - 1), extra];
    }
  }
  const usedIds = new Set<string>();
  const operations: ContractOperation[] = chosen.map((c) => {
    let base = camelIdent(c.rawId) ?? "op";
    if (!OPERATION_ID_RE.test(base)) base = "op";
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base.slice(0, 36)}${n}`;
    usedIds.add(id);
    return { id, ...c.op };
  });
  const check = pickCheck(operations);
  if (!check && auth.kind !== "none")
    notes.push("Нет безопасной операции чтения без параметров: ключ проверится при первом настоящем вызове");
  const info = isObj(doc.info) ? doc.info : {};
  return parseContract({
    format: CONTRACT_FORMAT,
    id: o.id,
    name: o.name.slice(0, 120),
    source: {
      kind: swagger ? "swagger" : "openapi",
      url: o.url ?? null,
      sha256: createHash("sha256").update(text).digest("hex"),
      title: str(info.title).slice(0, 200),
      version: str(info.version).slice(0, 60),
    },
    baseUrl,
    hosts: [new URL(baseUrl).hostname],
    auth,
    operations,
    check: check ? { operation: check } : null,
    mapping: [],
    notes: notes.slice(0, 20).map((n) => n.slice(0, 300)),
  });
}
