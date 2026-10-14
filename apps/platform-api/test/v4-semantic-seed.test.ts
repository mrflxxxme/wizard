// V4-22: the demo rows of the catalog get photos of the semantic library (V4-10) by their names — the acceptance
// rehearsal's clinic showed grey cards: the index of the old library is empty for the semantic photos. One photo per
// named row, never twice, never one of the plan's, landscape only; a field the index already covers stays as it is.
// V4-26: searched by the site's niche and only in the niche shards of the plan's photos — rehearsal 3 put a
// gynecologist's chair on the dental clinic's «Терапия».
import type { AppSpec } from "@wizard/appspec";
import { expect, test } from "vitest";
import { isPersonEntity, pickerCardCheck } from "../src/builds-v3/card-photos.js";
import { photoSeedHints, planNiche, semanticSeedHints } from "../src/builds-v3/host.js";

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
      { file: uuid(20 + i + 2), width: 1600, height: 1000, niche: "dental" },
      { file: uuid(20 + i + 3), width: 1600, height: 1000, niche: "dental" },
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

// V4-27: the build checks the card rows with the vision model in one call — two candidates a row, the model's photo,
// else the row's other candidate without text; photos with text are flagged in the library; a failed call changes
// nothing (first candidates).
test("the card check: one call for every row, the model's photo or the row's other candidate, text flagged", async () => {
  queries.length = 0;
  const names = { entity: "service", field: "name", values: ["Терапия", "Хирургия", "Ортодонтия"] };
  const calls: { slots: string[]; candidates: string[]; niche: string }[] = [];
  const flagged: string[] = [];
  const check = pickerCardCheck({
    niche: "стоматология",
    source: {
      thumbnail: async () => new Uint8Array([1]),
      flagText: async (files) => void flagged.push(...files),
    },
    picker: async (input) => {
      const files = input.candidates.map((c) => c.entry.file);
      calls.push({ slots: input.slots.map((s) => s.label), candidates: files, niche: input.niche });
      const at = (f: string) => files.indexOf(f);
      // Row 1 (22, 23): its second; row 2 (24, 25): nothing — its first stays; row 3 (26, 27): 26 has a sign and the
      // model still puts it there — the row takes 27.
      return [
        { slot: "card-1", index: at(uuid(23)) },
        { text: at(uuid(26)) },
        { slot: "card-3", index: at(uuid(26)) },
      ];
    },
  });
  const hints = await semanticSeedHints(spec, [names], new Set([uuid(1)]), new Set(), source, {
    niche: "стоматология",
    check,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.niche).toBe("стоматология");
  expect(calls[0]?.slots).toEqual([
    "Карточка каталога «Терапия»",
    "Карточка каталога «Хирургия»",
    "Карточка каталога «Ортодонтия»",
  ]);
  // Two dental candidates a row, never the other shard's.
  expect(calls[0]?.candidates).toEqual([22, 23, 24, 25, 26, 27].map(uuid));
  expect(flagged).toEqual([uuid(26)]);
  expect(hints[0]?.values).toEqual([uuid(23), uuid(24), uuid(27)].map((f) => `/_wizard/photos/${f}/960`));
  // A failed call: the rows take their first candidates.
  queries.length = 0;
  const failed = await semanticSeedHints(spec, [names], new Set([uuid(1)]), new Set(), source, {
    niche: "стоматология",
    check: pickerCardCheck({
      niche: "стоматология",
      source: { thumbnail: async () => null },
      picker: async () => null,
    }),
  });
  expect(failed[0]?.values).toEqual([uuid(22), uuid(24), uuid(26)].map((f) => `/_wizard/photos/${f}/960`));
});

// D49: the owner's people (doctors, masters, team) never get a stock photo — that would pass strangers off as the staff.
test("people entities get no library photos: neither by name nor from the plan", async () => {
  const people = {
    ...spec,
    entities: [
      ...spec.entities,
      {
        name: "specialist",
        fields: [
          { name: "name", type: "string" },
          { name: "photo", type: "image" },
        ],
      },
      { name: "team_member", fields: [{ name: "photo", type: "image" }] },
    ],
    permissions: [
      ...spec.permissions,
      { role: "visitor", entity: "specialist", ops: ["read"] },
      { role: "visitor", entity: "team_member", ops: ["read"] },
    ],
  } as unknown as AppSpec;
  expect(["specialist", "team_member", "doctors", "master"].every(isPersonEntity)).toBe(true);
  expect(["service", "membership", "product"].some(isPersonEntity)).toBe(false);
  queries.length = 0;
  const names = { entity: "specialist", field: "name", values: ["Иванова Анна", "Петров Олег"] };
  const hints = await semanticSeedHints(people, [names], new Set(), new Set(), source);
  expect(hints.map((h) => h.entity)).toEqual(["service"]);
  const plan = [{ slot: "gallery", file: uuid(5) }];
  expect(photoSeedHints(people, plan).map((h) => h.entity)).toEqual(["service"]);
});
