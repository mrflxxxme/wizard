// V3-21 acceptance (platform): (1) a key typed as text — in the first phrase, a message or an answer — is refused before
// anything is stored or reaches a model; (2) the agent's request_secret opens the platform's window with the recipient
// hosts and gets back only secret://name; the page encrypts the key in the browser (the real WebCrypto module of the
// page) and the platform opens it only inside the secret store; the key check of V3-20 goes only to the contract's host
// with the key substituted on the way out; (3) rotation (a failing new key keeps the old one; a passing one replaces it),
// re-check, the D37 check of window keys in a build, removal (back to the mock), deletion with the system; (4) canaries:
// no key ever appears in logs, model inputs, process output, API answers or any platform table. No external network.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockTransport } from "@wizard/agents/integrations";
import type { RouteInput, Router, RouterOptions } from "@wizard/llm";
import { dbSystemUuid, directTransport, MemoryFileStorage, storeSecrets } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CRM_HOST, crmOpenApi, crmSiteFetch } from "../../../packages/agents/test/integrations/fixtures.js";
import { sealSecret } from "../../platform-web/src/screens/v3/keys/seal.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { purgeDeletedSystems } from "../src/privacy/delete-system.js";
import type { InterviewHost } from "../src/runs/types.js";
import { SecretStore } from "../src/secrets/store.js";
import {
  REQUEST_SECRET_TOOL,
  runRequestSecret,
  secretEgressIssues,
  withKeyWindow,
} from "../src/secrets-v3/index.js";
import {
  createTestDb,
  fakeExecutors,
  fakeInterview,
  fakeRouterFactory,
  startApi,
  type TestApi,
  waitFor,
} from "./helpers.js";

const VIEWER = { "x-wizard-dev-user": "viewer-keys@example.test" };
// Keys of this file: random per run, never literals, never printed (assertions compare booleans).
const KEY = `crm-${randomBytes(12).toString("hex")}`;
const NEW_KEY = `crm-${randomBytes(12).toString("hex")}`;
const BAD_KEY = `crm-${randomBytes(12).toString("hex")}`;
const TYPED = `${"s"}k-proj-${randomBytes(24).toString("base64url")}`;
const CANARIES = [KEY, NEW_KEY, BAD_KEY, TYPED];
const leaks = (text: string) => CANARIES.filter((c) => text.includes(c)).length;

