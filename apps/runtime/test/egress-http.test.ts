// M2-52 (D71): ctx.http.fetch made by the runtime — SSRF refusals before any connection (IP literals, http://,
// undeclared and platform hosts, DNS answers in 127/8, 10/8, 169.254/16, ::1, rebinding through the proxy), a request
// through the egress proxy with a runtime grant to a local TLS upstream (loopback allowed by a test-only flag), secret
// substitution, limits, no redirects, the _w_egress_log journal without paths or bodies.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppSpec, quoteIdent } from "@wizard/appspec";
import { type Resolver, staticSecretReader, tcpDialer } from "@wizard/connectors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createEgressProxy,
  directTransport,
  EgressGrants,
  egressHttpClient,
  proxyTransport,
} from "../src/index.js";
import { createInternalHandler } from "../src/internal.js";
import { createEgressService } from "../src/sandbox/egress-service.js";
import { devEnv, forumSpec, type Harness, harness } from "./helpers.js";

const HOST = "api.partner-crm.ru";
const PLATFORM = ["borntobuild.ru", "sandpile.ru"];

function cert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "wz-egress-cert-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "2",
        "-subj",
        `/CN=${HOST}`,
        "-addext",
        `subjectAltName=DNS:${HOST}`,
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tls = cert();
let upstream: HttpsServer;
let upstreamPort = 0;
const hits: { method: string; url: string; auth: string | null; host: string | null }[] = [];

beforeAll(async () => {
  upstream = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    hits.push({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: req.headers.authorization ?? null,
      host: req.headers.host ?? null,
    });
    if (req.url === "/big") return res.end("x".repeat(3 * 1024 * 1024));
    if (req.url === "/drip") {
      // One byte every 100 ms for 3 s: never idle long enough for a socket timeout.
      res.writeHead(200, { "content-type": "text/plain" });
      let n = 0;
      const t = setInterval(() => {
        if (res.destroyed || n++ >= 30) {
          clearInterval(t);
          if (!res.destroyed) res.end();
          return;
        }
        res.write("x");
      }, 100);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "https://169.254.169.254/latest/meta-data" });
      return res.end();
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, echo: body }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

const dns: Record<string, string[]> = {
  [HOST]: ["127.0.0.1"],
  "loop.partner.ru": ["127.0.0.1"],
  "ten.partner.ru": ["10.0.0.5"],
  "meta.partner.ru": ["169.254.169.254"],
  "v6.partner.ru": ["::1"],
  "mixed.partner.ru": ["93.184.216.34", "10.1.2.3"],
};
const resolver: Resolver = async (h) => {
  const a = dns[h];
  if (!a) throw new Error("NXDOMAIN");
  return a;
};

const declared = [
  HOST,
  "loop.partner.ru",
  "ten.partner.ru",
  "meta.partner.ru",
  "v6.partner.ru",
  "mixed.partner.ru",
  "admin.borntobuild.ru",
];

function client(o: {
  transport: Parameters<typeof egressHttpClient>[0]["transport"];
  log?: unknown[];
  perCall?: number;
  timeoutMs?: number;
}) {
  const log = (o.log ?? []) as unknown[];
  return egressHttpClient({
    fn: "syncLead",
    hosts: declared,
    platformDomains: PLATFORM,
    secretNames: ["partner_key"],
    secrets: staticSecretReader({ partner_key: "S3CRET-VALUE" }),
    transport: o.transport,
    limits: {
      requestsPerCall: o.perCall ?? 10,
      maxResponseBytes: 1024 * 1024,
      ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    },
    minuteGate: () => true,
    log: (e) => void log.push(e),
  });
}

