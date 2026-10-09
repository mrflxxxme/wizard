// ctx.http.fetch of system functions (M2-52, D71; sdk.md §2, security/isolation.yaml#M2.network). The guest (workerd
// or the unsafe-local child) has no network: it asks the runtime over RPC, and the runtime makes the request here —
// https only, port 443, only hosts the spec declares for the function (functions[].egress, any public host except the
// platform's own and internal names), through the egress proxy (CONNECT with a short-lived grant; the proxy re-checks
// the host and every resolved address, SNI = CONNECT host) or, without a proxy (local runs), directly after the same
// address check, dialing the checked IP (no second lookup: DNS rebinding). Redirects are not followed. Secrets enter
// only as `secret://name` in header values, the path or the query string and are resolved here, so code never sees
// them; an OAuth client-credentials secret becomes an access token of its own host, cached in this process (V3-22).
// Answers are decoded (gzip, deflate, br) with the response cap on the decoded size too. Limits: requests per call and
// per minute per system, request and response size, time. Every attempt is journaled (_w_egress_log) with host,
// method, status, sizes — no path, query, headers or bodies.
import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { isIP, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { brotliDecompress, gunzip, inflate, inflateRaw } from "node:zlib";
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
  /** Access tokens of OAuth client-credentials secrets (default: the one cache of this runtime process). */
  tokens?: OAuthTokenCache;
}

export interface EgressResponse {
  status: number;
  ok: boolean;
  contentType: string | null;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

const forbidden = (message: string) => new WizardError("EGRESS_FORBIDDEN", { message });

// ------------------------------------------------------------------------------------------------ compressed answers

/**
 * Content codings the runtime asks for and undoes (V3-22: МойСклад answers only compressed). A function may send its own
 * Accept-Encoding, but only of these codings (and identity), so every answer it gets is one the runtime can decode.
 */
export const EGRESS_ACCEPT_ENCODING = "gzip, deflate, br";
const CODING = String.raw`(?:gzip|deflate|br|identity)(?:\s*;\s*q=(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?))?`;
const ACCEPT_ENCODING_RE = new RegExp(String.raw`^\s*${CODING}(?:\s*,\s*${CODING})*\s*$`, "i");

type ZlibCallback = (e: Error | null, out: Buffer) => void;

function decodeOne(coding: string, buf: Buffer, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done: ZlibCallback = (e, out) => (e ? reject(e) : resolve(out));
    // maxOutputLength stops inflating at the cap: a small bomb never grows into memory.
    if (coding === "gzip" || coding === "x-gzip") gunzip(buf, { maxOutputLength: max }, done);
    else if (coding === "br") brotliDecompress(buf, { maxOutputLength: max }, done);
    else if (coding === "deflate")
      inflate(buf, { maxOutputLength: max }, (e, out) => {
        // Some servers send raw deflate under «deflate».
        if (e && !tooLarge(e)) inflateRaw(buf, { maxOutputLength: max }, done);
        else done(e, out);
      });
    else reject(new Error("encoding"));
  });
}

const tooLarge = (e: unknown) => (e as { code?: unknown })?.code === "ERR_BUFFER_TOO_LARGE";

