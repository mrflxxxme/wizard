// Egress proxy (security/isolation.yaml#M2.network, L3-24): a separate deployment in the platform pool, the only way
// out for sandbox pods and for the runtime's connector traffic. It speaks CONNECT only:
//   * port 443 → host ∈ policy.https (function.egress ∩ global allowlist, connector hosts);
//   * ports 465/587 → host ∈ policy.smtp (smtp integrations of the system); 587 only after STARTTLS;
//   * the host is a DNS name; every resolved address is public and outside cluster CIDRs, checked after resolution
//     and dialed by IP (no second lookup: DNS rebinding);
//   * the TLS ClientHello MUST carry SNI equal to the CONNECT host, else the connection is cut;
//   * bounded bytes and duration; logs carry host, port, status and sizes only (never paths or payloads).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import type { AppSpec } from "@wizard/appspec";
import {
  type Dialer,
  egressHostProblem,
  ipInCidrs,
  isPrivateAddress,
  PLATFORM_DOMAINS,
  type Resolver,
  systemResolver,
  tcpDialer,
} from "@wizard/connectors";
import { verifyCapability } from "./capability.js";
import { peekClientHello } from "./sni.js";

export interface EgressPolicy {
  /** Hosts reachable on :443. */
  https: ReadonlySet<string>;
  /** SMTP hosts reachable on :465 (implicit TLS) and :587 (STARTTLS). */
  smtp: ReadonlySet<string>;
  /** Label for logs (system id). */
  label?: string;
}

export interface EgressProxyOptions {
  /** Proxy-Authorization header → policy of the caller, or null (→ 407). */
  authorize: (header: string | undefined) => EgressPolicy | null | Promise<EgressPolicy | null>;
  resolve?: Resolver;
  dial?: Dialer;
  /** Cluster/service/pod CIDRs, metadata ranges etc. denied in addition to non-public addresses. */
  deniedCidrs?: readonly string[];
  /** Bytes per connection, both directions together (default 50 MiB). */
  maxBytes?: number;
  /** Connection lifetime (default 120 s). */
  maxDurationMs?: number;
  /** Time to receive the ClientHello / SMTP preamble (default 10 s). */
  helloTimeoutMs?: number;
  log?: (line: Record<string, unknown>) => void;
  /** Tests only: loopback upstreams (127.0.0.0/8, ::1) pass the address check; every other private range stays denied. */
  allowLoopbackForTests?: boolean;
}

const HOST_RE = /^(?!\d+\.)(?!-)[a-z0-9-]{1,63}(\.(?!-)[a-z0-9-]{1,63})+$/;
export const EGRESS_PORTS = { https: 443, smtps: 465, submission: 587 } as const;
/** Commands a client may send to :587 before STARTTLS (no AUTH or mail in clear text). */
const SMTP_PRE_TLS = /^(EHLO|HELO|STARTTLS|NOOP|RSET|QUIT)( [\x21-\x7e]{1,255})?$/i;

/** Global allowlist of connector hosts (connectors/*.yaml); functions may add only hosts from this list. */
export const CONNECTOR_HOSTS: Readonly<Record<string, readonly string[]>> = {
  yookassa: ["api.yookassa.ru"],
  telegram: ["api.telegram.org"],
};

/**
 * Policy of one system: https = connector hosts of its integrations ∪ function.egress (D71, isolation.yaml#M2.network:
 * any public host the spec declares, no intersection with a global list; platform domains and internal names are
 * dropped — G2-EGRESS-01); smtp = hosts of its email integrations with provider=smtp, plus the platform SMTP host
 * when it uses provider=platform. `globalAllow` is kept for compatibility and no longer narrows function hosts.
 */
