// Outbound fetch of research by D46: any public page, but SSRF and internal ranges closed, size and time limits.
// The private-address check repeats packages/connectors/src/net.ts minimally: connectors is not a dependency of agents
// (architecture.yaml#monorepo). Requests carry no platform secrets: fixed headers only, no cookies, no credentials.
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { ResearchError, type ResearchFetch, type Resolver } from "./types.js";

/** Product token of robots.txt and the User-Agent of every research request. */
export const RESEARCH_BOT = "WizardResearchBot";
export const RESEARCH_USER_AGENT = `Mozilla/5.0 (compatible; ${RESEARCH_BOT}/1.0)`;
export const MAX_REDIRECTS = 5;

const PRIVATE_MSG = "Адрес указывает во внутреннюю сеть — такие адреса читать нельзя.";

/** All A/AAAA addresses of a host (system DNS). */
export const systemResolver: Resolver = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

function v4(ip: string): number[] | null {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

function privateV4(a: number, b: number): boolean {
  return (
    a === 0 || // "this network"
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 168) || // RFC 1918
    (a === 192 && b === 0) || // IETF assignments, TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const q = v4(m[2] as string);
    if (!q) return null;
    const [a, b, c, d] = q as [number, number, number, number];
    s = `${m[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const words = (part: string | undefined) =>
    part ? part.split(":").map((w) => Number.parseInt(w, 16)) : [];
  const head = words(halves[0]);
  const tail = words(halves[1]);
  if ([...head, ...tail].some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  return missing < 1 ? null : [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** True for addresses research must never reach (loopback, RFC 1918, link-local, ULA, …); unparseable → true. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const kind = isIP(bare);
  if (kind === 4) {
    const [a, b] = v4(bare) as [number, number];
    return privateV4(a, b);
  }
  if (kind !== 6) return true;
  const w = expandV6(bare);
  if (w?.length !== 8) return true;
  const [a, b] = w as [number, number];
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) {
    const hi = w[6] as number;
    return privateV4(hi >> 8, hi & 255); // IPv4-mapped
  }
  if (w.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1, IPv4-compatible
  if (a === 0x64 && b === 0xff9b) return true; // NAT64
  return (
    (a & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (a & 0xffc0) === 0xfe80 || // link-local
    (a & 0xff00) === 0xff00 || // multicast
    (a === 0x2001 && b === 0x0db8) // documentation
  );
}

const LOCAL_NAME_RE = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/i;

/** Parses an http(s) URL without credentials; anything else → ResearchError. */
export function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ResearchError("URL_INVALID", "Это не адрес страницы: нужен полный адрес вида https://…");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ResearchError("SCHEME_FORBIDDEN", "Читать можно только адреса http и https.");
  }
  if (url.username || url.password) {
    throw new ResearchError("URL_INVALID", "Адреса с логином и паролем не читаем.");
  }
  url.hash = "";
  return url;
}

/** Bare host of a URL (IPv6 without brackets, no trailing dot). */
export function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** The host must be public: no local names, IP literals and every resolved address outside private ranges. */
export async function assertPublicHost(url: URL, resolve: Resolver): Promise<void> {
  const host = bareHost(url);
  const literal = isIP(host) !== 0;
  // Local names and single labels ("metadata", "intranet") resolve through search domains into the internal network.
  if (!literal && (LOCAL_NAME_RE.test(host) || !host.includes("."))) {
    throw new ResearchError("EGRESS_PRIVATE", PRIVATE_MSG);
  }
  if (literal) {
    if (isPrivateAddress(host)) throw new ResearchError("EGRESS_PRIVATE", PRIVATE_MSG);
    return;
  }
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new ResearchError("DNS_FAILED", `Не удалось найти сайт ${host}.`);
  }
  if (addrs.length === 0) throw new ResearchError("DNS_FAILED", `Не удалось найти сайт ${host}.`);
  if (addrs.some(isPrivateAddress)) throw new ResearchError("EGRESS_PRIVATE", PRIVATE_MSG);
}

/**
 * Default transport of pages: node:http(s) whose DNS lookup refuses private addresses at connect time (no DNS
 * rebinding between the check and the connection); gzip, deflate and br are decompressed here.
 */
export function guardedTransport(resolve: Resolver = systemResolver): ResearchFetch {
  const lookup: LookupFunction = (hostname, options, callback) => {
    resolve(hostname).then(
      (addrs) => {
        const first = addrs[0];
        if (first === undefined || addrs.some(isPrivateAddress)) {
          callback(new ResearchError("EGRESS_PRIVATE", PRIVATE_MSG) as NodeJS.ErrnoException, "", 0);
        } else if (options.all) {
          callback(
            null,
            addrs.map((address) => ({ address, family: isIP(address) })),
          );
        } else {
          callback(null, first, isIP(first));
        }
      },
      () =>
        callback(
          new ResearchError("DNS_FAILED", `Не удалось найти сайт ${hostname}.`) as NodeJS.ErrnoException,
          "",
          0,
        ),
    );
  };
  return (input, init = {}) =>
    new Promise<Response>((done, reject) => {
      let url: URL;
      try {
        url = parseHttpUrl(input);
      } catch (e) {
        reject(e);
        return;
      }
      const host = bareHost(url);
      if (isIP(host) !== 0 && isPrivateAddress(host)) {
        reject(new ResearchError("EGRESS_PRIVATE", PRIVATE_MSG));
        return;
      }
      const method = (init.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(url, { method, headers, lookup, signal: init.signal ?? undefined }, (res) => {
        const status = res.statusCode ?? 0;
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          for (const x of Array.isArray(v) ? v : [v]) out.append(k, x);
        }
        if (method === "HEAD" || status === 204 || status === 205 || status === 304 || status < 200) {
          res.resume();
          done(new Response(null, { status: status < 200 ? 502 : status, headers: out }));
          return;
        }
        const enc = (out.get("content-encoding") ?? "").trim().toLowerCase();
        let body: Readable = res;
        if (enc === "gzip" || enc === "x-gzip") body = res.pipe(createGunzip());
        else if (enc === "br") body = res.pipe(createBrotliDecompress());
        else if (enc === "deflate") body = res.pipe(createInflate());
        if (body !== res) {
          res.on("error", (e) => body.destroy(e));
          out.delete("content-encoding");
          out.delete("content-length");
        }
        done(new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status, headers: out }));
      });
      req.on("error", reject);
      if (typeof init.body === "string") req.write(init.body);
      req.end();
    });
}

/** Fixed request headers of pages and documentation: no cookies, no authorization, nothing from the platform. */
export function publicHeaders(accept: string): Record<string, string> {
  return {
    "user-agent": RESEARCH_USER_AGENT,
    accept,
    "accept-language": "ru,en;q=0.8",
    "accept-encoding": "gzip, deflate, br",
  };
}

export interface FetchPublicOptions {
  fetch: ResearchFetch;
  resolve: Resolver;
  maxBytes: number;
  timeoutMs: number;
  accept: string;
  maxRedirects?: number;
  /** Runs before every hop (robots.txt); throws to refuse. */
  beforeHop?: (url: URL) => Promise<void>;
}

export interface Fetched {
  /** Final address after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: Uint8Array;
}

function netError(e: unknown, signal: AbortSignal): ResearchError {
  if (e instanceof ResearchError) return e;
  if (signal.aborted) return new ResearchError("TIMEOUT", "Сайт не ответил вовремя.");
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "EGRESS_PRIVATE" || code === "DNS_FAILED") {
    return new ResearchError(code, (e as Error).message);
  }
  return new ResearchError("NETWORK", "Не удалось связаться с сайтом.");
}

async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ResearchError("TOO_LARGE", `Страница больше ${Math.round(maxBytes / 1024)} КБ — не читаем.`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResearchError(
          "TOO_LARGE",
          `Страница больше ${Math.round(maxBytes / 1024)} КБ — не читаем.`,
        );
      }
      chunks.push(value);
    }
  } catch (e) {
    throw netError(e, signal);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * GET of a public address: every hop (redirects followed manually, ≤ 5) is checked for scheme, private addresses and
 * `beforeHop`; one deadline for all hops; the body is read up to `maxBytes`. Bodies of 4xx/5xx answers are skipped.
 */
export async function fetchPublic(raw: string, o: FetchPublicOptions): Promise<Fetched> {
  const signal = AbortSignal.timeout(o.timeoutMs);
  const maxRedirects = o.maxRedirects ?? MAX_REDIRECTS;
  let url = parseHttpUrl(raw);
  for (let hop = 0; ; hop++) {
    await assertPublicHost(url, o.resolve);
    await o.beforeHop?.(url);
    let res: Response;
    try {
      res = await o.fetch(url.href, {
        method: "GET",
        headers: publicHeaders(o.accept),
        redirect: "manual",
        signal,
      });
    } catch (e) {
      throw netError(e, signal);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      if (hop >= maxRedirects)
        throw new ResearchError("TOO_MANY_REDIRECTS", "Слишком много перенаправлений.");
      url = parseHttpUrl(new URL(location, url).href);
      continue;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (res.status >= 400) {
      await res.body?.cancel().catch(() => {});
      return { url: url.href, status: res.status, contentType, body: new Uint8Array(0) };
    }
    return {
      url: url.href,
      status: res.status,
      contentType,
      body: await readCapped(res, o.maxBytes, signal),
    };
  }
}

function charsetOf(contentType: string, head: string): string {
  const fromHeader = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;
  return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ?? "utf-8";
}

/** Body → text by the charset of Content-Type or of `<meta charset>` (windows-1251 is common on Russian sites). */
export function decodeText(body: Uint8Array, contentType: string): string {
  const head = new TextDecoder("latin1").decode(body.subarray(0, 2048));
  try {
    return new TextDecoder(charsetOf(contentType, head)).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}
