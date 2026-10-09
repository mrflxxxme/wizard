// V3-33 acceptance in platform-api: the flag (off by default, allowlisted orgs), the one-time consent with its text
// version, keys sealed by envelope encryption (local KEK and an OpenBao Transit stub), last 4 visible, the check call,
// pause and revocation (crypto-shredding), RLS by org, base URL rules, a whole build on the org's own key (scrubbed,
// llm_calls byok=true, nothing charged) and a canary key never reaching logs, errors, API answers or the database in
// clear. No external network: one loopback stub plays the user's gateway, a direct provider and OpenBao.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BYOK_CATALOG,
  type ByokCatalog,
  byokFetch,
  createRouter,
  MemoryUsageSink,
  type RouterOptions,
  validateByokCatalog,
} from "@wizard/llm";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsCjs from "ajv-formats";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { type ByokConfig, byokConfigFromEnv } from "../src/byok/config.js";
import {
  ByokService,
  type ByokServiceOptions,
  consentSha256,
  LocalTransit,
  OpenBaoTransit,
} from "../src/byok/index.js";
import { DEFAULT_ORG_ID, DEV_USER_ID } from "../src/db/index.js";
import { SecretStore } from "../src/secrets/store.js";
import { startBuild } from "./flow.js";
import { createTestDb, fakeExecutors, loadYaml, startApi, type TestApi, waitRun } from "./helpers.js";

// Canary keys: never printed by an assertion (booleans only), never in logs, errors, answers or clear in the database.
const KEY = `sk-canary-${randomBytes(12).toString("hex")}-GWKEY`;
const ZAI_KEY = `zk-canary-${randomBytes(12).toString("hex")}-ZAKEY`;
const WRONG = `sk-wrong-${randomBytes(12).toString("hex")}-BADKEY`;
const SECRETS = [KEY, ZAI_KEY, WRONG];
const leaks = (v: unknown): boolean => {
  const s = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
  return SECRETS.some((k) => s.includes(k));
};
const OTHER_EMAIL = "byok-other@wizard.local";
const VIEWER_EMAIL = "byok-viewer@wizard.local";
const PHONE = "+7 912 345-67-89";

