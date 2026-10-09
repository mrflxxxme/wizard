// V3-22: ctx.http.fetch decodes compressed answers (gzip, deflate, br) under the response cap — a gzip bomb stops at the
// cap — and asks for them by default; a function's own Accept-Encoding is limited to what the runtime can decode. An
// OAuth client-credentials secret (oauth2cc:) becomes an access token of the same host, cached in memory until it
// expires, dropped on a 401; refused credentials answer 401 without calling the API. Local TLS upstream, no network.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { staticSecretReader } from "@wizard/connectors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  directTransport,
  type EgressLogEntry,
  egressHttpClient,
  OAuthTokenCache,
  oauthClientSecret,
  parseOAuthClientSecret,
} from "../src/index.js";

const HOST = "api.shop-partner.ru";
const OTHER = "auth.shop-partner.ru";

function cert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "wz-egress-enc-"));
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
        `subjectAltName=DNS:${HOST},DNS:${OTHER}`,
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
const JSON_BODY = JSON.stringify({ rows: [{ name: "Свеча ароматическая", stock: 12 }] });
const BOMB = gzipSync(Buffer.alloc(32 * 1024 * 1024));
let server: Server;
let port = 0;
const seen: { path: string; ae: string | null; auth: string | null; body: string }[] = [];
let tokenNo = 0;
let current = "";

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = "";
    req.on("data", (c: Buffer) => {
      b += c;
    });
    req.on("end", () => resolve(b));
  });

