// V3-19 (runtime.yaml#auth.role_assignment (в)): the system owner from the platform gets the first isAdmin role at
// publication and signs in to the prod cabinet by an e-mail code; a repeated publication does not duplicate the user.
// Offline: the fake builder, the e-mail code goes to the runtime outbox.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { testPlatform } from "@wizard/connectors/testing";
import { createRuntimeApp, MemoryRegistry, ownerAdminRole, type RuntimeApp } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DEV_USER_EMAIL } from "../src/db/index.js";
import { startBuild } from "./flow.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  ROOT,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let rt: RuntimeApp;
const outboxDir = mkdtempSync(join(tmpdir(), "wz-pubowner-outbox-"));

beforeAll(async () => {
  tdb = await createTestDb("pubowner", { migrator: true });
  api = await startApi(tdb.url, {
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
    publish: {
      smoke: async () => ({ ok: true }),
      lockRetryDelaysMs: [10, 10, 10],
      telegram: { mode: "outbox", outboxDir: null },
    },
  });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
  rmSync(outboxDir, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON bodies in assertions
type Json = Record<string, any>;

describe("ownerAdminRole", () => {
  test("the first isAdmin login role, preferring one with email_otp; none → null", () => {
    const spec = JSON.parse(readFileSync(join(ROOT, "specs/appspec/examples/forum.json"), "utf8")) as AppSpec;
    expect(ownerAdminRole(spec)?.name).toBe("organizer");
    const roles = spec.roles.map((r) => ({ ...r, isAdmin: false }));
    expect(ownerAdminRole({ ...spec, roles })).toBeNull();
    const phoneFirst = [
      { ...roles[1], name: "boss", isAdmin: true, loginMethods: ["telegram"] },
      { ...roles[0], isAdmin: true },
      ...roles.slice(2),
    ] as AppSpec["roles"];
    expect(ownerAdminRole({ ...spec, roles: phoneFirst })?.name).toBe("organizer");
  });
});

describe("publish → the owner signs in to the prod cabinet as isAdmin", () => {
  let systemId = "";
  let key = "";
  let slug = "";
  let revision = 0;
  let cookie = "";
  const host = () => `${slug}.localhost`;
  const users = () =>
    api.deps.pg.unsafe(`select id, role, email from "app_${key}_prod".users where email = $1`, [
      DEV_USER_EMAIL,
    ]);

  async function call(method: string, path: string, body?: unknown, c?: string) {
    const headers: Record<string, string> = { host: host() };
    if (c) headers.cookie = c;
    if (method !== "GET") {
      headers.origin = `http://${host()}`;
      headers["x-wizard-request"] = "1";
      headers["content-type"] = "application/json";
    }
    const res = await rt.fetch(
      new Request(`http://127.0.0.1:4100${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    const text = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {}
    return { res, json, text };
  }

  async function publish() {
    const res = await api.req("POST", `/systems/${systemId}/publish`, {
      body: { revision, confirmDiff: true },
    });
    expect(res.status, res.text).toBe(202);
    return waitRun(api, res.body.run.id, ["succeeded", "failed"], 20_000);
  }

  beforeAll(async () => {
    const b = await startBuild(api);
    systemId = b.systemId;
    const run = await waitRun(api, b.buildRunId, ["succeeded"], 20_000);
    expect(run.status).toBe("succeeded");
    const s0 = await api.deps.db
      .selectFrom("platform.systems")
      .select(["schema_key", "slug", "draft_revision"])
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
    key = s0.schema_key;
    slug = s0.slug;
    const put = await api.req("PUT", `/systems/${systemId}/compliance`, {
      body: {
        expectedVersion: s0.draft_revision,
        operatorName: "ООО «Северный ритейл»",
        operatorContact: "privacy@north-retail.example",
        operatorAddress: "г. Москва, ул. Тверская, д. 1",
        operatorInn: "500100732259",
      },
    });
    expect(put.status, put.text).toBe(200);
    revision = put.body.revision.version;
  }, 60_000);

  test("first publication: the owner is a prod user of the first isAdmin role", async () => {
    const run = await publish();
    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
    const rows = await users();
    expect(rows.map((r) => r.role)).toEqual(["organizer"]);
  });

  test("the owner requests an e-mail code on the prod host and signs in as isAdmin", async () => {
    const spec = (await api.req("GET", `/systems/${systemId}/revisions/${revision}`)).body.spec as AppSpec;
    rt = createRuntimeApp({
      db: api.deps.pg,
      registry: new MemoryRegistry(),
      env: {
        authModeDev: true,
        devLogin: false,
        unsafeLocalExec: false,
        publicScheme: "http",
        platformOrigin: "http://localhost:5173",
        systemsDomain: "localhost",
        nodeEnv: "test",
        kubernetes: false,
      },
      platform: testPlatform(),
      outboxDir,
      auth: { secretsKey: "ab".repeat(24), limiter: { admit: async () => ({ ok: true }) } },
    });
    await rt.loadSystem({ systemKey: key, env: "prod", spec, slug });

    const start = await call("POST", "/api/auth/otp/start", {
      channel: "email",
      destination: DEV_USER_EMAIL,
    });
    expect(start.res.status, start.text).toBe(200);
    const mail = [...rt.outbox()].reverse().find((m) => (m.payload as Json)?.to === DEV_USER_EMAIL);
    const code = /(\d{6})/.exec(String((mail?.payload as Json)?.text ?? ""))?.[1];
    expect(code).toMatch(/^\d{6}$/);
    const c = (await call("GET", "/_wizard/spec")).json.compliance;
    const verify = await call("POST", "/api/auth/otp/verify", {
      challengeId: start.json.challengeId,
      code,
      _consent: { policyVersion: c.policyVersion, textHash: c.consentTextHash },
    });
    expect(verify.res.status, verify.text).toBe(200);
    expect(verify.json.user).toMatchObject({ role: "organizer", isAdmin: true });
    cookie = verify.res.headers
      .getSetCookie()
      .find((x) => x.startsWith("wz_sess="))
      ?.split(";")[0] as string;
    expect(cookie).toBeTruthy();
    const me = await call("GET", "/api/auth/me", undefined, cookie);
    expect(me.res.status).toBe(200);
    expect(me.json.user).toMatchObject({ role: "organizer", isAdmin: true });
  });

  test("a repeated publication keeps the one owner user (same id, session still valid)", async () => {
    const before = await users();
    const run = await publish();
    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
    const after = await users();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    const me = await call("GET", "/api/auth/me", undefined, cookie);
    expect(me.res.status).toBe(200);
    expect(me.json.user.isAdmin).toBe(true);
  });
});
