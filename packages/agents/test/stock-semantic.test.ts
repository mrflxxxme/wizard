// V4-10 acceptance (the semantic photo library): shards keep entries and int8 embeddings paired by a checksum, search
// ranks by cosine without near duplicates and photos already on the site, a topic with too few close photos is queued
// for backfill, the catalog is well-formed, the SigLIP input is computed without image libraries, and the photo grade
// gives one CSS filter per direction (a cast toward the accent, none for a neutral one).
import { describe, expect, test } from "vitest";
import {
  CATALOG,
  type Candidate,
  decodeVectors,
  EMBED_DIM,
  encodeVectors,
  GOOD_SCORE,
  imageInput,
  type LibraryObjects,
  lazyTextEncoder,
  loadSemanticLibrary,
  MAX_REQUESTS,
  MIN_GOOD,
  NICHE_TARGET,
  needsBackfill,
  normalize,
  padTokens,
  photoGrade,
  photoGradeCss,
  quantize,
  readRequests,
  readShard,
  requestBackfill,
  requestSlug,
  SEMANTIC_MODEL,
  SEMANTIC_OBJECTS,
  SEMANTIC_VERSION,
  type SemanticEntry,
  type Shard,
  SIGLIP,
  storageObjects,
  writeManifest,
  writeShard,
} from "../src/stock/index.js";

const memory = (): LibraryObjects & { map: Map<string, Uint8Array> } => {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    get: async (n) => map.get(n) ?? null,
    put: async (n, d) => {
      map.set(n, d);
    },
  };
};

/** A unit vector pointing mostly along axis `a` (plus a little of axis `b`). */
const axis = (a: number, b = (a + 1) % EMBED_DIM, mix = 0.1) => {
  const v = new Float32Array(EMBED_DIM);
  v[a] = 1;
  v[b] = mix;
  return normalize(v);
};

let seq = 0;
const entry = (over: Partial<SemanticEntry> = {}): SemanticEntry => {
  seq++;
  return {
    provider: "pexels",
    id: String(seq),
    file: `00000000-0000-5000-8000-${seq.toString(16).padStart(12, "0")}`,
    author: "Автор",
    pageUrl: `https://www.pexels.com/photo/${seq}/`,
    width: 1600,
    height: 1067,
    color: "#808080",
    luma: 0.5,
    query: "dental clinic",
    ...over,
  };
};

const shard = (slug: string, rows: { e?: Partial<SemanticEntry>; v: Float32Array }[]): Shard => ({
  slug,
  name: slug,
  entries: rows.map((r) => entry(r.e)),
  vectors: quantize(rows.map((r) => r.v)),
});

const library = async (shards: Shard[]) => {
  const o = memory();
  for (const s of shards) await writeShard(o, s);
  await writeManifest(o, {
    version: SEMANTIC_VERSION,
    model: SEMANTIC_MODEL,
    shards: shards.map((s) => ({
      slug: s.slug,
      name: s.name,
      count: s.entries.length,
      updatedAt: "2026-10-13",
    })),
  });
  return { o, lib: await loadSemanticLibrary(o) };
};

describe("vectors and shards", () => {
  test("int8 rows keep the cosine within 1 %, the bytes round-trip", () => {
    const rows = [axis(1, 7, 0.4), axis(3, 9, 0.8)];
    const q = quantize(rows);
    const back = decodeVectors(encodeVectors(q));
    expect(back.dim).toBe(EMBED_DIM);
    expect(Array.from(back.data)).toEqual(Array.from(q.data));
    for (let r = 0; r < rows.length; r++) {
      let s = 0;
      for (let i = 0; i < EMBED_DIM; i++)
        s += (back.data[r * EMBED_DIM + i] as number) * (back.scales[r] as number) * (rows[r]?.[i] as number);
      expect(s).toBeGreaterThan(0.99);
    }
    expect(() => decodeVectors(new Uint8Array(8))).toThrow();
  });

  test("a shard reads back; vectors not matching the meta make it unusable (a write in progress)", async () => {
    const o = memory();
    await writeShard(o, shard("dental", [{ v: axis(1) }, { v: axis(2) }]));
    const sh = await readShard(o, "dental");
    expect(sh?.entries).toHaveLength(2);
    expect(sh?.vectors.scales).toHaveLength(2);
    o.map.set(SEMANTIC_OBJECTS.vectors("dental"), encodeVectors(quantize([axis(5)])));
    expect(await readShard(o, "dental")).toBeNull();
    expect(await readShard(o, "missing")).toBeNull();
  });

  test("invalid entries are dropped with their vectors", async () => {
    const o = memory();
    await writeShard(
      o,
      shard("hair", [{ v: axis(1) }, { e: { pageUrl: "http://x" }, v: axis(2) }, { v: axis(3) }]),
    );
    const sh = await readShard(o, "hair");
    expect(sh?.entries.map((e) => e.pageUrl.startsWith("https://"))).toEqual([true, true]);
    expect(sh?.vectors.scales).toHaveLength(2);
    expect(sh?.vectors.data[EMBED_DIM + 3]).toBe(127);
  });
});

