// V3-22 (platform): the brief → contract path picks an API passport by the integration's name or a link to the provider —
// no documentation is read (research would fail on any fetch), no model; the mock contract tests pass, contractRef and
// secretRef land in the brief, a rebuild keeps the owner's account; other integrations still need documentation.
import { randomBytes } from "node:crypto";
import { parseContractRef } from "@wizard/agents/integrations";
import type { SystemBrief } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { getLatestBrief, saveBriefVersion } from "../src/briefs/store.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { createTestDb, fakeExecutors, startApi, type TestApi } from "./helpers.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let systemId = "";
const fetched: string[] = [];

beforeAll(async () => {
  tdb = await createTestDb("v3passports", { migrator: true });
  api = await startApi(tdb.url, {
    executors: fakeExecutors(),
    integrations: {
      research: {
        env: {},
        mode: "fixture",
        fetch: async (url: string | URL | Request) => {
          fetched.push(String(url));
          throw new Error("no network in passport tests");
        },
      },
      keyCheck: { transport: null },
    },
  });
  const key = randomBytes(6).toString("hex");
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `shop-${key.slice(0, 6)}`,
      schema_key: key,
      name: "Магазин свечей",
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
        { id: "payments", name: "Оплата заказов через ЮKassa", direction: "out" },
        { id: "crm", name: "Сделки в amoCRM", direction: "out" },
        { id: "partner", name: "Партнёрская CRM", direction: "out" },
      ],
      data: [{ entity: "Заказ", fields: [{ name: "Сумма" }, { name: "Комментарий" }], retention: "3 года" }],
    },
  });
});

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

const briefNow = async (): Promise<SystemBrief> =>
  (await getLatestBrief(api.deps.db, systemId))?.brief as SystemBrief;

describe("brief → contract by passport", () => {
  test("by name: ЮKassa without a link or a document; mock tests pass; references land in the brief", async () => {
    const r = await api.req("POST", `/systems/${systemId}/integrations/payments/contract`, { body: {} });
    expect(r.status).toBe(201);
    expect(parseContractRef(r.body.contractRef)).toMatchObject({ id: "payments", version: 1 });
    expect(r.body.contract).toMatchObject({
      status: "mock",
      hosts: ["api.yookassa.ru"],
      baseUrl: "https://api.yookassa.ru/v3",
      auth: { kind: "header", name: "Authorization", secret: "secret://payments_key" },
      check: { operation: "getShop" },
      tests: { ok: true },
    });
    expect(r.body.contract.operations.map((o: { id: string }) => o.id)).toContain("createRefund");
    expect(r.body.contract.notes.join("\n")).toMatch(/Паспорт API «ЮKassa»/);
    const brief = await briefNow();
    expect(brief.integrations.find((i) => i.id === "payments")).toMatchObject({
      contractRef: r.body.contractRef,
      secretRef: "secret://payments_key",
    });
    expect(fetched).toEqual([]);
  });

  test("by a link into the account: amoCRM on the owner's host; a rebuild by name keeps it", async () => {
    const r = await api.req("POST", `/systems/${systemId}/integrations/crm/contract`, {
      body: { url: "https://mycompany.amocrm.ru/leads/pipeline/1" },
    });
    expect(r.status).toBe(201);
    expect(r.body.contract).toMatchObject({
      hosts: ["mycompany.amocrm.ru"],
      baseUrl: "https://mycompany.amocrm.ru/api/v4",
      auth: { kind: "bearer", secret: "secret://crm_key" },
      tests: { ok: true },
    });
    const again = await api.req("POST", `/systems/${systemId}/integrations/crm/contract`, { body: {} });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(again.body.contract.hosts).toEqual(["mycompany.amocrm.ru"]);
    expect(fetched).toEqual([]);
  });

  test("an integration without a passport still needs documentation", async () => {
    const r = await api.req("POST", `/systems/${systemId}/integrations/partner/contract`, { body: {} });
    expect(r.status).toBe(400);
    expect(r.body.message_ru).toMatch(/ссылка на документацию/);
  });
});
