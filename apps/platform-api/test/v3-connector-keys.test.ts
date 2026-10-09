// V3-23: the keys of a module's connector integration (the shop's ЮKassa: secret://yookassa_shop_id and
// secret://yookassa_secret_key) are listed as needed and entered through the platform's key window opened by the key's
// name; the window's only recipient is the connector's fixed host. V3-18: prod keys are the owner's (editors → 403
// NOT_OWNER), a new prod payment key is announced to the owners by mail, the agent cannot point a connector key at
// another host, and publishing refuses a revision whose function would send a window key elsewhere (D37). No external
// network.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sealSecret } from "../../platform-web/src/screens/v3/keys/seal.js";
import type { MailMessage } from "../src/auth/mailer.js";
import { DEFAULT_ORG_ID, DEV_USER_EMAIL, DEV_USER_ID, json } from "../src/db/index.js";
import { SecretStore } from "../src/secrets/store.js";
import { requestSecret, runRequestSecret, systemSecretEgressIssues } from "../src/secrets-v3/index.js";
import { createTestDb, fakeExecutors, startApi, type TestApi } from "./helpers.js";

const SHOP = String(100000 + Math.floor(Math.random() * 800000));
const KEY = `test_${randomBytes(18).toString("base64url")}`;
const LIVE_KEY = `live_${randomBytes(18).toString("base64url")}`;
const EDITOR = { "x-wizard-dev-user": "editor-conkeys@example.test" };
const letters: MailMessage[] = [];
let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let systemId = "";

const call = (method: string, path: string, o: { body?: unknown; headers?: Record<string, string> } = {}) =>
  api.req(method, path, {
    ...(o.body !== undefined ? { body: o.body } : {}),
    ...(o.headers ? { headers: o.headers } : {}),
  });

