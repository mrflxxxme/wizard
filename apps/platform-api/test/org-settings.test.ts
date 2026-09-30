// M0-30: GET /orgs/{orgId}/settings served from M0 — buildModelLabel follows the build-tier parameter
// (models.yaml#week0_decision.switch, WIZARD_BUILD_DEFAULT_TIER) and the org policy; the run engine uses the same tier.

import type { RouterOptions } from "@wizard/llm";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { DEFAULT_ORG_ID } from "../src/db/index.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  loadYaml,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";

// biome-ignore lint/suspicious/noExplicitAny: OpenAPI document
const doc = loadYaml("specs/platform/api.yaml") as Record<string, any>;
const validate = new Ajv2020({ strict: false }).compile(doc.components.schemas.OrgSettings);
const path = `/orgs/${DEFAULT_ORG_ID}/settings`;

let tdb: Awaited<ReturnType<typeof createTestDb>>;
const apis: TestApi[] = [];
const routerOpts: RouterOptions[] = [];

async function api(tier: "T0" | "T1"): Promise<TestApi> {
  const fake = fakeRouterFactory();
  const a = await startApi(tdb.url, {
    config: { buildDefaultTier: tier },
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: (o) => {
      routerOpts.push(o);
      return fake(o);
    },
  });
  apis.push(a);
  return a;
}

async function setRegion(a: TestApi, region: string | null): Promise<void> {
  await a.deps.db
    .updateTable("platform.orgs")
    .set({ region_code: region })
    .where("id", "=", DEFAULT_ORG_ID)
    .execute();
}

beforeAll(async () => {
  tdb = await createTestDb("orgsettings");
});
afterAll(async () => {
  for (const a of apis) await a.dispose();
  await tdb?.drop();
});

describe("GET /orgs/{orgId}/settings (M0-30)", () => {
  test("config: WIZARD_BUILD_DEFAULT_TIER → buildDefaultTier, default T1", () => {
    expect(loadConfig({}).buildDefaultTier).toBe("T1");
    expect(loadConfig({ WIZARD_BUILD_DEFAULT_TIER: "T0" }).buildDefaultTier).toBe("T0");
    expect(loadConfig({ WIZARD_BUILD_DEFAULT_TIER: "T0" }, { buildDefaultTier: "T1" }).buildDefaultTier).toBe(
      "T1",
    );
    expect(() => loadConfig({ WIZARD_BUILD_DEFAULT_TIER: "T2" })).toThrow();
  });

  test("T0 by default → «модели в РФ»; the response matches api.yaml#OrgSettings", async () => {
    const a = await api("T0");
    await setRegion(a, "77");
    const res = await a.req("GET", path);
    expect(res.status).toBe(200);
    expect(validate(res.body)).toBe(true);
    expect(res.body).toEqual({ ruOnly: false, buildModelLabel: "модели в РФ", t1Restricted: false });
  });

  test("T1 by default → GLM-5.3 for an open org; ruOnly / t1Restricted / unknown region → «модели в РФ»", async () => {
    const a = await api("T1");
    await setRegion(a, "77");
    expect((await a.req("GET", path)).body.buildModelLabel).toBe("GLM-5.3");
    await setRegion(a, null);
    expect((await a.req("GET", path)).body.buildModelLabel).toBe("модели в РФ");
    await setRegion(a, "77");
    await a.deps.db
      .updateTable("platform.orgs")
      .set({ ru_only: true })
      .where("id", "=", DEFAULT_ORG_ID)
      .execute();
    expect((await a.req("GET", path)).body).toMatchObject({ ruOnly: true, buildModelLabel: "модели в РФ" });
    await a.deps.db
      .updateTable("platform.orgs")
      .set({ ru_only: false, t1_restricted: true })
      .where("id", "=", DEFAULT_ORG_ID)
      .execute();
    expect((await a.req("GET", path)).body).toMatchObject({
      t1Restricted: true,
      buildModelLabel: "модели в РФ",
    });
    await a.deps.db
      .updateTable("platform.orgs")
      .set({ t1_restricted: false })
      .where("id", "=", DEFAULT_ORG_ID)
      .execute();
  });

  test("foreign or malformed org id → 404", async () => {
    const a = apis[0] ?? (await api("T0"));
    expect((await a.req("GET", "/orgs/00000000-0000-0000-0000-00000000beef/settings")).status).toBe(404);
    expect((await a.req("GET", "/orgs/nope/settings")).status).toBe(404);
  });

  test("the run engine routes with the same build tier", async () => {
    const a = await api("T0");
    routerOpts.length = 0;
    const created = await a.req("POST", "/systems", { body: { prompt: "Регистрация на форум" } });
    expect(created.status).toBe(201);
    await waitRun(a, created.body.run.id, ["succeeded"]);
    expect(routerOpts.at(-1)?.registry?.buildDefaultTier).toBe("T0");
  });
});