beforeAll(async () => {
  server = createServer({ key: tls.key, cert: tls.cert }, async (req, res) => {
    const path = req.url ?? "";
    const body = await readBody(req);
    seen.push({
      path,
      ae: (req.headers["accept-encoding"] as string | undefined) ?? null,
      auth: req.headers.authorization ?? null,
      body,
    });
    const send = (encoding: string | null, buf: Buffer, status = 200) => {
      res.writeHead(status, {
        "content-type": "application/json",
        ...(encoding ? { "content-encoding": encoding } : {}),
      });
      res.end(buf);
    };
    const plain = Buffer.from(JSON_BODY);
    if (path === "/gzip") return send("gzip", gzipSync(plain));
    if (path === "/deflate") return send("deflate", deflateSync(plain));
    if (path === "/deflate-raw") return send("deflate", deflateRawSync(plain));
    if (path === "/br") return send("br", brotliCompressSync(plain));
    if (path === "/bomb") return send("gzip", BOMB);
    if (path === "/zstd") return send("zstd", plain);
    if (path === "/corrupt") return send("gzip", Buffer.from("definitely not gzip"));
    if (path === "/ae")
      return send(null, Buffer.from(JSON.stringify({ ae: req.headers["accept-encoding"] ?? null })));
    if (path === "/v2/oauth/token") {
      const f = new URLSearchParams(body);
      if (
        f.get("grant_type") !== "client_credentials" ||
        f.get("client_id") !== "good" ||
        f.get("client_secret") !== "s3cret"
      )
        return send(null, Buffer.from('{"error":"invalid_client"}'), 401);
      tokenNo += 1;
      current = `tok-${tokenNo}-abcdefgh`;
      return send(
        "gzip",
        gzipSync(JSON.stringify({ access_token: current, token_type: "bearer", expires_in: 3599 })),
      );
    }
    if (path === "/v2/orders")
      return req.headers.authorization === `Bearer ${current}`
        ? send("gzip", gzipSync(plain))
        : send(null, Buffer.from('{"error":"expired"}'), 401);
    return send(null, Buffer.from("{}"), 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => server?.close(r));
});

function client(
  o: { secrets?: Record<string, string>; tokens?: OAuthTokenCache; log?: EgressLogEntry[] } = {},
) {
  return egressHttpClient({
    fn: "syncOrders",
    hosts: [HOST, OTHER],
    platformDomains: ["wizard.example"],
    secretNames: Object.keys(o.secrets ?? {}),
    secrets: staticSecretReader(o.secrets ?? {}),
    transport: directTransport({
      resolve: async () => ["127.0.0.1"],
      allowPrivate: true,
      port,
      ca: tls.cert,
    }),
    limits: { maxResponseBytes: 1024 * 1024 },
    minuteGate: () => true,
    log: (e) => void o.log?.push(e),
    ...(o.tokens ? { tokens: o.tokens } : {}),
  });
}

describe("compressed answers", () => {
  test.each(["/gzip", "/deflate", "/deflate-raw", "/br"])(
    "%s is decoded; gzip, deflate, br asked by default",
    async (p) => {
      const r = await client().fetch(`https://${HOST}${p}`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual(JSON.parse(JSON_BODY));
      expect(seen.at(-1)?.ae).toBe("gzip, deflate, br");
    },
  );

  test("a gzip bomb stops at the response cap (decoded size) — LIMIT_EXCEEDED, journal too_large", async () => {
    const log: EgressLogEntry[] = [];
    await expect(client({ log }).fetch(`https://${HOST}/bomb`)).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
    expect(BOMB.length).toBeLessThan(1024 * 1024);
    expect(log.at(-1)).toMatchObject({ outcome: "too_large" });
  });

  test("an unknown coding and a broken body are Russian errors", async () => {
    await expect(client().fetch(`https://${HOST}/zstd`)).rejects.toMatchObject({
      code: "EGRESS_FAILED",
      details: { message: expect.stringMatching(/неизвестным способом/) },
    });
    await expect(client().fetch(`https://${HOST}/corrupt`)).rejects.toMatchObject({
      code: "EGRESS_FAILED",
      details: { message: expect.stringMatching(/не распаковался/) },
    });
  });

  test("a function may narrow Accept-Encoding to what the runtime decodes, nothing else", async () => {
    const r = await client().fetch(`https://${HOST}/ae`, { headers: { "Accept-Encoding": "identity" } });
    expect(await r.json()).toEqual({ ae: "identity" });
    await expect(
      client().fetch(`https://${HOST}/ae`, { headers: { "Accept-Encoding": "compress, zstd" } }),
    ).rejects.toMatchObject({ code: "EGRESS_FORBIDDEN" });
  });
});

describe("OAuth client credentials (oauth2cc:)", () => {
  const good = oauthClientSecret({
    tokenUrl: `https://${HOST}/v2/oauth/token`,
    clientId: "good",
    clientSecret: "s3cret",
  });
  const call = (c: ReturnType<typeof client>) =>
    c.fetch(`https://${HOST}/v2/orders`, { headers: { Authorization: "Bearer secret://cdek_key" } });

  test("the secret value round-trips; anything else is not one", () => {
    expect(parseOAuthClientSecret(good)).toEqual({
      tokenUrl: `https://${HOST}/v2/oauth/token`,
      clientId: "good",
      clientSecret: "s3cret",
    });
    expect(parseOAuthClientSecret("plain-token")).toBeNull();
    expect(parseOAuthClientSecret("oauth2cc:bm90IGpzb24")).toBeNull();
    expect(
      parseOAuthClientSecret(
        oauthClientSecret({ tokenUrl: "http://x.ru/t", clientId: "a", clientSecret: "b" }),
      ),
    ).toBeNull();
  });

  test("a token is requested once, cached in memory, never journaled with path or body; a 401 drops it", async () => {
    const tokens = new OAuthTokenCache();
    const log: EgressLogEntry[] = [];
    const before = tokenNo;
    const r1 = await call(client({ secrets: { cdek_key: good }, tokens, log }));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual(JSON.parse(JSON_BODY));
    const tokenReq = seen.find((s) => s.path === "/v2/oauth/token" && s.body.includes("client_id=good"));
    expect(new URLSearchParams(tokenReq?.body).get("grant_type")).toBe("client_credentials");
    expect(seen.at(-1)).toMatchObject({ path: "/v2/orders", auth: `Bearer ${current}` });
    expect(log.map((e) => e.outcome)).toEqual(["token", "ok"]);
    expect(JSON.stringify(log)).not.toMatch(/s3cret|tok-|oauth/);
    // Another call of the process: the cached token, no second token request.
    expect((await call(client({ secrets: { cdek_key: good }, tokens }))).status).toBe(200);
    expect(tokenNo).toBe(before + 1);
    // The provider revoked it: the call sees 401, the next one gets a fresh token.
    current = "revoked";
    expect((await call(client({ secrets: { cdek_key: good }, tokens }))).status).toBe(401);
    expect((await call(client({ secrets: { cdek_key: good }, tokens }))).status).toBe(200);
    expect(tokenNo).toBe(before + 2);
  });

  test("an expired token is requested again", async () => {
    let now = Date.now();
    const tokens = new OAuthTokenCache(() => now);
    const before = tokenNo;
    expect((await call(client({ secrets: { cdek_key: good }, tokens }))).status).toBe(200);
    now += 3600 * 1000;
    expect((await call(client({ secrets: { cdek_key: good }, tokens }))).status).toBe(200);
    expect(tokenNo).toBe(before + 2);
  });

  test("refused credentials: 401 to the function, the API is not called; a token host other than the request's is refused", async () => {
    const bad = oauthClientSecret({
      tokenUrl: `https://${HOST}/v2/oauth/token`,
      clientId: "good",
      clientSecret: "wrong",
    });
    const log: EgressLogEntry[] = [];
    const calls = seen.filter((s) => s.path === "/v2/orders").length;
    const r = await call(client({ secrets: { cdek_key: bad }, tokens: new OAuthTokenCache(), log }));
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "oauth_token_refused" });
    expect(seen.filter((s) => s.path === "/v2/orders").length).toBe(calls);
    expect(log.map((e) => e.outcome)).toEqual(["token_refused", "auth_failed"]);
    const elsewhere = oauthClientSecret({
      tokenUrl: `https://${OTHER}/v2/oauth/token`,
      clientId: "good",
      clientSecret: "s3cret",
    });
    await expect(
      call(client({ secrets: { cdek_key: elsewhere }, tokens: new OAuthTokenCache() })),
    ).rejects.toMatchObject({
      code: "EGRESS_FORBIDDEN",
    });
  });
});
