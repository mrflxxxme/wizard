// V3-20 acceptance (platform): (1) documentation link → contract by code (discover_docs → openapi.json) with the field
// mapping, mock contract tests, a stored version and contractRef/secretRef in a new brief version; (2) the build hook
// gives the mock client without a key, the key check (through the runtime egress client to a local TLS «CRM») switches
// it on, the generated live client reaches only the contract's host with the key substituted by the egress client;
// (3) keys of the system's own API: shown once, sha256 at rest, role + scopes checked, the runtime serves /api/v1 with
// the role's permissions and RLS, the audit journal, revocation and system deletion. No external network, no model.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockTransport, parseContractRef } from "@wizard/agents/integrations";
import { type AppSpec, dropSystemRoleDDL, quoteIdent, type SystemBrief } from "@wizard/appspec";
import { staticSecretReader } from "@wizard/connectors";
import {
  createRuntimeApp,
  directTransport,
  egressHttpClient,
  hashApiKey,
  MemoryFileStorage,
  MemoryRegistry,
  migrateSystem,
  pgApiKeyStore,
  type RuntimeApp,
  schemaName,
} from "@wizard/runtime";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CRM_HOST, crmOpenApi, crmSiteFetch } from "../../../packages/agents/test/integrations/fixtures.js";
import { getLatestBrief, saveBriefVersion } from "../src/briefs/store.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { integrationsBuildHook, onIntegrationKey } from "../src/integrations-v3/service.js";
import { purgeDeletedSystems } from "../src/privacy/delete-system.js";
import { SecretStore } from "../src/secrets/store.js";
import { createTestDb, fakeExecutors, ROOT, startApi, type TestApi } from "./helpers.js";

const VIEWER = { "x-wizard-dev-user": "viewer-integ@example.test" };
const KEY = "crm-live-key-0123456789";

function cert(host: string): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "wz-integ-cert-"));
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
        `/CN=${host}`,
        "-addext",
        `subjectAltName=DNS:${host}`,
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

const tls = cert(CRM_HOST);
let upstream: Server;
let port = 0;
const hits: { method: string; url: string; key: string | null }[] = [];
let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let systemId = "";
let schemaKey = "";
let slug = "";
const forum = JSON.parse(readFileSync(join(ROOT, "specs/appspec/examples/forum.json"), "utf8")) as AppSpec;

const transport = () =>
  directTransport({ resolve: async () => ["127.0.0.1"], allowPrivate: true, port, ca: tls.cert });

beforeAll(async () => {
  // The «CRM»: answers by the contract's mock, but only with the right X-Api-Key.
  upstream = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const key = (req.headers["x-api-key"] as string | undefined) ?? null;
      hits.push({ method: req.method ?? "", url: req.url ?? "", key });
      if (key !== KEY) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad key"}');
        return;
      }
      const latest = await api.deps.pg`
        select contract from platform.system_integration_contracts where system_id = ${systemId}
         order by version desc limit 1`;
      const contract = latest[0]?.contract;
      const body = Buffer.concat(chunks).toString("utf8");
      const r = await mockTransport(contract)({
        method: req.method as "GET",
        url: `https://${CRM_HOST}${req.url}`,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
        ...(body ? { body } : {}),
      });
      res.writeHead(r.status, { "content-type": "application/json" }).end(r.text);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  port = (upstream.address() as AddressInfo).port;

  tdb = await createTestDb("v3integ", { migrator: true });
  api = await startApi(tdb.url, {
    executors: fakeExecutors(),
    integrations: {
      research: { env: {}, mode: "fixture", fetch: crmSiteFetch(crmOpenApi()) },
      keyCheck: { transport: transport(), platformDomains: ["sandpile.ru"] },
    },
  });
  expect((await api.req("GET", "/me", { headers: VIEWER })).status).toBe(200);
  await api.deps.pg`update platform.memberships set role = 'viewer' where user_id =
    (select id from platform.users where email = 'viewer-integ@example.test')`;
  schemaKey = randomBytes(6).toString("hex");
  slug = `crm-${schemaKey.slice(0, 6)}`;
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug,
      schema_key: schemaKey,
      name: "Форум",
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
        { id: "crm", name: "Partner CRM: заявки", direction: "out" },
        { id: "onec", name: "1С: Бухгалтерия", direction: "in" },
      ],
      data: [
        {
          entity: "Заявка",
          fields: [
            { name: "Имя", pii: true },
            { name: "Телефон", pii: true },
          ],
          retention: "3 года",
        },
      ],
    },
  });
  // The draft and the published revision: the forum spec.
  await api.deps.pg`
    insert into platform.revisions (system_id, version, kind, author, spec, files_manifest_sha)
    values (${systemId}, 1, 'files', 'agent', cast(cast(${JSON.stringify(forum)} as text) as jsonb), ${"0".repeat(64)})`;
  await api.deps.pg`update platform.systems set draft_revision = 1, prod_revision = 1 where id = ${systemId}`;
});

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
  await new Promise((r) => upstream?.close(r));
});

