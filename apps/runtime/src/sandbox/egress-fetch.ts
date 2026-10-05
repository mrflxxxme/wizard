// ctx.http.fetch of system functions (M2-52, D71; sdk.md §2, security/isolation.yaml#M2.network). The guest (workerd
// or the unsafe-local child) has no network: it asks the runtime over RPC, and the runtime makes the request here —
// https only, port 443, only hosts the spec declares for the function (functions[].egress, any public host except the
// platform's own and internal names), through the egress proxy (CONNECT with a short-lived grant; the proxy re-checks
// the host and every resolved address, SNI = CONNECT host) or, without a proxy (local runs), directly after the same
// address check, dialing the checked IP (no second lookup: DNS rebinding). Redirects are not followed. Secrets enter
// only as `secret://name` in header values or the query string and are resolved here, so function code never sees
// them. Limits: requests per call and per minute per system, request and response size, time. Every attempt is
// journaled (_w_egress_log) with host, method, status, sizes — no path, query, headers or bodies.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { isIP, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import {
  type Dialer,
  egressHostProblem,
  isPrivateAddress,
  parseSecretRef,
  type Resolver,
  type SecretReader,
  systemResolver,
  tcpDialer,
} from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";

export interface EgressLimits {
  /** ctx.http.fetch calls in one function call. */
  requestsPerCall: number;
  /** Requests per minute per system (all functions, this runtime process). */
  requestsPerMinute: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  /** One deadline per request from its start: DNS, connect, TLS, sending and the whole response. */
  timeoutMs: number;
}

export const DEFAULT_EGRESS_LIMITS: EgressLimits = {
  requestsPerCall: 10,
  requestsPerMinute: 60,
  maxRequestBytes: 256 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
  timeoutMs: 10_000,
};

/** Request methods a function may use. */
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
/** Headers the runtime sets itself or that steer the proxy/connection: a function may not send them. */
const FORBIDDEN_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "keep-alive",
  "expect",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
  "cookie",
]);
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const SECRET_IN_TEXT_RE = /secret:\/\/[a-z0-9_]+/g;

/** Refusal before any connection (wrong scheme, host, address): EGRESS_FORBIDDEN. */
export class EgressRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Text of EGRESS_FORBIDDEN by the refusal reason of a transport. */
const REFUSED_RU: Record<string, string> & { proxy_denied: string } = {
  address_not_public: "Адрес сервера указывает во внутреннюю сеть — запрос запрещён",
  proxy_denied:
    "Прокси платформы запретил запрос: хост не разрешён функции или его адрес указывает во внутреннюю сеть",
  proxy_unauthorized: "Прокси платформы не подтвердил разрешение на запрос — попробуйте ещё раз",
};

/** Opens TLS to `host`:443 with SNI = host (the transport decides how the bytes leave the cluster). */
export interface EgressTransport {
  connect(host: string, timeoutMs: number): Promise<TLSSocket>;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error("timeout"));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function tlsOver(socket: Socket | undefined, host: string, ca?: string, ip?: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({
      ...(socket ? { socket } : { host: ip ?? host, port: 443 }),
      servername: host,
      ...(ca ? { ca } : {}),
      ALPNProtocols: ["http/1.1"],
    });
    s.once("secureConnect", () => resolve(s));
    s.once("error", reject);
  });
}

/**
 * Through the egress proxy (security/isolation.yaml#M2.network): CONNECT host:443 with `Proxy-Authorization: Bearer
 * <grant>`; any answer but 200 is a refusal (403/407) or a failure (502). TLS (SNI = host) runs inside the tunnel.
 */
