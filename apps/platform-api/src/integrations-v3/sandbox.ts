// V3-22, acceptance 2: the API passports against the providers' test contours, without model calls — СДЭК
// api.edu.cdek.ru (the public test account of the СДЭК docs, or CDEK_TEST_ACCOUNT / CDEK_TEST_SECURE) and the ЮKassa
// test shop (YOOKASSA_TEST_SHOP_ID / YOOKASSA_TEST_SECRET_KEY, test_ keys only). The path is the platform's key check
// (service.ts checkIntegration): the passport's contract, the key composed by passportKey and held by an in-memory
// SecretReader, the runtime egress client over contractTransport (secret://name resolved there, the СДЭК token traded
// by the egress client itself) — then a few safe operations, every answer validated against the passport. A mismatch
// names the operation, the JSON pointer, what the passport expects and what came (short scalars only). Keys, tokens and
// Authorization values never reach a line of the report: every text is masked when the step is recorded.
// CLI: tools/integrations/sandbox-check.mjs; workflow: .github/workflows/integrations-sandbox.yml.
import { randomUUID } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import {
  type ApiSchema,
  buildRequest,
  cdek,
  checkContractKey,
  type IntegrationContract,
  type IntegrationResponse,
  type IntegrationTransport,
  type OperationInput,
  operationOf,
  type Passport,
  passportById,
  passportContract,
  passportKey,
  passportTokenRequest,
  passportTokenValue,
  validateValue,
  yookassa,
} from "@wizard/agents/integrations";
import {
  isPrivateAddress,
  platformDomains,
  type Resolver,
  type SecretReader,
  staticSecretReader,
  systemResolver,
} from "@wizard/connectors";
import { directTransport, type EgressTransport, egressHttpClient } from "@wizard/runtime";
import { contractTransport } from "./transport.js";

/** Passports with a test contour (V3-22 acceptance 2): СДЭК — its own host, ЮKassa — a test shop on the same host. */
export const SANDBOX_PASSPORTS = ["cdek", "yookassa"] as const;
export type SandboxPassportId = (typeof SANDBOX_PASSPORTS)[number];

/** GitHub secrets the check reads (all optional). */
export const SANDBOX_ENV = {
  cdekAccount: "CDEK_TEST_ACCOUNT",
  cdekSecure: "CDEK_TEST_SECURE",
  kassaShop: "YOOKASSA_TEST_SHOP_ID",
  kassaKey: "YOOKASSA_TEST_SECRET_KEY",
} as const;

/**
 * The shared test account of the СДЭК test contour api.edu.cdek.ru, published in the СДЭК API documentation
 * (api-docs.cdek.ru, «Тестовая среда»; the same pair ships in public СДЭК SDKs). Public and not a secret: it opens only
 * the educational contour, where orders are never executed. CDEK_TEST_ACCOUNT / CDEK_TEST_SECURE override it.
 */
export const CDEK_PUBLIC_TEST_ACCOUNT = {
  account: "wqGwiQx0gg8mLtiEKsUinjVSICCjtTEP",
  secure: "RmAmgvSgSl1yirlz9QupbzOJVqhCxcP5",
} as const;

export type SandboxLevel = "notice" | "warning" | "error";
export type SandboxVerdict = "ok" | "mismatch" | "failed" | "unreachable" | "skipped" | "refused";

export interface SandboxStep {
  passport: SandboxPassportId;
  /** host | keys | token | the operation id (with a suffix for a repeat) */
  step: string;
  level: SandboxLevel;
  verdict: SandboxVerdict;
  status: number | null;
  ms: number;
  /** One Russian line, masked. */
  message_ru: string;
  /** Schema mismatches «/pointer: expected …; пришло …», masked. */
  problems: string[];
}

export interface SandboxReport {
  /** No step of level error. */
  ok: boolean;
  steps: SandboxStep[];
}

/** How the requests leave: direct (as the platform outside the cloud) or through an HTTP CONNECT proxy. */
export interface SandboxNet {
  /** http://proxy:port of HTTPS_PROXY; null — direct (DNS checked, public addresses only). */
  proxyUrl?: string | null;
  resolve?: Resolver;
  /** Tests: port of a local TLS upstream instead of 443 (direct only). */
  port?: number;
  /** Tests: CA of a local TLS upstream (replaces the default roots). */
  ca?: string;
  /** Tests: allow 127.0.0.1. */
  allowPrivate?: boolean;
  /** Deadline of the reachability probe, ms (default 10 000). */
  timeoutMs?: number;
  platformDomains?: readonly string[];
}

export interface SandboxOptions {
  passports: readonly SandboxPassportId[];
  env: Readonly<Record<string, string | undefined>>;
  net?: SandboxNet;
  /** СДЭК: create a test order in api.edu.cdek.ru, read it and delete it (orders there are never executed). */
  cdekOrder?: boolean;
  /** Marks the test payment and order (GitHub run id). */
  runId?: string;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// ------------------------------------------------------------------------------------------------ masking

const MASK = "•••";

/** Every occurrence of every secret (≥ 4 characters, also percent-encoded) replaced by •••. */
export function maskText(text: string, secrets: readonly string[]): string {
  const values = new Set<string>();
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    values.add(s);
    const enc = encodeURIComponent(s);
    if (enc !== s) values.add(enc);
  }
  let out = text;
  for (const v of [...values].sort((a, b) => b.length - a.length)) out = out.split(v).join(MASK);
  return out;
}

// ------------------------------------------------------------------------------------------------ answers

/** The value at a JSON Pointer of validateValue («/» — the root). */
function atPointer(value: unknown, pointer: string): { found: boolean; value: unknown } {
  if (pointer === "/" || pointer === "") return { found: true, value };
  let cur: unknown = value;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, key))
      return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[key];
  }
  return { found: true, value: cur };
}

/** A short view of a value of an answer: scalars (strings up to 60 characters), never long token-like strings. */
function preview(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `список из ${v.length}`;
  if (typeof v === "object") return "объект";
  if (typeof v === "string") {
    if (v.length > 40 && /^[A-Za-z0-9._~+/=-]+$/.test(v)) return `строка из ${v.length} символов`;
    const s = v.replace(/[\r\n]+/g, " ");
    return JSON.stringify(s.length > 60 ? `${s.slice(0, 60)}…` : s);
  }
  return String(v);
}

