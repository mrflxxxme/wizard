// L3-24 (isolation.yaml#M2.network): the egress proxy serves CONNECT :443 only (SMTP :465/:587 only to the system's
// smtp hosts), checks every resolved address (DNS rebinding, metadata, cluster CIDRs) and cuts a tunnel whose TLS
// SNI differs from the CONNECT host. DNS and dialing are injected: no traffic leaves this machine.
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { AppSpec } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  capabilityAuthorizer,
  createEgressProxy,
  type EgressPolicy,
  egressPolicyFor,
  issueCapability,
  newRequestId,
  parseConnectTarget,
  peekClientHello,
} from "../../src/index.js";
import { KEY } from "./helpers.js";

const DNS: Record<string, string[]> = {
  "api.telegram.org": ["149.154.167.220"],
  "smtp.yandex.ru": ["77.88.21.158"],
  "rebind.example.ru": ["10.0.0.5"],
  "mixed.example.ru": ["93.184.216.34", "169.254.169.254"],
  "cluster.example.ru": ["203.0.113.7"],
};
const POLICY: EgressPolicy = {
  https: new Set(["api.telegram.org", "rebind.example.ru", "mixed.example.ru", "cluster.example.ru"]),
  smtp: new Set(["smtp.yandex.ru"]),
  label: "sysa00000001",
};

interface Upstream {
  ip: string;
  port: number;
  data: Buffer;
}
const dialed: Upstream[] = [];
const upstreamSockets = new Set<Socket>();
const clientSockets = new Set<Socket>();
const logs: Record<string, unknown>[] = [];
let upstream: Server;
let proxy: Server;
let proxyPort = 0;
let upstreamPort = 0;
let token = "";

beforeAll(async () => {
  upstream = createServer((s) => {
    upstreamSockets.add(s);
    const rec = dialed[dialed.length - 1] as Upstream;
    if (rec.port === 587) s.write("220 smtp.yandex.ru ESMTP\r\n");
    s.on("data", (b: Buffer) => {
      rec.data = Buffer.concat([rec.data, b]);
      if (rec.port === 587 && /STARTTLS\r\n$/i.test(b.toString("latin1"))) s.write("220 go ahead\r\n");
      else if (rec.port === 587 && /^EHLO/i.test(b.toString("latin1"))) s.write("250 ok\r\n");
    });
    s.on("error", () => {});
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as { port: number }).port;
  proxy = createEgressProxy({
    authorize: capabilityAuthorizer(KEY, (id, env) =>
      id === "sysa00000001" && env === "prod" ? POLICY : null,
    ),
    resolve: async (h) => DNS[h] ?? [],
    dial: ({ host, port }) =>
      new Promise((resolve, reject) => {
        dialed.push({ ip: host, port, data: Buffer.alloc(0) });
        const s = netConnect(upstreamPort, "127.0.0.1", () => resolve(s));
        s.on("error", reject);
      }),
    deniedCidrs: ["203.0.113.0/24"],
    helloTimeoutMs: 2000,
    log: (l) => logs.push(l),
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyPort = (proxy.address() as { port: number }).port;
  token = issueCapability(KEY, {
    systemId: "sysa00000001",
    env: "prod",
    requestId: newRequestId(),
    exp: Date.now() + 600_000,
  });
});

afterAll(async () => {
  for (const s of [...upstreamSockets, ...clientSockets]) s.destroy();
  await new Promise((r) => proxy?.close(r));
  await new Promise((r) => upstream?.close(r));
});

/** Opens a CONNECT tunnel; resolves with the status code and the socket (open only on 200). */
function connectVia(
  target: string,
  auth: string | null = token,
): Promise<{ status: number; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const s = netConnect(proxyPort, "127.0.0.1", () => {
      clientSockets.add(s);
      s.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: Bearer ${auth}\r\n` : ""}\r\n`,
      );
    });
    let buf = "";
    const onData = (b: Buffer) => {
      buf += b.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.off("data", onData);
      resolve({ status: Number(buf.split(" ")[1]), socket: s });
    };
    s.on("data", onData);
    s.on("error", reject);
  });
}

