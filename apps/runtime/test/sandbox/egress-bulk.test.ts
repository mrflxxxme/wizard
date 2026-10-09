// V3-32: the egress proxy for the repository sandbox's package installs. platform-api issues a grant (same key as the
// runtime) for the registry hosts with its own tunnel limits — one registry tarball may exceed the proxy's default
// 50 MiB — and the package managers send it as the password of the proxy URL (Basic). Everything else stays as M2-52:
// the proxy asks egress-authorize, only granted hosts on :443, SNI = CONNECT host. No traffic leaves this machine.
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEgressProxy,
  EgressGrants,
  GRANT_MAX_BYTES,
  proxyToken,
  remoteCapabilityAuthorizer,
} from "../../src/index.js";
import { createInternalHandler } from "../../src/internal.js";
import { devEnv } from "../helpers.js";

const REGISTRY = "registry.npmjs.org";
const TOKEN = "t".repeat(32);
const grants = new EgressGrants();
const basic = (token: string) => `Basic ${Buffer.from(`wizard:${token}`).toString("base64")}`;

describe("bulk grants", () => {
  it("carry their tunnel limits, bounded; a plain grant has none", () => {
    const bulk = grants.issue(
      {
        systemId: "repo_sandbox",
        env: "draft",
        https: [REGISTRY],
        maxBytes: 1 << 30,
        maxDurationMs: 600_000,
      },
      600_000,
    );
    expect(grants.open(bulk)).toMatchObject({ https: [REGISTRY], maxBytes: 1 << 30, maxDurationMs: 600_000 });
    const plain = grants.open(
      grants.issue({ systemId: "repo_sandbox", env: "draft", https: [REGISTRY] }, 1000),
    );
    expect(plain).not.toHaveProperty("maxBytes");
    expect(() =>
      grants.issue({ systemId: "r", env: "draft", https: [REGISTRY], maxBytes: GRANT_MAX_BYTES + 1 }, 1000),
    ).toThrow(/invalid/);
    expect(() =>
      grants.issue({ systemId: "r", env: "draft", https: [REGISTRY], maxDurationMs: 10 }, 1000),
    ).toThrow(/invalid/);
  });

  it("the proxy credentials: Bearer <token>, or a grant as the password of Basic (never a capability token)", () => {
    expect(proxyToken("Bearer abc")).toBe("abc");
    expect(proxyToken(basic("g2.x.y"))).toBe("g2.x.y");
    expect(proxyToken(basic("v1.capability"))).toBeNull();
    expect(proxyToken(`Basic ${Buffer.from("no-colon").toString("base64")}`)).toBeNull();
    expect(proxyToken("Digest x")).toBeNull();
    expect(proxyToken(undefined)).toBeNull();
  });
});

describe("through the proxy with a bulk grant", () => {
  const received: number[] = [];
  const sockets = new Set<Socket>();
  const logs: Record<string, unknown>[] = [];
  let upstream: Server;
  let proxy: Server;
  let proxyPort = 0;
  let clientHello: Buffer = Buffer.alloc(0);

  beforeAll(async () => {
    upstream = createServer((s) => {
      sockets.add(s);
      const i = received.push(0) - 1;
      s.on("data", (b: Buffer) => {
        received[i] = (received[i] ?? 0) + b.length;
      });
      s.on("error", () => {});
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    // A real ClientHello with SNI = the registry host, captured once from a local listener.
    clientHello = await new Promise<Buffer>((resolve) => {
      const grab = createServer((s) => {
        s.once("data", (b: Buffer) => {
          resolve(b);
          s.destroy();
          grab.close();
        });
      });
      grab.listen(0, "127.0.0.1", () => {
        const port = (grab.address() as { port: number }).port;
        const t = tlsConnect({ host: "127.0.0.1", port, servername: REGISTRY, rejectUnauthorized: false });
        t.on("error", () => {});
      });
    });
    const internal = createInternalHandler({
      env: { ...devEnv, internalToken: TOKEN },
      systems: {} as never,
      db: {} as never,
      grants,
    });
    proxy = createEgressProxy({
      // As egress-main: the runtime's internal port decides, here called in process.
      authorize: remoteCapabilityAuthorizer({
        runtimeInternalUrl: "http://internal",
        internalToken: TOKEN,
        fetch: ((url: string, init: RequestInit) => internal(new Request(url, init))) as typeof fetch,
      }),
      resolve: async (h) => (h === REGISTRY ? ["104.16.1.35"] : []),
      dial: () =>
        new Promise((resolve, reject) => {
          const s = netConnect(upstreamPort, "127.0.0.1", () => resolve(s));
          s.on("error", reject);
        }),
      maxBytes: 4096,
      log: (l) => logs.push(l),
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyPort = (proxy.address() as { port: number }).port;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => proxy?.close(r));
    await new Promise((r) => upstream?.close(r));
  });

  /** CONNECT with Basic credentials, then the ClientHello and `bytes` more; resolves with the bytes upstream got. */
  const push = (target: string, token: string, bytes: number) =>
    new Promise<{ status: number; got: number }>((resolve, reject) => {
      const before = received.length;
      const s = netConnect(proxyPort, "127.0.0.1", () => {
        sockets.add(s);
        s.write(
          `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${basic(token)}\r\n\r\n`,
        );
      });
      let head = "";
      // A tunnel cut at its limit resets the client side: only an error before the CONNECT answer fails the call.
      s.on("error", (e) => (head.includes("\r\n\r\n") ? undefined : reject(e)));
      s.on("data", (b: Buffer) => {
        if (head.includes("\r\n\r\n")) return;
        head += b.toString("latin1");
        if (!head.includes("\r\n\r\n")) return;
        const status = Number(head.split(" ")[1]);
        if (status !== 200) return resolve({ status, got: 0 });
        s.write(Buffer.concat([clientHello, Buffer.alloc(bytes, 7)]));
        setTimeout(() => resolve({ status, got: received[before] ?? 0 }), 300);
      });
    });

  it("a bulk grant opens only its hosts and carries more than the proxy's default per tunnel", async () => {
    const bulk = grants.issue(
      { systemId: "repo_sandbox", env: "draft", https: [REGISTRY], maxBytes: 1 << 20, maxDurationMs: 60_000 },
      60_000,
    );
    const big = await push(`${REGISTRY}:443`, bulk, 64 * 1024);
    expect(big.status).toBe(200);
    expect(big.got).toBe(clientHello.length + 64 * 1024);
    expect((await push("evil.example.ru:443", bulk, 10)).status).toBe(403);
    expect((await push(`${REGISTRY}:80`, bulk, 10)).status).toBe(403);
  });

  it("a plain grant keeps the proxy's limit; a forged or capability token gets 407", async () => {
    const plain = grants.issue({ systemId: "repo_sandbox", env: "draft", https: [REGISTRY] }, 60_000);
    const cut = await push(`${REGISTRY}:443`, plain, 64 * 1024);
    expect(cut.status).toBe(200);
    expect(cut.got).toBeLessThanOrEqual(4096);
    expect(logs.some((l) => l.outcome === "max_bytes")).toBe(true);
    const forged = `${plain.slice(0, -4)}AAAA`;
    expect((await push(`${REGISTRY}:443`, forged, 10)).status).toBe(407);
    expect((await push(`${REGISTRY}:443`, "v1.not-a-grant", 10)).status).toBe(407);
  });
});
