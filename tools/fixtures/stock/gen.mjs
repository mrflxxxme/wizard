#!/usr/bin/env node
// Stock fixtures of B2-38 (node tools/fixtures/stock/gen.mjs): search answers in the format of the Pexels API
// (GET /v1/search) and the Pixabay API (GET /api/), keyed «query|orientation» as packages/agents/src/stock/fixtures.ts
// reads them; «*» answers any other query. The answers are synthetic (the platform keys come with M2-20): authors and
// pages are marked as fixtures, image URLs carry `wz=<w>x<h>` — the fixture fetch draws a deterministic picture of that
// size instead of downloading. A live recording (WIZARD_STOCK_MODE=record, or the record action of the stock workflow —
// tools/deploy/stock-ci.mjs) writes the Pexels answers of QUERIES into pexels.recorded.json, which wins over these;
// this generator never touches that file.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const SIZES = {
  landscape: [[960, 640], [1200, 800], [960, 600]],
  portrait: [[640, 900], [720, 960]],
  square: [[800, 800], [720, 720]],
};
// Claimed sizes of the originals (the API reports the full photo; the fixture file is smaller).
const CLAIMED = { landscape: [5472, 3648], portrait: [3648, 5472], square: [4000, 4000] };

/** Queries the tests and the demo builds ask (stock/query.ts for their niches and styles); the dictionary of record. */
export const QUERIES = [
  ["dental clinic daylight", "landscape"],
  ["dentist with patient daylight", "landscape"],
  ["dental care daylight", "landscape"],
  ["barber shop warm", "landscape"],
  ["barber shop warm", "portrait"],
  ["barber tools warm", "square"],
  ["barber at work warm", "landscape"],
  ["renovated apartment interior daylight", "landscape"],
  ["interior details interior daylight", "landscape"],
];

const n = (s) => Number.parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16);

function pexels(query, orientation, count = 12) {
  const [cw, ch] = CLAIMED[orientation];
  const photos = Array.from({ length: count }, (_, i) => {
    const id = 1_000_000 + (n(`pexels|${query}|${orientation}|${i}`) % 8_000_000);
    const [w, h] = SIZES[orientation][i % SIZES[orientation].length];
    return {
      id,
      width: cw,
      height: ch,
      url: `https://www.pexels.com/photo/fixture-${id}/`,
      photographer: `Автор фикстуры ${(i % 5) + 1}`,
      photographer_url: `https://www.pexels.com/@fixture-${(i % 5) + 1}`,
      photographer_id: 100 + (i % 5),
      avg_color: "#8A9BA8",
      src: {
        original: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?wz=${w}x${h}`,
        large2x: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940&wz=${w}x${h}`,
        large: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&h=650&w=940&wz=${w}x${h}`,
      },
      liked: false,
      alt: `fixture ${query}`,
    };
  });
  return { page: 1, per_page: count, photos, total_results: count };
}

function pixabay(query, orientation, count = 12) {
  const [cw, ch] = CLAIMED[orientation];
  const hits = Array.from({ length: count }, (_, i) => {
    const id = 2_000_000 + (n(`pixabay|${query}|${orientation}|${i}`) % 8_000_000);
    const [w, h] = SIZES[orientation][i % SIZES[orientation].length];
    const user = `fixture_author_${(i % 4) + 1}`;
    return {
      id,
      pageURL: `https://pixabay.com/photos/fixture-${id}/`,
      type: "photo",
      tags: query.split(" ").join(", "),
      largeImageURL: `https://pixabay.com/get/fixture_${id}_1280.jpg?wz=${w}x${h}`,
      imageWidth: cw,
      imageHeight: ch,
      user_id: 300 + (i % 4),
      user,
    };
  });
  return { total: count, totalHits: count, hits };
}

// «*»: landscape photos first, then portrait and square ones (a collage asks for all three).
const mixed = (f, list) =>
  ["landscape", "portrait", "square"].map((o, i) => f("any", o, [16, 4, 4][i])).reduce((a, x) => ({
    ...a,
    [list]: [...a[list], ...x[list]],
  }));

/** Writes the synthetic answers of both providers. */
export function generate() {
  const out = { pexels: {}, pixabay: {} };
  for (const [q, o] of QUERIES) {
    out.pexels[`${q}|${o}`] = pexels(q, o);
    out.pixabay[`${q}|${o}`] = pixabay(q, o);
  }
  out.pexels["*"] = { ...mixed(pexels, "photos"), per_page: 24, total_results: 24 };
  out.pixabay["*"] = { ...mixed(pixabay, "hits"), total: 24, totalHits: 24 };
  for (const p of ["pexels", "pixabay"])
    writeFileSync(join(dir, `${p}.json`), `${JSON.stringify(out[p], null, 1)}\n`);
  console.log(`stock fixtures: ${QUERIES.length} queries + «*» for pexels and pixabay`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) generate();
