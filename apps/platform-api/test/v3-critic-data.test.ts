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
      { slot: "hero", file: "lib-hero-1" },
      { slot: "gallery-1", file: "lib-mugs-1" },
      { slot: "gallery-2", file: "lib-bowls-2" },
    ];
    await api.deps.pg`
      insert into platform.system_build_checkpoints (system_id, key, checkpoint)
      values (${id}, 'photos', ${api.deps.pg.json({ fingerprint: "f", data: { photos } })})`;
    const hints = await draftSeedHints(api.deps.db, id, shop);
    const image = hints.filter((h) => h.values.every((v) => String(v).startsWith("/_wizard/photos/")));
    expect(image.length).toBeGreaterThan(0);
    // The work photos first, the first screen last.
    expect(image[0]?.values.slice(0, 3)).toEqual([
      "/_wizard/photos/lib-mugs-1/960",
      "/_wizard/photos/lib-bowls-2/960",
      "/_wizard/photos/lib-hero-1/960",
    ]);
    await migrateDraft(api.deps.pg, { systemKey: key, spec: shop, prevSpec: null });
    await seedDraft(api.deps.pg, { systemKey: key, spec: shop, hints });
    const h = image[0] as { entity: string; field: string };
    const stored = await api.deps.pg.unsafe<{ v: string | null }[]>(
      `select "${h.field}"::text as v from "${schemaName(key, "draft")}"."${h.entity}"`,
    );
    expect(stored.length).toBeGreaterThan(0);
    for (const r of stored) expect(r.v).toMatch(/^\/_wizard\/photos\/lib-[a-z]+-\d\/960$/);
    // The card shows it as its picture as is (same origin, the runtime's library route).
    expect(productPhoto(stored[0]?.v)).toBe(stored[0]?.v);
    const rows = await draftCriticRows(api.deps.db, id, shop);
    expect((rows[h.entity] ?? []).map((r) => r[h.field])).toEqual(stored.map((r) => r.v));
  });

  test("photo hints: only image fields a public role reads, never the site's own photo places; no photos — none", () => {
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
    expect(photoSeedHints(spec, [{ slot: "hero", file: "a1" }])).toEqual([
      { entity: "product", field: "photo", values: Array(10).fill("/_wizard/photos/a1/960") },
    ]);
    expect(photoSeedHints(spec, [])).toEqual([]);
    expect(photoSeedHints(spec, [{ slot: "hero", file: "../etc" }])).toEqual([]);
  });
});