function cert(host: string): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "wz-keys-cert-"));
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
        ...["-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}`],
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

const tls = cert(CRM_HOST);
/** Keys the «CRM» accepts right now. */
const accepted = new Set([KEY]);
const hits: { host: string; keyOk: boolean; keyPresent: boolean }[] = [];
let upstream: Server;
let port = 0;
let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let systemId = "";
const logs: string[] = [];
const modelInputs: string[] = [];
const output: string[] = [];
const restore: (() => void)[] = [];

/** Everything a test could leak into: answers (collected), logs, model inputs, process output. */
const answers: string[] = [];
const call = async (
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
) => {
  const r = await api.req(method, path, init);
  answers.push(r.text);
  return r;
};

beforeAll(async () => {
  for (const s of [process.stdout, process.stderr]) {
    const orig = s.write.bind(s);
    s.write = ((chunk: unknown, ...rest: unknown[]) => {
      output.push(String(chunk));
      return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof s.write;
    restore.push(() => {
      s.write = orig;
    });
  }
  // The «CRM»: answers by the contract's mock, but only with an accepted X-Api-Key.
  upstream = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const key = (req.headers["x-api-key"] as string | undefined) ?? null;
    hits.push({
      host: String(req.headers.host ?? "").split(":")[0] ?? "",
      keyOk: !!key && accepted.has(key),
      keyPresent: !!key,
    });
    req.resume();
    req.on("end", async () => {
      if (!key || !accepted.has(key)) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad key"}');
        return;
      }
      const [latest] = await api.deps.pg`
        select contract from platform.system_integration_contracts where system_id = ${systemId}
         order by version desc limit 1`;
      const r = await mockTransport(latest?.contract)({
        method: req.method as "GET",
        url: `https://${CRM_HOST}${req.url}`,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
      });
      res.writeHead(r.status, { "content-type": "application/json" }).end(r.text);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  port = (upstream.address() as AddressInfo).port;
  tdb = await createTestDb("v3keys", { migrator: true });
  const base = fakeRouterFactory();
  api = await startApi(tdb.url, {
    executors: {
      ...fakeExecutors(),
      // What a real interview would hand to the model: the system's chat as the host gives it.
      interviewTurn: async (host: InterviewHost) => {
        modelInputs.push(JSON.stringify(host.context));
        return fakeInterview(host);
      },
    },
    createRouter: (opts: RouterOptions): Router => {
      const r = base(opts);
      return {
        ...r,
        route: async (input: RouteInput) => {
          modelInputs.push(JSON.stringify(input));
          return r.route(input);
        },
      };
    },
    log: (m, e) =>
      logs.push(`${m} ${e instanceof Error ? `${e.message} ${e.stack}` : JSON.stringify(e ?? null)}`),
    integrations: {
      research: { env: {}, mode: "fixture", fetch: crmSiteFetch(crmOpenApi()) },
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
  expect((await api.req("GET", "/me", { headers: VIEWER })).status).toBe(200);
  await api.deps.pg`update platform.memberships set role = 'viewer' where user_id =
    (select id from platform.users where email = 'viewer-keys@example.test')`;
  const key = randomBytes(6).toString("hex");
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `keys-${key.slice(0, 6)}`,
      schema_key: key,
      name: "Заявки в CRM",
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
      integrations: [{ id: "crm", name: "Partner CRM: заявки", direction: "out" }],
      data: [{ entity: "Заявка", fields: [{ name: "Телефон", pii: true }], retention: "3 года" }],
    },
  });
  const c = await api.req("POST", `/systems/${systemId}/integrations/crm/contract`, {
    body: { url: "https://partner-crm.ru/docs", need: "заявки с сайта в CRM" },
  });
  expect(c.status).toBe(201);
}, 60_000);

afterAll(async () => {
  for (const r of restore) r();
  await api?.dispose();
  await tdb?.drop();
  await new Promise((r) => upstream?.close(r));
});

const store = () => new SecretStore(api.deps.config.secretsFile, api.deps.config.secretsKey);
const contractStatus = async () =>
  (
    await api.deps.pg`
      select status from platform.system_integration_contracts where system_id = ${systemId}
       order by version desc limit 1`
  )[0]?.status as string;

/** The page's steps: read the window (public key), encrypt in «the browser», submit the ciphertext. */
async function enterKey(windowId: string, value: string) {
  const w = await call("GET", `/systems/${systemId}/secret-windows/${windowId}`);
  expect(w.status).toBe(200);
  const sealed = await sealSecret(w.body.window, value);
  return call("POST", `/systems/${systemId}/secret-windows/${windowId}/submit`, { body: sealed });
}

describe("a key typed as text is refused", () => {
  test("in a message, an answer and the first phrase: 400 SECRET_IN_TEXT, nothing stored, no run, no model", async () => {
    const runs = async () => Number((await api.deps.pg`select count(*)::int as n from platform.runs`)[0]?.n);
    const before = await runs();
    const m = await call("POST", `/systems/${systemId}/messages`, {
      body: { text: `Подключи CRM, вот ключ API: ${TYPED}` },
    });
    expect(m.status).toBe(400);
    expect(m.body).toMatchObject({ code: "VALIDATION_FAILED", details: { reason: "SECRET_IN_TEXT" } });
    expect(m.body.message_ru).toMatch(/окне ключа/);
    const a = await call("POST", `/systems/${systemId}/answers`, {
      body: { answers: [{ questionId: "q1", text: `токен ${TYPED}` }] },
    });
    expect(a.status).toBe(400);
    expect(a.body.details?.reason).toBe("SECRET_IN_TEXT");
    const s = await call("POST", "/systems", { body: { prompt: `Сайт кофейни, ключ ЮKassa ${TYPED}` } });
    expect(s.status).toBe(400);
    expect(await runs()).toBe(before);
    const stored = await api.deps.pg`select text from platform.messages where system_id = ${systemId}`;
    expect(stored).toHaveLength(0);
    // An ordinary message passes and reaches the (recorded) model input.
    const ok = await call("POST", `/systems/${systemId}/messages`, {
      body: { text: "Заявки с сайта — в CRM" },
    });
    expect(ok.status).toBe(202);
    await waitFor(async () => modelInputs.some((x) => x.includes("Заявки с сайта")));
  });
});

let windowId = "";

describe("request_secret and the window", () => {
  test("the tool returns only secret://name; the window shows the integration, the hosts and the purpose", async () => {
    expect(REQUEST_SECRET_TOOL.name).toBe("request_secret");
    const evil = await runRequestSecret(
      { pg: api.deps.pg, platformDomains: ["sandpile.ru"] },
      { systemId },
      { name: "crm_key", domain: "evil.example.com", purpose: "Подключить CRM", integrationId: "crm" },
    );
    expect(evil).toMatchObject({ status: "rejected", secretRef: "secret://crm_key" });
    expect(evil.message_ru).toContain(CRM_HOST);
    const internal = await runRequestSecret(
      { pg: api.deps.pg, platformDomains: ["sandpile.ru"] },
      { systemId },
      { name: "other_key", domain: "app.sandpile.ru", purpose: "Проверка" },
    );
    expect(internal.status).toBe("rejected");
    const r = await runRequestSecret(
      { pg: api.deps.pg, platformDomains: ["sandpile.ru"] },
      { systemId },
      { name: "crm_key", domain: CRM_HOST, purpose: "Отправлять заявки с сайта в CRM", integrationId: "crm" },
    );
    expect(r).toMatchObject({ status: "window_opened", secretRef: "secret://crm_key" });
    expect(Object.keys(r).sort()).toEqual(["message_ru", "secretRef", "status", "windowId"]);
    windowId = r.windowId as string;
    // The same request again keeps the open window.
    const again = await runRequestSecret(
      { pg: api.deps.pg, platformDomains: ["sandpile.ru"] },
      { systemId },
      { name: "crm_key", domain: CRM_HOST, purpose: "Отправлять заявки с сайта в CRM", integrationId: "crm" },
    );
    expect(again.windowId).toBe(windowId);

    const list = await call("GET", `/systems/${systemId}/secrets`, { headers: VIEWER });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(list.body.windows).toEqual([
      expect.objectContaining({
        id: windowId,
        name: "crm_key",
        secretRef: "secret://crm_key",
        integrationName: "Partner CRM: заявки",
        hosts: [CRM_HOST],
        requestedBy: "agent",
        status: "open",
      }),
    ]);
    expect(list.body.needed).toEqual([
      expect.objectContaining({
        integrationId: "crm",
        secretRef: "secret://crm_key",
        hosts: [CRM_HOST],
        present: false,
      }),
    ]);
    expect(list.body.items).toEqual([]);
  });

  test("the window's public key: P-256, made once, the private half sealed by the KMS; viewers may not open it", async () => {
    const a = await call("GET", `/systems/${systemId}/secret-windows/${windowId}`);
    expect(a.status).toBe(200);
    expect(a.body.window).toMatchObject({
      alg: "ECDH-ES+HKDF-SHA256+A256GCM",
      publicKey: { kty: "EC", crv: "P-256" },
      context: `wz-key-window/v1:${windowId}:${systemId}:draft:crm_key`,
    });
    expect(Object.keys(a.body.window.publicKey).sort()).toEqual(["crv", "kty", "x", "y"]);
    const b = await call("GET", `/systems/${systemId}/secret-windows/${windowId}`);
    expect(b.body.window.publicKey).toEqual(a.body.window.publicKey);
    const [row] = await api.deps.pg`
      select sealed_private, wrapped_dek, kek_backend, kek_name from platform.secret_windows where id = ${windowId}`;
    expect(row?.wrapped_dek).toMatch(/^local:v1:/);
    expect(row).toMatchObject({ kek_backend: "local", kek_name: "secret-window" });
    expect(String(row?.sealed_private)).not.toContain("PRIVATE");
    const viewer = await call("GET", `/systems/${systemId}/secret-windows/${windowId}`, { headers: VIEWER });
    expect(viewer.status).toBe(403);
  });

  test("a tampered or misdirected ciphertext does not open and leaves the window open; a wrong format too", async () => {
    const w = (await call("GET", `/systems/${systemId}/secret-windows/${windowId}`)).body.window;
    const sealed = await sealSecret(w, KEY);
    const flipped = `${sealed.ct.slice(0, -2)}${sealed.ct.endsWith("AA") ? "AB" : "AA"}`;
    const t = await call("POST", `/systems/${systemId}/secret-windows/${windowId}/submit`, {
      body: { ...sealed, ct: flipped },
    });
    expect(t.status).toBe(400);
    expect(t.body.details?.reason).toBe("SEAL_INVALID");
    const other = await sealSecret({ ...w, context: `${w.context}x` }, KEY);
    const o = await call("POST", `/systems/${systemId}/secret-windows/${windowId}/submit`, { body: other });
    expect(o.body.details?.reason).toBe("SEAL_INVALID");
    const plain = await call("POST", `/systems/${systemId}/secret-windows/${windowId}/submit`, {
      body: { v: 1, alg: "ECDH-ES+HKDF-SHA256+A256GCM", key: KEY },
    });
    expect(plain.status).toBe(400);
    const short = await enterKey(windowId, "abc");
    expect(short.body.details?.reason).toBe("KEY_FORMAT");
    expect(hits).toHaveLength(0);
    expect((await call("GET", `/systems/${systemId}/secrets`)).body.windows).toHaveLength(1);
  });

  test("the key: encrypted in the browser, checked through the egress client only at the contract's host, stored as secret://crm_key", async () => {
    const win = (await call("GET", `/systems/${systemId}/secret-windows/${windowId}`)).body.window;
    // Leading and trailing whitespace of a pasted key is not part of it.
    const sealed = await sealSecret(win, `  ${KEY}\n`);
    expect(JSON.stringify(sealed).includes(KEY)).toBe(false);
    const r = await call("POST", `/systems/${systemId}/secret-windows/${windowId}/submit`, { body: sealed });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toMatchObject({
      saved: true,
      secret: {
        name: "crm_key",
        secretRef: "secret://crm_key",
        hosts: [CRM_HOST],
        last4: KEY.slice(-4),
        version: 1,
        status: "ok",
        integrationName: "Partner CRM: заявки",
      },
      checks: [expect.objectContaining({ integrationId: "crm", ok: true, status: "live" })],
    });
    expect(r.body.message_ru).toMatch(/^Ключ сохранён: ••••.{4} и проверен/);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.host === CRM_HOST && h.keyOk)).toBe(true);
    expect(await contractStatus()).toBe("live");
    expect(store().get(systemId, "draft", "crm_key") === KEY).toBe(true);
    // V3-23: the runtime (same data volume and WIZARD_SECRETS_KEY) reads the key by the system's schema_key.
    const runtimeSecrets = storeSecrets({
      file: api.deps.config.secretsFile,
      keyMaterial: api.deps.config.secretsKey,
      systemUuid: dbSystemUuid(api.deps.pg),
    });
    const [row] = await api.deps.pg<{ schema_key: string }[]>`
      select schema_key from platform.systems where id = ${systemId}`;
    const key = row?.schema_key ?? "";
    expect((await runtimeSecrets(key, "draft").get("crm_key")) === KEY).toBe(true);
    await expect(runtimeSecrets(key, "prod").get("crm_key")).rejects.toMatchObject({
      code: "SECRET_MISSING",
    });
    // One-time window: its key pair is gone; a replay of the same ciphertext and a new read are refused.
    const [w] = await api.deps
      .pg`select status, public_jwk, sealed_private from platform.secret_windows where id = ${windowId}`;
    expect(w).toMatchObject({ status: "filled", public_jwk: null, sealed_private: null });
    const replay = await call("POST", `/systems/${systemId}/secret-windows/${windowId}/submit`, {
      body: sealed,
    });
    expect(replay.status).toBe(400);
    expect(replay.body.details?.reason).toBe("WINDOW_CLOSED");
    const reread = await call("GET", `/systems/${systemId}/secret-windows/${windowId}`);
    expect(reread.body.details?.reason).toBe("WINDOW_CLOSED");
    const list = await call("GET", `/systems/${systemId}/secrets`);
    expect(list.body.items).toEqual([
      expect.objectContaining({ name: "crm_key", last4: KEY.slice(-4), status: "ok" }),
    ]);
    expect(list.body.needed[0].present).toBe(true);
    // The agent asking again is told the key is there.
    const asked = await runRequestSecret(
      { pg: api.deps.pg },
      { systemId },
      { name: "crm_key", domain: CRM_HOST, purpose: "CRM", integrationId: "crm" },
    );
    expect(asked.status).toBe("already_set");
  });
});

describe("rotation, re-check, D37, removal", () => {
  test("a new key that fails its check is not stored: the old key keeps working and the integration stays live", async () => {
    const opened = await call("POST", `/systems/${systemId}/secret-windows`, {
      body: { integrationId: "crm" },
    });
    expect(opened.status).toBe(201);
    expect(opened.body.window).toMatchObject({ requestedBy: "user", hosts: [CRM_HOST], name: "crm_key" });
    const r = await enterKey(opened.body.window.id, BAD_KEY);
    expect(r.status).toBe(200);
    expect(r.body.saved).toBe(false);
    expect(r.body.message_ru).toMatch(/^Новый ключ не прошёл проверку: .+ Работает прежний ключ ••••/);
    expect(store().get(systemId, "draft", "crm_key") === KEY).toBe(true);
    expect(await contractStatus()).toBe("live");
  });

  test("a new key that passes replaces the old one (version 2, rotated); the old one is gone", async () => {
    accepted.add(NEW_KEY);
    const opened = await call("POST", `/systems/${systemId}/secret-windows`, {
      body: { integrationId: "crm" },
    });
    const r = await enterKey(opened.body.window.id, NEW_KEY);
    expect(r.body).toMatchObject({
      saved: true,
      secret: { version: 2, status: "ok", last4: NEW_KEY.slice(-4) },
    });
    expect(r.body.secret.rotatedAt).not.toBeNull();
    expect(store().get(systemId, "draft", "crm_key") === NEW_KEY).toBe(true);
    accepted.delete(KEY);
    hits.length = 0;
    const check = await call("POST", `/systems/${systemId}/secrets/crm_key/check`, { body: {} });
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({
      secret: { status: "ok" },
      checks: [expect.objectContaining({ ok: true })],
    });
    expect(hits.every((h) => h.host === CRM_HOST && h.keyOk)).toBe(true);
  });

  test("D37: a contract that grew a host beyond the window is not checked; a build function sending the key elsewhere stops", async () => {
    const [last] = await api.deps.pg`
      select contract, sha256, version from platform.system_integration_contracts where system_id = ${systemId}
       order by version desc limit 1`;
    const grown = {
      ...(last?.contract as Record<string, unknown>),
      hosts: [CRM_HOST, "collector.example.com"],
    };
    await api.deps.pg`
      insert into platform.system_integration_contracts (system_id, integration_id, version, contract, sha256, status)
      values (${systemId}, 'crm', ${Number(last?.version) + 1}, cast(cast(${JSON.stringify(grown)} as text) as jsonb),
              ${"f".repeat(64)}, 'live')`;
    hits.length = 0;
    const check = await call("POST", `/systems/${systemId}/secrets/crm_key/check`, { body: {} });
    expect(check.body.secret.status).toBe("failed");
    expect(check.body.checks[0]).toMatchObject({ ok: false, code: "HOSTS_CHANGED" });
    expect(hits).toHaveLength(0);
    const opened = await call("POST", `/systems/${systemId}/secret-windows`, {
      body: { integrationId: "crm" },
    });
    expect(opened.body.window.hosts).toEqual([CRM_HOST, "collector.example.com"]);
    await call("DELETE", `/systems/${systemId}/secret-windows/${opened.body.window.id}`);
    await api.deps.pg`
      delete from platform.system_integration_contracts where system_id = ${systemId} and version = ${Number(last?.version) + 1}`;

    const spec = {
      functions: [
        { name: "sendLead", egress: [CRM_HOST], secretRefs: ["secret://crm_key"] },
        { name: "leak", egress: ["collector.example.com"], secretRefs: ["secret://crm_key"] },
        { name: "other", egress: ["api.other.ru"], secretRefs: ["secret://other_key"] },
      ],
    };
    const issues = secretEgressIssues(spec, [{ name: "crm_key", hosts: [CRM_HOST] }]);
    expect(issues).toEqual([expect.objectContaining({ path: "/functions/1/egress/0" })]);
    const hook = withKeyWindow(async () => ({ spec }), { pg: api.deps.pg, systemId });
    await expect(hook({})).rejects.toThrow(/collector\.example\.com/);
    // V3-18: a deterministic stop — RunFailure in Russian, not retryable (not «Внутренняя ошибка прогона»).
    await expect(hook({})).rejects.toMatchObject({
      name: "RunFailure",
      code: "GATES_FAILED",
      retryable: false,
      message_ru: expect.stringMatching(/^Сборка остановлена: ключ доступа.*collector\.example\.com/),
    });
    const fine = withKeyWindow(async () => ({ spec: { functions: spec.functions.slice(0, 1) } }), {
      pg: api.deps.pg,
      systemId,
    });
    await expect(fine({})).resolves.toBeTruthy();
  });

  test("removal: the value, its metadata and binding go; the integration is back on the mock; then the agent asks again", async () => {
    const viewer = await call("DELETE", `/systems/${systemId}/secrets/crm_key`, { headers: VIEWER });
    expect(viewer.status).toBe(403);
    const r = await call("DELETE", `/systems/${systemId}/secrets/crm_key`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ removed: true, integrations: [{ integrationId: "crm", status: "mock" }] });
    expect(store().get(systemId, "draft", "crm_key")).toBeNull();
    expect(await contractStatus()).toBe("mock");
    const list = await call("GET", `/systems/${systemId}/secrets`);
    expect(list.body.items).toEqual([]);
    expect(list.body.needed[0].present).toBe(false);
    expect((await call("DELETE", `/systems/${systemId}/secrets/crm_key`)).status).toBe(404);
    // The build hook asks for the missing key (an agent window).
    const hook = withKeyWindow(async () => ({ spec: { functions: [] } }), { pg: api.deps.pg, systemId });
    await hook({});
    const after = await call("GET", `/systems/${systemId}/secrets`);
    expect(after.body.windows).toEqual([expect.objectContaining({ requestedBy: "agent", name: "crm_key" })]);
  });
});

describe("canaries and deletion", () => {
  test("no key in logs, model inputs, process output, API answers, the secret file or any platform table", async () => {
    expect(leaks(logs.join("\n"))).toBe(0);
    expect(leaks(modelInputs.join("\n"))).toBe(0);
    expect(leaks(output.join(""))).toBe(0);
    expect(leaks(answers.join("\n"))).toBe(0);
    expect(leaks(readFileSync(api.deps.config.secretsFile, "utf8"))).toBe(0);
    const tables = await api.deps.pg<{ t: string }[]>`
      select c.relname as t from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'platform' and c.relkind = 'r'`;
    let dumped = 0;
    for (const { t } of tables) {
      const rows = await api.deps.pg.unsafe(`select t::text as x from platform.${JSON.stringify(t)} t`);
      dumped += rows.length;
      expect(leaks(rows.map((r) => r.x as string).join("\n")), t).toBe(0);
    }
    expect(dumped).toBeGreaterThan(10);
  });

  test("a deleted system takes its windows and keys with it", async () => {
    accepted.add(KEY);
    const w = (await call("GET", `/systems/${systemId}/secrets`)).body.windows[0];
    expect((await enterKey(w.id, KEY)).body.saved).toBe(true);
    await api.deps
      .pg`update platform.systems set deleted_at = now() - interval '31 days' where id = ${systemId}`;
    const purged = await purgeDeletedSystems({
      db: api.deps.db,
      pg: api.deps.pg,
      blobs: api.deps.blobs,
      config: api.deps.config,
      files: new MemoryFileStorage(),
    });
    expect(purged.map((p) => p.systemId)).toContain(systemId);
    const [left] = await api.deps.pg<{ w: number; b: number; r: number }[]>`
      select (select count(*)::int from platform.secret_windows where system_id = ${systemId}) as w,
             (select count(*)::int from platform.secret_bindings where system_id = ${systemId}) as b,
             (select count(*)::int from platform.secrets_refs where system_id = ${systemId}) as r`;
    expect(left).toEqual({ w: 0, b: 0, r: 0 });
    expect(store().get(systemId, "draft", "crm_key")).toBeNull();
  });
});