beforeAll(async () => {
  tdb = await createTestDb("conkeys");
  api = await startApi(tdb.url, {
    executors: fakeExecutors(),
    secretWindow: { platformDomains: ["sandpile.ru"] },
    mailer: {
      async send(m) {
        letters.push(m);
      },
    },
  });
  const key = randomBytes(6).toString("hex");
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `shop-${key.slice(0, 6)}`,
      schema_key: key,
      name: "Магазин керамики",
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  systemId = row.id;
  const spec = {
    integrations: [
      {
        name: "shop_pay",
        connector: "yookassa",
        config: {},
        secretRefs: ["secret://yookassa_shop_id", "secret://yookassa_secret_key"],
      },
      { name: "notify", connector: "email", config: {} },
    ],
  };
  await api.deps.pg`
    insert into platform.revisions (system_id, version, kind, author, spec, ops, files_manifest_sha)
    values (${systemId}, 1, 'ops', 'agent', ${api.deps.pg.json(spec)}, ${api.deps.pg.json([])}, ${"0".repeat(64)})`;
  await api.deps.pg`update platform.systems set draft_revision = 1 where id = ${systemId}`;
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

describe("module connector keys (the shop's ЮKassa)", () => {
  test("listed as needed with the connector's fixed host; a window by the key's name; unknown names → 404", async () => {
    const list = await call("GET", `/systems/${systemId}/secrets`);
    expect(list.status).toBe(200);
    expect(list.body.needed).toEqual([
      expect.objectContaining({
        integrationId: "shop_pay",
        name: "yookassa_shop_id",
        secretRef: "secret://yookassa_shop_id",
        hosts: ["api.yookassa.ru"],
        present: false,
        connector: { id: "yookassa", label_ru: "Оплата ЮKassa" },
      }),
      expect.objectContaining({ name: "yookassa_secret_key", hosts: ["api.yookassa.ru"], present: false }),
    ]);
    const open = await call("POST", `/systems/${systemId}/secret-windows`, {
      body: { name: "yookassa_shop_id" },
    });
    expect(open.status).toBe(201);
    expect(open.body.window).toMatchObject({ name: "yookassa_shop_id", hosts: ["api.yookassa.ru"] });
    expect(
      (await call("POST", `/systems/${systemId}/secret-windows`, { body: { name: "crm_key" } })).status,
    ).toBe(404);
  });

  test("both keys entered through their windows: stored encrypted, listed as present, never echoed", async () => {
    const store = new SecretStore(api.deps.config.secretsFile, api.deps.config.secretsKey);
    for (const [name, value] of [
      ["yookassa_shop_id", SHOP],
      ["yookassa_secret_key", KEY],
    ] as const) {
      const open = await call("POST", `/systems/${systemId}/secret-windows`, { body: { name } });
      expect([200, 201]).toContain(open.status);
      const w = await call("GET", `/systems/${systemId}/secret-windows/${open.body.window.id}`);
      const sealed = await sealSecret(w.body.window, value);
      const r = await call("POST", `/systems/${systemId}/secret-windows/${open.body.window.id}/submit`, {
        body: sealed,
      });
      expect(r.status, `${name}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.saved).toBe(true);
      expect(JSON.stringify(r.body).includes(value)).toBe(false);
      expect(store.get(systemId, "draft", name) === value).toBe(true);
    }
    const list = await call("GET", `/systems/${systemId}/secrets`);
    expect(list.body.needed.map((n: { present: boolean }) => n.present)).toEqual([true, true]);
    expect(JSON.stringify(list.body).includes(KEY)).toBe(false);
  });
});

describe("V3-18: prod keys, connector hosts, D37 at publishing", () => {
  test("prod keys are the owner's: an editor gets 403 NOT_OWNER for every prod mutation; draft stays open to editors", async () => {
    const base = `/systems/${systemId}`;
    const denied = await call("POST", `${base}/secret-windows`, {
      body: { name: "yookassa_secret_key", env: "prod" },
      headers: EDITOR,
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({
      code: "NOT_OWNER",
      message_ru: "Это действие доступно только владельцу",
    });
    const draft = await call("POST", `${base}/secret-windows`, {
      body: { name: "yookassa_secret_key" },
      headers: EDITOR,
    });
    expect([200, 201]).toContain(draft.status);
    expect(
      (await call("DELETE", `${base}/secret-windows/${draft.body.window.id}`, { headers: EDITOR })).status,
    ).toBe(200);

    // The owner opens the prod window; the editor can neither read, fill nor close it.
    const opened = await call("POST", `${base}/secret-windows`, {
      body: { name: "yookassa_secret_key", env: "prod" },
    });
    expect(opened.status).toBe(201);
    const w = opened.body.window;
    expect(w).toMatchObject({ env: "prod", hosts: ["api.yookassa.ru"] });
    const sealed = await sealSecret(w, LIVE_KEY);
    for (const [method, path, body] of [
      ["GET", `${base}/secret-windows/${w.id}`, undefined],
      ["POST", `${base}/secret-windows/${w.id}/submit`, sealed],
      ["DELETE", `${base}/secret-windows/${w.id}`, undefined],
    ] as const) {
      const r = await call(method, path, { ...(body ? { body } : {}), headers: EDITOR });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.code).toBe("NOT_OWNER");
    }
    letters.length = 0;
    const saved = await call("POST", `${base}/secret-windows/${w.id}/submit`, { body: sealed });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.saved).toBe(true);
    const store = new SecretStore(api.deps.config.secretsFile, api.deps.config.secretsKey);
    expect(store.get(systemId, "prod", "yookassa_secret_key") === LIVE_KEY).toBe(true);

    // The owners learn that the live payment key was replaced (last 4 characters only, never the key).
    expect(letters).toEqual([
      expect.objectContaining({ kind: "notice", to: DEV_USER_EMAIL, subject: "Заменён ключ приёма оплаты" }),
    ]);
    expect(letters[0]?.text).toContain("Магазин керамики");
    expect(letters[0]?.text).toContain(`••••${LIVE_KEY.slice(-4)}`);
    expect(JSON.stringify(letters).includes(LIVE_KEY)).toBe(false);

    const check = await call("POST", `${base}/secrets/yookassa_secret_key/check`, {
      body: { env: "prod" },
      headers: EDITOR,
    });
    expect(check.status).toBe(403);
    expect(check.body.code).toBe("NOT_OWNER");
    const remove = await call("DELETE", `${base}/secrets/yookassa_secret_key?env=prod`, { headers: EDITOR });
    expect(remove.status).toBe(403);
    expect(remove.body.code).toBe("NOT_OWNER");
    expect(store.get(systemId, "prod", "yookassa_secret_key") === LIVE_KEY).toBe(true);
    // Draft keys: the editor still re-checks them; nothing new is mailed.
    expect(
      (await call("POST", `${base}/secrets/yookassa_secret_key/check`, { body: {}, headers: EDITOR })).status,
    ).toBe(200);
    expect(letters).toHaveLength(1);
  });

  test("the agent cannot point a connector key at another host: the window gets the connector's host", async () => {
    const r = await requestSecret(api.deps, {
      systemId,
      name: "yookassa_secret_key",
      domain: "yookassa-api.ru",
      purpose: "Оплата заказов",
      requestedBy: "agent",
    });
    expect(r.window.hosts).toEqual(["api.yookassa.ru"]);
    // Known connector key names are bound even before the spec declares the integration.
    const other = await api.deps.db
      .insertInto("platform.systems")
      .values({
        org_id: DEFAULT_ORG_ID,
        slug: `bare-${randomBytes(3).toString("hex")}`,
        schema_key: randomBytes(6).toString("hex"),
        name: "Без спеки",
        pending_questions: json([]),
        created_by: DEV_USER_ID,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const tool = await runRequestSecret(
      { pg: api.deps.pg },
      { systemId: other.id },
      { name: "yookassa_shop_id", domain: "pay.evil.example", purpose: "Оплата" },
    );
    expect(tool.status).toBe("window_opened");
    expect(tool.message_ru).toContain("api.yookassa.ru");
    expect(tool.message_ru.includes("evil")).toBe(false);
  });

  test("D37 at publishing: a revision whose function sends a window key to another host is refused", async () => {
    const leak = {
      integrations: [
        {
          name: "shop_pay",
          connector: "yookassa",
          config: {},
          secretRefs: ["secret://yookassa_shop_id", "secret://yookassa_secret_key"],
        },
      ],
      functions: [
        { name: "pay", egress: ["api.yookassa.ru"], secretRefs: ["secret://yookassa_secret_key"] },
        { name: "steal", egress: ["collector.example.com"], secretRefs: ["secret://yookassa_secret_key"] },
      ],
    };
    expect(await systemSecretEgressIssues(api.deps.pg, systemId, leak)).toEqual([
      expect.objectContaining({ path: "/functions/1/egress/0" }),
    ]);
    expect(
      await systemSecretEgressIssues(api.deps.pg, systemId, { functions: leak.functions.slice(0, 1) }),
    ).toEqual([]);
    await api.deps.pg`
      insert into platform.revisions (system_id, version, kind, author, spec, ops, files_manifest_sha, g0_passed, bundle_key)
      values (${systemId}, 2, 'ops', 'agent', ${api.deps.pg.json(leak)}, ${api.deps.pg.json([])}, ${"0".repeat(64)}, true, 'bundles/leak')`;
    await api.deps.pg`update platform.systems set draft_revision = 2 where id = ${systemId}`;
    const r = await call("POST", `/systems/${systemId}/publish`, { body: { revision: 2 } });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body).toMatchObject({ code: "GATES_FAILED", details: { reason: "SECRET_EGRESS" } });
    expect(r.body.message_ru).toContain("collector.example.com");
    const [runs] = await api.deps.pg`
      select count(*)::int as n from platform.runs where system_id = ${systemId} and kind = 'publish'`;
    expect(runs?.n).toBe(0);
  });
});
