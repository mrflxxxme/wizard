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
import { pgCheckpointStore } from "../src/builds-v3/checkpoints.js";
import { checkCardPhotos, draftNiche, draftSeedHints } from "../src/builds-v3/host.js";
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

// V4-29: the demo prices go by the site's niche — the art director's (checkpoint «design»), else its photos' one.
describe("the niche of the draft", () => {
  const checkpoint = (systemId: string, key: string, data: unknown) =>
    api.deps.pg`
      insert into platform.system_build_checkpoints (system_id, key, checkpoint)
      values (${systemId}, ${key}, ${api.deps.pg.json({ key, fingerprint: "f", data } as never)})`;

  test("design first, then the photos' alt, else none", async () => {
    const a = await addSystem();
    expect(await draftNiche(api.deps.db, a.id)).toBeNull();
    await checkpoint(a.id, "photos", {
      photos: [{ slot: "top", alt: "Первый экран — фото по теме «кофейня»" }],
    });
    expect(await draftNiche(api.deps.db, a.id)).toBe("кофейня");
    await checkpoint(a.id, "design", { niche: "кофейня и обжарка" });
    expect(await draftNiche(api.deps.db, a.id)).toBe("кофейня и обжарка");
  });
});

// V4-27: the build checks the card photos (checkCardPhotos, PhotoHost.cards) and keeps the verdict; the seed of the
// draft takes it while the rows are the same, and a repeated check of the same rows calls no model.
describe("the card check of the build and the seed", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const entry = (n: number) =>
    ({
      provider: "pexels",
      id: String(n),
      file: uuid(n),
      author: "Автор",
      pageUrl: `https://www.pexels.com/photo/${n}/`,
      width: 1600,
      height: 1000,
      color: "#808080",
      luma: 0.5,
      query: "interior",
      niche: "interior",
    }) as const;
  /** Every query answers the plan's photo and thirty more, best first (a row takes from what is not taken yet). */
  const source = {
    search: async (_q: string, o: { filter?: (e: never) => boolean }) =>
      [1, ...Array.from({ length: 30 }, (_, i) => 11 + i)]
        .map(entry)
        .filter((e) => !o.filter || o.filter(e as never))
        .map((e) => ({ entry: e as never, score: 0.2 })),
    thumbnail: async () => new Uint8Array([1]),
    requestBackfill: async () => {},
  };
  const storage = { get: async () => null } as never;

  test("the verdict is kept and seeded; the same rows are not checked twice", async () => {
    const { id } = await addSystem();
    await saveBriefVersion(api.deps.db, { systemId: id, brief: INTERIOR_STUDIO, author: "agent" });
    const runId = randomUUID();
    await api.deps.db
      .insertInto("platform.runs")
      .values({
        id: runId,
        org_id: DEFAULT_ORG_ID,
        system_id: id,
        kind: "build",
        mode: "create",
        status: "running",
        input: JSON.stringify({}) as never,
      })
      .execute();
    await pgCheckpointStore(api.deps.pg, id, runId).save({
      key: "photos",
      fingerprint: "f",
      data: {
        photos: [{ slot: "top", file: uuid(1), alt: "Первый экран — фото по теме «дизайн интерьера»" }],
      },
      costMilli: 0,
      durationMs: 0,
      runId,
    });
    let calls = 0;
    const picker = async (input: {
      slots: { slot: string }[];
      candidates: { entry: { file: string } }[];
    }) => {
      calls++;
      // Every row takes its second candidate.
      return input.slots.map((s, i) => ({ slot: s.slot, index: i * 2 + 1 }));
    };
    const o = { db: api.deps.db, pg: api.deps.pg, systemId: id, runId, spec, storage, picker, source };
    await checkCardPhotos(o);
    expect(calls).toBe(1);
    const hints = await draftSeedHints(api.deps.db, id, spec, storage, () => source);
    const photos = hints.find((h) => h.field !== "name");
    // Two candidates a row and four more for a second round: rows (11, 12 | 13–16), (17, 18 | 19–22), …
    expect(photos?.values).toEqual([12, 18, 24, 30].map((n) => `/_wizard/photos/${uuid(n)}/960`));
    await checkCardPhotos(o);
    expect(calls).toBe(1);
  });
});