const closed = (s: Socket, ms = 3000) =>
  new Promise<boolean>((resolve) => {
    if (s.destroyed) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    s.once("close", () => {
      clearTimeout(t);
      resolve(true);
    });
  });

/** Sends a real TLS ClientHello with the given SNI through the tunnel. */
function hello(socket: Socket, servername: string): void {
  const t = tlsConnect({ socket, servername, rejectUnauthorized: false });
  t.on("error", () => {});
}

const until = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 20));
  return cond();
};

describe("egress proxy: what is refused before any connection", () => {
  it("plain HTTP proxying and direct requests → 403", async () => {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/anything?token=secret`);
    expect(r.status).toBe(403);
  });

  it("no or invalid capability → 407; expired → 407", async () => {
    expect((await connectVia("api.telegram.org:443", null)).status).toBe(407);
    expect((await connectVia("api.telegram.org:443", "v1.e30.AAAA")).status).toBe(407);
    const old = issueCapability(KEY, {
      systemId: "sysa00000001",
      env: "prod",
      requestId: newRequestId(),
      exp: 1,
    });
    expect((await connectVia("api.telegram.org:443", old)).status).toBe(407);
    const otherSystem = issueCapability(KEY, {
      systemId: "sysb00000002",
      env: "prod",
      requestId: newRequestId(),
      exp: Date.now() + 60_000,
    });
    expect((await connectVia("api.telegram.org:443", otherSystem)).status).toBe(407);
  });

  it("port ≠ 443/465/587, host outside the allowlist, IP literal, SMTP port to a non-SMTP host → 403", async () => {
    const before = dialed.length;
    for (const t of [
      "api.telegram.org:80",
      "api.telegram.org:22",
      "evil.example.com:443",
      "149.154.167.220:443",
      "[::1]:443",
      "api.telegram.org:465",
      "api.telegram.org:587",
      "smtp.yandex.ru:443",
      "*.telegram.org:443",
    ])
      expect((await connectVia(t)).status, t).toBe(403);
    expect(dialed.length).toBe(before);
  });

  it("DNS rebinding, metadata and cluster CIDRs: checked after resolution → 403, nothing dialed", async () => {
    const before = dialed.length;
    for (const t of ["rebind.example.ru:443", "mixed.example.ru:443", "cluster.example.ru:443"])
      expect((await connectVia(t)).status, t).toBe(403);
    expect(dialed.length).toBe(before);
  });
});

describe("egress proxy: SNI = CONNECT host", () => {
  it("matching SNI → the ClientHello reaches the resolved IP", async () => {
    const { status, socket } = await connectVia("api.telegram.org:443");
    expect(status).toBe(200);
    const rec = dialed[dialed.length - 1] as Upstream;
    expect(rec.ip).toBe("149.154.167.220");
    hello(socket, "api.telegram.org");
    expect(await until(() => rec.data.length > 0)).toBe(true);
    expect(peekClientHello(rec.data)).toEqual({ done: true, ok: true, sni: "api.telegram.org" });
    socket.destroy();
  });

  it("SNI ≠ CONNECT host → the tunnel is cut, upstream gets nothing", async () => {
    const { status, socket } = await connectVia("api.telegram.org:443");
    expect(status).toBe(200);
    const rec = dialed[dialed.length - 1] as Upstream;
    hello(socket, "evil.example.com");
    expect(await closed(socket)).toBe(true);
    expect(rec.data.length).toBe(0);
  });

  it("no TLS (plain HTTP in the tunnel) → cut", async () => {
    const { socket } = await connectVia("api.telegram.org:443");
    const rec = dialed[dialed.length - 1] as Upstream;
    socket.write("GET /bot123:secret/getMe HTTP/1.1\r\nHost: api.telegram.org\r\n\r\n");
    expect(await closed(socket)).toBe(true);
    expect(rec.data.length).toBe(0);
  });

  it("SMTP 465 (implicit TLS) to the system's smtp host with matching SNI is forwarded", async () => {
    const { status, socket } = await connectVia("smtp.yandex.ru:465");
    expect(status).toBe(200);
    const rec = dialed[dialed.length - 1] as Upstream;
    hello(socket, "smtp.yandex.ru");
    expect(await until(() => rec.data.length > 0)).toBe(true);
    socket.destroy();
  });

  it("SMTP 587: only EHLO/STARTTLS in clear text, then a ClientHello with matching SNI", async () => {
    const ok = await connectVia("smtp.yandex.ru:587");
    const rec = dialed[dialed.length - 1] as Upstream;
    let greeting = "";
    ok.socket.on("data", (b: Buffer) => {
      greeting += b.toString("latin1");
    });
    ok.socket.write("EHLO client.example\r\n");
    ok.socket.write("STARTTLS\r\n");
    expect(await until(() => greeting.includes("220 go ahead"))).toBe(true);
    const plainLen = rec.data.length;
    hello(ok.socket, "smtp.yandex.ru");
    expect(await until(() => rec.data.length > plainLen)).toBe(true);
    expect(peekClientHello(rec.data.subarray(plainLen))).toMatchObject({ ok: true, sni: "smtp.yandex.ru" });
    ok.socket.destroy();

    const bad = await connectVia("smtp.yandex.ru:587");
    const rec2 = dialed[dialed.length - 1] as Upstream;
    bad.socket.write("AUTH PLAIN AGxvZ2luAHBhc3N3b3Jk\r\n");
    expect(await closed(bad.socket)).toBe(true);
    expect(rec2.data.toString("latin1")).not.toContain("AUTH");
  });

  it("logs: host, port, status and sizes only — no paths, queries or payloads", () => {
    const text = JSON.stringify(logs);
    expect(text).not.toMatch(/bot123|secret|getMe|AUTH|AGxvZ2lu/);
    expect(logs.some((l) => l.outcome === "sni_mismatch")).toBe(true);
    for (const l of logs)
      expect(
        Object.keys(l).every((k) => /^(ts|svc|host|port|status|reason|outcome|up|down|sys|method)$/.test(k)),
      ).toBe(true);
  });
});

describe("egress policy and parsing", () => {
  it("parseConnectTarget: DNS names with a port only", () => {
    expect(parseConnectTarget("API.Telegram.org.:443")).toEqual({ host: "api.telegram.org", port: 443 });
    for (const t of ["1.2.3.4:443", "[::1]:443", "host:99999", "host", "a.b:443/x", "-a.b:443", undefined])
      expect(parseConnectTarget(t)).toBeNull();
  });

  it("egressPolicyFor: connector hosts ∪ function.egress without platform/internal names (D71); smtp from email integrations", () => {
    const spec = {
      integrations: [
        { name: "pay", connector: "yookassa" },
        { name: "mail", connector: "email", config: { provider: "smtp", host: "smtp.yandex.ru" } },
        { name: "notify", connector: "email" },
      ],
      functions: [
        {
          name: "f",
          kind: "action",
          file: "functions/f.ts",
          egress: ["api.partner.ru", "evil.example.com", "admin.borntobuild.ru", "db.svc.cluster.local"],
        },
      ],
    } as unknown as AppSpec;
    const p = egressPolicyFor(spec, {
      globalAllow: ["api.partner.ru"],
      platformSmtpHost: "smtp.wizard-mail.ru",
    });
    expect([...p.https].sort()).toEqual(["api.partner.ru", "api.yookassa.ru", "evil.example.com"]);
    expect([...p.smtp].sort()).toEqual(["smtp.wizard-mail.ru", "smtp.yandex.ru"]);
  });

  it("peekClientHello: partial input waits, non-TLS and garbage are refused", () => {
    expect(peekClientHello(Buffer.from([0x16, 0x03]))).toEqual({ done: false });
    expect(peekClientHello(Buffer.from("GET / HTTP/1.1\r\n"))).toMatchObject({
      ok: false,
      reason: "not_tls",
    });
    expect(peekClientHello(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x02, 0, 0, 0]))).toMatchObject({
      ok: false,
      reason: "not_client_hello",
    });
    expect(peekClientHello(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0, 0, 9, 9]))).toMatchObject({
      ok: false,
    });
    expect(peekClientHello(Buffer.from([0x16, 0x03, 0x01, 0xff, 0xff]))).toMatchObject({
      reason: "too_large",
    });
  });
});