const secrets = () => new SecretStore(api.deps.config.secretsFile, api.deps.config.secretsKey);
const putKey = (value: string) =>
  api.deps.db
    .transaction()
    .execute((trx) =>
      secrets().put(trx, { orgId: DEFAULT_ORG_ID, systemId, env: "draft", name: "crm_key", value }),
    );
const briefNow = async (): Promise<SystemBrief> =>
  (await getLatestBrief(api.deps.db, systemId))?.brief as SystemBrief;

describe("outgoing: documentation → contract → mock → key check → live", () => {
  test("a documentation link gives the contract by code; mock tests pass; contractRef and secretRef land in the brief", async () => {
    const list = await api.req("GET", `/systems/${systemId}/integrations`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual(["crm", "onec"]);
    expect(list.body.items[0].contract).toBeNull();

    const r = await api.req("POST", `/systems/${systemId}/integrations/crm/contract`, {
      body: { url: "https://partner-crm.ru/docs", need: "заявки с сайта в CRM" },
    });
    expect(r.status).toBe(201);
    expect(parseContractRef(r.body.contractRef)).toMatchObject({ id: "crm", version: 1 });
    expect(r.body.contract).toMatchObject({
      status: "mock",
      hosts: [CRM_HOST],
      baseUrl: `https://${CRM_HOST}/v2`,
    });
    expect(r.body.contract.tests).toMatchObject({ ok: true });
    expect(
      r.body.contract.mapping.some(
        (m: { field: string; pointer: string }) => m.field === "Телефон" && m.pointer === "/body/phone",
      ),
    ).toBe(true);
    expect(r.body.check).toBeNull();
    const brief = await briefNow();
    expect(brief.integrations.find((i) => i.id === "crm")).toMatchObject({
      contractRef: r.body.contractRef,
      secretRef: "secret://crm_key",
    });
    const again = await api.req("POST", `/systems/${systemId}/integrations/crm/contract`, {
      body: { url: "https://partner-crm.ru/docs", need: "заявки с сайта в CRM" },
    });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
  });

  test("contract errors are Russian; an incoming integration has no contract; viewers cannot change", async () => {
    const bad = await api.req("POST", `/systems/${systemId}/integrations/crm/contract`, {
      body: { openapi: { hello: 1 } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.message_ru).toMatch(/OpenAPI/);
    const incoming = await api.req("POST", `/systems/${systemId}/integrations/onec/contract`, {
      body: { url: "https://partner-crm.ru/docs" },
    });
    expect(incoming.status).toBe(400);
    const viewer = await api.req("POST", `/systems/${systemId}/integrations/crm/check`, {
      body: {},
      headers: VIEWER,
    });
    expect(viewer.status).toBe(403);
  });

  test("no key: the build hook gives the mock client (no egress, no key) and the check says the key is missing", async () => {
    const hook = integrationsBuildHook(api.deps.pg, systemId);
    const layer = await hook({ brief: await briefNow(), spec: forum, files: {} });
    const fns = (layer?.spec.functions ?? []).filter((f) => f.file.startsWith("functions/integrations/crm/"));
    expect(fns.length).toBeGreaterThan(3);
    expect(fns.every((f) => !f.egress && !f.secretRefs)).toBe(true);
    const r = await api.req("POST", `/systems/${systemId}/integrations/crm/check`, { body: {} });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "mock", check: { ok: false, code: "SECRET_MISSING" } });
    expect(hits).toHaveLength(0);
  });

  test("a wrong key → failed (401 from the API); the right key → live: one GET to the contract's host with the key", async () => {
    await putKey("wrong-key");
    const failed = await api.req("POST", `/systems/${systemId}/integrations/crm/check`, { body: {} });
    expect(failed.body).toMatchObject({ state: "failed", check: { ok: false, code: "AUTH_FAILED" } });
    await putKey(KEY);
    hits.length = 0;
    const res = await onIntegrationKey(
      {
        db: api.deps.db,
        pg: api.deps.pg,
        config: api.deps.config,
        secrets: secrets(),
        keyCheck: { transport: transport(), platformDomains: [] },
      },
      { systemId, secretName: "crm_key" },
    );
    expect(res).toEqual([expect.objectContaining({ integrationId: "crm", ok: true, status: "live" })]);
    expect(hits).toEqual([{ method: "GET", url: expect.stringMatching(/^\/v2\//), key: KEY }]);
    const list = await api.req("GET", `/systems/${systemId}/integrations`);
    expect(list.body.items[0].contract.status).toBe("live");
    expect(list.body.items[0].keyPresent).toEqual({ draft: true, prod: false });
    // The key never leaves the vault: not in answers, not in the contract table.
    expect(list.text).not.toContain(KEY);
    const [row] = await api.deps
      .pg`select contract::text as c, key_check::text as k from platform.system_integration_contracts where system_id = ${systemId} order by version desc limit 1`;
    expect(`${row?.c}${row?.k}`).not.toContain(KEY);
  });

  test("live: functions get egress = the contract's host; the generated client reaches it with the key, nothing else", async () => {
    const hook = integrationsBuildHook(api.deps.pg, systemId);
    const layer = await hook({ brief: await briefNow(), spec: forum, files: {} });
    const fn = layer?.spec.functions?.find((f) => f.name === "crmCreateLead");
    expect(fn).toMatchObject({ kind: "action", egress: [CRM_HOST], secretRefs: ["secret://crm_key"] });
    const src = layer?.files["functions/integrations/crm/client.ts"] as string;
    expect(src).not.toContain(KEY);
    const js = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const client = (await import(
      `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
    )) as Record<string, (ctx: unknown, input: unknown) => Promise<unknown>>;
    // ctx.http of the function as the runtime builds it: its declared hosts and keys only.
    const http = egressHttpClient({
      fn: fn?.name ?? "",
      hosts: fn?.egress ?? [],
      platformDomains: [],
      secretNames: (fn?.secretRefs ?? []).map((r) => r.slice("secret://".length)),
      secrets: staticSecretReader({ crm_key: KEY }),
      transport: transport(),
      minuteGate: () => true,
      log: () => {},
    });
    const ctx = {
      http,
      error: (code: string, details: unknown) => Object.assign(new Error(code), { code, details }),
    };
    hits.length = 0;
    const lead = (await client.createLead?.(ctx, { body: { name: "Иван" } })) as { id: number; name: string };
    expect(typeof lead.id).toBe("number");
    expect(hits).toEqual([{ method: "POST", url: "/v2/leads", key: KEY }]);
    await expect(http.fetch("https://evil.example.ru/steal")).rejects.toMatchObject({
      code: "EGRESS_FORBIDDEN",
    });
    await expect(
      http.fetch(`https://${CRM_HOST}/v2/account`, { headers: { "X-Api-Key": "secret://other_key" } }),
    ).rejects.toMatchObject({
      code: "EGRESS_FORBIDDEN",
    });
    expect(hits).toHaveLength(1);
  });
});

describe("incoming: the system's own API with keys", () => {
  let rt: RuntimeApp;
  const role = `wz_rt_integ_${randomBytes(4).toString("hex")}`;
  const host = () => `${slug}.localhost:4100`;
  const call = (method: string, path: string, key: string | null, body?: unknown) =>
    rt.fetch(
      new Request(`http://127.0.0.1:4100${path}`, {
        method,
        headers: {
          host: host(),
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const keys: Record<string, { key: string; id: string }> = {};

  beforeAll(async () => {
    await api.deps.pg.unsafe(`CREATE ROLE ${quoteIdent(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await migrateSystem(api.deps.pg, { systemId: schemaKey, env: "prod", spec: forum, runtimeRole: role });
    rt = createRuntimeApp({
      db: api.deps.pg,
      registry: new MemoryRegistry(),
      dbRole: role,
      env: {
        authModeDev: true,
        devLogin: true,
        unsafeLocalExec: false,
        publicScheme: "http",
        platformOrigin: "http://localhost:5173",
        systemsDomain: "localhost",
        nodeEnv: "test",
        kubernetes: false,
      },
      apiKeys: pgApiKeyStore(api.deps.pg),
      files: null,
    });
    await rt.loadSystem({ systemKey: schemaKey, env: "prod", spec: forum, slug });
  });

  afterAll(async () => {
    const schema = schemaName(schemaKey, "prod");
    await api.deps.pg.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    for (const st of dropSystemRoleDDL(schema)) await api.deps.pg.unsafe(st).catch(() => {});
    await api.deps.pg.unsafe(`DROP OWNED BY ${quoteIdent(role)}`).catch(() => {});
    await api.deps.pg.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(role)}`).catch(() => {});
  });

  test("a key is shown once, stored as sha256; scopes are checked against the role; viewers cannot issue", async () => {
    const created = await api.req("POST", `/systems/${systemId}/api-keys`, {
      body: {
        name: "1С: Бухгалтерия",
        env: "prod",
        role: "organizer",
        scopes: [{ entity: "stream", ops: ["read", "create"] }],
      },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(created.body.key).toMatch(/^wzk_[a-z2-7]{40}$/);
    keys.onec = { key: created.body.key, id: created.body.item.id };
    expect(created.body.item.prefix).toBe((created.body.key as string).slice(0, 12));
    const [row] = await api.deps
      .pg`select key_hash, row_to_json(k)::text as t from platform.system_api_keys k where id = ${keys.onec.id}`;
    expect(row?.key_hash).toBe(hashApiKey(created.body.key));
    expect(row?.t).not.toContain(created.body.key);
    const list = await api.req("GET", `/systems/${systemId}/api-keys`, { headers: VIEWER });
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(created.body.key);
    expect(list.text).not.toContain(row?.key_hash);

    const partner = await api.req("POST", `/systems/${systemId}/api-keys`, {
      body: {
        name: "Партнёр",
        env: "prod",
        role: "partner",
        scopes: [{ entity: "partner_quota", ops: ["read"] }],
      },
    });
    keys.partner = { key: partner.body.key, id: partner.body.item.id };

    const wider = await api.req("POST", `/systems/${systemId}/api-keys`, {
      body: {
        name: "Шире роли",
        env: "prod",
        role: "partner",
        scopes: [{ entity: "partner_quota", ops: ["read", "delete"] }],
      },
    });
    expect(wider.status).toBe(400);
    expect(wider.body.message_ru).toMatch(/не может удалять/);
    const users = await api.req("POST", `/systems/${systemId}/api-keys`, {
      body: { name: "Люди", env: "prod", role: "organizer", scopes: [{ entity: "users", ops: ["read"] }] },
    });
    expect(users.status).toBe(400);
    const byViewer = await api.req("POST", `/systems/${systemId}/api-keys`, {
      headers: VIEWER,
      body: { name: "x", env: "prod", role: "organizer", scopes: [{ entity: "stream", ops: ["read"] }] },
    });
    expect(byViewer.status).toBe(403);
  });

  test("OpenAPI 3.1 of a key on the system host: only its scope", async () => {
    const byViewer = await api.req("GET", `/systems/${systemId}/api-keys/${keys.onec?.id}/openapi.json`, {
      headers: VIEWER,
    });
    expect(byViewer.status).toBe(403);
    const r = await api.req("GET", `/systems/${systemId}/api-keys/${keys.onec?.id}/openapi.json`);
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe("3.1.0");
    expect(r.body.servers[0].url).toMatch(new RegExp(`^http://${slug}\\.localhost:\\d+/api/v1$`));
    expect(Object.keys(r.body.paths).sort()).toEqual(["/data/stream", "/data/stream/{id}"]);
    expect(Object.keys(r.body.paths["/data/stream"]).sort()).toEqual(["get", "post"]);
  });

  test("the runtime serves /api/v1 by the platform's keys: role permissions and RLS hold, every request is journaled", async () => {
    const created = await call("POST", "/api/v1/data/stream", keys.onec?.key as string, {
      name: "Синхронизация 1С",
      capacity: 10,
    });
    expect(created.status).toBe(201);
    const listed = (await (await call("GET", "/api/v1/data/stream", keys.onec?.key as string)).json()) as {
      items: { name: string }[];
    };
    expect(listed.items.map((i) => i.name)).toContain("Синхронизация 1С");
    expect(
      (await call("DELETE", `/api/v1/data/stream/${randomUUID()}`, keys.onec?.key as string)).status,
    ).toBe(403);
    // partner_quota rows exist, but rowFilter $user.id has no user behind a key → none visible.
    await api.deps.pg.unsafe(
      `insert into ${quoteIdent(schemaName(schemaKey, "prod"))}.users (id, role, display_name) values ($1, 'partner', 'p')`,
      [randomUUID()],
    );
    const quota = await call("GET", "/api/v1/data/partner_quota", keys.partner?.key as string);
    expect(quota.status).toBe(200);
    expect(((await quota.json()) as { items: unknown[] }).items).toEqual([]);
    const calls = await api.req("GET", `/systems/${systemId}/api-keys/${keys.onec?.id}/calls`);
    expect(
      calls.body.items.map(
        (c: { target: string; status: number; method: string }) => `${c.method} ${c.target} ${c.status}`,
      ),
    ).toEqual(
      expect.arrayContaining(["POST data:stream 201", "GET data:stream 200", "DELETE data:stream/:id 403"]),
    );
    expect(calls.text).not.toContain("Синхронизация");
  });

  test("revocation stops the key at once; a deleted system stops all keys; the purge removes keys, journal and contracts", async () => {
    const revoked = await api.req("DELETE", `/systems/${systemId}/api-keys/${keys.onec?.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.item.revokedAt).not.toBeNull();
    expect((await call("GET", "/api/v1/data/stream", keys.onec?.key as string)).status).toBe(401);
    expect((await call("GET", "/api/v1/data/partner_quota", keys.partner?.key as string)).status).toBe(200);
    await api.deps
      .pg`update platform.systems set deleted_at = now() - interval '31 days' where id = ${systemId}`;
    expect((await call("GET", "/api/v1/data/partner_quota", keys.partner?.key as string)).status).toBe(401);
    await api.deps.pg.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName(schemaKey, "prod"))} CASCADE`);
    const purged = await purgeDeletedSystems({
      db: api.deps.db,
      pg: api.deps.pg,
      blobs: api.deps.blobs,
      config: api.deps.config,
      files: new MemoryFileStorage(),
    });
    expect(purged.map((p) => p.systemId)).toContain(systemId);
    const [left] = await api.deps.pg<{ k: number; c: number; i: number }[]>`
      select (select count(*)::int from platform.system_api_keys where system_id = ${systemId}) as k,
             (select count(*)::int from platform.system_api_calls where system_id = ${systemId}) as c,
             (select count(*)::int from platform.system_integration_contracts where system_id = ${systemId}) as i`;
    expect(left).toEqual({ k: 0, c: 0, i: 0 });
  });
});