export function egressPolicyFor(
  spec: AppSpec,
  o: {
    globalAllow?: Iterable<string>;
    platformSmtpHost?: string;
    label?: string;
    platformDomains?: readonly string[];
  },
): EgressPolicy {
  const platform = o.platformDomains ?? PLATFORM_DOMAINS;
  const https = new Set<string>();
  const smtp = new Set<string>();
  for (const integ of spec.integrations ?? []) {
    for (const h of CONNECTOR_HOSTS[integ.connector] ?? []) https.add(h);
    if (integ.connector === "email") {
      const cfg = (integ.config ?? {}) as { provider?: unknown; host?: unknown };
      if (cfg.provider === "smtp" && typeof cfg.host === "string" && HOST_RE.test(cfg.host.toLowerCase())) {
        smtp.add(cfg.host.toLowerCase());
      } else if (o.platformSmtpHost) smtp.add(o.platformSmtpHost.toLowerCase());
    }
  }
  for (const f of spec.functions ?? [])
    for (const h of f.egress ?? []) if (egressHostProblem(h, platform) === null) https.add(h.toLowerCase());
  return { https, smtp, ...(o.label ? { label: o.label } : {}) };
}

/** authorize() over capability tokens: `Proxy-Authorization: Bearer <token>` → policy of {systemId, env}. */
export function capabilityAuthorizer(
  key: Uint8Array,
  policyOf: (systemId: string, env: "draft" | "prod") => EgressPolicy | null,
  clock: () => number = Date.now,
): EgressProxyOptions["authorize"] {
  return (header) => {
    if (!header?.startsWith("Bearer ")) return null;
    const check = verifyCapability(key, header.slice(7).trim(), clock());
    return check.ok ? policyOf(check.cap.systemId, check.cap.env) : null;
  };
}

/** Parses the CONNECT target `host:port`; IP literals, wildcards and bracketed hosts are refused. */
export function parseConnectTarget(target: string | undefined): { host: string; port: number } | null {
  const m = /^([^:/\s]+):(\d{1,5})$/.exec(target ?? "");
  if (!m) return null;
  const host = (m[1] as string).toLowerCase().replace(/\.$/, "");
  const port = Number(m[2]);
  if (isIP(host) || !HOST_RE.test(host) || port < 1 || port > 65535) return null;
  return { host, port };
}

type Verdict = { status: number; reason: string };

