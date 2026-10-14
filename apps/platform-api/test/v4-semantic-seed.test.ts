// V4-22: the demo rows of the catalog get photos of the semantic library (V4-10) by their names — the acceptance
// rehearsal's clinic showed grey cards: the index of the old library is empty for the semantic photos. One photo per
// named row, never twice, never one of the plan's, landscape only; a field the index already covers stays as it is.
import type { AppSpec } from "@wizard/appspec";
import { expect, test } from "vitest";
import { semanticSeedHints } from "../src/builds-v3/host.js";

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

/** A fake library: each query answers its own photos; the first one is the plan's hero (portrait in one case). */
const queries: string[] = [];
const source = {
  async search(text: string, o: { filter?: (e: never) => boolean }) {
    queries.push(text);
    const i = queries.length;
    const entries = [
      { file: uuid(1), width: 1600, height: 1000 }, // the plan's photo
      { file: uuid(10 + i), width: 800, height: 1200 }, // portrait
      { file: uuid(20 + i), width: 1600, height: 1000 },
      { file: uuid(20 + i + 1), width: 1600, height: 1000 },
    ];
    return entries
      .filter((e) => (o.filter ? o.filter(e as never) : true))
      .map((entry, k) => ({ entry: entry as never, score: 0.2 - k / 100 }));
  },
};

test("a photo per named row by its name, no repeats, not the plan's, landscape; private entities and covered fields aside", async () => {
  queries.length = 0;
  const names = { entity: "service", field: "name", values: ["Терапия", "Хирургия", "Ортодонтия"] };
  const hints = await semanticSeedHints(spec, [names], new Set([uuid(1)]), new Set(), source);
  expect(queries).toEqual([
    "Стоматология Казани, Терапия",
    "Стоматология Казани, Хирургия",
    "Стоматология Казани, Ортодонтия",
  ]);
  expect(hints).toEqual([
    {
      entity: "service",
      field: "photo",
      values: [uuid(21), uuid(22), uuid(23)].map((f) => `/_wizard/photos/${f}/960`),
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