export function proxyTransport(o: {
  /** http://wizard-egress-proxy:3128 */
  proxyUrl: string;
  /** Grant of the call for this host (the proxy asks the runtime's internal port about it). */
  grant: (host: string) => string;
  dial?: Dialer;
  ca?: string;
}): EgressTransport {
  const u = new URL(o.proxyUrl);
  const dial = o.dial ?? tcpDialer;
  return {
    async connect(host, timeoutMs) {
      const grant = o.grant(host);
      let raw: Socket | undefined;
      const work = (async () => {
        raw = await dial({ host: u.hostname, port: Number(u.port || 3128) });
        const socket = raw;
        const status = await new Promise<number>((resolve, reject) => {
          let buf = Buffer.alloc(0);
          const onData = (b: Buffer) => {
            buf = Buffer.concat([buf, b]);
            const end = buf.indexOf("\r\n\r\n");
            if (end < 0) {
              if (buf.length > 4096) reject(new Error("proxy_header"));
              return;
            }
            socket.off("data", onData);
            const rest = buf.subarray(end + 4);
            if (rest.length) socket.unshift(rest);
            resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf.toString("latin1"))?.[1] ?? 0));
          };
          socket.on("data", onData);
          socket.once("error", reject);
          socket.once("close", () => reject(new Error("proxy_closed")));
          socket.write(
            `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: Bearer ${grant}\r\n\r\n`,
          );
        });
        // 407: the grant was not accepted; 403: the host or its resolved address is not allowed.
        if (status === 407) throw new EgressRefused("proxy_unauthorized");
        if (status === 403) throw new EgressRefused("proxy_denied");
        if (status !== 200) throw new Error(`proxy_${status}`);
        socket.removeAllListeners("close");
        socket.removeAllListeners("error");
        return tlsOver(socket, host, o.ca);
      })();
      return withTimeout(work, timeoutMs, () => raw?.destroy());
    },
  };
}

/**
 * Without a proxy (local runs, tests): resolve once, every address must be public (unless `allowPrivate`, tests only),
 * then dial the checked IP with SNI = host — the name is never looked up again.
 */
export function directTransport(
  o: { resolve?: Resolver; ca?: string; allowPrivate?: boolean; port?: number } = {},
): EgressTransport {
  const resolve = o.resolve ?? systemResolver;
  return {
    async connect(host, timeoutMs) {
      let sock: TLSSocket | undefined;
      let late = false;
      // The DNS lookup counts against the same deadline as the TLS handshake.
      const work = (async () => {
        let addrs: string[];
        try {
          addrs = await resolve(host);
        } catch {
          throw new Error("dns");
        }
        if (addrs.length === 0) throw new Error("dns");
        if (!o.allowPrivate && addrs.some((a) => isPrivateAddress(a)))
          throw new EgressRefused("address_not_public");
        if (late) throw new Error("timeout");
        const ip = addrs[0] as string;
        return await new Promise<TLSSocket>((resolveSock, reject) => {
          const s = tlsConnect({
            host: ip,
            port: o.port ?? 443,
            servername: isIP(host) ? "" : host,
            ...(o.ca ? { ca: o.ca } : {}),
            ALPNProtocols: ["http/1.1"],
          });
          sock = s;
          s.once("secureConnect", () => resolveSock(s));
          s.once("error", reject);
        });
      })();
      work.catch(() => {});
      return withTimeout(work, timeoutMs, () => {
        late = true;
        sock?.destroy();
      });
    },
  };
}

/** One line of _w_egress_log. */
export interface EgressLogEntry {
  fn: string;
  host: string;
  method: string;
  status: number | null;
  /** ok | forbidden | rate_limited | limit | too_large | timeout | failed */
  outcome: string;
  bytesOut: number;
  bytesIn: number;
  durationMs: number;
}

export interface EgressClientOptions {
  /** Function name (journal). */
  fn: string;
  /** Hosts the spec declares for this function (functions[].egress). */
  hosts: readonly string[];
  /** Platform domains a system never calls (connectors platformDomains()). */
  platformDomains: readonly string[];
  /** Secrets the function may reference (functions[].secretRefs). */
  secretNames: readonly string[];
  secrets: SecretReader;
  transport: EgressTransport;
  limits?: Partial<EgressLimits>;
  /** Per-system minute limiter shared by all calls; false — over the limit. */
  minuteGate: () => boolean;
  log: (e: EgressLogEntry) => void | Promise<void>;
}

