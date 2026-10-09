// Requests of a contract, its deterministic mock, the contract tests and the key check (V3-20). One request builder
// for every side: the platform's contract tests against the mock, the key check against the real API (through the
// runtime egress client: only the contract's hosts, secret://name resolved there), and the generated client of the
// system (codegen.ts) builds the same URL, headers and body. The key never appears here — only its secret:// name.
import type { ContractMethod, ContractOperation, IntegrationContract } from "./contract.js";
import { sampleValue, validateValue } from "./schema.js";

export interface IntegrationRequest {
  method: ContractMethod;
  /** Absolute https URL; `secret://name` may stand in the query (the auth parameter) or the path (auth kind path). */
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface IntegrationResponse {
  status: number;
  contentType: string | null;
  text: string;
}

/** Sends one request: the mock, or the runtime egress client on the platform (only the contract's hosts). */
export type IntegrationTransport = (req: IntegrationRequest) => Promise<IntegrationResponse>;

/** Input of an operation: its params by `arg` and `body`. */
export type OperationInput = Record<string, unknown>;

const enc = (v: unknown) => encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v));

/** The operation by id; throws when the contract has none. */
export function operationOf(contract: IntegrationContract, id: string): ContractOperation {
  const op = contract.operations.find((o) => o.id === id);
  if (!op) throw new Error(`operation ${id} is not in contract ${contract.id}`);
  return op;
}

/** The request of an operation for `input` (params by their arg names, `body`) with the key as secret://name. */
export function buildRequest(
  contract: IntegrationContract,
  opId: string,
  input: OperationInput,
): IntegrationRequest {
  const op = operationOf(contract, opId);
  let path = op.path;
  const query: string[] = [];
  const headers: Record<string, string> = { Accept: "application/json" };
  for (const p of op.params) {
    const v = input[p.arg];
    if (v === undefined || v === null) continue;
    if (p.in === "path") path = path.split(`{${p.name}}`).join(enc(v));
    else if (p.in === "query")
      for (const item of Array.isArray(v) ? v : [v]) query.push(`${encodeURIComponent(p.name)}=${enc(item)}`);
    else headers[p.name] = typeof v === "string" ? v : JSON.stringify(v);
  }
  const secret = contract.auth.secret;
  if (secret && contract.auth.kind === "bearer") headers.Authorization = `Bearer ${secret}`;
  if (secret && contract.auth.kind === "header" && contract.auth.name) headers[contract.auth.name] = secret;
  // Not percent-encoded: the runtime finds secret://name in the query or the path and puts the value in its place.
  if (secret && contract.auth.kind === "query" && contract.auth.name)
    query.push(`${encodeURIComponent(contract.auth.name)}=${secret}`);
  const keyPath = secret && contract.auth.kind === "path" ? `/${contract.auth.name ?? ""}${secret}` : "";
  const req: IntegrationRequest = {
    method: op.method,
    url: `${contract.baseUrl}${keyPath}${path}${query.length ? `?${query.join("&")}` : ""}`,
    headers,
  };
  if (op.body && input.body !== undefined) {
    req.headers["Content-Type"] = "application/json";
    req.body = JSON.stringify(input.body);
  }
  return req;
}

/** The answer body the mock gives for an operation: the document's example when valid, else a seeded sample. */
export function mockBody(contract: IntegrationContract, op: ContractOperation): unknown {
  if (op.response.status === 204) return null;
  if (
    op.response.example !== undefined &&
    validateValue(op.response.schema, op.response.example).length === 0
  )
    return op.response.example;
  return sampleValue(op.response.schema, `${contract.id}:${op.id}`);
}

/** A valid input of an operation (contract tests): every param and the body sampled from their schemas. */
export function sampleInput(contract: IntegrationContract, op: ContractOperation): OperationInput {
  const input: OperationInput = {};
  for (const p of op.params) input[p.arg] = sampleValue(p.schema, `${contract.id}:${op.id}:${p.name}`);
  if (op.body) input.body = sampleValue(op.body.schema, `${contract.id}:${op.id}:body`);
  return input;
}

const json = (status: number, body: unknown): IntegrationResponse => ({
  status,
  contentType: "application/json",
  text: body === null ? "" : JSON.stringify(body),
});

function matchPath(template: string, path: string): Record<string, string> | null {
  const t = template.split("/");
  const p = path.split("/");
  if (t.length !== p.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < t.length; i++) {
    const seg = t[i] as string;
    const m = /^\{([^}]+)\}$/.exec(seg);
    if (m) {
      if (!p[i]) return null;
      params[m[1] as string] = decodeURIComponent(p[i] as string);
    } else if (seg !== p[i]) return null;
  }
  return params;
}

