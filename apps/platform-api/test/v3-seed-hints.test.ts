// V3-18, platform part: the draft of a system with a brief is seeded with the names of the offer its brief lists
// (onG0Passed → draftSeedHints → seedDraft {hints}); a system without a brief keeps the generator's neutral names.
import { randomUUID } from "node:crypto";
import type { AppSpec } from "@wizard/appspec";
import { schemaName } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { briefSite } from "../../../packages/agents/test/v3-brief-site.js";
import { INTERIOR_STUDIO } from "../../../packages/agents/test/v3-eval-briefs.js";
import { migrateDraft, seedDraft } from "../src/agents/draft.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { draftSeedHints } from "../src/builds-v3/host.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { createTestDb, fakeExecutors, startApi, type TestApi } from "./helpers.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let spec: AppSpec;

beforeAll(async () => {
  tdb = await createTestDb("v3seedhints");
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
      slug: `sh-${key}`,
      schema_key: key,
      name: "Студия",
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, key };
}

const names = async (key: string) =>
  (
    await api.deps.pg.unsafe(
      `select name, description, price from "${schemaName(key, "draft")}".service order by sort_order, name`,
    )
  ).map((r) => r as unknown as { name: string; description: string | null; price: number | null });

describe("draft seed hints from the brief", () => {
  test("a system with a brief: its listed services name the preview's catalog, without invented descriptions", async () => {
    const { id, key } = await addSystem();
    await saveBriefVersion(api.deps.db, { systemId: id, brief: INTERIOR_STUDIO, author: "agent" });
    const hints = await draftSeedHints(api.deps.db, id, spec);
    expect(hints).toEqual([
      {
        entity: "service",
        field: "name",
        values: ["Дизайн квартиры", "Дизайн дома", "Авторский надзор", "Комплектация"],
      },
    ]);
    await migrateDraft(api.deps.pg, { systemKey: key, spec, prevSpec: null });
    await seedDraft(api.deps.pg, { systemKey: key, spec, hints });
    const rows = await names(key);
    expect(rows.map((r) => r.name)).toEqual(
      expect.arrayContaining(["Дизайн квартиры", "Дизайн дома", "Авторский надзор"]),
    );
    for (const r of rows) {
      expect(r.name).not.toMatch(/«/);
      expect(r.description).toBeNull();
    }
  });

  test("a system without a brief: no hints, neutral names «Услуга N»", async () => {
    const { id, key } = await addSystem();
    expect(await draftSeedHints(api.deps.db, id, spec)).toEqual([]);
    await migrateDraft(api.deps.pg, { systemKey: key, spec, prevSpec: null });
    await seedDraft(api.deps.pg, { systemKey: key, spec });
    for (const r of await names(key)) expect(r.name).toMatch(/^Услуга \d+$/);
  });
});