export interface EgressResponse {
  status: number;
  ok: boolean;
  contentType: string | null;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

const forbidden = (message: string) => new WizardError("EGRESS_FORBIDDEN", { message });

async function resolveSecrets(text: string, o: EgressClientOptions): Promise<string> {
  const names = [...new Set(text.match(SECRET_IN_TEXT_RE) ?? [])];
  let out = text;
  for (const ref of names) {
    const name = parseSecretRef(ref);
    if (!name || !o.secretNames.includes(name))
      throw forbidden(`Секрет ${ref} не объявлен в secretRefs функции`);
    let value: string;
    try {
      value = await o.secrets.get(name);
    } catch {
      throw new WizardError("EGRESS_FAILED", { message: `Секрет ${ref} не задан` });
    }
    if (/[\r\n\0]/.test(value))
      throw new WizardError("EGRESS_FAILED", { message: `Секрет ${ref} задан неверно` });
    out = out.split(ref).join(value);
  }
  return out;
}

/** HttpClient of one function call (sdk.md: ctx.http.fetch). */
export function egressHttpClient(o: EgressClientOptions): {
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<EgressResponse>;
} {
  const limits: EgressLimits = { ...DEFAULT_EGRESS_LIMITS, ...o.limits };
  const allowed = new Set(
    o.hosts.map((h) => h.toLowerCase()).filter((h) => egressHostProblem(h, o.platformDomains) === null),
  );
  let used = 0;

  return {
    async fetch(rawUrl, init = {}) {
      const started = Date.now();
      const method = String(init.method ?? "GET").toUpperCase();
      let host = "";
      const entry = async (outcome: string, extra: Partial<EgressLogEntry> = {}) =>
        await o.log({
          fn: o.fn,
          host: host || "-",
          method: METHODS.has(method) ? method : "OTHER",
          status: null,
          outcome,
          bytesOut: 0,
          bytesIn: 0,
          durationMs: Date.now() - started,
          ...extra,
        });
      let url: URL;
      try {
        url = new URL(String(rawUrl));
      } catch {
        await entry("forbidden");
        throw forbidden("Неверный адрес запроса");
      }
      host = url.hostname.toLowerCase().replace(/\.$/, "");
      if (
        url.protocol !== "https:" ||
        (url.port !== "" && url.port !== "443") ||
        url.username ||
        url.password
      ) {
        await entry("forbidden");
        throw forbidden("Внешние запросы — только https на стандартный порт");
      }
      if (!allowed.has(host)) {
        await entry("forbidden");
        throw forbidden(`Хост ${host} не объявлен в egress функции`);
      }
      if (!METHODS.has(method)) {
        await entry("forbidden");
        throw forbidden("Недопустимый метод запроса");
      }
      used += 1;
      if (used > limits.requestsPerCall) {
        await entry("limit");
        throw new WizardError("LIMIT_EXCEEDED", {
          message: `Не больше ${limits.requestsPerCall} внешних запросов за вызов`,
          limit: "http_requests",
        });
      }
      if (!o.minuteGate()) {
        await entry("rate_limited");
        throw new WizardError("RATE_LIMITED", {
          message: "Слишком много внешних запросов, попробуйте позже",
        });
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(init.headers ?? {})) {
        const name = k.toLowerCase();
        if (!HEADER_NAME_RE.test(k) || FORBIDDEN_HEADERS.has(name) || name.startsWith("proxy-")) {
          await entry("forbidden");
          throw forbidden(`Заголовок ${k} задаёт платформа`);
        }
        if (typeof v !== "string" || /[\r\n\0]/.test(v)) {
          await entry("forbidden");
          throw forbidden(`Неверное значение заголовка ${k}`);
        }
        headers[name] = await resolveSecrets(v, o);
      }
      const path = await resolveSecrets(`${url.pathname}${url.search}`, o);
      const body =
        init.body === undefined || init.body === null ? null : Buffer.from(String(init.body), "utf8");
      if (body && body.length > limits.maxRequestBytes) {
        await entry("too_large", { bytesOut: body.length });
        throw new WizardError("PAYLOAD_TOO_LARGE", { message: "Слишком большой исходящий запрос" });
      }
      headers.host = host;
      headers.connection = "close";
      if (body) headers["content-length"] = String(body.length);
      if (!headers["user-agent"]) headers["user-agent"] = "Wizard-System/1";
      // One deadline for the whole request (connect, TLS, sending, every byte of the answer): a server that keeps
      // the socket busy with a byte now and then is cut at timeoutMs from the start, not only after an idle gap.
      const left = () => Math.max(1, limits.timeoutMs - (Date.now() - started));
      let socket: TLSSocket;
      try {
        socket = await o.transport.connect(host, left());
      } catch (e) {
        if (e instanceof EgressRefused) {
          await entry("forbidden");
          throw forbidden(REFUSED_RU[e.reason] ?? REFUSED_RU.proxy_denied);
        }
        await entry(String((e as Error)?.message) === "timeout" ? "timeout" : "failed");
        throw new WizardError("EGRESS_FAILED", { message: "Внешний сервис недоступен" });
      }
      let deadline: NodeJS.Timeout | undefined;
      try {
        const res = await new Promise<{ status: number; type: string | null; buf: Buffer }>(
          (resolve, reject) => {
            const req = httpRequest(
              {
                method,
                path,
                headers,
                setHost: false,
                // No agent: the request uses exactly this socket (checked host, SNI) and closes it afterwards.
                createConnection: () => socket,
              },
              (r: IncomingMessage) => {
                const chunks: Buffer[] = [];
                let size = 0;
                r.on("data", (b: Buffer) => {
                  size += b.length;
                  if (size > limits.maxResponseBytes) {
                    req.destroy(new Error("too_large"));
                    return;
                  }
                  chunks.push(b);
                });
                r.on("end", () =>
                  resolve({
                    status: r.statusCode ?? 0,
                    type: typeof r.headers["content-type"] === "string" ? r.headers["content-type"] : null,
                    buf: Buffer.concat(chunks),
                  }),
                );
                r.on("error", reject);
              },
            );
            deadline = setTimeout(() => {
              req.destroy(new Error("timeout"));
              socket.destroy();
              reject(new Error("timeout"));
            }, left());
            req.on("error", reject);
            req.end(body ?? undefined);
          },
        );
        clearTimeout(deadline);
        await entry("ok", { status: res.status, bytesOut: body?.length ?? 0, bytesIn: res.buf.length });
        const text = res.buf.toString("utf8");
        return {
          status: res.status,
          ok: res.status >= 200 && res.status < 300,
          contentType: res.type,
          text: async () => text,
          json: async () => {
            try {
              return JSON.parse(text) as unknown;
            } catch {
              throw new WizardError("EGRESS_FAILED", { message: "Ответ внешнего сервиса — не JSON" });
            }
          },
        };
      } catch (e) {
        clearTimeout(deadline);
        socket.destroy();
        const why = String((e as Error)?.message);
        if (why === "too_large") {
          await entry("too_large", { bytesOut: body?.length ?? 0 });
          throw new WizardError("LIMIT_EXCEEDED", {
            message: `Ответ внешнего сервиса больше ${Math.round(limits.maxResponseBytes / 1024)} КБ`,
            limit: "http_response",
          });
        }
        await entry(why === "timeout" ? "timeout" : "failed", { bytesOut: body?.length ?? 0 });
        throw new WizardError("EGRESS_FAILED", {
          message: why === "timeout" ? "Внешний сервис отвечал слишком долго" : "Внешний сервис недоступен",
        });
      }
    },
  };
}

/** Fixed one-minute windows per key (system), per runtime process. */
export class MinuteWindows {
  private readonly windows = new Map<string, { w: number; n: number }>();
  constructor(private readonly clock: () => number = Date.now) {}
  take(key: string, limit: number): boolean {
    const w = Math.floor(this.clock() / 60_000);
    const hit = this.windows.get(key);
    if (!hit || hit.w !== w) {
      if (this.windows.size > 10_000) this.windows.clear();
      this.windows.set(key, { w, n: 1 });
      return true;
    }
    hit.n += 1;
    return hit.n <= limit;
  }
}