describe("SSRF: refused before a connection", () => {
  // Direct transport WITHOUT the loopback allowance: every private answer is refused after DNS.
  const strict = () =>
    client({ transport: directTransport({ resolve: resolver, ca: tls.cert, port: upstreamPort }) });

  test.each([
    ["https://127.0.0.1/", "IP literal"],
    ["https://[::1]/", "IPv6 literal"],
    ["https://169.254.169.254/latest/meta-data", "metadata IP"],
    [`http://${HOST}/`, "plain http"],
    [`https://${HOST}:8443/`, "other port"],
    ["https://undeclared.partner.ru/", "undeclared host"],
    ["https://admin.borntobuild.ru/", "platform domain"],
  ])("%s (%s) → EGRESS_FORBIDDEN", async (url) => {
    const before = hits.length;
    await expect(strict().fetch(url)).rejects.toMatchObject({ code: "EGRESS_FORBIDDEN" });
    expect(hits.length).toBe(before);
  });

  test.each([
    ["loop.partner.ru", "127.0.0.1"],
    ["ten.partner.ru", "10.0.0.5"],
    ["meta.partner.ru", "169.254.169.254"],
    ["v6.partner.ru", "::1"],
    ["mixed.partner.ru", "public + 10.1.2.3"],
  ])("declared %s resolving to %s → EGRESS_FORBIDDEN, no request", async (host) => {
    const before = hits.length;
    await expect(strict().fetch(`https://${host}/`)).rejects.toMatchObject({ code: "EGRESS_FORBIDDEN" });
    expect(hits.length).toBe(before);
  });

  test("forbidden headers and undeclared secrets are refused", async () => {
    const c = strict();
    await expect(c.fetch(`https://${HOST}/`, { headers: { Host: "evil.ru" } })).rejects.toMatchObject({
      code: "EGRESS_FORBIDDEN",
    });
    await expect(
      c.fetch(`https://${HOST}/`, { headers: { "Proxy-Authorization": "x" } }),
    ).rejects.toMatchObject({
      code: "EGRESS_FORBIDDEN",
    });
    await expect(
      c.fetch(`https://${HOST}/`, { headers: { Authorization: "Bearer secret://other_key" } }),
    ).rejects.toMatchObject({ code: "EGRESS_FORBIDDEN" });
  });
});

