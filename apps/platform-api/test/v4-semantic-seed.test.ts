// V4-22: the demo rows of the catalog get photos of the semantic library (V4-10) by their names — the acceptance
// rehearsal's clinic showed grey cards: the index of the old library is empty for the semantic photos. One photo per
// named row, never twice, never one of the plan's, landscape only; a field the index already covers stays as it is.
// V4-26: searched by the site's niche and only in the niche shards of the plan's photos — rehearsal 3 put a
// gynecologist's chair on the dental clinic's «Терапия».
import type { AppSpec } from "@wizard/appspec";
import { expect, test } from "vitest";
import { isPersonEntity, pickerCardCheck, rowNiches } from "../src/builds-v3/card-photos.js";
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

// V4-27: the build checks the card rows with the vision model in one call — two candidates a row, the model's photo or
// none; the rows left empty get one more round with their next two; a catalog still with an empty card shows no photos
// (uniformly, never 3 of 4); photos with text are flagged in the library.
/** A library where query i answers four dental photos of its own (i·10+1…4), a medical one first, the plan's hero. */
const rowsSource = () => {
  const qs: string[] = [];
  return {
    qs,
    async search(text: string, o: { filter?: (e: never) => boolean }) {
      qs.push(text);
      const i = qs.length;
      const entries = [
        { file: uuid(1), width: 1600, height: 1000, niche: "dental" },
        { file: uuid(900 + i), width: 1600, height: 1000, niche: "medical-center" },
        ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({
          file: uuid(i * 10 + n),
          width: 1600,
          height: 1000,
          niche: "dental",
        })),
      ];
      return entries
        .filter((e) => (o.filter ? o.filter(e as never) : true))
        .map((entry, k) => ({ entry: entry as never, score: 0.2 - k / 100 }));
    },
  };
};
const names3 = { entity: "service", field: "name", values: ["Терапия", "Хирургия", "Ортодонтия"] };
const photoOf = (n: number) => `/_wizard/photos/${uuid(n)}/960`;

test("the card check: one call, the model's photo; an empty row's second round; text flagged", async () => {
  const src = rowsSource();
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
      // Round 1 — row 1 (21, 22): its second; row 2 (31, 32): nothing fits; row 3 (41, 42): 41 has a sign and the
      // model still puts it there. Round 2 — row 2 (33–36) and row 3 (43–46): their first.
      if (calls.length === 1)
        return [
          { slot: "card-1", index: at(uuid(22)) },
          { text: at(uuid(41)) },
          { slot: "card-3", index: at(uuid(41)) },
        ];
      return [
        { slot: "card-1", index: at(uuid(33)) },
        { slot: "card-2", index: at(uuid(43)) },
      ];
    },
  });
  const hints = await semanticSeedHints(spec, [names3], new Set([uuid(1)]), new Set(), src, {
    niche: "стоматология",
    check,
  });
  // The first search finds the shard of the plan's photo; the rows are searched by the niche, in the dental shard only.
  expect(src.qs).toEqual([
    "стоматология",
    "стоматология, Терапия",
    "стоматология, Хирургия",
    "стоматология, Ортодонтия",
  ]);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.slots).toEqual([
    "Карточка каталога «Терапия»",
    "Карточка каталога «Хирургия»",
    "Карточка каталога «Ортодонтия»",
  ]);
  expect(calls[0]?.candidates).toEqual([21, 22, 31, 32, 41, 42].map(uuid));
  expect(calls[1]?.slots).toEqual(["Карточка каталога «Хирургия»", "Карточка каталога «Ортодонтия»"]);
  // V4-30: the second round goes four candidates deeper (photos with text are flagged out of the library meanwhile).
  expect(calls[1]?.candidates).toEqual([33, 34, 35, 36, 43, 44, 45, 46].map(uuid));
  expect(flagged).toEqual([uuid(41)]);
  expect(hints[0]?.values).toEqual([photoOf(22), photoOf(33), photoOf(43)]);
});