/** The body the function sees: Content-Encoding undone in reverse order, at most `max` decoded bytes. */
async function decodeBody(buf: Buffer, header: string | undefined, max: number): Promise<Buffer> {
  const codings = (header ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== "identity");
  if (codings.length > 2) throw new Error("encoding");
  let out = buf;
  for (const c of codings.reverse()) {
    if (out.length === 0) break;
    try {
      out = await decodeOne(c, out, max);
    } catch (e) {
      if (tooLarge(e)) throw new Error("too_large");
      throw new Error((e as Error)?.message === "encoding" ? "encoding" : "decode");
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ OAuth tokens

/**
 * A secret value holding OAuth 2.0 client credentials (V3-22, СДЭК): `oauth2cc:` + base64url of {token_url, client_id,
 * client_secret}. Where a function sends it (as secret://name), the runtime puts an access token instead — requested
 * from token_url (the same host as the request) and kept in the memory of the process until it expires.
 */
export const OAUTH_CLIENT_SECRET_PREFIX = "oauth2cc:";

export interface OAuthClientSecret {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

const CREDENTIAL_RE = /^[\x21-\x7e]{1,512}$/;

/** The secret value of client credentials. */
export function oauthClientSecret(c: OAuthClientSecret): string {
  const json = JSON.stringify({
    token_url: c.tokenUrl,
    client_id: c.clientId,
    client_secret: c.clientSecret,
  });
  return `${OAUTH_CLIENT_SECRET_PREFIX}${Buffer.from(json, "utf8").toString("base64url")}`;
}

/** Client credentials of a secret value; null — not a valid oauth2cc value. */
export function parseOAuthClientSecret(value: string): OAuthClientSecret | null {
  if (!value.startsWith(OAUTH_CLIENT_SECRET_PREFIX)) return null;
  try {
    const j = JSON.parse(
      Buffer.from(value.slice(OAUTH_CLIENT_SECRET_PREFIX.length), "base64url").toString("utf8"),
    ) as {
      token_url?: unknown;
      client_id?: unknown;
      client_secret?: unknown;
    };
    if (
      typeof j.token_url !== "string" ||
      typeof j.client_id !== "string" ||
      typeof j.client_secret !== "string"
    )
      return null;
    const u = new URL(j.token_url);
    if (u.protocol !== "https:" || u.port || u.username || u.password || u.hash) return null;
    if (!CREDENTIAL_RE.test(j.client_id) || !CREDENTIAL_RE.test(j.client_secret)) return null;
    return { tokenUrl: u.toString(), clientId: j.client_id, clientSecret: j.client_secret };
  } catch {
    return null;
  }
}

/**
 * Access tokens by credentials (sha256 of the secret value), only in this process's memory: never logged, never
 * stored. One token request per credentials at a time; a refused request is not cached.
 */
export class OAuthTokenCache {
  private readonly tokens = new Map<string, { token: string; until: number }>();
  private readonly pending = new Map<string, Promise<string | null>>();
  constructor(private readonly clock: () => number = Date.now) {}

  /** A valid token, or the one `request` gets (ttl in seconds); null — the token endpoint refused the credentials. */
  async token(
    value: string,
    request: () => Promise<{ token: string; ttl: number } | null>,
  ): Promise<string | null> {
    const key = createHash("sha256").update(value).digest("hex");
    const hit = this.tokens.get(key);
    if (hit && hit.until > this.clock()) return hit.token;
    const running = this.pending.get(key);
    if (running) return running;
    const work = (async () => {
      const got = await request();
      if (!got) return null;
      if (this.tokens.size >= 1000) this.tokens.clear();
      // A minute before the provider's expiry (at least 30 s of use), at most a day.
      const ms = Math.max(30_000, Math.min(got.ttl, 86_400) * 1000 - 60_000);
      this.tokens.set(key, { token: got.token, until: this.clock() + ms });
      return got.token;
    })();
    this.pending.set(key, work);
    try {
      return await work;
    } finally {
      this.pending.delete(key);
    }
  }

  /** Forget the token of a secret value (the API answered 401 to it). */
  drop(value: string): void {
    this.tokens.delete(createHash("sha256").update(value).digest("hex"));
  }
}

const PROCESS_TOKENS = new OAuthTokenCache();
const ACCESS_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{8,8192}$/;

/** The token endpoint refused the client credentials: the call answers 401 without reaching the API. */
class TokenRefused extends Error {}

// ------------------------------------------------------------------------------------------------ the client

interface RawAnswer {
  status: number;
  type: string | null;
  encoding: string | undefined;
  buf: Buffer;
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
  const tokens = o.tokens ?? PROCESS_TOKENS;
  let used = 0;

  /**
   * One request over a fresh connection to `host` within the deadline from `started`. Rejects with EgressRefused, or
   * Error(connect | connect_timeout | timeout | too_large | …).
   */
  async function exchange(
    host: string,
    req: { method: string; path: string; headers: Record<string, string>; body: Buffer | null },
    started: number,
  ): Promise<RawAnswer> {
    // One deadline for the whole request (connect, TLS, sending, every byte of the answer): a server that keeps
    // the socket busy with a byte now and then is cut at timeoutMs from the start, not only after an idle gap.
    const left = () => Math.max(1, limits.timeoutMs - (Date.now() - started));
    let socket: TLSSocket;
    try {
      socket = await o.transport.connect(host, left());
    } catch (e) {
      if (e instanceof EgressRefused) throw e;
      throw new Error(String((e as Error)?.message) === "timeout" ? "connect_timeout" : "connect");
    }
    let deadline: NodeJS.Timeout | undefined;
    try {
      const res = await new Promise<RawAnswer>((resolve, reject) => {
        const r0 = httpRequest(
          {
            method: req.method,
            path: req.path,
            headers: req.headers,
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
                r0.destroy(new Error("too_large"));
                return;
              }
              chunks.push(b);
            });
            r.on("end", () =>
              resolve({
                status: r.statusCode ?? 0,
                type: typeof r.headers["content-type"] === "string" ? r.headers["content-type"] : null,
                encoding:
                  typeof r.headers["content-encoding"] === "string"
                    ? r.headers["content-encoding"]
                    : undefined,
                buf: Buffer.concat(chunks),
              }),
            );
            r.on("error", reject);
          },
        );
        deadline = setTimeout(() => {
          r0.destroy(new Error("timeout"));
          socket.destroy();
          reject(new Error("timeout"));
        }, left());
        r0.on("error", reject);
        r0.end(req.body ?? undefined);
      });
      clearTimeout(deadline);
      return res;
    } catch (e) {
      clearTimeout(deadline);
      socket.destroy();
      throw e;
    }
  }

  /** Access token of client credentials from their token endpoint (journaled as a POST, without path or body). */
  async function accessToken(c: OAuthClientSecret, value: string, host: string): Promise<string | null> {
    return tokens.token(value, async () => {
      const started = Date.now();
      const body = Buffer.from(
        new URLSearchParams({
          grant_type: "client_credentials",
          client_id: c.clientId,
          client_secret: c.clientSecret,
        }).toString(),
        "utf8",
      );
      const u = new URL(c.tokenUrl);
      const note = async (outcome: string, status: number | null, bytesIn = 0) =>
        await o.log({
          fn: o.fn,
          host,
          method: "POST",
          status,
          outcome,
          bytesOut: body.length,
          bytesIn,
          durationMs: Date.now() - started,
        });
      let raw: RawAnswer;
      try {
        raw = await exchange(
          host,
          {
            method: "POST",
            path: `${u.pathname}${u.search}`,
            headers: {
              accept: "application/json",
              "accept-encoding": EGRESS_ACCEPT_ENCODING,
              "content-type": "application/x-www-form-urlencoded",
              "content-length": String(body.length),
              "user-agent": "Wizard-System/1",
              host,
              connection: "close",
            },
            body,
          },
          started,
        );
      } catch (e) {
        await note(e instanceof EgressRefused ? "forbidden" : "token_failed", null);
        throw new WizardError("EGRESS_FAILED", { message: "Внешний сервис не выдал токен доступа" });
      }
      if (raw.status === 400 || raw.status === 401 || raw.status === 403) {
        await note("token_refused", raw.status, raw.buf.length);
        return null;
      }
      type TokenAnswer = { access_token?: unknown; expires_in?: unknown };
      const parsed = await (async (): Promise<TokenAnswer | null> => {
        if (raw.status < 200 || raw.status > 299) return null;
        try {
          const text = (await decodeBody(raw.buf, raw.encoding, limits.maxResponseBytes)).toString("utf8");
          const j = JSON.parse(text) as unknown;
          return j && typeof j === "object" ? (j as TokenAnswer) : null;
        } catch {
          return null;
        }
      })();
      const token = parsed?.access_token;
      if (typeof token !== "string" || !ACCESS_TOKEN_RE.test(token)) {
        await note("token_failed", raw.status, raw.buf.length);
        throw new WizardError("EGRESS_FAILED", { message: "Внешний сервис не выдал токен доступа" });
      }
      await note("token", raw.status, raw.buf.length);
      const ttl = typeof parsed?.expires_in === "number" && parsed.expires_in > 0 ? parsed.expires_in : 3600;
      return { token, ttl };
    });
  }

  /**
   * secret://name references of a header value or the path, resolved; an oauth2cc value becomes an access token of
   * its credentials (the token endpoint must be the request's host); `oauth` collects the oauth2cc values.
   */
  async function resolveSecrets(text: string, host: string, oauth: Set<string>): Promise<string> {
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
      if (value.startsWith(OAUTH_CLIENT_SECRET_PREFIX)) {
        const c = parseOAuthClientSecret(value);
        if (!c) throw new WizardError("EGRESS_FAILED", { message: `Секрет ${ref} задан неверно` });
        if (new URL(c.tokenUrl).hostname.toLowerCase() !== host)
          throw forbidden("Токен доступа запрашивается только у хоста запроса");
        const token = await accessToken(c, value, host);
        if (!token) throw new TokenRefused();
        oauth.add(value);
        value = token;
      }
      out = out.split(ref).join(value);
    }
    return out;
  }

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
      const oauth = new Set<string>();
      let path: string;
      try {
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
          if (name === "accept-encoding" && !ACCEPT_ENCODING_RE.test(v)) {
            await entry("forbidden");
            throw forbidden("Accept-Encoding — только gzip, deflate, br или identity");
          }
          headers[name] = await resolveSecrets(v, host, oauth);
        }
        path = await resolveSecrets(`${url.pathname}${url.search}`, host, oauth);
      } catch (e) {
        if (!(e instanceof TokenRefused)) throw e;
        // The credentials were refused by the token endpoint: the API is not called, the function sees a 401.
        await entry("auth_failed", { status: 401 });
        const text = JSON.stringify({ error: "oauth_token_refused" });
        return {
          status: 401,
          ok: false,
          contentType: "application/json",
          text: async () => text,
          json: async () => JSON.parse(text) as unknown,
        };
      }
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
      if (!headers["accept-encoding"]) headers["accept-encoding"] = EGRESS_ACCEPT_ENCODING;
      let res: RawAnswer;
      let decoded: Buffer;
      try {
        res = await exchange(host, { method, path, headers, body }, started);
        decoded = await decodeBody(res.buf, res.encoding, limits.maxResponseBytes);
      } catch (e) {
        if (e instanceof EgressRefused) {
          await entry("forbidden");
          throw forbidden(REFUSED_RU[e.reason] ?? REFUSED_RU.proxy_denied);
        }
        const why = String((e as Error)?.message);
        if (why === "connect" || why === "connect_timeout") {
          await entry(why === "connect_timeout" ? "timeout" : "failed");
          throw new WizardError("EGRESS_FAILED", { message: "Внешний сервис недоступен" });
        }
        if (why === "too_large") {
          await entry("too_large", { bytesOut: body?.length ?? 0 });
          throw new WizardError("LIMIT_EXCEEDED", {
            message: `Ответ внешнего сервиса больше ${Math.round(limits.maxResponseBytes / 1024)} КБ`,
            limit: "http_response",
          });
        }
        if (why === "encoding" || why === "decode") {
          await entry("failed", { bytesOut: body?.length ?? 0 });
          throw new WizardError("EGRESS_FAILED", {
            message:
              why === "encoding"
                ? "Ответ внешнего сервиса сжат неизвестным способом"
                : "Ответ внешнего сервиса не распаковался",
          });
        }
        await entry(why === "timeout" ? "timeout" : "failed", { bytesOut: body?.length ?? 0 });
        throw new WizardError("EGRESS_FAILED", {
          message: why === "timeout" ? "Внешний сервис отвечал слишком долго" : "Внешний сервис недоступен",
        });
      }
      await entry("ok", { status: res.status, bytesOut: body?.length ?? 0, bytesIn: res.buf.length });
      // A token the API no longer accepts is forgotten: the next call asks for a new one.
      if (res.status === 401) for (const v of oauth) tokens.drop(v);
      const text = decoded.toString("utf8");
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
