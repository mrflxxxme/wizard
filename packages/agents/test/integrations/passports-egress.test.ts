// V3-22: the key check of passports through the runtime egress client (the platform's and the functions' only way out).
// A key in the URL path (Telegram /bot<token>/…, Bitrix24 /rest/<user>/<code>/…) is substituted on the way out; МойСклад
// answers only gzip — the client asks for it and decodes; СДЭК's Account and Secure password (one oauth2cc: value) are
// traded for an access token at call time. A local TLS «API» answers by the passport's mock (no external network).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { staticSecretReader } from "@wizard/connectors";
import { directTransport, egressHttpClient, OAuthTokenCache, parseOAuthClientSecret } from "@wizard/runtime";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  checkContractKey,
  type IntegrationContract,
  type IntegrationTransport,
  mockTransport,
  passportById,
  passportContract,
  passportKey,
  runContractTests,
} from "../../src/integrations/index.js";

const HOSTS = ["api.telegram.org", "mycompany.bitrix24.ru", "api.moysklad.ru", "api.cdek.ru"];
const MS_TOKEN = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const TG_TOKEN = "123456:test-only-not-a-real-bot-token-0000";
const B24_CODE = "q8bzjAbc123";

function cert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "wz-passport-cert-"));
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
        `/CN=${HOSTS[0]}`,
        "-addext",
        `subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(",")}`,
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
const hits: string[] = [];
let server: Server;
let port = 0;
const passport = (id: string) => {
  const p = passportById(id);
  if (!p) throw new Error(id);
  return p;
};
const telegram = passportContract(passport("telegram"));
const b24key = passportKey(passport("bitrix24"), {
  webhook_url: `https://mycompany.bitrix24.ru/rest/7/${B24_CODE}/`,
});
if (!b24key.ok) throw new Error("bitrix24 key");
const bitrix = passportContract(passport("bitrix24"), { account: b24key.account });
const moysklad = passportContract(passport("moysklad"));
const cdek = passportContract(passport("cdek"));
const cdekKey = passportKey(passport("cdek"), { client_id: "account0001", client_secret: "securepass01" });
if (!cdekKey.ok) throw new Error("cdek key");
let cdekToken = "";
let cdekTokens = 0;
const readBody = (req: import("node:http").IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
    });
    req.on("end", () => resolve(b));
  });

beforeAll(async () => {
  server = createServer({ key: tls.key, cert: tls.cert }, async (req, res) => {
    const host = String(req.headers.host ?? "");
    const url = req.url ?? "";
    const body = await readBody(req);
    hits.push(`${host}${url}`);
    const deny = (status: number) =>
      res.writeHead(status, { "content-type": "application/json" }).end('{"error":"denied"}');
    let contract: IntegrationContract;
    let gzip = false;
    if (host === "api.telegram.org" || host === "mycompany.bitrix24.ru") {
      contract = host === "api.telegram.org" ? telegram : bitrix;
      if (!url.startsWith(host === "api.telegram.org" ? `/bot${TG_TOKEN}/` : `/rest/7/${B24_CODE}/`))
        return deny(401);
    } else if (host === "api.moysklad.ru") {
      // МойСклад: only compressed answers, only to its token.
      if (!/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return deny(415);
      if (req.headers.authorization !== `Bearer ${MS_TOKEN}`) return deny(401);
      contract = moysklad;
      gzip = true;
    } else {
      contract = cdek;
      if (url === "/v2/oauth/token") {
        const f = new URLSearchParams(body);
        if (f.get("client_id") !== "account0001" || f.get("client_secret") !== "securepass01")
          return deny(401);
        cdekTokens += 1;
        cdekToken = `cdek-token-${cdekTokens}-abcdef`;
        return res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ access_token: cdekToken, token_type: "bearer", expires_in: 3599 }));
      }
      if (req.headers.authorization !== `Bearer ${cdekToken}`) return deny(401);
    }
    const r = await mockTransport(contract)({
      method: (req.method ?? "GET") as "GET",
      url: `https://${host}${url}`,
      headers: { Authorization: "Bearer x" },
      ...(body ? { body } : {}),
    });
    res.writeHead(r.status, {
      "content-type": "application/json",
      ...(gzip ? { "content-encoding": "gzip" } : {}),
    });
    res.end(gzip ? gzipSync(r.text) : r.text);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => server?.close(r));
});