test("the model may give a row another row's candidate of the call, once", async () => {
  const src = rowsSource();
  const check = pickerCardCheck({
    niche: "стоматология",
    source: { thumbnail: async () => new Uint8Array([1]) },
    picker: async (input) => {
      const at = (f: string) => input.candidates.findIndex((c) => c.entry.file === f);
      // Row 2 takes row 3's 41; row 3 takes its own 42; row 1 its 21.
      return [
        { slot: "card-1", index: at(uuid(21)) },
        { slot: "card-2", index: at(uuid(41)) },
        { slot: "card-3", index: at(uuid(42)) },
      ];
    },
  });
  const hints = await semanticSeedHints(spec, [names3], new Set([uuid(1)]), new Set(), src, {
    niche: "стоматология",
    check,
  });
  expect(hints[0]?.values).toEqual([photoOf(21), photoOf(41), photoOf(42)]);
});

test("a card still empty after the second round leaves the whole catalog without photos; a failed call takes the first", async () => {
  const empty = async (rows: readonly { candidates: { file: string }[] }[]) =>
    rows.map((r, i) => (rows.length === 3 && i !== 1 ? r.candidates[0] : null)) as never;
  expect(
    await semanticSeedHints(spec, [names3], new Set([uuid(1)]), new Set(), rowsSource(), {
      niche: "стоматология",
      check: empty,
    }),
  ).toEqual([]);
  const failed = await semanticSeedHints(spec, [names3], new Set([uuid(1)]), new Set(), rowsSource(), {
    niche: "стоматология",
    check: pickerCardCheck({
      niche: "стоматология",
      source: { thumbnail: async () => null },
      picker: async () => null,
    }),
  });
  expect(failed[0]?.values).toEqual([photoOf(21), photoOf(31), photoOf(41)]);
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
  expect(
    [
      "specialist",
      "team_member",
      "doctors",
      "master",
      "portfolio_item",
      "works",
      "review",
      "testimonials",
      "project",
    ].every(isPersonEntity),
  ).toBe(true);
  expect(["service", "membership", "product"].some(isPersonEntity)).toBe(false);
  queries.length = 0;
  const names = { entity: "specialist", field: "name", values: ["Иванова Анна", "Петров Олег"] };
  const hints = await semanticSeedHints(people, [names], new Set(), new Set(), source);
  expect(hints.map((h) => h.entity)).toEqual(["service"]);
  const plan = [{ slot: "gallery", file: uuid(5) }];
  expect(photoSeedHints(people, plan).map((h) => h.entity)).toEqual(["service"]);
});

// V4-28: a salon's site photos come from one shard (hair); its «Брови и ресницы» card searches the brows niche.
test("a row naming another niche of the catalog searches that niche; a row of the site's own niche stays in it", async () => {
  expect(rowNiches("Брови и ресницы")).toEqual(["brows"]);
  expect(rowNiches("Маникюр и педикюр")).toContain("nails");
  expect(rowNiches("Десерты")).toEqual([]);
  const salon = {
    ...spec,
    entities: [spec.entities[0]],
  } as unknown as AppSpec;
  const lib = [
    { file: uuid(1), width: 1600, height: 1000, niche: "hair" }, // the plan's photo
    { file: uuid(2), width: 1600, height: 1000, niche: "hair" },
    { file: uuid(3), width: 1600, height: 1000, niche: "brows" },
  ];
  const src = {
    async search(_t: string, o: { filter?: (e: never) => boolean }) {
      return lib
        .filter((e) => (o.filter ? o.filter(e as never) : true))
        .map((entry) => ({ entry: entry as never, score: 0.2 }));
    },
  };
  const names = { entity: "service", field: "name", values: ["Брови и ресницы", "Стрижки"] };
  const hints = await semanticSeedHints(salon, [names], new Set([uuid(1)]), new Set(), src, {
    niche: "салон красоты",
  });
  expect(hints[0]?.values).toEqual([uuid(3), uuid(2)].map((f) => `/_wizard/photos/${f}/960`));
});
