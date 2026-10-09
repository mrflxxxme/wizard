// V3-23: the keys of a module's connector integration (the shop's ЮKassa: secret://yookassa_shop_id and
// secret://yookassa_secret_key) are listed as needed and entered through the platform's key window opened by the key's
// name; the window's only recipient is the connector's fixed host. No external network.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sealSecret } from "../../platform-web/src/screens/v3/keys/seal.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { SecretStore } from "../src/secrets/store.js";
import { createTestDb, fakeExecutors, startApi, type TestApi } from "./helpers.js";

const SHOP = String(100000 + Math.floor(Math.random() * 800000));
const KEY = `test_${randomBytes(18).toString("base64url")}`;
let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let systemId = "";

const call = (method: string, path: string, o: { body?: unknown } = {}) =>
  api.req(method, path, { ...(o.body !== undefined ? { body: o.body } : {}) });

beforeAll(async () => {
  tdb = await createTestDb("conkeys");
  api = await startApi(tdb.url, {
    executors: fakeExecutors(),
    secretWindow: { platformDomains: ["sandpile.ru"] },
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