/** The platform's key check transport: the runtime egress client, the contract's hosts and key only. */
function egressOf(
  c: IntegrationContract,
  value: string,
  tokens = new OAuthTokenCache(),
): IntegrationTransport {
  const name = (c.auth.secret ?? "").slice("secret://".length);
  const client = egressHttpClient({
    fn: `integration_check:${c.id}`,
    hosts: c.hosts,
    platformDomains: ["wizard.example"],
    secretNames: [name],
    secrets: staticSecretReader({ [name]: value }),
    transport: directTransport({
      resolve: async () => ["127.0.0.1"],
      allowPrivate: true,
      port,
      ca: tls.cert,
    }),
    limits: { requestsPerCall: 50 },
    minuteGate: () => true,
    log: () => {},
    tokens,
  });
  return async (req) => {
    const r = await client.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    return { status: r.status, contentType: r.contentType, text: await r.text() };
  };
}

test("Telegram: the token is substituted into /bot<token>/getMe by the egress client; a wrong token is AUTH_FAILED", async () => {
  expect(await checkContractKey(telegram, egressOf(telegram, TG_TOKEN))).toMatchObject({
    ok: true,
    verified: true,
  });
  expect(hits).toContain(`api.telegram.org/bot${TG_TOKEN}/getMe`);
  expect(await checkContractKey(telegram, egressOf(telegram, "1:wrong"))).toMatchObject({
    code: "AUTH_FAILED",
  });
});

test("Битрикс24: the webhook code goes into /rest/<user>/<code>/ on the owner's portal only", async () => {
  expect(bitrix.hosts).toEqual(["mycompany.bitrix24.ru"]);
  expect(JSON.stringify(bitrix)).not.toContain(B24_CODE);
  expect(await checkContractKey(bitrix, egressOf(bitrix, b24key.value ?? ""))).toMatchObject({
    ok: true,
    verified: true,
  });
  expect(hits).toContain(`mycompany.bitrix24.ru/rest/7/${B24_CODE}/crm.lead.fields.json`);
});

test("МойСклад: the egress client asks for gzip and decodes the compressed answer; the key check passes", async () => {
  expect(await checkContractKey(moysklad, egressOf(moysklad, MS_TOKEN))).toMatchObject({
    ok: true,
    verified: true,
  });
  expect(hits).toContain("api.moysklad.ru/api/remap/1.2/entity/organization?limit=10");
  expect(await checkContractKey(moysklad, egressOf(moysklad, "f".repeat(40)))).toMatchObject({
    code: "AUTH_FAILED",
  });
});

test("СДЭК: Account and Secure password are one oauth2cc: key; the token is requested at call time and cached", async () => {
  expect(parseOAuthClientSecret(cdekKey.value)).toEqual({
    tokenUrl: "https://api.cdek.ru/v2/oauth/token",
    clientId: "account0001",
    clientSecret: "securepass01",
  });
  const sandbox = passportKey(
    passport("cdek"),
    { client_id: "a1234567", client_secret: "b1234567" },
    { sandbox: true },
  );
  expect(sandbox.ok && parseOAuthClientSecret(sandbox.value)?.tokenUrl).toBe(
    "https://api.edu.cdek.ru/v2/oauth/token",
  );
  const tokens = new OAuthTokenCache();
  const before = cdekTokens;
  expect(await checkContractKey(cdek, egressOf(cdek, cdekKey.value, tokens))).toMatchObject({
    ok: true,
    verified: true,
  });
  const report = await runContractTests(cdek, egressOf(cdek, cdekKey.value, tokens));
  expect(report.results.filter((r) => !r.ok)).toEqual([]);
  expect(cdekTokens).toBe(before + 1);
  const wrong = passportKey(passport("cdek"), { client_id: "account0001", client_secret: "wrongpass01" });
  if (!wrong.ok) throw new Error("cdek key");
  expect(await checkContractKey(cdek, egressOf(cdek, wrong.value))).toMatchObject({ code: "AUTH_FAILED" });
});
