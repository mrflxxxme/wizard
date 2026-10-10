// V3-40, platform part of the critic's data: the critic's browser lists the same demo rows the visitor's draft holds —
// draftCriticRows (builds-v3/host.ts) makes them as onG0Passed seeds the draft (the system's schema key, the brief's
// seed hints → seedDraft), so ids, names and statuses match the rows in the draft schema.
import { randomUUID } from "node:crypto";
import type { AppSpec } from "@wizard/appspec";
import { schemaName } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { briefSite } from "../../../packages/agents/test/v3-brief-site.js";
import { CERAMICS_SHOP, INTERIOR_STUDIO } from "../../../packages/agents/test/v3-eval-briefs.js";
import { productPhoto } from "../../../packages/ui-kit/src/v3/headless/shop.js";
import { migrateDraft, seedDraft } from "../src/agents/draft.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { draftCriticRows, draftSeedHints, photoSeedHints } from "../src/builds-v3/host.js";
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

  // V3-40: the critic saw a shop of empty cards — the demo goods had no pictures. The photos the photos stage picked
  // for the niche (its checkpoint, written before the first G0) become the goods' pictures in the draft itself.
  test("the shop's demo goods carry the library photos of the niche — in the draft and in the critic's rows", async () => {
    const shop = (await briefSite("v3-05-ceramics-shop", CERAMICS_SHOP, { request: null })).spec;
    const { id, key } = await addSystem();
    await saveBriefVersion(api.deps.db, { systemId: id, brief: CERAMICS_SHOP, author: "agent" });
    const photos = [
      { slot: "top", file: "lib-hero-1" },
      { slot: "gallery-1", file: "lib-mugs-1" },
      { slot: "gallery-2", file: "lib-bowls-2" },
    ];
    await api.deps.pg`
      insert into platform.system_build_checkpoints (system_id, key, checkpoint)
      values (${id}, 'photos', ${api.deps.pg.json({ fingerprint: "f", data: { photos } })})`;
    const hints = await draftSeedHints(api.deps.db, id, shop);
    const image = hints.filter((h) => h.values.every((v) => String(v).startsWith("/_wizard/photos/")));
    expect(image.length).toBeGreaterThan(0);
    // The work photos, never the first screen's, never twice (no library here: only the plan's).
    expect(image.flatMap((h) => h.values)).toEqual([
      "/_wizard/photos/lib-mugs-1/960",
      "/_wizard/photos/lib-bowls-2/960",
    ]);
    await migrateDraft(api.deps.pg, { systemKey: key, spec: shop, prevSpec: null });
    await seedDraft(api.deps.pg, { systemKey: key, spec: shop, hints });
    const h = image[0] as { entity: string; field: string };
    const stored = await api.deps.pg.unsafe<{ v: string | null }[]>(
      `select "${h.field}"::text as v from "${schemaName(key, "draft")}"."${h.entity}"`,
    );
    expect(stored.length).toBeGreaterThan(0);
    const shown = stored.map((r) => r.v).filter((v): v is string => v !== null);
    expect(shown.length).toBeGreaterThan(0);
    expect(new Set(shown).size).toBe(shown.length);
    for (const v of shown) expect(v).toMatch(/^\/_wizard\/photos\/lib-(mugs|bowls)-\d\/960$/);
    // The card shows it as its picture as is (same origin, the runtime's library route).
    expect(productPhoto(shown[0])).toBe(shown[0]);
    const rows = await draftCriticRows(api.deps.db, id, shop);
    // The critic's rows are the draft's (a row without a photo: no value there, NULL in the table).
    expect((rows[h.entity] ?? []).map((r) => r[h.field] ?? null)).toEqual(stored.map((r) => r.v));
  });

  test("photo hints: public image fields only, never the site's own places, never the first screen's photo or a repeat", () => {
    const spec = {
      roles: [
        { name: "visitor", access: "public" },
        { name: "owner", access: "login" },
      ],
      entities: [
        { name: "product", fields: [{ name: "photo", type: "image" }] },
        { name: "staff_doc", fields: [{ name: "scan", type: "image" }] },
        { name: "site_photo", fields: [{ name: "image", type: "image" }] },
      ],
      permissions: [
        { role: "visitor", entity: "product", ops: ["read"] },
        { role: "visitor", entity: "site_photo", ops: ["read"] },
        { role: "owner", entity: "staff_doc", ops: ["read", "create"] },
      ],
    } as unknown as AppSpec;
    expect(photoSeedHints(spec, [{ slot: "about", file: "a1" }])).toEqual([
      { entity: "product", field: "photo", values: ["/_wizard/photos/a1/960"] },
    ]);
    // The first screen's photo is never a card's; nothing else — no hints.
    expect(photoSeedHints(spec, [{ slot: "top", file: "a1" }])).toEqual([]);
    expect(photoSeedHints(spec, [])).toEqual([]);
    expect(photoSeedHints(spec, [{ slot: "about", file: "../etc" }])).toEqual([]);
    // More of the niche from the library: entries under the subjects of the plan's photos, details first, no repeats,
    // other niches and portraits aside.
    const entry = (query: string, file: string, orientation = "landscape") => ({ query, file, orientation });
    const library = {
      version: 1,
      entries: [
        entry("farm fresh produce", "top-1"),
        entry("farm fresh produce", "f-hero-2"),
        entry("fresh vegetables basket", "f-veg-1"),
        entry("fresh vegetables basket", "f-veg-2"),
        entry("fresh vegetables basket", "f-veg-3", "portrait"),
        entry("dental clinic", "d-1"),
      ],
    } as unknown as Parameters<typeof photoSeedHints>[2];
    const hints = photoSeedHints(
      spec,
      [
        { slot: "top", file: "top-1" },
        { slot: "about", file: "f-veg-1" },
      ],
      library,
    );
    expect(hints).toEqual([
      {
        entity: "product",
        field: "photo",
        values: [
          "/_wizard/photos/f-veg-1/960",
          "/_wizard/photos/f-veg-2/960",
          "/_wizard/photos/f-hero-2/960",
        ],
      },
    ]);
  });
});