describe("search", () => {
  test("best cosine first, filter and exclude respected, a photo of two shards once", async () => {
    const twin = entry({ id: "twin" });
    const { lib } = await library([
      shard("a", [
        { v: axis(1, 2, 0.05) },
        { e: { width: 800, height: 1200 }, v: axis(1, 3, 0.2) },
        { v: axis(9) },
      ]),
      { ...shard("b", [{ v: axis(1, 4, 0.5) }]), entries: [twin] },
      { ...shard("c", [{ v: axis(1, 4, 0.5) }]), entries: [{ ...twin }] },
    ]);
    expect(lib?.size).toBe(4);
    const q = axis(1, 0, 0);
    const all = lib?.search(q, { duplicate: 1.01 }) ?? [];
    expect(all.map((c) => c.entry.niche)).toEqual(["a", "a", "b", "a"]);
    const landscape = lib?.search(q, { filter: (e) => e.width > e.height, duplicate: 1.01 }) ?? [];
    expect(landscape).toHaveLength(3);
    const first = all[0] as Candidate;
    const rest = lib?.search(q, { exclude: new Set([`pexels:${first.entry.id}`]), duplicate: 1.01 }) ?? [];
    expect(rest.map((c) => c.entry.id)).not.toContain(first.entry.id);
    expect(lib?.search(q, { limit: 2 })).toHaveLength(2);
  });

  test("near duplicates are skipped", async () => {
    const { lib } = await library([
      shard("a", [{ v: axis(1, 2, 0.01) }, { v: axis(1, 2, 0.02) }, { v: axis(1, 5, 0.6) }]),
    ]);
    expect(lib?.search(axis(1, 0, 0)).length).toBe(2);
  });

  test("no manifest — no library", async () => {
    expect(await loadSemanticLibrary(memory())).toBeNull();
  });

  test("backfill when fewer than MIN_GOOD candidates are on topic", () => {
    const c = (score: number): Candidate => ({ entry: { ...entry(), niche: "x" }, score });
    expect(needsBackfill(Array.from({ length: 20 }, () => c(GOOD_SCORE + 0.01)))).toBe(false);
    expect(
      needsBackfill([
        ...Array.from({ length: MIN_GOOD - 1 }, () => c(GOOD_SCORE)),
        ...Array.from({ length: 13 }, () => c(0.01)),
      ]),
    ).toBe(true);
  });
});

describe("backfill requests", () => {
  test("the same niche counts up, the queue is capped", async () => {
    const o = memory();
    await requestBackfill(o, "  Ремонт   ЛОДОК ", new Date("2026-10-13T10:00:00Z"));
    await requestBackfill(o, "ремонт лодок", new Date("2026-10-13T11:00:00Z"));
    await requestBackfill(o, "Ёлочные игрушки");
    const r = await readRequests(o);
    expect(r.requests.map((x) => [x.text, x.count])).toEqual([
      ["ремонт лодок", 2],
      ["елочные игрушки", 1],
    ]);
    for (let i = 0; i < MAX_REQUESTS + 5; i++) await requestBackfill(o, `ниша ${i}`);
    expect((await readRequests(o)).requests).toHaveLength(MAX_REQUESTS);
    expect(requestSlug("Ремонт лодок")).toBe(requestSlug("ремонт  лодок"));
    expect(requestSlug("ремонт лодок")).toMatch(/^req-[a-z0-9]+$/);
  });

  test("storageObjects maps names to keys and tags the meta", async () => {
    const puts: { key: string; mime: string; field: string }[] = [];
    const store = new Map<string, Uint8Array>();
    const o = storageObjects(
      {
        get: async (k) => (store.has(k) ? { data: store.get(k) as Uint8Array } : null),
        put: async (k, d, m) => {
          store.set(k, d);
          puts.push({ key: k, mime: m.mime, field: m.field });
        },
      },
      (n) => `wz_photos/${n.length}`,
    );
    await requestBackfill(o, "барбершоп");
    expect(puts).toEqual([
      { key: `wz_photos/${SEMANTIC_OBJECTS.requests.length}`, mime: "application/json", field: "semantic" },
    ]);
    expect((await readRequests(o)).requests[0]?.text).toBe("барбершоп");
  });
});

