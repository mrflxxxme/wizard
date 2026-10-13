// V4-10 acceptance (the photos of a site from the semantic library): candidates are searched per slot kind by a
// Russian query, at most 20 go to the vision pick, its invalid choices are ignored and the slots it leaves take the
// best remaining fitting photo, no photo repeats on the site, a thin topic queues the niche for backfill (only once the
// catalog is mostly filled), the photos stage takes the library first and the stock way while it is empty, and the
// site CSS applies the direction's grade to the library photos.
import type { SystemPlan } from "@wizard/appspec";
import { photoSlots } from "@wizard/modules";
import { describe, expect, test } from "vitest";
import {
  createLibraryStockClient,
  designCss,
  emptyLibraryIndex,
  runPhotosStage,
} from "../src/builder/index.js";
import {
  BACKFILL_MIN_LIBRARY,
  type Candidate,
  createSemanticSource,
  EMBED_DIM,
  GOOD_SCORE,
  type LibraryObjects,
  type LibraryPhotoEntry,
  normalize,
  type PhotoPicker,
  PICK_CANDIDATES,
  photoQueryText,
  quantize,
  readRequests,
  SEMANTIC_MODEL,
  SEMANTIC_VERSION,
  type SemanticPhotoSource,
  semanticPhotos,
  writeManifest,
  writeShard,
} from "../src/stock/index.js";

const plan = (niche: string, photoStyle = ""): SystemPlan => ({
  version: 1,
  niche,
  goals: [{ id: "leads", statement: "Получать заявки с сайта" }],
  modules: [{ id: "landing" }, { id: "leads" }, { id: "notify" }],
  landing: {
    sections: [
      { type: "header", variant: "bar", content: {} },
      { type: "hero", variant: "collage", content: { title: "Заголовок", cta: "Оставить заявку" } },
      { type: "about", variant: "split", content: { title: "О нас", text: "Текст." } },
      { type: "gallery", variant: "grid", content: { title: "Работы", items: ["Один", "Два", "Три"] } },
      { type: "lead_form", variant: "card", content: { title: "Оставьте заявку" } },
      { type: "footer", variant: "simple", content: {} },
    ],
  },
  design: {
    direction: { mood: ["спокойствие"] },
    theme: "strict",
    accent: "#2A7F9E",
    fontPair: { heading: "Onest", body: "Onest" },
    photoStyle,
  },
  outOfScope: [],
  custom: [],
});

let seq = 0;
const photo = (
  o: "landscape" | "portrait" | "square",
  over: Partial<LibraryPhotoEntry> = {},
): LibraryPhotoEntry => {
  seq++;
  const [width, height] = o === "landscape" ? [1800, 1200] : o === "portrait" ? [1200, 1800] : [1400, 1400];
  return {
    provider: seq % 2 ? "pexels" : "pixabay",
    id: String(1000 + seq),
    file: `00000000-0000-5000-8000-${seq.toString(16).padStart(12, "0")}`,
    author: `Автор ${seq}`,
    pageUrl: `https://www.pexels.com/photo/${seq}/`,
    width,
    height,
    color: "#7f8c99",
    luma: 0.5,
    query: "dental clinic",
    niche: "dental",
    ...over,
  };
};

/** A source over a fixed list: every search returns the entries that pass its filter, in list order. */
const fakeSource = (entries: LibraryPhotoEntry[], score = GOOD_SCORE + 0.05) => {
  const log = { queries: [] as string[], backfill: [] as string[], thumbs: 0 };
  const source: SemanticPhotoSource = {
    async search(text, o) {
      log.queries.push(text);
      return entries
        .filter((e) => !o.exclude?.has(`${e.provider}:${e.id}`) && (!o.filter || o.filter(e)))
        .slice(0, o.limit ?? 20)
        .map((entry): Candidate => ({ entry, score }));
    },
    async requestBackfill(text) {
      log.backfill.push(text);
    },
    async thumbnail() {
      log.thumbs++;
      return new Uint8Array([1]);
    },
  };
  return { source, log };
};

