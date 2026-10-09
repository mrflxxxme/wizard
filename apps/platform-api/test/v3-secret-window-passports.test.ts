// V3-21 over the API passports of V3-22: the window of a passport integration asks for the passport's own fields; the
// page encrypts them, the platform composes the key (ЮKassa Basic, СДЭК token by Account and Secure password, amoCRM
// token for the account typed into the window), rebuilds a per-account contract for that account before the check, and
// a refused rotation never sends the old key to a new account. Local TLS «APIs» answer by the contracts' mocks; no
// external network, no model; keys are random per run and never printed.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockTransport } from "@wizard/agents/integrations";
import { directTransport } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sealSecret } from "../../platform-web/src/screens/v3/keys/seal.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { SecretStore } from "../src/secrets/store.js";
import { createTestDb, fakeExecutors, startApi, type TestApi } from "./helpers.js";

const HOSTS = ["api.yookassa.ru", "api.cdek.ru", "mycompany.amocrm.ru", "othercompany.amocrm.ru"];
const b64 = (n: number) => randomBytes(n).toString("base64url");
const AMO = `${b64(18)}.${b64(48)}.${b64(32)}`;
const AMO_BAD = `${b64(18)}.${b64(48)}.${b64(32)}`;
const SHOP = "506751";
const KASSA = `test_${b64(30)}`;
const CDEK_ID = b64(16);
const CDEK_SECRET = b64(24);
const CDEK_TOKEN = `${b64(20)}.${b64(40)}.${b64(20)}`;
const CANARIES = [AMO, AMO_BAD, KASSA, CDEK_ID, CDEK_SECRET, CDEK_TOKEN];
const leaks = (t: string) => CANARIES.filter((c) => t.includes(c)).length;
const basic = `Basic ${Buffer.from(`${SHOP}:${KASSA}`).toString("base64")}`;
/** Authorization values the «APIs» accept, by label (the labels go into the hits, never the values). */
const ACCEPT: Record<string, string> = { amo: `Bearer ${AMO}`, kassa: basic, cdek: `Bearer ${CDEK_TOKEN}` };
const labelOf = (auth: string | undefined) =>
  !auth
    ? "none"
    : (Object.entries(ACCEPT).find(([, v]) => v === auth)?.[0] ??
      (auth === `Bearer ${AMO_BAD}` ? "amo_bad" : "other"));

