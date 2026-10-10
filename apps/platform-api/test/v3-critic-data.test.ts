// V3-40, platform part of the critic's data: the critic's browser lists the same demo rows the visitor's draft holds —
// draftCriticRows (builds-v3/host.ts) makes them as onG0Passed seeds the draft (the system's schema key, the brief's
// seed hints → seedDraft), so ids, names and statuses match the rows in the draft schema.
import { randomUUID } from "node:crypto";
import type { AppSpec } from "@wizard/appspec";
import { schemaName } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { briefSite } from "../../../packages/agents/test/v3-brief-site.js";
import { INTERIOR_STUDIO } from "../../../packages/agents/test/v3-eval-briefs.js";
import { migrateDraft, seedDraft } from "../src/agents/draft.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { draftCriticRows, draftSeedHints } from "../src/builds-v3/host.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { createTestDb, fakeExecutors, startApi, type TestApi } from "./helpers.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let spec: AppSpec;

beforeAll(async () => {
  tdb = await createTestDb("v3criticdata");
  api = await startApi(tdb.url, { executors: fakeExecutors() });
  spec = (await briefSite("v3-01-interior-studio", INTERIOR_STUDIO, { request: null })).spec;
});

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

async function addSystem(): Promise<{ id: string; key: string }> {
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `cd-${key}`,
      schema_key: key,
      name: "Студия",
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, key };
}

const sorted = (xs: string[]) => [...xs].sort();

describe("V3-40 the critic's demo rows", () => {
  test("the same rows the draft was seeded with: ids, names of the brief, statuses", async () => {
    const { id, key } = await addSystem();
    await saveBriefVersion(api.deps.db, { systemId: id, brief: INTERIOR_STUDIO, author: "agent" });
    // As onG0Passed does on the first G0 of the system.
    await migrateDraft(api.deps.pg, { systemKey: key, spec, prevSpec: null });
    await seedDraft(api.deps.pg, {
      systemKey: key,
      spec,
      hints: await draftSeedHints(api.deps.db, id, spec),
    });
    const rows = await draftCriticRows(api.deps.db, id, spec);
    const schema = schemaName(key, "draft");
    const services = await api.deps.pg.unsafe<{ id: string; name: string; active: boolean }[]>(
      `select id::text as id, name, active from "${schema}".service`,
    );
    expect(services.length).toBeGreaterThan(0);
    expect(sorted((rows.service ?? []).map((r) => `${r.id} ${r.name} ${r.active}`))).toEqual(
      sorted(services.map((r) => `${r.id} ${r.name} ${r.active}`)),
    );
    expect(services.map((r) => r.name)).toEqual(
      expect.arrayContaining(["Дизайн квартиры", "Дизайн дома", "Авторский надзор"]),
    );
    const articles = await api.deps.pg.unsafe<{ id: string; title: string; status: string }[]>(
      `select id::text as id, title, status from "${schema}".article`,
    );
    expect(sorted((rows.article ?? []).map((r) => `${r.id} ${r.title} ${r.status}`))).toEqual(
      sorted(articles.map((r) => `${r.id} ${r.title} ${r.status}`)),
    );
  });

  test("no such system — no rows (the critic's lists stay empty)", async () => {
    expect(await draftCriticRows(api.deps.db, randomUUID(), spec)).toEqual({});
  });
});