describe("through the egress proxy with a runtime grant", () => {
  const grants = new EgressGrants();
  let proxyUrl = "";
  let proxy: ReturnType<typeof createEgressProxy>;
  const proxyLog: Record<string, unknown>[] = [];

  beforeAll(async () => {
    // The proxy asks the runtime's internal port about the grant, as egress-main does in the cluster.
    const internal = createInternalHandler({
      env: { ...devEnv, internalToken: "t".repeat(32) },
      systems: {} as never,
      db: {} as never,
      grants,
    });
    proxy = createEgressProxy({
      authorize: async (h) => {
        const token = h?.startsWith("Bearer ") ? h.slice(7) : "";
        const res = await internal(
          new Request("http://internal/_wizard/internal/egress-authorize", {
            method: "POST",
            headers: { "x-wizard-internal-token": "t".repeat(32) },
            body: JSON.stringify({ token }),
          }),
        );
        if (res.status !== 200) return null;
        const b = (await res.json()) as { https: string[]; smtp: string[] };
        return { https: new Set(b.https), smtp: new Set(b.smtp) };
      },
      resolve: resolver,
      dial: ({ host }) => tcpDialer({ host, port: upstreamPort }),
      allowLoopbackForTests: true,
      log: (l) => proxyLog.push(l),
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => proxy.close(() => r()));
  });

  const via = (hosts: string[], o: { perCall?: number; log?: unknown[] } = {}) => {
    const token = grants.issue({ systemId: "sys0000000a1", env: "prod", https: hosts }, 60_000);
    return client({
      transport: proxyTransport({ proxyUrl, grant: () => token, ca: tls.cert }),
      ...o,
    });
  };

  test("POST JSON → 200; the secret is resolved on the host, SNI/Host = the declared host", async () => {
    const log: unknown[] = [];
    const r = await via([HOST], { log }).fetch(`https://${HOST}/v1/leads?key=secret://partner_key`, {
      method: "POST",
      headers: { Authorization: "Bearer secret://partner_key", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Анна" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, echo: '{"name":"Анна"}' });
    const hit = hits.at(-1);
    expect(hit).toMatchObject({
      method: "POST",
      url: "/v1/leads?key=S3CRET-VALUE",
      auth: "Bearer S3CRET-VALUE",
      host: HOST,
    });
    expect(log).toEqual([
      expect.objectContaining({ host: HOST, method: "POST", status: 200, outcome: "ok" }),
    ]);
    expect(JSON.stringify(log)).not.toMatch(/S3CRET|leads|Анна/);
    expect(JSON.stringify(proxyLog)).not.toMatch(/S3CRET|leads/);
  });

  test("a host outside the grant and a name resolving to 10/8 → refused by the proxy", async () => {
    const before = hits.length;
    // The client allows ten.partner.ru (declared) but the proxy re-checks the address after resolution.
    await expect(via(["ten.partner.ru"]).fetch("https://ten.partner.ru/")).rejects.toMatchObject({
      code: "EGRESS_FORBIDDEN",
    });
    // Grant for another host: the proxy answers 403.
    await expect(via(["other.partner.ru"]).fetch(`https://${HOST}/`)).rejects.toMatchObject({
      code: "EGRESS_FORBIDDEN",
    });
    expect(hits.length).toBe(before);
  });

  test("redirects are not followed; response size and requests per call are limited", async () => {
    const before = hits.length;
    const r = await via([HOST]).fetch(`https://${HOST}/redirect`);
    expect(r.status).toBe(302);
    expect(hits.length).toBe(before + 1);
    await expect(via([HOST]).fetch(`https://${HOST}/big`)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    const c = via([HOST], { perCall: 2 });
    await c.fetch(`https://${HOST}/a`);
    await c.fetch(`https://${HOST}/b`);
    await expect(c.fetch(`https://${HOST}/c`)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  test("an unknown, forged or expired grant is refused at egress-authorize — and the text says so", async () => {
    const forged = (() => {
      const [p, body, sig] = grants
        .issue({ systemId: "sys0000000a1", env: "prod", https: ["other.partner.ru"] }, 60_000)
        .split(".") as [string, string, string];
      const g = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { https: string[] };
      g.https = [HOST];
      return `${p}.${Buffer.from(JSON.stringify(g)).toString("base64url")}.${sig}`;
    })();
    const expired = new EgressGrants(null, () => Date.now() - 120_000).issue(
      { systemId: "sys0000000a1", env: "prod", https: [HOST] },
      60_000,
    );
    for (const token of ["g2.unknown", "g1.legacy", forged, expired]) {
      const c = client({ transport: proxyTransport({ proxyUrl, grant: () => token, ca: tls.cert }) });
      const err = await c.fetch(`https://${HOST}/`).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "EGRESS_FORBIDDEN" });
      expect((err as Error).message).toMatch(/не подтвердил разрешение/);
      expect((err as Error).message).not.toMatch(/внутреннюю сеть/);
    }
  });

  test("a slow server dripping a byte at a time is cut by the overall deadline", async () => {
    const c = client({
      transport: proxyTransport({
        proxyUrl,
        grant: () => grants.issue({ systemId: "sys0000000a1", env: "prod", https: [HOST] }, 60_000),
        ca: tls.cert,
      }),
      timeoutMs: 700,
    });
    const t0 = Date.now();
    await expect(c.fetch(`https://${HOST}/drip`)).rejects.toMatchObject({
      code: "EGRESS_FAILED",
      message: "Внешний сервис отвечал слишком долго",
    });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("overall deadline without a proxy", () => {
  test("a server dripping a byte every 100 ms is cut at timeoutMs from the start", async () => {
    const log: unknown[] = [];
    const c = client({
      transport: directTransport({ resolve: resolver, ca: tls.cert, allowPrivate: true, port: upstreamPort }),
      timeoutMs: 700,
      log,
    });
    const t0 = Date.now();
    await expect(c.fetch(`https://${HOST}/drip`)).rejects.toMatchObject({
      code: "EGRESS_FAILED",
      message: "Внешний сервис отвечал слишком долго",
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(log).toEqual([expect.objectContaining({ host: HOST, outcome: "timeout" })]);
  });
});

describe("grants are checked by any runtime replica", () => {
  const KEY = new Uint8Array(randomBytes(32));
  const INTERNAL = "t".repeat(32);
  // Two independent runtime processes of one deployment: same env secret, separate memory.
  const replicaA = createEgressService({
    proxyUrl: "http://127.0.0.1:1",
    platformDomains: PLATFORM,
    grantKey: KEY,
  });
  const replicaB = createEgressService({
    proxyUrl: "http://127.0.0.1:1",
    platformDomains: PLATFORM,
    grantKey: KEY,
  });
  const authorizeAt = (grants: EgressGrants) => {
    const internal = createInternalHandler({
      env: { ...devEnv, internalToken: INTERNAL },
      systems: {} as never,
      db: {} as never,
      grants,
    });
    return async (token: string) =>
      internal(
        new Request("http://internal/_wizard/internal/egress-authorize", {
          method: "POST",
          headers: { "x-wizard-internal-token": INTERNAL },
          body: JSON.stringify({ token }),
        }),
      );
  };

  test("a grant issued by replica A is accepted at replica B; another key or a tampered grant is not", async () => {
    const token = replicaA.grants.issue({ systemId: "sys0000000a1", env: "prod", https: [HOST] }, 60_000);
    const res = await authorizeAt(replicaB.grants)(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ https: [HOST], smtp: [], label: "sys0000000a1" });
    expect(replicaB.grants.open(token)).toMatchObject({
      systemId: "sys0000000a1",
      env: "prod",
      https: [HOST],
    });
    const stranger = new EgressGrants(new Uint8Array(randomBytes(32)));
    expect((await authorizeAt(stranger)(token)).status).toBe(403);
    expect((await authorizeAt(replicaB.grants)(`${token.slice(0, -2)}AA`)).status).toBe(403);
  });

  test("ctx.http of a call on replica A goes through a proxy that asks replica B", async () => {
    const internalB = authorizeAt(replicaB.grants);
    const proxy = createEgressProxy({
      authorize: async (h) => {
        const res = await internalB(h?.startsWith("Bearer ") ? h.slice(7) : "");
        if (res.status !== 200) return null;
        const b = (await res.json()) as { https: string[]; smtp: string[] };
        return { https: new Set(b.https), smtp: new Set(b.smtp) };
      },
      resolve: resolver,
      dial: ({ host }) => tcpDialer({ host, port: upstreamPort }),
      allowLoopbackForTests: true,
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    try {
      const a = createEgressService({
        proxyUrl: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
        ca: tls.cert,
        platformDomains: PLATFORM,
        grantKey: KEY,
      });
      const sys = {
        spec: { functions: [{ name: "syncLead", egress: [HOST] }] },
        entry: { systemId: "sys0000000a1", env: "prod" },
        schema: "app_sys0000000a1_prod",
        data: { transaction: async () => undefined },
      } as never;
      const c = a.client(sys, "syncLead", staticSecretReader({}));
      if (!c) throw new Error("no client");
      const r = await c.fetch(`https://${HOST}/v1/ping`);
      expect(r.status).toBe(200);
    } finally {
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  });
});

describe("runtime service: journal _w_egress_log and the per-minute limit", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.close();
  });

  test("rows carry host, method, status and outcome — no path, query or body", async () => {
    const spec: AppSpec = forumSpec();
    const fn = (spec.functions ?? []).find((f) => f.name === "sendReminder");
    if (!fn) throw new Error("no sendReminder");
    fn.egress = [HOST];
    fn.secretRefs = ["secret://partner_key"];
    const slug = `eg${randomBytes(3).toString("hex")}`;
    const { schema } = await h.system(slug, spec);
    const resolved = await h.rt.systems.resolve(slug, "draft");
    if (!resolved) throw new Error("system not loaded");
    const service = createEgressService({
      direct: { resolve: resolver, ca: tls.cert, allowPrivate: true, port: upstreamPort },
      platformDomains: PLATFORM,
      limits: { requestsPerMinute: 2 },
    });
    const c = service.client(resolved, "sendReminder", staticSecretReader({ partner_key: "S3CRET-VALUE" }));
    if (!c) throw new Error("no client");
    expect((await c.fetch(`https://${HOST}/private/path?token=secret://partner_key`)).status).toBe(200);
    await expect(c.fetch("https://undeclared.partner.ru/x")).rejects.toMatchObject({
      code: "EGRESS_FORBIDDEN",
    });
    expect((await c.fetch(`https://${HOST}/second`)).status).toBe(200);
    // Third request in the same minute for this system → RATE_LIMITED (requestsPerMinute: 2).
    await expect(c.fetch(`https://${HOST}/third`)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const rows = await h.sql.unsafe(
      `select fn, host, method, status, outcome, bytes_in from ${quoteIdent(schema)}."_w_egress_log" order by id`,
    );
    expect(rows.map((r) => `${r.host}:${r.outcome}:${r.status ?? "-"}`)).toEqual([
      `${HOST}:ok:200`,
      "undeclared.partner.ru:forbidden:-",
      `${HOST}:ok:200`,
      `${HOST}:rate_limited:-`,
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/private|S3CRET|token/);
  });
});