const library = [
  ...Array.from({ length: 30 }, () => photo("landscape")),
  ...Array.from({ length: 5 }, () => photo("portrait")),
  ...Array.from({ length: 5 }, () => photo("square")),
];

describe("semanticPhotos", () => {
  const p = plan("стоматология", "светлые фото");
  const slots = photoSlots(p);

  test("a Russian query per slot kind; the picker sees at most 20 and its choices are kept", async () => {
    const { source, log } = fakeSource(library);
    let seen = 0;
    const picker: PhotoPicker = async (input) => {
      seen = input.candidates.length;
      expect(input.palette).toEqual(["#2A7F9E"]);
      // The last fitting candidate for the first screen: the model, not the rank, decides.
      const i = input.candidates.findLastIndex((c) => c.entry.height > c.entry.width);
      return [{ slot: slots[0]?.slot as string, index: i }];
    };
    const r = await semanticPhotos({ plan: p, slots, source, picker, pickedAt: "2026-10-13" });
    expect(log.queries).toContain("стоматология, светлые фото");
    expect(log.queries).toContain("стоматология, люди за работой, мастер с клиентом, светлые фото");
    expect(seen).toBeLessThanOrEqual(PICK_CANDIDATES);
    expect(r.picked).toBe(true);
    expect(r.photos).toHaveLength(slots.length);
    expect(r.photos[0]?.file).not.toBe(library.find((e) => e.height > e.width)?.file);
    expect(new Set(r.photos.map((x) => x.file)).size).toBe(r.photos.length);
    expect(r.photos[0]).toMatchObject({ license: "Лицензия Pexels", pickedAt: "2026-10-13" });
    expect(r.backfill).toBe(false);
  });

  test("invalid choices are ignored: out of range, wrong orientation, the same photo twice", async () => {
    const { source } = fakeSource(library);
    const portraitSlot = slots.find((s) => s.orientation === "portrait");
    const picker: PhotoPicker = async (input) => {
      const land = input.candidates.findIndex((c) => c.entry.width > c.entry.height);
      return [
        { slot: slots[0]?.slot as string, index: 99 },
        { slot: portraitSlot?.slot ?? "x", index: land },
        { slot: "about", index: land },
        { slot: "gallery", index: land },
      ];
    };
    const r = await semanticPhotos({ plan: p, slots, source, picker, pickedAt: "2026-10-13" });
    expect(r.photos).toHaveLength(slots.length);
    const files = r.photos.map((x) => x.file);
    expect(new Set(files).size).toBe(files.length);
    for (const ph of r.photos) {
      const s = slots.find((x) => x.slot === ph.slot);
      if (s?.orientation === "portrait") expect(ph.height).toBeGreaterThan(ph.width);
    }
  });

  test("a failing picker — rank order; photos already on the site are never reused", async () => {
    const { source } = fakeSource(library);
    const used = new Set([`${library[0]?.provider}:${library[0]?.id}`]);
    const r = await semanticPhotos({
      plan: p,
      slots,
      source,
      picker: async () => {
        throw new Error("model down");
      },
      used,
      pickedAt: "2026-10-13",
    });
    expect(r.picked).toBe(false);
    expect(r.photos.map((x) => x.file)).not.toContain(library[0]?.file);
    expect(r.photos.find((x) => x.slot === "about")?.file).toBe(library[1]?.file);
  });

  test("too few photos on the topic queue the niche; slots without a fitting photo stay empty", async () => {
    const { source, log } = fakeSource([photo("landscape"), photo("landscape")], 0.01);
    const r = await semanticPhotos({ plan: p, slots, source, pickedAt: "2026-10-13" });
    expect(r.backfill).toBe(true);
    expect(log.backfill).toEqual(["стоматология"]);
    expect(r.photos.length).toBe(2);
  });

  test("the query of a kind leads with the niche", () => {
    expect(photoQueryText({ niche: "клининг" }, "gallery")).toBe("клининг, результат работы, интерьер");
  });
});

