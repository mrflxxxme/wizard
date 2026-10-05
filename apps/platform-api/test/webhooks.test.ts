// M2-53: listSystemWebhooks — the owner's cabinet gets the same secret address the runtime checks; other orgs get 404.
import type { AppSpec } from "@wizard/appspec";
import { webhookHookToken } from "@wizard/connectors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { webhookAddresses } from "../src/routes/webhooks.js";
import { startBuild } from "./flow.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";

const KEY = "k".repeat(40);

describe("webhookAddresses", () => {
  test("one URL per webhook integration, token = the runtime's webhookHookToken; tokenVersion rotates it", () => {
    const spec = {
      integrations: [
        {
          name: "site",
          connector: "webhook",
          config: { verify: "shared_secret", entity: "lead", fields: { name: "name" } },
        },
        {
          name: "crm",
          connector: "webhook",
          config: { verify: "shared_secret", entity: "lead", fields: { name: "n" }, tokenVersion: 2 },
        },
        { name: "mail", connector: "email" },
      ],
    } as unknown as AppSpec;
    const out = webhookAddresses(spec, {
      origin: "https://zapis.sandpile.ru",
      systemKey: "abc123def456",
      env: "prod",
      key: KEY,
    });
    expect(out.map((x) => x.integration)).toEqual(["site", "crm"]);
    const site = webhookHookToken(KEY, { systemId: "abc123def456", env: "prod", integration: "site" });
    expect(out[0]).toEqual({
      integration: "site",
      env: "prod",
      url: `https://zapis.sandpile.ru/_wizard/hooks/webhook/site/${site}`,
      verify: "shared_secret",
      entity: "lead",
    });
    expect(site).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const v1 = webhookHookToken(KEY, { systemId: "abc123def456", env: "prod", integration: "crm" });
    expect(out[1]?.url.endsWith(v1)).toBe(false);
    // Draft and prod addresses differ.
    expect(webhookHookToken(KEY, { systemId: "abc123def456", env: "draft", integration: "site" })).not.toBe(
      site,
    );
  });
});

describe("GET /systems/:id/webhooks", () => {
  let tdb: Awaited<ReturnType<typeof createTestDb>>;
  let api: TestApi;
  beforeAll(async () => {
    tdb = await createTestDb("webhooks");
    api = await startApi(tdb.url, {
      executors: fakeExecutors({ spec: "bakery" }),
      createRouter: fakeRouterFactory(),
    });
  });
  afterAll(async () => {
    await api?.dispose();
    await tdb?.drop();
  });

  test("a system without webhooks → empty list; another org's id or garbage → 404", async () => {
    const s = await startBuild(api, "Кондитерская");
    await waitRun(api, s.buildRunId, ["succeeded"]);
    const r = await api.req("GET", `/systems/${s.systemId}/webhooks`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [] });
    expect((await api.req("GET", "/systems/00000000-0000-0000-0000-000000000000/webhooks")).status).toBe(404);
    expect((await api.req("GET", "/systems/not-a-uuid/webhooks")).status).toBe(404);
  });
});