/**
 * Deterministic mock of the API by its contract: the operation by method and path, the key present where the contract
 * puts it, required params and the body checked against their schemas (400 with the problems), the answer — mockBody.
 */
export function mockTransport(contract: IntegrationContract): IntegrationTransport {
  return async (req) => {
    const url = new URL(req.url.replace(/secret:\/\/([a-z0-9_]+)/g, "secret-$1"));
    const base = new URL(contract.baseUrl);
    if (url.hostname !== base.hostname || !url.pathname.startsWith(base.pathname))
      return json(404, { error: "unknown host or base path" });
    let rest = url.pathname.slice(base.pathname.replace(/\/$/, "").length) || "/";
    if (contract.auth.kind === "path") {
      // The key segment right after the base: /<prefix><key>/… (secret://name or the value itself).
      const seg = /^\/([^/]*)/.exec(rest)?.[1] ?? "";
      const prefix = contract.auth.name ?? "";
      if (!seg.startsWith(prefix) || seg.length === prefix.length) return json(401, { error: "no key" });
      rest = rest.slice(seg.length + 1) || "/";
    }
    for (const op of contract.operations) {
      if (op.method !== req.method) continue;
      const params = matchPath(op.path, rest);
      if (!params) continue;
      const header = (name: string) =>
        Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
      const a = contract.auth;
      const keyed =
        a.kind === "none" ||
        a.kind === "path" ||
        (a.kind === "bearer" && /^Bearer \S+/.test(header("authorization") ?? "")) ||
        (a.kind === "header" && !!header(a.name ?? "")) ||
        (a.kind === "query" && url.searchParams.has(a.name ?? ""));
      if (!keyed) return json(401, { error: "no key" });
      const problems: string[] = [];
      for (const p of op.params) {
        const raw =
          p.in === "path" ? params[p.name] : p.in === "query" ? url.searchParams.get(p.name) : header(p.name);
        if (raw === undefined || raw === null) {
          if (p.required) problems.push(`нет параметра ${p.name}`);
          continue;
        }
        let value: unknown = raw;
        if (p.schema.type !== "string") {
          try {
            value = JSON.parse(raw);
          } catch {
            value = raw;
          }
        }
        for (const i of validateValue(p.schema, value)) problems.push(`${p.name}: ${i.message_ru}`);
      }
      if (op.body) {
        if (req.body === undefined) {
          if (op.body.required) problems.push("нет тела запроса");
        } else {
          let body: unknown;
          try {
            body = JSON.parse(req.body);
          } catch {
            problems.push("тело запроса — не JSON");
          }
          if (body !== undefined)
            for (const i of validateValue(op.body.schema, body))
              problems.push(`body${i.path}: ${i.message_ru}`);
        }
      }
      if (problems.length) return json(400, { error: "invalid request", problems });
      return json(op.response.status, mockBody(contract, op));
    }
    return json(404, { error: "unknown operation" });
  };
}

export interface OperationResult {
  operation: string;
  ok: boolean;
  status: number | null;
  /** Russian problems: status, schema mismatches (paths only, never values of the answer). */
  problems: string[];
}

export interface ContractTestReport {
  ok: boolean;
  total: number;
  passed: number;
  results: OperationResult[];
}

function parseAnswer(r: IntegrationResponse): { value: unknown; problem: string | null } {
  if (r.text.trim() === "") return { value: null, problem: null };
  try {
    return { value: JSON.parse(r.text), problem: null };
  } catch {
    return { value: undefined, problem: "Ответ не в формате JSON" };
  }
}

async function runOperation(
  contract: IntegrationContract,
  op: ContractOperation,
  transport: IntegrationTransport,
): Promise<OperationResult> {
  const r = await transport(buildRequest(contract, op.id, sampleInput(contract, op)));
  const problems: string[] = [];
  if (r.status < 200 || r.status > 299) problems.push(`Ответ ${r.status} вместо ${op.response.status}`);
  else if (op.response.status !== 204) {
    const a = parseAnswer(r);
    if (a.problem) problems.push(a.problem);
    else
      for (const i of validateValue(op.response.schema, a.value)) problems.push(`${i.path}: ${i.message_ru}`);
  }
  return { operation: op.id, ok: problems.length === 0, status: r.status, problems: problems.slice(0, 10) };
}

