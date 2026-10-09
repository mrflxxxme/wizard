// V3-22: a key in the URL path (Telegram /bot<token>/…, Bitrix24 /rest/<user>/<code>/…) reaches the API only through the
// runtime egress client — the request leaves with secret://name, the client substitutes the value on the way out, only
// to the contract's host. A local TLS «API» answers by the passport's mock only to the right key (no external network).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticSecretReader } from "@wizard/connectors";
import { directTransport, egressHttpClient } from "@wizard/runtime";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  checkContractKey,
  type IntegrationContract,
  type IntegrationTransport,
  mockTransport,
  passportById,
  passportContract,
  passportKey,
} from "../../src/integrations/index.js";

const HOSTS = ["api.telegram.org", "mycompany.bitrix24.ru"];
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

beforeAll(async () => {
  server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const host = String(req.headers.host ?? "");
    const url = req.url ?? "";
    hits.push(`${host}${url}`);
    const contract = host === "api.telegram.org" ? telegram : bitrix;
    const key = host === "api.telegram.org" ? `/bot${TG_TOKEN}/` : `/rest/7/${B24_CODE}/`;
    if (!url.startsWith(key)) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"ok":false,"error_code":401}');
      return;
    }
    void mockTransport(contract)({
      method: (req.method ?? "GET") as "GET",
      url: `https://${host}${url}`,
      headers: {},
    }).then((r) => res.writeHead(r.status, { "content-type": "application/json" }).end(r.text));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => server?.close(r));
});

/** The platform's key check transport: the runtime egress client, the contract's hosts and key only. */
function egressOf(c: IntegrationContract, value: string): IntegrationTransport {
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
    minuteGate: () => true,
    log: () => {},
  });
  return async (req) => {
    const r = await client.fetch(req.url, { method: req.method, headers: req.headers });
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