/**
 * Mismatches of an answer with the passport's schema: the JSON Pointer, what the passport expects (validateValue's
 * Russian text) and what came. At most 10.
 */
export function describeIssues(schema: ApiSchema, value: unknown): string[] {
  return validateValue(schema, value)
    .slice(0, 10)
    .map((i) => {
      const got = atPointer(value, i.path);
      const missing = i.message_ru.startsWith("Нет обязательного поля");
      return `${i.path}: ${i.message_ru}${got.found && !missing ? `; пришло ${preview(got.value)}` : ""}`;
    });
}

const NAME_RE = /^[A-Za-z0-9_.$-]{1,40}$/;

/** Field names of an answer the passport does not describe (top level, or the first item of a list). */
export function extraFields(schema: ApiSchema, value: unknown): string[] {
  let s = schema;
  let v = value;
  if (s.type === "array" && Array.isArray(v) && s.items) {
    s = s.items;
    v = v[0];
  }
  if (s.type !== "object" || !s.properties || !v || typeof v !== "object" || Array.isArray(v)) return [];
  const known = new Set(Object.keys(s.properties));
  return Object.keys(v).filter((k) => !known.has(k) && NAME_RE.test(k));
}

const extrasText = (names: readonly string[]) =>
  names.length
    ? `; поля вне паспорта: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ` и ещё ${names.length - 8}` : ""}`
    : "";

/** Error fields of a provider's answer (ЮKassa code/description/parameter, СДЭК errors[] and requests[].errors[]). */
export function providerError(text: string): string | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const out: string[] = [];
  const take = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, unknown>;
    for (const k of ["code", "error", "description", "error_description", "message", "parameter"]) {
      const v = r[k];
      if (typeof v === "string" && v.trim()) out.push(`${k}=${v.trim().slice(0, 160)}`);
    }
  };
  const r = j as Record<string, unknown>;
  take(r);
  const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, 3) : []);
  for (const e of list(r.errors)) take(e);
  for (const q of list(r.requests)) for (const e of list((q as { errors?: unknown })?.errors)) take(e);
  return out.length
    ? out
        .join(", ")
        .replace(/[\r\n]+/g, " ")
        .slice(0, 400)
    : null;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === "") return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Text of a transport failure (the egress client's Russian message and code), without values. */
function errorText(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  const msg = (e as { message?: unknown })?.message;
  const m = typeof msg === "string" && msg ? msg.slice(0, 200) : "запрос не выполнен";
  return typeof code === "string" ? `${m} (${code})` : m;
}

// ------------------------------------------------------------------------------------------------ network

const CODE_RE = /^[A-Z][A-Z0-9_]{1,60}$/;
const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown })?.code;
  if (typeof c === "string" && CODE_RE.test(c)) return c;
  const m = String((e as { message?: unknown })?.message ?? "");
  if (m === "timeout") return "ETIMEDOUT";
  return CODE_RE.test(m) ? m : "ERROR";
};

const timeoutError = () => Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });

/** `p` or ETIMEDOUT after `ms` (a DNS lookup cannot be cancelled; sockets have their own deadlines below). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeoutError()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** TCP to host:port within `ms`; the socket is destroyed on any failure. */
function tcpConnect(host: string, port: number, ms: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = netConnect({ host, port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(timeoutError());
    }, ms);
    s.once("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("error", (e) => {
      clearTimeout(timer);
      s.destroy();
      reject(e);
    });
  });
}

/** TLS with SNI = host over `socket` within `ms`; both are destroyed on any failure. */
function tlsOver(socket: Socket, host: string, ca: string | undefined, ms: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ socket, servername: host, ...(ca ? { ca } : {}), ALPNProtocols: ["http/1.1"] });
    const fail = (e: Error) => {
      clearTimeout(timer);
      s.destroy();
      socket.destroy();
      reject(e);
    };
    const timer = setTimeout(() => fail(timeoutError()), ms);
    s.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("error", fail);
  });
}