/**
 * Contract tests: every operation with a sampled valid input, the answer checked against the contract. Meant for the
 * mock (and a provider's sandbox) — writing operations are never sent to a live API by the platform.
 */
export async function runContractTests(
  contract: IntegrationContract,
  transport: IntegrationTransport,
): Promise<ContractTestReport> {
  const results: OperationResult[] = [];
  for (const op of contract.operations) {
    try {
      results.push(await runOperation(contract, op, transport));
    } catch (e) {
      results.push({ operation: op.id, ok: false, status: null, problems: [transportProblem(e)] });
    }
  }
  const passed = results.filter((r) => r.ok).length;
  return { ok: passed === results.length, total: results.length, passed, results };
}

export type KeyCheckCode =
  | "OK"
  | "SECRET_MISSING"
  | "NO_CHECK_OPERATION"
  | "AUTH_FAILED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "CONTRACT_MISMATCH"
  | "EGRESS_FORBIDDEN";

export interface KeyCheckResult {
  /** The integration may switch on (OK, or no safe operation to call — then verified is false). */
  ok: boolean;
  /** The key was really sent and accepted. */
  verified: boolean;
  code: KeyCheckCode;
  status: number | null;
  message_ru: string;
  problems: string[];
}

function transportProblem(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  const msg = (e as { details?: { message?: unknown } })?.details?.message;
  if (typeof msg === "string") return msg.slice(0, 200);
  return typeof code === "string" ? `Запрос не выполнен: ${code}` : "Запрос не выполнен";
}

/**
 * The check with the key (D77 (15)): the contract's safe GET through `transport` (on the platform — the runtime egress
 * client, the key substituted there). 401/403 — the key is wrong; a 2xx answer that does not match the contract —
 * the contract is stale; no safe GET — nothing is sent, the integration switches on unverified.
 */
export async function checkContractKey(
  contract: IntegrationContract,
  transport: IntegrationTransport,
): Promise<KeyCheckResult> {
  const name = contract.name;
  if (!contract.check)
    return {
      ok: true,
      verified: false,
      code: "NO_CHECK_OPERATION",
      status: null,
      message_ru: `У «${name}» нет безопасной операции для проверки — ключ проверится при первом вызове`,
      problems: [],
    };
  const op = operationOf(contract, contract.check.operation);
  let r: IntegrationResponse;
  try {
    r = await transport(buildRequest(contract, op.id, sampleInput(contract, op)));
  } catch (e) {
    const forbidden = (e as { code?: unknown })?.code === "EGRESS_FORBIDDEN";
    return {
      ok: false,
      verified: false,
      code: forbidden ? "EGRESS_FORBIDDEN" : "UPSTREAM_UNAVAILABLE",
      status: null,
      message_ru: forbidden
        ? `Запрос к «${name}» запрещён: адрес не входит в разрешённые хосты контракта`
        : `«${name}» не ответил — попробуйте проверить ключ позже`,
      problems: [transportProblem(e)],
    };
  }
  const fail = (code: KeyCheckCode, message_ru: string, problems: string[] = []): KeyCheckResult => ({
    ok: false,
    verified: false,
    code,
    status: r.status,
    message_ru,
    problems,
  });
  if (r.status === 401 || r.status === 403)
    return fail("AUTH_FAILED", `Ключ не подошёл: «${name}» ответил ${r.status}. Проверьте ключ и его права`);
  if (r.status === 404)
    return fail("NOT_FOUND", `Адрес API «${name}» не найден (404) — контракт нужно обновить`);
  if (r.status === 429) return fail("RATE_LIMITED", `«${name}» просит подождать (429) — проверим ключ позже`);
  if (r.status >= 500) return fail("UPSTREAM_UNAVAILABLE", `«${name}» сейчас недоступен (${r.status})`);
  if (r.status < 200 || r.status > 299)
    return fail("INVALID_REQUEST", `«${name}» отклонил запрос проверки (${r.status})`);
  const a = parseAnswer(r);
  const problems = a.problem
    ? [a.problem]
    : validateValue(op.response.schema, a.value).map((i) => `${i.path}: ${i.message_ru}`);
  if (problems.length)
    return fail(
      "CONTRACT_MISMATCH",
      `Ключ подошёл, но ответ «${name}» не совпал с контрактом`,
      problems.slice(0, 10),
    );
  return {
    ok: true,
    verified: true,
    code: "OK",
    status: r.status,
    message_ru: `Ключ «${name}» подошёл`,
    problems: [],
  };
}
