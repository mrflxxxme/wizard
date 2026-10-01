// Outbound network guard (connector-interface.md §1 ctx.fetch; email.yaml#config_schema.host): after DNS
// resolution the address MUST NOT be private, loopback, link-local, CGNAT or otherwise non-public.
import { lookup } from "node:dns/promises";
import { isIP, Socket } from "node:net";
import { ConnectorError } from "./errors.js";

export type Resolver = (host: string) => Promise<string[]>;
/** Opens a plain TCP connection (TLS is layered on top by the caller). */
export type Dialer = (addr: { host: string; port: number }) => Promise<Socket>;

/** All A/AAAA addresses of a host (system DNS). */
export const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export const tcpDialer: Dialer = ({ host, port }) =>
  new Promise((resolve, reject) => {
    const socket = new Socket();
    const fail = (e: Error) => {
      socket.destroy();
      reject(e);
    };
    socket.once("error", fail);
    socket.setTimeout(10_000, () => fail(new Error("connect timeout")));
    socket.connect(port, host, () => {
      socket.off("error", fail);
      socket.setTimeout(0);
      resolve(socket);
    });
  });

function v4(ip: string): number[] | null {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

function privateV4([a, b]: number[]): boolean {
  const x = a as number;
  const y = b as number;
  return (
    x === 0 || // "this network"
    x === 10 || // RFC 1918
    x === 127 || // loopback
    (x === 100 && y >= 64 && y <= 127) || // CGNAT RFC 6598
    (x === 169 && y === 254) || // link-local
    (x === 172 && y >= 16 && y <= 31) || // RFC 1918
    (x === 192 && y === 168) || // RFC 1918
    (x === 192 && y === 0) || // IETF protocol assignments / TEST-NET-1 (192.0.0.0/24, 192.0.2.0/24)
    (x === 198 && (y === 18 || y === 19)) || // benchmarking
    x >= 224 // multicast, reserved, broadcast
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

/** True for addresses a connector must never reach (SSRF guard, L3-24). Unparseable input counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/%.*$/, "");
  const kind = isIP(bare);
  if (kind === 4) return privateV4(v4(bare) as number[]);
  if (kind !== 6) return true;
  const w = expandV6(bare);
  if (w?.length !== 8) return true;
  const [a] = w as [number];
  const zeroPrefix = w.slice(0, 5).every((x) => x === 0);
  if (zeroPrefix && w[5] === 0xffff) {
    // IPv4-mapped ::ffff:a.b.c.d
    return privateV4([
      (w[6] as number) >> 8,
      (w[6] as number) & 255,
      (w[7] as number) >> 8,
      (w[7] as number) & 255,
    ]);
  }
  if (w.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1, IPv4-compatible
  if (a === 0x64 && w[1] === 0xff9b) return true; // NAT64
  return (
    (a & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (a & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (a & 0xff00) === 0xff00 || // multicast
    (a === 0x2001 && w[1] === 0x0db8) // documentation
  );
}

/**
 * Resolves `host` and returns its public addresses; any non-public address (or an IP literal that is not public)
 * → ConnectorError CONFIG_INVALID before a connection is opened.
 */
export async function resolvePublic(host: string, resolve: Resolver = systemResolver): Promise<string[]> {
  let addrs: string[];
  try {
    addrs = isIP(host) ? [host] : await resolve(host);
  } catch {
    throw new ConnectorError("UPSTREAM_UNAVAILABLE", "Не удалось найти адрес сервера");
  }
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) {
    throw new ConnectorError(
      "CONFIG_INVALID",
      "Адрес сервера указывает во внутреннюю сеть — подключение запрещено",
    );
  }
  return addrs;
}

export interface GuardedFetchOptions {
  resolve?: Resolver;
  /** Hosts configured by the platform itself (e.g. a Bot API stub in tests) skip the address check. */
  trustedHosts?: Iterable<string>;
  timeoutMs?: number;
  inner?: typeof fetch;
}

/**
 * fetch for ConnectorCtx (M1): the target host must resolve to public addresses; errors never carry the URL.
 * M2 moves this to the egress proxy (security/isolation.yaml#M2.network).
 */
export function guardedFetch(o: GuardedFetchOptions = {}): typeof fetch {
  const trusted = new Set([...(o.trustedHosts ?? [])].map((h) => h.toLowerCase()));
  const inner = o.inner ?? fetch;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:" && !trusted.has(url.host.toLowerCase())) {
      throw new ConnectorError("EGRESS_DISABLED", "Разрешены только HTTPS-запросы");
    }
    if (!trusted.has(url.host.toLowerCase())) {
      await resolvePublic(url.hostname.replace(/^\[|\]$/g, ""), o.resolve).catch((e: unknown) => {
        if (e instanceof ConnectorError && e.code === "CONFIG_INVALID") {
          throw new ConnectorError("EGRESS_DISABLED", "Запросы во внутреннюю сеть запрещены");
        }
        throw e;
      });
    }
    const signal = init?.signal ?? AbortSignal.timeout(o.timeoutMs ?? 10_000);
    return inner(input, { ...init, signal, redirect: "manual" });
  }) as typeof fetch;
}

/** Address as 4 (IPv4, incl. IPv4-mapped IPv6) or 16 bytes; null when unparseable. */
function ipBytes(ip: string): number[] | null {
  const bare = ip
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  const kind = isIP(bare);
  if (kind === 4) return v4(bare);
  if (kind !== 6) return null;
  const w = expandV6(bare);
  if (w?.length !== 8) return null;
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) {
    return [(w[6] as number) >> 8, (w[6] as number) & 255, (w[7] as number) >> 8, (w[7] as number) & 255];
  }
  return w.flatMap((x) => [x >> 8, x & 255]);
}

/** True when `ip` belongs to one of `cidrs` ("a.b.c.d/n", "x::/n" or a bare address). Bad entries never match. */
export function ipInCidrs(ip: string, cidrs: Iterable<string>): boolean {
  const addr = ipBytes(ip);
  if (!addr) return false;
  for (const cidr of cidrs) {
    const [net, bitsRaw] = cidr.trim().split("/") as [string, string | undefined];
    const base = ipBytes(net);
    if (!base || base.length !== addr.length) continue;
    const bits = bitsRaw === undefined ? base.length * 8 : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > base.length * 8) continue;
    let ok = true;
    for (let i = 0; i < base.length && ok; i++) {
      const take = Math.max(0, Math.min(8, bits - i * 8));
      const mask = (0xff << (8 - take)) & 0xff;
      ok = ((addr[i] as number) & mask) === ((base[i] as number) & mask);
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Client address per platform/deploy.yaml#cloud.client_ip: the socket peer, or — when the peer is a trusted ingress
 * (CIDRs of WIZARD_TRUSTED_PROXIES) — the right-most X-Forwarded-For hop that is not itself trusted.
 */
export function effectiveClientIp(
  peer: string | null | undefined,
  forwardedFor: string | null | undefined,
  trustedProxies: readonly string[],
): string | null {
  if (!peer) return null;
  if (!forwardedFor || trustedProxies.length === 0 || !ipInCidrs(peer, trustedProxies)) return peer;
  const hops = forwardedFor
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    if (!ipBytes(hop)) return peer;
    if (!ipInCidrs(hop, trustedProxies) || i === 0) return hop;
  }
  return peer;
}