/** CONNECT host:443 through an HTTP proxy within `ms`; resolves with the tunnel, rejects with code PROXY_<status>. */
async function openTunnel(proxyUrl: string, host: string, ms: number): Promise<Socket> {
  const started = Date.now();
  const u = new URL(proxyUrl);
  const socket = await tcpConnect(u.hostname, Number(u.port || 80), ms);
  const user = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
  const auth =
    u.username || u.password ? `Proxy-Authorization: Basic ${Buffer.from(user).toString("base64")}\r\n` : "";
  const fail = (code: string) => Object.assign(new Error("proxy"), { code });
  let timer: NodeJS.Timeout | undefined;
  try {
    const status = await new Promise<number>((resolve, reject) => {
      timer = setTimeout(() => reject(timeoutError()), Math.max(1, ms - (Date.now() - started)));
      let buf = Buffer.alloc(0);
      const onData = (b: Buffer) => {
        buf = Buffer.concat([buf, b]);
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buf.length > 8192) reject(fail("PROXY_HEADER"));
          return;
        }
        socket.off("data", onData);
        const rest = buf.subarray(end + 4);
        if (rest.length) socket.unshift(rest);
        resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf.toString("latin1"))?.[1] ?? 0));
      };
      socket.on("data", onData);
      socket.once("error", reject);
      socket.once("close", () => reject(fail("PROXY_CLOSED")));
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${auth}\r\n`);
    });
    if (status !== 200) throw fail(`PROXY_${status}`);
  } catch (e) {
    socket.destroy();
    throw e;
  } finally {
    clearTimeout(timer);
  }
  socket.removeAllListeners("close");
  socket.removeAllListeners("error");
  return socket;
}

/**
 * EgressTransport through a plain HTTP CONNECT proxy (HTTPS_PROXY of a developer machine or a runner behind a proxy):
 * the proxy resolves the name, TLS with SNI = host runs inside the tunnel against the default roots (NODE_EXTRA_CA_CERTS).
 */
export function connectProxyTransport(proxyUrl: string, o: { ca?: string } = {}): EgressTransport {
  return {
    async connect(host, timeoutMs) {
      const started = Date.now();
      const raw = await openTunnel(proxyUrl, host, timeoutMs);
      return tlsOver(raw, host, o.ca, Math.max(1, timeoutMs - (Date.now() - started)));
    },
  };
}

/** The egress transport of the check: the same directTransport the platform uses outside the cloud, or the proxy. */
export function sandboxTransport(net: SandboxNet = {}): EgressTransport {
  if (net.proxyUrl) return connectProxyTransport(net.proxyUrl, net.ca ? { ca: net.ca } : {});
  return directTransport({
    ...(net.resolve ? { resolve: net.resolve } : {}),
    ...(net.ca ? { ca: net.ca } : {}),
    ...(net.allowPrivate ? { allowPrivate: true } : {}),
    ...(net.port ? { port: net.port } : {}),
  });
}

export interface HostReach {
  ok: boolean;
  via: "direct" | "proxy";
  /** Where it broke: name, TCP, the proxy tunnel, TLS. */
  stage: "dns" | "tcp" | "proxy" | "tls" | null;
  code: string | null;
  family: "IPv4" | "IPv6" | null;
  addresses: number;
  ms: number;
}

/** Reachability of host:443 the way the egress client goes there: DNS → TCP → TLS, or CONNECT → TLS. */
export async function probeHost(host: string, net: SandboxNet = {}): Promise<HostReach> {
  const started = Date.now();
  const timeout = net.timeoutMs ?? 10_000;
  const left = () => Math.max(1, timeout - (Date.now() - started));
  const via = net.proxyUrl ? "proxy" : "direct";
  let family: HostReach["family"] = null;
  let addresses = 0;
  const done = (stage: HostReach["stage"], code: string | null): HostReach => ({
    ok: stage === null,
    via,
    stage,
    code,
    family,
    addresses,
    ms: Date.now() - started,
  });
  let raw: Socket | undefined;
  if (net.proxyUrl) {
    try {
      raw = await openTunnel(net.proxyUrl, host, left());
    } catch (e) {
      return done("proxy", codeOf(e));
    }
  } else {
    let addrs: string[];
    try {
      addrs = await withTimeout((net.resolve ?? systemResolver)(host), left());
    } catch (e) {
      return done("dns", codeOf(e) === "ERROR" ? "ENOTFOUND" : codeOf(e));
    }
    addresses = addrs.length;
    if (!addrs.length) return done("dns", "ENODATA");
    if (!net.allowPrivate && addrs.some((a) => isPrivateAddress(a))) return done("dns", "ADDRESS_NOT_PUBLIC");
    const ip = addrs[0] as string;
    family = ip.includes(":") ? "IPv6" : "IPv4";
    try {
      raw = await tcpConnect(ip, net.port ?? 443, left());
    } catch (e) {
      return done("tcp", codeOf(e));
    }
  }
  try {
    (await tlsOver(raw, host, net.ca, left())).destroy();
  } catch (e) {
    return done("tls", codeOf(e));
  }
  return done(null, null);
}

const CERT_CODES = /CERT|SELF_SIGNED|UNABLE_TO|ALTNAME|DEPTH_ZERO/;

/** What broke on the way to the host, Russian (the stage, the code and what it likely means). */
export function reachCause(host: string, r: HostReach): string {
  const code = r.code ?? "ERROR";
  if (r.stage === "dns")
    return code === "ADDRESS_NOT_PUBLIC"
      ? "имя указывает во внутреннюю сеть — запрос запрещён"
      : `имя не разрешается в адрес (${code})`;
  if (r.stage === "proxy") return `прокси HTTPS_PROXY не открыл туннель к ${host}:443 (${code})`;
  if (r.stage === "tcp") {
    const why =
      code === "ECONNREFUSED"
        ? "порт 443 закрыт"
        : code === "ETIMEDOUT"
          ? "нет ответа"
          : code === "ECONNRESET"
            ? "соединение сброшено"
            : code === "ENETUNREACH" || code === "EHOSTUNREACH"
              ? "нет маршрута до адреса"
              : "ошибка соединения";
    return `TCP-соединение (${r.family ?? "адрес"}) не установлено — ${why} (${code})`;
  }
  if (CERT_CODES.test(code))
    return `сертификат не прошёл проверку (${code}): если его выпустил удостоверяющий центр не из хранилища Node (например, НУЦ Минцифры), рантайм платформы тоже не сможет ходить к этому API`;
  if (code === "ECONNRESET")
    return "соединение сброшено во время TLS-рукопожатия (ECONNRESET) — похоже, хост не принимает соединения из этой сети";
  if (code === "ETIMEDOUT") return "нет ответа на TLS-рукопожатие (ETIMEDOUT)";
  return `TLS-рукопожатие не прошло (${code})`;
}

/** Russian line of a host unreachable after every attempt, with what to do. */
export function reachMessage(host: string, r: HostReach, attempts = 1): string {
  const where = r.via === "proxy" ? "через прокси" : "с этого раннера";
  const tries = attempts > 1 ? ` (${attempts} попытки)` : "";
  const tail =
    r.via === "proxy"
      ? "Операции не выполнялись: проверьте прокси или запустите проверку с раннера GitHub или сервера пилота."
      : "Операции не выполнялись: проверку нужно запустить из сети, где хост доступен (например, с сервера пилота в РФ).";
  return `${host} недоступен ${where}${tries}: ${reachCause(host, r)}. ${tail}`;
}

// ------------------------------------------------------------------------------------------------ the run

interface Run {
  id: SandboxPassportId;
  passport: Passport;
  contract: IntegrationContract;
  secrets: SecretReader;
  egress: EgressTransport;
  net: SandboxNet;
  report: SandboxStep[];
  masks: string[];
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Attempts of a safe request on a transport failure (resets of the TLS handshake happen on some networks). */
export const SANDBOX_ATTEMPTS = 4;
const RETRY_PAUSE_MS = 1500;

function record(
  run: Run,
  s: Omit<SandboxStep, "passport" | "message_ru" | "problems" | "ms"> & {
    started: number;
    message_ru: string;
    problems?: string[];
  },
): SandboxStep {
  const m = (t: string) => maskText(t, run.masks);
  const step: SandboxStep = {
    passport: run.id,
    step: s.step,
    level: s.level,
    verdict: s.verdict,
    status: s.status,
    ms: Math.max(0, run.clock() - s.started),
    message_ru: m(s.message_ru),
    problems: (s.problems ?? []).map(m),
  };
  run.report.push(step);
  return step;
}

/** One «function call» of the egress client over the contract (the platform's contractTransport). */
const callTransport = (run: Run): IntegrationTransport =>
  contractTransport({
    contract: run.contract,
    secrets: run.secrets,
    transport: run.egress,
    ...(run.net.platformDomains ? { platformDomains: run.net.platformDomains } : {}),
  });

interface OpOutcome {
  step: SandboxStep;
  value: unknown;
}

/** «; с 2-й попытки (до этого: …)» — a request that went through only after transport failures. */
const retriesText = (failures: readonly string[]) =>
  failures.length
    ? `; с ${failures.length + 1}-й попытки (до этого: ${[...new Set(failures)].join("; ")})`
    : "";

/** Why the requests did not go through: a fresh probe of the host. */
async function diagnose(run: Run): Promise<string> {
  const host = new URL(run.contract.baseUrl).hostname;
  const r = await probeHost(host, run.net);
  return r.ok
    ? "соединение с хостом сейчас проходит — сбой был временным"
    : `соединение с ${host}: ${reachCause(host, r)}`;
}

/**
 * An operation through the egress client, the answer validated against the passport. A transport failure is retried
 * (SANDBOX_ATTEMPTS) unless `retry` is false; `retryIf` decides before each repeat (a creation that is not idempotent
 * is repeated only when the object did not appear).
 */
async function runOp(
  run: Run,
  opId: string,
  input: OperationInput,
  o: { label?: string; retry?: boolean; retryIf?: () => Promise<boolean> } = {},
): Promise<OpOutcome> {
  const label = o.label ?? opId;
  const op = operationOf(run.contract, opId);
  const started = run.clock();
  const attempts = o.retry === false ? 1 : SANDBOX_ATTEMPTS;
  const failures: string[] = [];
  let r: IntegrationResponse | null = null;
  for (let i = 0; i < attempts && !r; i++) {
    if (i > 0) {
      await run.sleep(RETRY_PAUSE_MS);
      if (o.retryIf && !(await o.retryIf())) break;
    }
    try {
      r = await callTransport(run)(buildRequest(run.contract, opId, input));
    } catch (e) {
      failures.push(errorText(e));
    }
  }
  if (!r)
    return {
      step: record(run, {
        step: label,
        level: "error",
        verdict: "failed",
        status: null,
        started,
        message_ru: `запрос не выполнен${attempts > 1 ? ` за ${attempts} попытки` : ""}: ${[...new Set(failures)].join("; ")}; ${await diagnose(run)}`,
      }),
      value: undefined,
    };
  const retried = retriesText(failures);
  if (r.status < 200 || r.status > 299) {
    const err = providerError(r.text);
    return {
      step: record(run, {
        step: label,
        level: "error",
        verdict: "failed",
        status: r.status,
        started,
        message_ru: `${run.passport.name} ответил ${r.status} вместо ${op.response.status}${err ? `: ${err}` : ""}${retried}`,
      }),
      value: undefined,
    };
  }
  const parsed = parseJson(r.text);
  if (!parsed.ok)
    return {
      step: record(run, {
        step: label,
        level: "error",
        verdict: "mismatch",
        status: r.status,
        started,
        message_ru: `ответ ${r.status} не в формате JSON (${r.contentType ?? "без Content-Type"})${retried}`,
      }),
      value: undefined,
    };
  const problems = describeIssues(op.response.schema, parsed.value);
  if (r.status !== op.response.status)
    problems.unshift(`статус ответа ${r.status}, в паспорте ${op.response.status}`);
  if (problems.length)
    return {
      step: record(run, {
        step: label,
        level: "error",
        verdict: "mismatch",
        status: r.status,
        started,
        message_ru: `ответ ${r.status} не совпал с паспортом (${problems.length})${retried}`,
        problems,
      }),
      value: parsed.value,
    };
  return {
    step: record(run, {
      step: label,
      level: "notice",
      verdict: "ok",
      status: r.status,
      started,
      message_ru: `ответ ${r.status} совпал с паспортом${extrasText(extraFields(op.response.schema, parsed.value))}${retried}`,
    }),
    value: parsed.value,
  };
}

/**
 * The key check exactly as checkIntegration runs it (checkContractKey over contractTransport), repeated on a transport
 * failure; the answer is kept (tee) to describe a mismatch precisely.
 */
async function checkStep(run: Run): Promise<{ usable: boolean; value: unknown }> {
  const opId = run.contract.check?.operation ?? "";
  const label = opId || "check";
  const started = run.clock();
  const failures: string[] = [];
  let res: Awaited<ReturnType<typeof checkContractKey>> | null = null;
  let last: IntegrationResponse | undefined;
  for (let i = 0; i < SANDBOX_ATTEMPTS; i++) {
    if (i > 0) await run.sleep(RETRY_PAUSE_MS);
    const seen: IntegrationResponse[] = [];
    const base = callTransport(run);
    const tee: IntegrationTransport = async (req) => {
      const r = await base(req);
      seen.push(r);
      return r;
    };
    res = await checkContractKey(run.contract, tee);
    last = seen.at(-1);
    if (!(res.code === "UPSTREAM_UNAVAILABLE" && res.status === null)) break;
    failures.push(res.problems[0] ?? res.message_ru);
  }
  if (!res) return { usable: false, value: undefined };
  const parsed = last ? parseJson(last.text) : { ok: false as const };
  const value = parsed.ok ? parsed.value : undefined;
  if (res.code === "UPSTREAM_UNAVAILABLE" && res.status === null) {
    record(run, {
      step: label,
      level: "error",
      verdict: "failed",
      status: null,
      started,
      message_ru: `проверка ключа не выполнена за ${SANDBOX_ATTEMPTS} попытки: ${[...new Set(failures)].join("; ")}; ${await diagnose(run)}`,
    });
    return { usable: false, value };
  }
  const retried = retriesText(failures);
  if (res.code === "OK") {
    const schema = operationOf(run.contract, opId).response.schema;
    record(run, {
      step: label,
      level: "notice",
      verdict: "ok",
      status: res.status,
      started,
      message_ru: `проверка ключа: ${res.message_ru} (${res.status}), ответ совпал с паспортом${extrasText(extraFields(schema, value))}${retried}`,
    });
    return { usable: true, value };
  }
  if (res.code === "CONTRACT_MISMATCH") {
    const schema = operationOf(run.contract, opId).response.schema;
    const problems = parsed.ok ? describeIssues(schema, value) : res.problems;
    record(run, {
      step: label,
      level: "error",
      verdict: "mismatch",
      status: res.status,
      started,
      message_ru: `проверка ключа: ключ подошёл (${res.status}), но ответ не совпал с паспортом (${problems.length})${retried}`,
      problems,
    });
    return { usable: true, value };
  }
  const err = last ? providerError(last.text) : null;
  record(run, {
    step: label,
    level: "error",
    verdict: "failed",
    status: res.status,
    started,
    message_ru: `проверка ключа: ${res.code} — ${res.message_ru}${err ? `; ответ: ${err}` : ""}${res.problems.length ? `; ${res.problems.join("; ")}` : ""}${retried}`,
  });
  return { usable: false, value };
}

/** Reachability of the contract's host (up to SANDBOX_ATTEMPTS probes); false — the passport stops here. */
async function hostStep(run: Run, account_ru: string): Promise<boolean> {
  const host = new URL(run.contract.baseUrl).hostname;
  const started = run.clock();
  const failed: HostReach[] = [];
  let r: HostReach | null = null;
  for (let i = 0; i < SANDBOX_ATTEMPTS; i++) {
    if (i > 0) await run.sleep(RETRY_PAUSE_MS);
    const got = await probeHost(host, run.net);
    if (got.ok) {
      r = got;
      break;
    }
    failed.push(got);
  }
  if (!r) {
    record(run, {
      step: "host",
      level: "error",
      verdict: "unreachable",
      status: null,
      started,
      message_ru: reachMessage(host, failed.at(-1) as HostReach, failed.length),
    });
    return false;
  }
  const route =
    r.via === "proxy"
      ? "через прокси HTTPS_PROXY"
      : `напрямую, ${r.family ?? "адрес"}, адресов в DNS: ${r.addresses}`;
  const flaky = failed.length
    ? `; до этого ${failed.length} из ${failed.length + 1} попыток не прошли: ${[...new Set(failed.map((f) => reachCause(host, f)))].join("; ")}`
    : "";
  record(run, {
    step: "host",
    level: failed.length ? "warning" : "notice",
    verdict: "ok",
    status: null,
    started,
    message_ru: `${host} доступен (${route}; TCP и TLS за ${r.ms} мс)${flaky}; ключ — ${account_ru}`,
  });
  return true;
}

function refuse(run: Run, step: string, message_ru: string): void {
  record(run, { step, level: "error", verdict: "refused", status: null, started: run.clock(), message_ru });
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const env = (o: SandboxOptions, name: string) => (o.env[name] ?? "").trim();

// ------------------------------------------------------------------------------------------------ СДЭК

/**
 * The token of client credentials, as the platform's own tools request it (passportTokenRequest: form body) — a
 * diagnosis next to the runtime's exchange: the answer's shape and lifetime, and, when the form is refused, whether
 * СДЭК wants the parameters in the query string (as in its examples).
 */
async function cdekToken(run: Run, fields: Record<string, string>): Promise<void> {
  const req = passportTokenRequest(cdek, fields, { sandbox: true });
  if (!req) return;
  const host = new URL(req.url).hostname;
  const client = egressHttpClient({
    fn: "sandbox_token:cdek",
    hosts: [host],
    platformDomains: run.net.platformDomains ?? platformDomains(process.env),
    secretNames: [],
    secrets: staticSecretReader({}),
    transport: run.egress,
    limits: { requestsPerCall: 2 * SANDBOX_ATTEMPTS },
    minuteGate: () => true,
    log: () => {},
  });
  const started = run.clock();
  const failures: string[] = [];
  // A token request is safe to repeat; a transport failure is retried like the operations.
  const send = async (url: string, body: string | undefined) => {
    for (let i = 0; ; i++) {
      if (i > 0) await run.sleep(RETRY_PAUSE_MS);
      try {
        const r = await client.fetch(url, {
          method: "POST",
          headers: body ? req.headers : { Accept: "application/json" },
          ...(body ? { body } : {}),
        });
        return { status: r.status, text: await r.text() };
      } catch (e) {
        failures.push(errorText(e));
        if (i + 1 >= SANDBOX_ATTEMPTS) throw e;
      }
    }
  };
  const answer = (r: { status: number; text: string }) => {
    const t = r.status >= 200 && r.status < 300 ? passportTokenValue(r.text) : null;
    if (t) run.masks.push(t.value);
    return t;
  };
  let r: { status: number; text: string };
  try {
    r = await send(req.url, req.body);
  } catch (e) {
    record(run, {
      step: "token",
      level: "error",
      verdict: "failed",
      status: null,
      started,
      message_ru: `токен не запрошен за ${SANDBOX_ATTEMPTS} попытки: ${[...new Set(failures)].join("; ") || errorText(e)}; ${await diagnose(run)}`,
    });
    return;
  }
  const t = answer(r);
  if (t) {
    const j = parseJson(r.text);
    const names =
      j.ok && j.value && typeof j.value === "object"
        ? Object.keys(j.value).filter((k) => k !== "access_token" && NAME_RE.test(k))
        : [];
    const ttl = cdek.key.token?.ttlSeconds ?? 3600;
    record(run, {
      step: "token",
      level: "notice",
      verdict: "ok",
      status: r.status,
      started,
      message_ru: `токен OAuth выдан (${r.status}, параметры в теле x-www-form-urlencoded): живёт ${t.expiresIn} с${Math.abs(t.expiresIn - ttl) > 60 ? `, в паспорте ${ttl} с` : ""}; поля ответа: ${names.join(", ") || "только access_token"}${retriesText(failures)}`,
    });
    return;
  }
  const err = providerError(r.text);
  // The documented form of СДЭК: the same parameters in the query string of the POST.
  let q: { status: number; text: string } | null = null;
  try {
    q = await send(`${req.url}?${req.body ?? ""}`, undefined);
  } catch {
    q = null;
  }
  if (q && answer(q))
    record(run, {
      step: "token",
      level: "error",
      verdict: "mismatch",
      status: r.status,
      started,
      message_ru: `токен выдан только с параметрами в строке запроса; с телом x-www-form-urlencoded — ${r.status}${err ? ` (${err})` : ""}. Рантайм (egress-fetch, accessToken) шлёт их в теле — поправить рантайм и passportTokenRequest`,
    });
  else
    record(run, {
      step: "token",
      level: "error",
      verdict: "failed",
      status: r.status,
      started,
      message_ru: `токен не выдан: ${r.status}${err ? ` (${err})` : ""}; в строке запроса — ${q?.status ?? "запрос не выполнен"}`,
    });
}

async function runCdek(run: Run, o: SandboxOptions): Promise<void> {
  const account = env(o, SANDBOX_ENV.cdekAccount);
  const secure = env(o, SANDBOX_ENV.cdekSecure);
  run.masks.push(account, secure, CDEK_PUBLIC_TEST_ACCOUNT.account, CDEK_PUBLIC_TEST_ACCOUNT.secure);
  if (!account !== !secure) {
    refuse(
      run,
      "keys",
      `задан только один из секретов ${SANDBOX_ENV.cdekAccount} и ${SANDBOX_ENV.cdekSecure}: нужны оба или ни одного (тогда — общая тестовая учётная запись из документации СДЭК); запросы не отправлялись`,
    );
    return;
  }
  const own = account !== "";
  const fields = {
    client_id: own ? account : CDEK_PUBLIC_TEST_ACCOUNT.account,
    client_secret: own ? secure : CDEK_PUBLIC_TEST_ACCOUNT.secure,
  };
  const key = passportKey(cdek, fields, { sandbox: true });
  if (!key.ok) {
    refuse(run, "keys", `ключ СДЭК не собран: ${key.problems_ru.join("; ")}; запросы не отправлялись`);
    return;
  }
  run.masks.push(key.value, key.value.slice("oauth2cc:".length));
  const name = run.contract.auth.secret?.slice("secret://".length) ?? "cdek_key";
  run.secrets = staticSecretReader({ [name]: key.value });
  if (
    !(await hostStep(run, own ? "секреты CDEK_TEST_*" : "общая тестовая учётная запись из документации СДЭК"))
  )
    return;
  await cdekToken(run, fields);
  const check = await checkStep(run);
  if (!check.usable) return;
  const example = (opId: string) => operationOf(run.contract, opId).body?.schema.example;
  await runOp(run, "calculateTariff", { body: example("calculateTariff") });
  const list = await runOp(run, "calculateTariffList", { body: example("calculateTariffList") });
  const points = await runOp(run, "listDeliveryPoints", {
    cityCode: 44,
    type: "PVZ",
    countryCode: "RU",
    size: 5,
    page: 0,
  });
  await runOp(run, "listWebhooks", {});
  if (o.cdekOrder) await cdekOrder(run, o, list.value, points.value);
}

type TariffItem = { tariff_code?: unknown; delivery_mode?: unknown };
type PointItem = { code?: unknown; is_reception?: unknown };

/**
 * A test order in the educational contour only: склад-дверь from a reception point of the answer (or дверь-дверь),
 * read back, then deleted. Fictitious recipient, «оплачено» items.
 */
async function cdekOrder(run: Run, o: SandboxOptions, tariffs: unknown, points: unknown): Promise<void> {
  const host = new URL(run.contract.baseUrl).hostname;
  if (!cdek.sandboxBaseUrl || host !== new URL(cdek.sandboxBaseUrl).hostname) {
    refuse(
      run,
      "createOrder",
      `тестовый заказ создаётся только в учебном контуре, а контракт смотрит в ${host}`,
    );
    return;
  }
  const list = ((tariffs as { tariff_codes?: unknown })?.tariff_codes ?? []) as TariffItem[];
  const pvz = (Array.isArray(points) ? (points as PointItem[]) : []).find(
    (p) => typeof p.code === "string" && p.is_reception !== false,
  );
  const toDoor = list.find((t) => t.delivery_mode === 3 && typeof t.tariff_code === "number");
  const doorDoor = list.find((t) => t.delivery_mode === 1 && typeof t.tariff_code === "number");
  const tariff = pvz && toDoor ? toDoor : doorDoor;
  if (!tariff) {
    record(run, {
      step: "createOrder",
      level: "warning",
      verdict: "skipped",
      status: null,
      started: run.clock(),
      message_ru:
        "тестовый заказ не создан: в ответе calculateTariffList нет тарифа склад-дверь или дверь-дверь",
    });
    return;
  }
  const fromWarehouse = tariff === toDoor;
  const body = {
    type: 1,
    number: `wz-sandbox-${o.runId ?? run.clock().toString(36)}`.slice(0, 40),
    tariff_code: tariff.tariff_code,
    comment: "Проверка паспорта Wizard в учебном контуре",
    ...(fromWarehouse
      ? { shipment_point: (pvz as PointItem).code }
      : { from_location: { code: 44, address: "ул. Тверская, 1" } }),
    to_location: { code: 137, address: "Невский пр., 1" },
    recipient: { name: "Покупатель Тестовый", phones: [{ number: "+70001234567" }] },
    packages: [
      {
        number: "1",
        weight: 1500,
        length: 30,
        width: 20,
        height: 10,
        items: [
          {
            name: "Тестовый товар",
            ware_key: "WZ-TEST-1",
            payment: { value: 0 },
            cost: 100,
            weight: 1500,
            amount: 1,
          },
        ],
      },
    ],
  };
  // A failed attempt may still have reached СДЭК: before sending the order again, look it up by its number.
  let found: string | null = null;
  const missing = async () => {
    try {
      const r = await callTransport(run)(buildRequest(run.contract, "findOrder", { imNumber: body.number }));
      const id = (parseJson(r.text) as { value?: { entity?: { uuid?: unknown } } }).value?.entity?.uuid;
      if (r.status >= 200 && r.status < 300 && typeof id === "string") found = id;
    } catch {
      return false;
    }
    return found === null;
  };
  const created = await runOp(run, "createOrder", { body }, { retryIf: missing });
  if (found)
    created.step.message_ru += "; заказ при этом создан (нашёлся по номеру) — повторно не отправлялся";
  const uuid = (created.value as { entity?: { uuid?: unknown } } | undefined)?.entity?.uuid ?? found;
  if (typeof uuid !== "string") return;
  // The order is created asynchronously: give СДЭК a moment before reading it back.
  await run.sleep(2000);
  const got = await runOp(run, "getOrder", { uuid });
  const order = got.value as
    | {
        entity?: { cdek_number?: unknown; statuses?: { code?: unknown; date_time?: unknown }[] };
        requests?: { state?: unknown; errors?: unknown }[];
      }
    | undefined;
  const reqs = order?.requests;
  const state = reqs?.find((q) => typeof q?.state === "string")?.state;
  if (order) {
    // What the passport's verify_ru asks about: the type of cdek_number and the order of statuses.
    const cn = order.entity?.cdek_number;
    const statuses = (Array.isArray(order.entity?.statuses) ? order.entity.statuses : [])
      .slice(0, 4)
      .map((st) => `${String(st?.code).slice(0, 30)} ${String(st?.date_time).slice(0, 30)}`);
    const err = reqs ? providerError(JSON.stringify({ requests: reqs })) : null;
    got.step.message_ru += maskText(
      `${typeof state === "string" ? `; состояние запроса: ${state}${err ? ` (${err})` : ""}` : ""}; cdek_number: ${cn === undefined ? "нет" : cn === null ? "null" : typeof cn === "string" ? "строка" : typeof cn}; statuses как пришли: ${statuses.join(" → ") || "нет"}`,
      run.masks,
    );
  }
  await runOp(run, "findOrder", { imNumber: body.number });
  await runOp(run, "deleteOrder", { uuid });
}

// ------------------------------------------------------------------------------------------------ ЮKassa

async function runYookassa(run: Run, o: SandboxOptions): Promise<void> {
  const shop = env(o, SANDBOX_ENV.kassaShop);
  const secret = env(o, SANDBOX_ENV.kassaKey);
  run.masks.push(shop, secret);
  if (!shop && !secret) {
    record(run, {
      step: "keys",
      level: "warning",
      verdict: "skipped",
      status: null,
      started: run.clock(),
      message_ru: `нет тестового магазина: создайте его в личном кабинете ЮKassa и положите ключи в секреты ${SANDBOX_ENV.kassaShop} и ${SANDBOX_ENV.kassaKey} (Settings → Secrets and variables → Actions); проверка ЮKassa пропущена`,
    });
    return;
  }
  if (!shop || !secret) {
    refuse(
      run,
      "keys",
      `задан только один из секретов ${SANDBOX_ENV.kassaShop} и ${SANDBOX_ENV.kassaKey} — нужны оба; запросы не отправлялись`,
    );
    return;
  }
  if (!secret.startsWith("test_")) {
    refuse(
      run,
      "keys",
      `${SANDBOX_ENV.kassaKey} — не ключ тестового магазина (должен начинаться с test_): с боевым ключом проверка не запускается, запросы не отправлялись`,
    );
    return;
  }
  const key = passportKey(yookassa, { shop_id: shop, secret_key: secret });
  if (!key.ok || key.test !== true) {
    refuse(
      run,
      "keys",
      `ключ ЮKassa не собран: ${key.ok ? "ключ не тестовый" : key.problems_ru.join("; ")}; запросы не отправлялись`,
    );
    return;
  }
  run.masks.push(key.value, key.value.replace(/^Basic /, ""));
  const name = run.contract.auth.secret?.slice("secret://".length) ?? "yookassa_key";
  run.secrets = staticSecretReader({ [name]: key.value });
  if (!(await hostStep(run, `тестовый магазин (секреты ${SANDBOX_ENV.kassaShop}, ${SANDBOX_ENV.kassaKey})`)))
    return;
  const check = await checkStep(run);
  if (!check.usable) return;
  const me = (check.value ?? {}) as { test?: unknown; fiscalization_enabled?: unknown };
  if (me.test !== true) {
    refuse(
      run,
      "createPayment",
      "магазин по ответу GET /me не тестовый (test ≠ true) — платежи не создаём, остальные операции пропущены",
    );
    return;
  }
  const amount = { value: "1.00", currency: "RUB" };
  const body = {
    amount,
    capture: false,
    description: "Проверка паспорта Wizard: тестовый платёж",
    confirmation: { type: "redirect", return_url: "https://example.com/wizard-sandbox" },
    metadata: { order_id: `wz-sandbox-${o.runId ?? run.clock().toString(36)}` },
    // A test shop with 54-ФЗ receipts on refuses a payment without a receipt.
    ...(me.fiscalization_enabled === true
      ? {
          receipt: {
            customer: { email: "sandbox@example.com" },
            items: [
              {
                description: "Проверка интеграции",
                quantity: 1,
                amount,
                vat_code: 1,
                payment_mode: "full_payment",
                payment_subject: "service",
              },
            ],
          },
        }
      : {}),
  };
  const idem = randomUUID();
  const created = await runOp(run, "createPayment", { idempotenceKey: idem, body });
  const id = (created.value as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string") return;
  const again = await runOp(
    run,
    "createPayment",
    { idempotenceKey: idem, body },
    { label: "createPayment (повтор)" },
  );
  const againId = (again.value as { id?: unknown } | undefined)?.id;
  if (again.step.verdict === "ok" || again.step.verdict === "mismatch") {
    if (againId === id) again.step.message_ru += "; повтор с тем же Idempotence-Key вернул тот же платёж";
    else {
      again.step.level = "error";
      again.step.verdict = "mismatch";
      again.step.message_ru += "; повтор с тем же Idempotence-Key вернул другой платёж";
    }
  }
  const got = await runOp(run, "getPayment", { paymentId: id });
  await runOp(run, "listPayments", { limit: 1 });
  const status =
    (got.value as { status?: unknown } | undefined)?.status ??
    (created.value as { status?: unknown } | undefined)?.status;
  if (status === "waiting_for_capture")
    await runOp(run, "cancelPayment", { paymentId: id, idempotenceKey: randomUUID() });
  else
    record(run, {
      step: "cancelPayment",
      level: "notice",
      verdict: "skipped",
      status: null,
      started: run.clock(),
      message_ru: `платёж в статусе ${typeof status === "string" ? status : "неизвестно"}: отмена в ЮKassa — только для waiting_for_capture; неоплаченный тестовый платёж истечёт сам`,
    });
}

// ------------------------------------------------------------------------------------------------ entry points

/** Passports of a CLI argument: all (or empty) — every one with a test contour; ids separated by commas. */
export function parsePassports(
  raw: string,
): { ok: true; ids: SandboxPassportId[] } | { ok: false; error_ru: string } {
  const words = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (words.length === 0 || words.includes("all")) return { ok: true, ids: [...SANDBOX_PASSPORTS] };
  const ids: SandboxPassportId[] = [];
  for (const w of words) {
    if ((SANDBOX_PASSPORTS as readonly string[]).includes(w)) {
      if (!ids.includes(w as SandboxPassportId)) ids.push(w as SandboxPassportId);
      continue;
    }
    const p = passportById(w);
    const names = SANDBOX_PASSPORTS.map((id) => passportById(id)?.name ?? id).join(", ");
    return {
      ok: false,
      error_ru: p
        ? `у паспорта «${p.name}» нет тестового контура: проверяются только ${names}`
        : `неизвестный паспорт «${w.slice(0, 40)}»: есть ${SANDBOX_PASSPORTS.join(", ")} или all`,
    };
  }
  return { ok: true, ids };
}

/** The check of every chosen passport on its test contour (СДЭК first). Never throws for a provider's answer. */
export async function runSandboxCheck(o: SandboxOptions): Promise<SandboxReport> {
  const report: SandboxStep[] = [];
  const net = o.net ?? {};
  const egress = sandboxTransport(net);
  const clock = o.clock ?? Date.now;
  for (const id of SANDBOX_PASSPORTS.filter((p) => o.passports.includes(p))) {
    const passport = id === "cdek" ? cdek : yookassa;
    const run: Run = {
      id,
      passport,
      contract: passportContract(passport, { sandbox: id === "cdek" }),
      secrets: staticSecretReader({}),
      egress,
      net,
      report,
      masks: [],
      clock,
      sleep: o.sleep ?? sleepMs,
    };
    try {
      if (id === "cdek") await runCdek(run, o);
      else await runYookassa(run, o);
    } catch (e) {
      record(run, {
        step: "run",
        level: "error",
        verdict: "failed",
        status: null,
        started: clock(),
        message_ru: `проверка прервалась: ${errorText(e)}`,
      });
    }
  }
  return { ok: report.every((s) => s.level !== "error"), steps: report };
}

const NAMES: Record<SandboxPassportId, string> = { cdek: cdek.name, yookassa: yookassa.name };

const escData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s: string) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** The line of a step: its message and up to 5 problems. */
function lineOf(s: SandboxStep): string {
  const shown = s.problems.slice(0, 5).join("; ");
  const more = s.problems.length > 5 ? `; и ещё ${s.problems.length - 5}` : "";
  return `${s.message_ru}${shown ? ` — ${shown}${more}` : ""}`.replace(/[\r\n]+/g, " ").slice(0, 1500);
}

/** GitHub annotations, one line per step; above 10 of a level (GitHub's cap per step) the rest share the 10th line. */
export function sandboxAnnotations(report: SandboxReport): string[] {
  const by = new Map<SandboxLevel, SandboxStep[]>();
  for (const s of report.steps) by.set(s.level, [...(by.get(s.level) ?? []), s]);
  const out: string[] = [];
  for (const s of report.steps) {
    const same = by.get(s.level) ?? [];
    const i = same.indexOf(s);
    if (i > 9) continue;
    const title = `${NAMES[s.passport]} · ${s.step}`;
    if (i === 9 && same.length > 10) {
      const rest = same.slice(9).map((x) => `${NAMES[x.passport]} · ${x.step}: ${lineOf(x)}`);
      out.push(
        `::${s.level} title=${escProp(`${title} и ещё ${same.length - 10}`)}::${escData(rest.join(" | ").slice(0, 3000))}`,
      );
      continue;
    }
    out.push(`::${s.level} title=${escProp(title)}::${escData(lineOf(s))}`);
  }
  return out;
}

const VERDICT_RU: Record<SandboxVerdict, string> = {
  ok: "совпал",
  mismatch: "расхождение",
  failed: "ошибка",
  unreachable: "хост недоступен",
  skipped: "пропущен",
  refused: "отказ",
};

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

/** Markdown of the step summary: a table of the steps and the mismatches in full. */
export function sandboxSummary(report: SandboxReport): string {
  const lines = [
    "## Паспорта API на тестовых контурах (V3-22)",
    "",
    report.ok ? "Ошибок нет." : "Есть ошибки — подробности в строках ниже.",
    "",
    "| Паспорт | Шаг | Итог | Статус | мс | Подробности |",
    "|---|---|---|---|---|---|",
    ...report.steps.map(
      (s) =>
        `| ${NAMES[s.passport]} | ${cell(s.step)} | ${VERDICT_RU[s.verdict]} | ${s.status ?? "—"} | ${s.ms} | ${cell(s.message_ru)} |`,
    ),
  ];
  const bad = report.steps.filter((s) => s.problems.length);
  if (bad.length) {
    lines.push("", "### Расхождения с паспортом", "");
    for (const s of bad) {
      lines.push(`**${NAMES[s.passport]} · ${cell(s.step)}**`, "");
      for (const p of s.problems) lines.push(`- \`${p.replace(/`/g, "'")}\``);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}