describe("catalog", () => {
  test("slugs unique and valid, every niche has queries, 20–30 thousand photos in all", () => {
    const slugs = CATALOG.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const c of CATALOG) {
      expect(c.slug).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
      expect(c.queries.length).toBeGreaterThanOrEqual(3);
      expect(c.name).toMatch(/[а-яё]/);
    }
    const total = CATALOG.length * NICHE_TARGET;
    expect(total).toBeGreaterThanOrEqual(20_000);
    expect(total).toBeLessThanOrEqual(30_000);
  });

  test("the flagship class comes first: services with booking before shops", () => {
    const at = (s: string) => CATALOG.findIndex((c) => c.slug === s);
    for (const s of ["dental", "cleaning", "aircon", "hair", "kids-center"])
      expect(at(s)).toBeLessThan(at("clothing"));
  });
});

describe("SigLIP input", () => {
  test("tokens padded to 64 with <pad>, a long text keeps its <eos>", () => {
    expect(padTokens([5, 6, 1])).toEqual([5, 6, 1, ...Array(61).fill(0)]);
    const long = padTokens([...Array(100).keys()].map((i) => i + 2));
    expect(long).toHaveLength(SIGLIP.maxTokens);
    expect(long.at(-1)).toBe(1);
  });

  test("pixels resized by area to 224², normalized to −1…1, mean colour and luma", () => {
    const w = 448;
    const h = 224;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        // Left half red, right half blue.
        data[p] = x < w / 2 ? 255 : 0;
        data[p + 2] = x < w / 2 ? 0 : 255;
        data[p + 3] = 255;
      }
    const r = imageInput({ data, width: w, height: h });
    const S = SIGLIP.size;
    expect(r.pixels).toHaveLength(3 * S * S);
    expect(r.pixels[0]).toBe(1); // red channel, left
    expect(r.pixels[S - 1]).toBe(-1); // red channel, right
    expect(r.pixels[2 * S * S + S - 1]).toBe(1); // blue channel, right
    expect(r.color).toBe("#800080");
    expect(r.luma).toBeCloseTo(0.14, 2);
    expect(() => imageInput({ data: new Uint8Array(4), width: 2, height: 2 })).toThrow();
  });

  test("the lazy encoder loads once, again after a failure, and releases on close", async () => {
    let loads = 0;
    let closed = 0;
    let fail = true;
    const enc = lazyTextEncoder(async () => {
      loads++;
      if (fail) throw new Error("no model");
      return { encode: async () => axis(1), close: async () => void closed++ };
    });
    await expect(enc.encode("кофейня")).rejects.toThrow("no model");
    fail = false;
    await enc.encode("кофейня");
    await enc.encode("пекарня");
    expect(loads).toBe(2);
    expect(enc.loaded()).toBe(true);
    await enc.close();
    expect(closed).toBe(1);
    expect(enc.loaded()).toBe(false);
  });
});

describe("photo grade", () => {
  test("a cast toward the accent hue on top of the treatment's tone", () => {
    const g = photoGrade({ treatment: "warm-grade", accent: "#1f6feb" });
    expect(g.hue).toBe(216);
    expect(g.filter).toBe(
      "contrast(1.03) saturate(1.02) brightness(1.02) sepia(0.2) hue-rotate(-179deg) saturate(1.04)",
    );
    expect(photoGrade({ treatment: "natural", accent: "#e8590c" }).filter).toContain("hue-rotate(-14deg)");
  });

  test("an oklch accent of the palette; a neutral accent gets no cast", () => {
    expect(photoGrade({ treatment: "natural", accent: "oklch(0.62 0.19 25)" }).hue).not.toBeNull();
    const grey = photoGrade({ treatment: "soft-grade", accent: "oklch(0.4 0.01 250)" });
    expect(grey).toEqual({ filter: "contrast(0.94) saturate(0.86) brightness(1.04)", hue: null });
  });

  test("monochrome becomes a duotone of the accent; the CSS targets library photos only", () => {
    const g = photoGrade({ treatment: "monochrome", accent: "#2b8a3e" });
    expect(g.filter).toMatch(/^grayscale\(1\) contrast\(1\.08\) sepia\(0\.4\) hue-rotate\(-?\d+deg\)$/);
    const css = photoGradeCss(g);
    expect(css).toContain(`--ds-image-filter:${g.filter}`);
    expect(css).toContain('img[src*="/_wizard/photos/"],[data-wz-photo]{filter:var(--ds-image-filter)}');
  });
});