const memory = (): LibraryObjects => {
  const map = new Map<string, Uint8Array>();
  return { get: async (n) => map.get(n) ?? null, put: async (n, d) => void map.set(n, d) };
};
const unit = (i: number) => {
  const v = new Float32Array(EMBED_DIM);
  v[i % EMBED_DIM] = 1;
  return normalize(v);
};
const encoder = { encode: async () => unit(1), close: async () => {} };

describe("createSemanticSource", () => {
  test("no library yet — no candidates and no backfill requests", async () => {
    const objects = memory();
    const src = createSemanticSource({
      objects,
      modelDir: "/nonexistent",
      thumbnail: async () => null,
      encoder,
    });
    expect(await src.search("клининг", {})).toEqual([]);
    await src.requestBackfill("клининг");
    expect((await readRequests(objects)).requests).toEqual([]);
  });

  test("a loaded library answers by cosine; backfill requests once the catalog is mostly filled", async () => {
    const objects = memory();
    const entries = [photo("landscape"), photo("landscape")];
    await writeShard(objects, { slug: "a", name: "a", entries, vectors: quantize([unit(5), unit(1)]) });
    await writeManifest(objects, {
      version: SEMANTIC_VERSION,
      model: SEMANTIC_MODEL,
      shards: [{ slug: "a", name: "a", count: 2, updatedAt: "2026-10-13" }],
    });
    const src = createSemanticSource({
      objects,
      modelDir: "/nonexistent",
      thumbnail: async () => null,
      encoder,
    });
    const r = await src.search("клининг", {});
    expect(r.map((c) => c.entry.id)).toEqual([entries[1]?.id, entries[0]?.id]);
    await src.requestBackfill("клининг");
    expect((await readRequests(objects)).requests).toEqual([]);
    expect(BACKFILL_MIN_LIBRARY).toBeGreaterThan(2);
  });
});

describe("the photos stage with a semantic library", () => {
  const empty = createLibraryStockClient({ load: async () => emptyLibraryIndex() });
  const store = async () => {
    throw new Error("never");
  };

  test("the library answers: copies from it, attribution kept, a note for the report", async () => {
    const { source } = fakeSource(library);
    const r = await runPhotosStage({
      plan: plan("стоматология"),
      host: { stock: empty, store, semantic: source },
      now: () => Date.parse("2026-10-13T10:00:00Z"),
    });
    expect(r.picked).toBe(photoSlots(plan("стоматология")).length);
    expect(r.note).toMatch(/^фото из библиотеки: \d+ из \d+ \(по сходству\)$/);
    expect(r.plan.design.photos?.[0]).toMatchObject({ pickedAt: "2026-10-13", provider: "pexels" });
  });

  test("an empty or failing library — the stock way, never a failure", async () => {
    for (const semantic of [
      fakeSource([]).source,
      {
        ...fakeSource([]).source,
        search: async () => {
          throw new Error("no model");
        },
      },
    ]) {
      const r = await runPhotosStage({ plan: plan("пекарня"), host: { stock: empty, store, semantic } });
      expect(r.picked).toBe(0);
      expect(r.note).toMatch(/^библиотека по смыслу (пуста|недоступна)/);
      expect(r.note).toContain("сток не нашёл подходящих");
    }
  });
});

test("the site CSS grades the library photos", async () => {
  const { designSystemV3 } = await import("@wizard/ui-kit/v3/design");
  const ds = designSystemV3({ archetype: "calm_medical", seed: "s1", niche: "стоматология" });
  const css = designCss(ds);
  expect(css).toContain('img[src*="/_wizard/photos/"],[data-wz-photo]{filter:var(--ds-image-filter)}');
});