function cert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "wz-pass-cert-"));
  try {
    execFileSync(
      "openssl",
      [
        ...[
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-nodes",
          "-days",
          "2",
        ],
        ...[
          "-subj",
          "/CN=api.yookassa.ru",
          "-addext",
          `subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(",")}`,
        ],
        ...["-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")],
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
const hits: { host: string; path: string; auth: string }[] = [];
const answers: string[] = [];
const logs: string[] = [];
let upstream: Server;
let port = 0;
let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let systemId = "";

beforeAll(async () => {
  upstream = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const host = String(req.headers.host ?? "").split(":")[0] ?? "";
      const body = Buffer.concat(chunks).toString("utf8");
      const auth = req.headers.authorization as string | undefined;
      const send = (status: number, text: string) =>
        res.writeHead(status, { "content-type": "application/json" }).end(text);
      if ((req.url ?? "").endsWith("/oauth/token")) {
        const f = new URLSearchParams(body);
        const ok = f.get("client_id") === CDEK_ID && f.get("client_secret") === CDEK_SECRET;
        hits.push({ host, path: "/oauth/token", auth: ok ? "cdek_credentials" : "bad_credentials" });
        send(ok ? 200 : 401, ok ? JSON.stringify({ access_token: CDEK_TOKEN, expires_in: 3600 }) : "{}");
        return;
      }
      const label = labelOf(auth);
      hits.push({ host, path: (req.url ?? "").split("?")[0] ?? "", auth: label });
      if (!Object.keys(ACCEPT).includes(label)) {
        send(401, '{"error":"unauthorized"}');
        return;
      }
      const [row] = await api.deps.pg`
        select contract from platform.system_integration_contracts
         where system_id = ${systemId} and contract->'hosts' ? ${host} order by version desc limit 1`;
      const r = await mockTransport(row?.contract)({
        method: req.method as "GET",
        url: `https://${host}${req.url}`,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
        ...(body ? { body } : {}),
      });
      send(r.status, r.text);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  port = (upstream.address() as AddressInfo).port;
  tdb = await createTestDb("v3keyspass");
  api = await startApi(tdb.url, {
    executors: fakeExecutors(),
    log: (m, e) =>
      logs.push(`${m} ${e instanceof Error ? `${e.message} ${e.stack}` : JSON.stringify(e ?? null)}`),
    integrations: {
      keyCheck: {
        transport: directTransport({
          resolve: async () => ["127.0.0.1"],
          allowPrivate: true,
          port,
          ca: tls.cert,
        }),
        platformDomains: ["sandpile.ru"],
      },
    },
    secretWindow: { platformDomains: ["sandpile.ru"] },
  });
  const key = randomBytes(6).toString("hex");
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `pass-${key.slice(0, 6)}`,
      schema_key: key,
      name: "Магазин",
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  systemId = row.id;
  await saveBriefVersion(api.deps.db, {
    systemId,
    author: "agent",
    brief: {
      integrations: [
        { id: "amo", name: "amoCRM", direction: "out" },
        { id: "kassa", name: "ЮKassa", direction: "out" },
        { id: "cdek", name: "СДЭК", direction: "out" },
      ],
    },
  });
  for (const id of ["amo", "kassa", "cdek"]) {
    const c = await api.req("POST", `/systems/${systemId}/integrations/${id}/contract`, { body: {} });
    expect(c.status, id).toBe(201);
  }
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
  await new Promise((r) => upstream?.close(r));
});

const call = async (method: string, path: string, body?: unknown) => {
  const r = await api.req(method, path, body !== undefined ? { body } : {});
  answers.push(r.text);
  return r;
};
const store = () => new SecretStore(api.deps.config.secretsFile, api.deps.config.secretsKey);
const hostsOf = async (id: string) =>
  (
    await api.deps.pg`
      select contract from platform.system_integration_contracts where system_id = ${systemId} and integration_id = ${id}
       order by version desc limit 1`
  )[0]?.contract.hosts as string[];

/** Open the owner's window for an integration, encrypt the passport's fields «in the browser», submit. */
async function enter(integrationId: string, fields: Record<string, string>) {
  const o = await call("POST", `/systems/${systemId}/secret-windows`, { integrationId });
  expect(o.status).toBeLessThan(300);
  const w = o.body.window;
  const sealed = await sealSecret(w, JSON.stringify({ fields }));
  return { window: w, r: await call("POST", `/systems/${systemId}/secret-windows/${w.id}/submit`, sealed) };
}

describe("passport windows", () => {
  test("the window carries the passport's fields; amoCRM's hosts come from the account typed into it", async () => {
    const list = await call("GET", `/systems/${systemId}/secrets`);
    const amo = list.body.needed.find((n: { integrationId: string }) => n.integrationId === "amo");
    expect(amo).toMatchObject({
      hosts: ["your-account.amocrm.ru"],
      account: { label_ru: "Адрес аккаунта amoCRM", suffixes: ["amocrm.ru", "amocrm.com"] },
    });
    const o = await call("POST", `/systems/${systemId}/secret-windows`, { integrationId: "amo" });
    expect(o.body.window.form).toMatchObject({
      passport: "amocrm",
      compose: "plain",
      account: { field: "account", suffixes: ["amocrm.ru", "amocrm.com"] },
    });
    expect(o.body.window.form.fields.map((f: { key: string; secret: boolean }) => [f.key, f.secret])).toEqual(
      [
        ["account", false],
        ["token", true],
      ],
    );
    expect(typeof o.body.window.form.fields[1].pattern).toBe("string");
    // A wrong shape is refused before anything is stored and leaves the window open.
    const sealed = await sealSecret(
      o.body.window,
      JSON.stringify({ fields: { account: "mycompany", token: "abc" } }),
    );
    const bad = await call("POST", `/systems/${systemId}/secret-windows/${o.body.window.id}/submit`, sealed);
    expect(bad.status).toBe(400);
    expect(bad.body.details).toMatchObject({ reason: "KEY_FORMAT" });
    expect(bad.body.message_ru).toMatch(/Долгосрочный токен amoCRM/);
    expect(hits).toHaveLength(0);
  });

  test("amoCRM: the contract moves to the owner's account before the check; the key goes only there", async () => {
    const { r } = await enter("amo", { account: "https://mycompany.amocrm.ru/leads/", token: AMO });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      saved: true,
      secret: { name: "amo_key", hosts: ["mycompany.amocrm.ru"], last4: AMO.slice(-4), status: "ok" },
      checks: [expect.objectContaining({ integrationId: "amo", ok: true, status: "live" })],
    });
    expect(await hostsOf("amo")).toEqual(["mycompany.amocrm.ru"]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.host === "mycompany.amocrm.ru" && h.auth === "amo")).toBe(true);
    expect(store().get(systemId, "draft", "amo_key") === AMO).toBe(true);
  });

  test("a refused rotation to another account keeps the old key and account; the old key never reaches the new host", async () => {
    hits.length = 0;
    const { r } = await enter("amo", { account: "othercompany.amocrm.ru", token: AMO_BAD });
    expect(r.body.saved).toBe(false);
    expect(r.body.message_ru).toMatch(/Работает прежний ключ/);
    expect(await hostsOf("amo")).toEqual(["mycompany.amocrm.ru"]);
    expect(store().get(systemId, "draft", "amo_key") === AMO).toBe(true);
    expect(hits.filter((h) => h.host === "othercompany.amocrm.ru").every((h) => h.auth === "amo_bad")).toBe(
      true,
    );
    expect(hits.filter((h) => h.auth === "amo").every((h) => h.host === "mycompany.amocrm.ru")).toBe(true);
  });

  test("ЮKassa: shopId and the secret key become «Basic …» made by the platform", async () => {
    hits.length = 0;
    const { r } = await enter("kassa", { shop_id: SHOP, secret_key: KASSA });
    expect(r.body).toMatchObject({
      saved: true,
      secret: { name: "kassa_key", hosts: ["api.yookassa.ru"], last4: KASSA.slice(-4), status: "ok" },
    });
    expect(store().get(systemId, "draft", "kassa_key") === basic).toBe(true);
    expect(hits.every((h) => h.host === "api.yookassa.ru" && h.auth === "kassa")).toBe(true);
  });

  test("СДЭК: Account and Secure password are one oauth2cc: key; the egress client gets the token at the check, nobody stores it", async () => {
    hits.length = 0;
    const { r } = await enter("cdek", { client_id: CDEK_ID, client_secret: CDEK_SECRET });
    expect(r.body).toMatchObject({
      saved: true,
      secret: { name: "cdek_key", status: "ok", hosts: ["api.cdek.ru"], last4: CDEK_SECRET.slice(-4) },
    });
    expect(hits[0]).toEqual({ host: "api.cdek.ru", path: "/oauth/token", auth: "cdek_credentials" });
    expect(hits.slice(1).every((h) => h.host === "api.cdek.ru" && h.auth === "cdek")).toBe(true);
    const stored = store().get(systemId, "draft", "cdek_key") ?? "";
    expect(stored.startsWith("oauth2cc:")).toBe(true);
    expect(stored.includes(CDEK_TOKEN)).toBe(false);
    const check = await call("POST", `/systems/${systemId}/secrets/cdek_key/check`, {});
    expect(check.body.secret.status).toBe("ok");
    expect(hits.filter((h) => h.path === "/oauth/token").length).toBeLessThanOrEqual(2);
    const del = await call("DELETE", `/systems/${systemId}/secrets/cdek_key`);
    expect(del.status).toBe(200);
    expect(store().get(systemId, "draft", "cdek_key")).toBeNull();
    const refs = await api.deps
      .pg`select name from platform.secrets_refs where system_id = ${systemId} and name like 'cdek%'`;
    expect(refs).toHaveLength(0);
  });

  test("canaries: no field, key or token in answers, logs or any platform table", async () => {
    expect(leaks(answers.join("\n"))).toBe(0);
    expect(leaks(logs.join("\n"))).toBe(0);
    const tables = await api.deps.pg<{ t: string }[]>`
      select c.relname as t from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'platform' and c.relkind = 'r'`;
    for (const { t } of tables) {
      const rows = await api.deps.pg.unsafe(`select t::text as x from platform.${JSON.stringify(t)} t`);
      expect(leaks(rows.map((r) => r.x as string).join("\n")), t).toBe(0);
    }
  });
});