interface Req {
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const okBody = (model: string) => ({
  id: "c",
  object: "chat.completion",
  created: 1,
  model,
  choices: [{ index: 0, message: { role: "assistant", content: "Готово" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
});

/** The loopback stub: /gw (the user's gateway), /zai (a direct provider), /platform-* (platform keys), /v1/transit. */
async function startStub() {
  const reqs: Req[] = [];
  const deks = new Map<string, string>();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      const path = req.url ?? "/";
      reqs.push({ path, method: req.method ?? "GET", headers: req.headers, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const auth = req.headers.authorization ?? "";
      if (path.startsWith("/v1/transit/")) {
        if (req.headers["x-vault-token"] !== "bao-test-token")
          return send(403, { errors: ["permission denied"] });
        if (path === "/v1/transit/datakey/plaintext/wizard-byok") {
          const plaintext = randomBytes(32).toString("base64");
          const id = randomBytes(8).toString("hex");
          deks.set(id, plaintext);
          return send(200, { data: { plaintext, ciphertext: `vault:v1:${id}` } });
        }
        if (path === "/v1/transit/decrypt/wizard-byok") {
          const id = String((JSON.parse(body) as { ciphertext: string }).ciphertext).replace("vault:v1:", "");
          const plaintext = deks.get(id);
          return plaintext ? send(200, { data: { plaintext } }) : send(400, { errors: ["bad"] });
        }
        return send(404, {});
      }
      if (path.startsWith("/gw/") || path.startsWith("/zai/")) {
        const want = path.startsWith("/gw/") ? KEY : ZAI_KEY;
        // A provider that echoes the key it refused (OpenAI does, masked): nothing of this may travel further.
        if (auth !== `Bearer ${want}`)
          return send(401, { error: { message: `Incorrect API key provided: ${auth}` } });
        if (path.endsWith("/models")) return send(200, { data: [{ id: "gpt-x-pro" }, { id: "glm-5.3" }] });
        return send(200, okBody("byok"));
      }
      if (path.startsWith("/platform-")) return send(200, okBody("platform"));
      return send(404, {});
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, reqs, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

let stub: Awaited<ReturnType<typeof startStub>>;
let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let svc: ByokService;
let catalog: ByokCatalog;
const logged: string[] = [];
let otherOrg = "";
const as = (email: string) => ({ headers: { "x-wizard-dev-user": email } });

const config = (orgs: string[]): ByokConfig => ({
  public: false,
  orgs: new Set(orgs),
  kms: "local",
  openbao: null,
  allowPrivateNetwork: true,
});

beforeAll(async () => {
  // Everything the process prints is kept for the grep at the end.
  for (const m of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : String(x))).join(" "));
    });
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      logged.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write);
  }
  // The capture itself is checked by the grep test (a sentinel line).
  console.info("byok: log capture on");
  stub = await startStub();
  catalog = validateByokCatalog({
    ...BYOK_CATALOG,
    providers: BYOK_CATALOG.providers.map((p) =>
      p.id === "zai" ? { ...p, baseUrl: `${stub.url}/zai/v1` } : p,
    ),
  });
  tdb = await createTestDb("byok");
  const env = {
    ZAI_BASE_URL: `${stub.url}/platform-zai`,
    ZAI_API_KEY: "platform-zai",
    CLOUDRU_BASE_URL: `${stub.url}/platform-cloudru`,
    CLOUDRU_API_KEY: "platform-cloudru",
  };
  api = await startApi(tdb.url, {
    executors: fakeExecutors({ spec: "forum" }),
    // The run engine's router, live against the stub: the org's own key comes through opts.byok.
    createRouter: (o: RouterOptions) => createRouter({ ...o, mode: "live", env, sleep: async () => {} }),
    byok: ({ pg, secrets }) => {
      svc = new ByokService({
        pg,
        config: config([DEFAULT_ORG_ID]),
        kms: new LocalTransit(secrets),
        catalog,
        fetch: byokFetch({ allowPrivateNetwork: true }),
      });
      return svc;
    },
    log: (m, e) => logged.push(`${m} ${e instanceof Error ? `${e.message} ${e.stack}` : String(e ?? "")}`),
  });
  const [o] = await api.deps
    .pg`insert into platform.orgs (name, region_code) values ('Чужая', '77') returning id`;
  otherOrg = String(o?.id);
  const [u] = await api.deps.pg`insert into platform.users (email) values (${OTHER_EMAIL}) returning id`;
  await api.deps
    .pg`insert into platform.memberships (org_id, user_id, role) values (${otherOrg}, ${u?.id}, 'owner')`;
  const [v] = await api.deps.pg`insert into platform.users (email) values (${VIEWER_EMAIL}) returning id`;
  await api.deps
    .pg`insert into platform.memberships (org_id, user_id, role) values (${DEFAULT_ORG_ID}, ${v?.id}, 'viewer')`;
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
  await stub?.close();
  vi.restoreAllMocks();
});

// ajv against api.yaml#components.schemas (as contract.test.ts does).
const doc = loadYaml("specs/platform/api.yaml") as { components: Record<string, unknown> };
const ajv = new Ajv2020({ strict: false, allErrors: true });
formatsCjs.default(ajv);
const rewrite = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(rewrite)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [
            k,
            k === "$ref" && typeof x === "string" ? `api${x}` : rewrite(x),
          ]),
        )
      : v;
ajv.addSchema({ $id: "api", components: rewrite(doc.components) });
const valid = (schema: "ByokState" | "ByokKey", body: unknown): boolean => {
  const fn = ajv.getSchema(`api#/components/schemas/${schema}`);
  if (!fn) throw new Error(`no schema ${schema}`);
  const ok = fn(body) as boolean;
  if (!ok) logged.push(`schema ${schema}: ${JSON.stringify(fn.errors)}`);
  return ok;
};

const BASE = `/orgs/${DEFAULT_ORG_ID}/byok`;
let gwKeyId = "";