export function createEgressProxy(o: EgressProxyOptions): Server {
  const resolve = o.resolve ?? systemResolver;
  const dial = o.dial ?? tcpDialer;
  const denied = o.deniedCidrs ?? [];
  const maxBytes = o.maxBytes ?? 50 * 1024 * 1024;
  const maxDuration = o.maxDurationMs ?? 120_000;
  const helloTimeout = o.helloTimeoutMs ?? 10_000;
  const log = (line: Record<string, unknown>) =>
    o.log?.({ ts: new Date().toISOString(), svc: "egress-proxy", ...line });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Plain proxying (GET http://…) and direct requests are never served: CONNECT only.
    log({ status: 403, reason: "not_connect", method: req.method });
    res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end("CONNECT only\n");
  });

  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => client.destroy());
    const target = parseConnectTarget(req.url);
    const reply = (v: Verdict, extra: Record<string, unknown> = {}) => {
      log({
        host: target?.host ?? null,
        port: target?.port ?? null,
        status: v.status,
        reason: v.reason,
        ...extra,
      });
      const text =
        v.status === 407 ? "Proxy Authentication Required" : v.status === 502 ? "Bad Gateway" : "Forbidden";
      const auth = v.status === 407 ? 'Proxy-Authenticate: Bearer realm="wizard-egress"\r\n' : "";
      client.end(`HTTP/1.1 ${v.status} ${text}\r\n${auth}Connection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    void (async () => {
      if (!target) return reply({ status: 403, reason: "bad_target" });
      const policy = await Promise.resolve(o.authorize(req.headers["proxy-authorization"])).catch(() => null);
      if (!policy) return reply({ status: 407, reason: "unauthorized" });
      const smtpPort = target.port === EGRESS_PORTS.smtps || target.port === EGRESS_PORTS.submission;
      if (target.port !== EGRESS_PORTS.https && !smtpPort) return reply({ status: 403, reason: "port" });
      const allowed = smtpPort ? policy.smtp : policy.https;
      if (!allowed.has(target.host))
        return reply({ status: 403, reason: "host_not_allowed" }, { sys: policy.label });
      let addrs: string[];
      try {
        addrs = await resolve(target.host);
      } catch {
        return reply({ status: 502, reason: "dns" }, { sys: policy.label });
      }
      // Rebinding: every address must be public; the socket is then opened to a checked IP, not to the name.
      const loopbackOk = (a: string) =>
        o.allowLoopbackForTests === true && (a === "::1" || a.startsWith("127."));
      if (
        addrs.length === 0 ||
        addrs.some((a) => !loopbackOk(a) && (isPrivateAddress(a) || ipInCidrs(a, denied)))
      ) {
        return reply({ status: 403, reason: "address_not_public" }, { sys: policy.label });
      }
      let upstream: Socket;
      try {
        upstream = await dial({ host: addrs[0] as string, port: target.port });
      } catch {
        return reply({ status: 502, reason: "dial" }, { sys: policy.label });
      }
      tunnel(client, upstream, head, target, policy.label, target.port === EGRESS_PORTS.submission);
    })();
  });

  function tunnel(
    client: Socket,
    upstream: Socket,
    head: Buffer,
    target: { host: string; port: number },
    label: string | undefined,
    starttls: boolean,
  ): void {
    let up = 0;
    let down = 0;
    let closed = false;
    let outcome = "ok";
    const close = (why?: string) => {
      if (closed) return;
      closed = true;
      if (why) outcome = why;
      clearTimeout(life);
      clearTimeout(helloTimer);
      client.destroy();
      upstream.destroy();
      log({ host: target.host, port: target.port, status: 200, outcome, up, down, sys: label });
    };
    const life = setTimeout(() => close("max_duration"), maxDuration);
    let helloTimer = setTimeout(() => close("hello_timeout"), helloTimeout);
    upstream.on("error", () => close("upstream_error"));
    client.on("error", () => close("client_error"));
    upstream.on("close", () => close());
    client.on("close", () => close());

    const toUpstream = (b: Buffer) => {
      up += b.length;
      if (up + down > maxBytes) return close("max_bytes");
      upstream.write(b);
    };
    const pipeDown = () =>
      upstream.on("data", (b: Buffer) => {
        down += b.length;
        if (up + down > maxBytes) return close("max_bytes");
        client.write(b);
      });

    // Phase 1 (587 only): SMTP commands in clear text until STARTTLS; the server greeting flows back meanwhile.
    // Phase 2: buffer the client's first TLS record, check SNI, then forward everything.
    let phase: "smtp" | "hello" | "open" = starttls ? "smtp" : "hello";
    let pending = Buffer.alloc(0);
    if (starttls) pipeDown();

    const onClient = (chunk: Buffer) => {
      if (closed) return;
      if (phase === "open") return toUpstream(chunk);
      pending = Buffer.concat([pending, chunk]);
      if (phase === "smtp") {
        for (;;) {
          const nl = pending.indexOf("\r\n");
          if (nl < 0) {
            if (pending.length > 512) return close("smtp_line");
            return;
          }
          const line = pending.subarray(0, nl).toString("latin1");
          if (!SMTP_PRE_TLS.test(line)) return close("smtp_before_tls");
          toUpstream(pending.subarray(0, nl + 2));
          pending = pending.subarray(nl + 2);
          if (/^STARTTLS$/i.test(line)) {
            phase = "hello";
            clearTimeout(helloTimer);
            helloTimer = setTimeout(() => close("hello_timeout"), helloTimeout);
            break;
          }
        }
        if (pending.length === 0) return;
      }
      const peek = peekClientHello(pending);
      if (!peek.done) return;
      if (!peek.ok) return close(`tls_${peek.reason}`);
      if (peek.sni !== target.host) return close("sni_mismatch");
      clearTimeout(helloTimer);
      phase = "open";
      const first = pending;
      pending = Buffer.alloc(0);
      if (!starttls) pipeDown();
      toUpstream(first);
    };
    client.on("data", onClient);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) onClient(head);
  }

  return server;
}
