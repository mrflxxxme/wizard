// V4-22: the demo rows of the catalog get photos of the semantic library (V4-10) by their names — the acceptance
// rehearsal's clinic showed grey cards: the index of the old library is empty for the semantic photos. One photo per
// named row, never twice, never one of the plan's, landscape only; a field the index already covers stays as it is.
// V4-26: searched by the site's niche and only in the niche shards of the plan's photos — rehearsal 3 put a
// gynecologist's chair on the dental clinic's «Терапия».
import type { AppSpec } from "@wizard/appspec";
import { expect, test } from "vitest";
import { planNiche, semanticSeedHints } from "../src/builds-v3/host.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const spec = {
  app: { name: "Стоматология Казани" },
  roles: [
    { name: "visitor", access: "public" },
    { name: "owner", access: "login" },
  ],
  entities: [
    {
      name: "service",
      fields: [
        { name: "name", type: "string" },
        { name: "photo", type: "image" },
      ],
    },
    { name: "staff_doc", fields: [{ name: "scan", type: "image" }] },
  ],
  permissions: [
    { role: "visitor", entity: "service", ops: ["read"] },
    { role: "owner", entity: "staff_doc", ops: ["read"] },
  ],
} as unknown as AppSpec;

/**
 * A fake library: each query answers its own photos — the plan's hero (dental shard), a portrait, a photo of another
 * medical shard ranked first, then the dental ones.
 */
const queries: string[] = [];
const source = {
  async search(text: string, o: { filter?: (e: never) => boolean }) {
    queries.push(text);
    const i = queries.length;
    const entries = [
      { file: uuid(1), width: 1600, height: 1000, niche: "dental" }, // the plan's photo
      { file: uuid(10 + i), width: 800, height: 1200, niche: "dental" }, // portrait
      { file: uuid(100 + i), width: 1600, height: 1000, niche: "medical-center" },
      { file: uuid(20 + i), width: 1600, height: 1000, niche: "dental" },
      { file: uuid(20 + i + 1), width: 1600, height: 1000, niche: "dental" },
    ];
    return entries
      .filter((e) => (o.filter ? o.filter(e as never) : true))
      .map((entry, k) => ({ entry: entry as never, score: 0.2 - k / 100 }));
  },
};

test("a photo per named row by its name, no repeats, not the plan's, landscape; private entities and covered fields aside", async () => {
  queries.length = 0;
  const names = { entity: "service", field: "name", values: ["Терапия", "Хирургия", "Ортодонтия"] };
  const hints = await semanticSeedHints(spec, [names], new Set([uuid(1)]), new Set(), source, {
    niche: "стоматология",
  });
  // The first search finds the shard of the plan's photo; the rows are searched by the niche, in the dental shard only.
  expect(queries).toEqual([
    "стоматология",
    "стоматология, Терапия",
    "стоматология, Хирургия",
    "стоматология, Ортодонтия",
  ]);
  expect(hints).toEqual([
    {
      entity: "service",
      field: "photo",
      values: [uuid(22), uuid(23), uuid(24)].map((f) => `/_wizard/photos/${f}/960`),
    },
  ]);
  // Covered by the index: nothing more; no names: up to six photos of the site's name.
  expect(await semanticSeedHints(spec, [names], new Set(), new Set(["service.photo"]), source)).toEqual([]);
  queries.length = 0;
  const unnamed = await semanticSeedHints(spec, [], new Set(), new Set(), source);
  expect(queries).toEqual(["Стоматология Казани"]);
  expect(unnamed[0]?.values.length).toBeGreaterThan(0);
  // No library: no hints.
  expect(await semanticSeedHints(spec, [names], new Set(), new Set(), { search: async () => [] })).toEqual(
    [],
  );
});

test("the niche of the plan comes from its photos' alt", () => {
  expect(planNiche([{ slot: "top", alt: "Первый экран — фото по теме «стоматология»" }])).toBe(
    "стоматология",
  );
  expect(planNiche([{ slot: "top", alt: "Фото" }, {}])).toBeNull();
});