describe("flag (off until V3-35) and consent", () => {
  test("defaults from env: off for everyone, OpenBao in production, private networks never in production", () => {
    const c = byokConfigFromEnv({});
    expect(c.public).toBe(false);
    expect(c.orgs.size).toBe(0);
    expect(c.kms).toBe("local");
    expect(byokConfigFromEnv({ NODE_ENV: "production" }).kms).toBe("openbao");
    expect(
      byokConfigFromEnv({ NODE_ENV: "production", WIZARD_BYOK_ALLOW_PRIVATE_NETWORK: "1" })
        .allowPrivateNetwork,
    ).toBe(false);
    expect([...byokConfigFromEnv({ WIZARD_BYOK_ORGS: `${DEFAULT_ORG_ID}, junk` }).orgs]).toEqual([
      DEFAULT_ORG_ID,
    ]);
  });

  test("an org outside the allowlist: {available: false}, mutations 403", async () => {
    const g = await api.req("GET", `/orgs/${otherOrg}/byok`, as(OTHER_EMAIL));
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ available: false });
    expect(valid("ByokState", g.body)).toBe(true);
    const p = await api.req("POST", `/orgs/${otherOrg}/byok/keys`, {
      ...as(OTHER_EMAIL),
      body: { provider: "openai", model: "m", key: KEY, gatewayUrl: `${stub.url}/gw/v1` },
    });
    expect(p.status).toBe(403);
    expect(leaks(p.text), "key in the answer").toBe(false);
  });

  test("allowlisted org: consent text with version; keys need it; wrong version 412; idempotent accept", async () => {
    const g = await api.req("GET", BASE);
    expect(g.status).toBe(200);
    expect(valid("ByokState", g.body)).toBe(true);
    expect(g.body.available).toBe(true);
    expect(g.body.consent.acceptedAt).toBeNull();
    expect(g.body.consent.paragraphs.join(" ")).toContain("заменяет персональные данные заглушками");
    expect(g.body.providers.find((p: { id: string }) => p.id === "openai")).toMatchObject({ direct: false });
    expect(g.body.callTypes).toContain("page_compose");
    expect(g.body.callTypes).not.toContain("techreview");

    const early = await api.req("POST", `${BASE}/keys`, {
      body: { provider: "openai", model: "gpt-x-pro", key: KEY, gatewayUrl: `${stub.url}/gw/v1` },
    });
    expect(early.status).toBe(422);
    expect(early.body.code).toBe("CONSENT_REQUIRED");
    expect(leaks(early.text), "key in the answer").toBe(false);

    const viewer = await api.req("POST", `${BASE}/consent`, { ...as(VIEWER_EMAIL), body: { version: "x" } });
    expect(viewer.status).toBe(403);
    expect((await api.req("POST", `${BASE}/consent`, { body: { version: "2020-01-01.1" } })).status).toBe(
      412,
    );
    const version = g.body.consent.version as string;
    const ok = await api.req("POST", `${BASE}/consent`, { body: { version } });
    expect(ok.status).toBe(200);
    expect(ok.body.consent.acceptedAt).not.toBeNull();
    expect((await api.req("POST", `${BASE}/consent`, { body: { version } })).status).toBe(200);
    const rows = await api.deps.pg`
      select user_id, text_version, text_sha256, accepted_at from platform.byok_consents where org_id = ${DEFAULT_ORG_ID}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: DEV_USER_ID,
      text_version: version,
      text_sha256: consentSha256(),
    });
  });
});

describe("keys: sealed, last 4, check, rules", () => {
  test("a gateway key: 201, last 4 only, «не проверена нами», check ok; the database holds ciphertext only", async () => {
    const res = await api.req("POST", `${BASE}/keys`, {
      body: { provider: "openai", model: "gpt-x-pro", key: KEY, gatewayUrl: `${stub.url}/gw/v1/` },
    });
    expect(leaks(res.text), "key in the answer").toBe(false);
    expect(res.status).toBe(201);
    expect(valid("ByokKey", res.body.key)).toBe(true);
    expect(res.body.key).toMatchObject({
      provider: "openai",
      model: "gpt-x-pro",
      verified: false,
      direct: false,
      last4: KEY.slice(-4),
      status: "active",
      check: { status: "ok", code: null },
    });
    gwKeyId = res.body.key.id;
    const [row] = await api.deps.pg`select * from platform.byok_keys where id = ${gwKeyId}`;
    expect(leaks(row), "key in clear in the database").toBe(false);
    expect(String(row?.wrapped_dek)).toMatch(/^local:v1:/);
    expect(row?.gateway_url).toBe(`${stub.url}/gw/v1`);
    // The check went to the gateway with the key in the header, and nowhere else.
    const check = stub.reqs.filter((r) => r.path === "/gw/v1/models");
    expect(check.length).toBe(1);
    expect(check[0]?.headers.authorization === `Bearer ${KEY}`).toBe(true);
    const list = await api.req("GET", BASE);
    expect(leaks(list.text), "key in GET").toBe(false);
    expect(list.body.keys.map((k: { id: string }) => k.id)).toEqual([gwKeyId]);
  });

  test("a direct provider (accepts RF): no gateway; a verified model; a wrong key fails the check without echo", async () => {
    const bad = await api.req("POST", `${BASE}/keys`, {
      body: { provider: "zai", model: "glm-5.3", key: WRONG },
    });
    expect(leaks(bad.text), "key in the answer").toBe(false);
    expect(bad.status).toBe(201);
    expect(bad.body.key).toMatchObject({
      verified: true,
      direct: true,
      gatewayHost: null,
      check: { status: "failed", code: "KEY_INVALID" },
    });
    expect(bad.body.key.check.message_ru).toContain("не принял ключ");
    const revoke = await api.req("DELETE", `${BASE}/keys/${bad.body.key.id}`);
    expect(revoke.body.key.status).toBe("revoked");
  });

  test("base URL rules and validation never echo the key", async () => {
    const add = (body: Record<string, unknown>) => api.req("POST", `${BASE}/keys`, { body });
    const cases: [Record<string, unknown>, string][] = [
      [{ provider: "openai", model: "m", key: KEY }, "gateway_required"],
      [
        { provider: "openai", model: "m", key: KEY, gatewayUrl: "https://api.openai.com/v1" },
        "official_host",
      ],
      [
        { provider: "zai", model: "glm-5.3", key: KEY, gatewayUrl: "https://proxy.example/v1" },
        "gateway_not_allowed",
      ],
      [{ provider: "openai", model: "m", key: KEY, gatewayUrl: "ftp://gw.example/v1" }, "bad_url"],
    ];
    for (const [body, reason] of cases) {
      const r = await add(body);
      expect(leaks(r.text), "key in the answer").toBe(false);
      expect(r.status, reason).toBe(400);
      expect(r.body.details?.reason, reason).toBe(reason);
    }
    const short = await add({ provider: "openai", model: "m", key: "abc", gatewayUrl: `${stub.url}/gw/v1` });
    expect(short.status).toBe(400);
    expect(short.body.details).toEqual({ field: "key" });
    const extra = await add({
      provider: "openai",
      model: "m",
      key: KEY,
      gatewayUrl: `${stub.url}/gw/v1`,
      x: 1,
    });
    expect(leaks(extra.text), "key in the answer").toBe(false);
    expect(extra.status).toBe(400);
    expect(extra.body.details).toEqual({ fields: ["(body)"] });
    const ct = await add({
      provider: "openai",
      model: "m",
      key: KEY,
      gatewayUrl: `${stub.url}/gw/v1`,
      callTypes: ["techreview"],
    });
    expect(ct.status).toBe(400);
    expect(ct.body.details).toEqual({ field: "callTypes" });
  });

  test("roles and other orgs: viewer reads only; another org's key is 404", async () => {
    const v = await api.req("GET", BASE, as(VIEWER_EMAIL));
    expect(v.status).toBe(200);
    expect(leaks(v.text), "key in GET").toBe(false);
    const p = await api.req("POST", `${BASE}/keys/${gwKeyId}/check`, as(VIEWER_EMAIL));
    expect(p.status).toBe(403);
    expect(p.body.code).toBe("NOT_OWNER");
    const foreign = await api.req("DELETE", `${BASE}/keys/${gwKeyId}`, as(OTHER_EMAIL));
    expect(foreign.status).toBe(404);
    const svcForeign = await svc.check(otherOrg, gwKeyId).catch((e: unknown) => e);
    expect((svcForeign as { code?: string }).code).toBe("FORBIDDEN");
  });

  test("RLS: without the org context nothing is visible; another org sees nothing", async () => {
    // A role without SUPERUSER/BYPASSRLS, as the platform login is in the cloud (the test login is a superuser).
    await api.deps.pg.unsafe(`DO $$ BEGIN
      CREATE ROLE wz_byok_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$`);
    await api.deps.pg.unsafe("GRANT USAGE ON SCHEMA platform TO wz_byok_rls_probe");
    await api.deps.pg.unsafe(
      "GRANT SELECT, UPDATE ON platform.byok_keys, platform.byok_consents TO wz_byok_rls_probe",
    );
    const count = (org: string | null) =>
      api.deps.pg.begin(async (sql) => {
        await sql`set local role wz_byok_rls_probe`;
        if (org) await sql`select pg_catalog.set_config('wizard.org_id', ${org}, true)`;
        const [k] = await sql`select count(*)::int as n from platform.byok_keys`;
        const [c] = await sql`select count(*)::int as n from platform.byok_consents`;
        const upd = await sql`update platform.byok_keys set model = model`;
        return { keys: k?.n, consents: c?.n, updated: upd.count };
      });
    expect(await count(null)).toEqual({ keys: 0, consents: 0, updated: 0 });
    expect(await count(otherOrg)).toEqual({ keys: 0, consents: 0, updated: 0 });
    const own = await count(DEFAULT_ORG_ID);
    expect(own.keys).toBeGreaterThan(0);
    expect(own.consents).toBe(1);
  });
});

describe("a build on the org's own key", () => {
  test("every model call of the build goes to the user's gateway scrubbed; llm_calls byok=true; nothing charged", async () => {
    const before = stub.reqs.length;
    const b = await startBuild(api, `Регистрация на форум, телефон организатора ${PHONE}`);
    await waitRun(api, b.buildRunId, ["succeeded"], 20_000);
    const rows = await api.deps.pg<
      {
        run_id: string;
        byok: boolean;
        tier: string;
        scrubbed: boolean;
        cost_rub: string;
        credits_milli: string;
        billable: boolean;
        provider: string;
        model_id: string;
        call_type: string;
      }[]
    >`select run_id, byok, tier, scrubbed, cost_rub, credits_milli, billable, provider, model_id, call_type
      from platform.llm_calls where system_id = ${b.systemId}`;
    // Interview, answers and build runs of the system.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows)
      expect(r, r.call_type).toMatchObject({
        byok: true,
        tier: "T1",
        scrubbed: true,
        cost_rub: "0.0000",
        credits_milli: "0",
        billable: false,
        provider: "byok:openai",
        model_id: "byok:gpt-x-pro",
      });
    const sent = stub.reqs.slice(before).filter((r) => r.path === "/gw/v1/chat/completions");
    expect(sent.length).toBe(rows.length);
    expect(sent.every((r) => r.headers.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(sent.some((r) => r.body.includes("912"))).toBe(false);
    expect(stub.reqs.slice(before).some((r) => r.path.startsWith("/platform-"))).toBe(false);
    const [charge] = await api.deps.pg`
      select coalesce(sum(amount_milli), 0)::int as milli from platform.credit_ledger
      where run_id = ${b.buildRunId} and kind = 'charge'`;
    expect(charge?.milli).toBe(0);
    const [key] = await api.deps
      .pg`select last_used_at, last_error_code from platform.byok_keys where id = ${gwKeyId}`;
    expect(key?.last_used_at).not.toBeNull();
    expect(key?.last_error_code).toBeNull();
  });

  test("paused key → the platform models (charged); active again → the key", async () => {
    const pause = await api.req("PATCH", `${BASE}/keys/${gwKeyId}`, { body: { status: "paused" } });
    expect(pause.body.key.status).toBe("paused");
    const resolver = svc.resolver();
    expect(await resolver.resolve(DEFAULT_ORG_ID, "page_compose")).toBeNull();
    await api.req("PATCH", `${BASE}/keys/${gwKeyId}`, { body: { status: "active" } });
    const route = await resolver.resolve(DEFAULT_ORG_ID, "page_compose");
    expect(route?.keyId).toBe(gwKeyId);
    expect((await route?.apiKey()) === KEY).toBe(true);
    // Another org never gets it; T0-only and check call types are refused before any lookup (packages/llm).
    expect(await resolver.resolve(otherOrg, "page_compose")).toBeNull();
  });

  test("a key the provider stops accepting is disabled until a new check", async () => {
    const resolver = svc.resolver();
    const route = await resolver.resolve(DEFAULT_ORG_ID, "page_compose");
    expect(route).not.toBeNull();
    await resolver.report?.(gwKeyId, { ok: false, errorCode: "HTTP_401" });
    expect(await resolver.resolve(DEFAULT_ORG_ID, "page_compose")).toBeNull();
    const again = await api.req("POST", `${BASE}/keys/${gwKeyId}/check`);
    expect(leaks(again.text), "key in the answer").toBe(false);
    expect(again.body.key.check).toMatchObject({ status: "ok", code: null });
    expect(await resolver.resolve(DEFAULT_ORG_ID, "page_compose")).not.toBeNull();
  });
});

describe("OpenBao Transit and revocation", () => {
  test("Transit wraps the data key (vault:v1:…); the key opens only through it", async () => {
    const o: ByokServiceOptions = {
      pg: api.deps.pg,
      config: config([DEFAULT_ORG_ID]),
      kms: new OpenBaoTransit({ addr: stub.url, token: "bao-test-token" }),
      catalog,
      fetch: byokFetch({ allowPrivateNetwork: true }),
    };
    const bao = new ByokService(o);
    const key = await bao.addKey(DEFAULT_ORG_ID, DEV_USER_ID, {
      provider: "zai",
      model: "glm-5.3",
      key: ZAI_KEY,
    });
    expect(key.check.status).toBe("ok");
    const [row] = await api.deps
      .pg`select wrapped_dek, kek_backend, kek_name, ciphertext from platform.byok_keys where id = ${key.id}`;
    expect(leaks(row), "key in clear in the database").toBe(false);
    expect(row).toMatchObject({ kek_backend: "openbao", kek_name: "wizard-byok" });
    expect(String(row?.wrapped_dek)).toMatch(/^vault:v1:/);
    expect(stub.reqs.some((r) => r.path === "/v1/transit/datakey/plaintext/wizard-byok")).toBe(true);
    // The local KEK cannot open it; a wrong token gets a value-free KMS error.
    const secrets = new SecretStore(`${api.artifactsDir}/.other-secrets.enc`, "x".repeat(32));
    const local = new ByokService({ ...o, kms: new LocalTransit(secrets) });
    expect((await local.check(DEFAULT_ORG_ID, key.id)).check.code).toBe("KMS_UNAVAILABLE");
    const badToken = new ByokService({ ...o, kms: new OpenBaoTransit({ addr: stub.url, token: "nope" }) });
    expect((await badToken.check(DEFAULT_ORG_ID, key.id)).check.code).toBe("KMS_UNAVAILABLE");
    expect((await bao.check(DEFAULT_ORG_ID, key.id)).check.status).toBe("ok");
    await bao.revoke(DEFAULT_ORG_ID, key.id, DEV_USER_ID);
  });

  test("revocation destroys the ciphertext and the wrapped data key; the key is gone from the API", async () => {
    const r = await api.req("DELETE", `${BASE}/keys/${gwKeyId}`);
    expect(r.status).toBe(200);
    expect(r.body.key.status).toBe("revoked");
    const [row] = await api.deps.pg`
      select ciphertext, wrapped_dek, revoked_at, revoked_by from platform.byok_keys where id = ${gwKeyId}`;
    expect(row).toMatchObject({ ciphertext: null, wrapped_dek: null, revoked_by: DEV_USER_ID });
    expect(row?.revoked_at).not.toBeNull();
    expect((await api.req("POST", `${BASE}/keys/${gwKeyId}/check`)).status).toBe(404);
    expect((await api.req("GET", BASE)).body.keys).toEqual([]);
    expect(await svc.resolver().resolve(DEFAULT_ORG_ID, "page_compose")).toBeNull();
  });
});

describe("the key never leaves in clear", () => {
  test("a direct router call: refused key → platform chain; error rows carry codes only", async () => {
    const sink = new MemoryUsageSink();
    const bad = await svc.addKey(DEFAULT_ORG_ID, DEV_USER_ID, {
      provider: "openai",
      model: "gpt-x-pro",
      key: KEY,
      gatewayUrl: `${stub.url}/gw/v1`,
    });
    const r = svc.resolver();
    const router = createRouter({
      mode: "live",
      env: { ZAI_BASE_URL: `${stub.url}/platform-zai`, ZAI_API_KEY: "platform-zai" },
      sink,
      byok: {
        ...r,
        // The stored key replaced by a wrong one at call time: the gateway echoes it in a 401.
        resolve: async (org, ct) => {
          const route = await r.resolve(org, ct);
          return route ? { ...route, apiKey: async () => WRONG } : null;
        },
      },
      sleep: async () => {},
    });
    const out = await router.route({
      callType: "page_compose",
      messages: [{ role: "user", content: "Страница контактов" }],
      orgPolicy: { ruOnly: false, t1Restricted: false },
      ctx: { orgId: DEFAULT_ORG_ID },
    });
    expect(leaks({ out, records: sink.records }), "key in the result or journal").toBe(false);
    expect(out.byok).toBeUndefined();
    expect(sink.records.map((x) => [x.byok ?? false, x.errorCode])).toEqual([
      [true, "HTTP_401"],
      [false, null],
    ]);
    await svc.revoke(DEFAULT_ORG_ID, bad.id, DEV_USER_ID);
  });

  test("grep: no canary key in anything the process printed or logged", () => {
    expect(logged.length).toBeGreaterThan(0);
    expect(
      logged.some((l) => leaks(l)),
      "a key in the logs",
    ).toBe(false);
  });
});
