// B2-43 acceptance (the photo library filled from CI, read without the network): the seeding queries are the photos
// stage's own (stockQuery) for every niche of the dictionary, the index keeps one entry per stock photo with a cap per
// query and a fixed byte form, the library client answers the exact query, then the niche, then the generic photos of
// the slot's orientation, and the photos stage on a library host picks the copies with their author and licence.
import type { SystemPlan } from "@wizard/appspec";
import { photoSlots } from "@wizard/modules";
import { describe, expect, test } from "vitest";
import {
  CATALOG_NICHES,
  createLibraryStockClient,
  emptyLibraryIndex,
  fitsSlot,
  GENERIC_TERMS,
  LIBRARY_SLOT_KINDS,
  type LibraryEntry,
  type LibraryIndex,
  libraryCap,
  librarySearch,
  librarySeedQueries,
  mergeLibraryIndex,
  NICHE_TERMS,
  nicheTerms,
  type PhotoHost,
  parseLibraryIndex,
  planSeedQueries,
  querySubject,
  runPhotosStage,
  STOCK_LICENSES,
  StockError,
  serializeLibraryIndex,
  stockQuery,
} from "../src/builder/index.js";

const uuid = (n: number) => `00000000-0000-5000-8000-${n.toString(16).padStart(12, "0")}`;
let seq = 0;
const entry = (over: Partial<LibraryEntry> & Pick<LibraryEntry, "query">): LibraryEntry => {
  seq++;
  const provider = over.provider ?? "pexels";
  return {
    orientation: "landscape",
    provider,
    id: String(1000 + seq),
    file: uuid(seq),
    author: `Автор ${seq}`,
    authorUrl: `https://www.pexels.com/@a${seq}`,
    pageUrl: `https://www.pexels.com/photo/${1000 + seq}/`,
    ...STOCK_LICENSES[provider],
    width: 1600,
    height: 1000,
    pickedAt: "2026-10-07",
    ...over,
  };
};
const index = (entries: LibraryEntry[]): LibraryIndex => ({ version: 1, entries });

const plan = (niche: string, photoStyle: string): SystemPlan => ({
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

describe("seeding queries (the photos stage's own)", () => {
  test("one catalog niche per niche of the dictionary, in its order, then the generic terms", () => {
    expect(CATALOG_NICHES).toHaveLength(NICHE_TERMS.length + 1);
    CATALOG_NICHES.forEach((niche, i) => {
      const want = NICHE_TERMS[i] ?? GENERIC_TERMS;
      expect(nicheTerms({ niche, goals: [] }).hero, niche || "generic").toBe(want.hero);
    });
  });

  test("the kinds are the ones photoSlots gives: hero in three orientations, the rest landscape", () => {
    const kinds = new Set(LIBRARY_SLOT_KINDS.map((k) => `${k.type}|${k.orientation}`));
    for (const s of photoSlots(plan("стоматология", "")))
      expect(kinds).toContain(`${s.type}|${s.orientation}`);
    expect(kinds).toEqual(
      new Set([
        "hero|landscape",
        "about|landscape",
        "features|landscape",
        "gallery|landscape",
        "hero|portrait",
        "hero|square",
      ]),
    );
  });

  test("queries equal stockQuery: exact queries of a plan first, then every niche × kind once, with caps", () => {
    const p = plan("стоматология «Улыбка»", "светлые кабинеты, дневной свет");
    const first = planSeedQueries(p, photoSlots(p));
    for (const q of first) expect(q).toMatchObject(stockQuery(p, q.type, q.orientation));
    expect(first.map((q) => `${q.text}|${q.orientation}`)).toEqual([
      "dental clinic daylight|portrait",
      "dental clinic daylight|square",
      "dentist with patient daylight|landscape",
      "dental care daylight|landscape",
    ]);
    const all = librarySeedQueries(first);
    expect(all.slice(0, first.length).map((q) => q.text)).toEqual(first.map((q) => q.text));
    const keys = all.map((q) => `${q.text}|${q.orientation}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const niche of CATALOG_NICHES)
      for (const k of LIBRARY_SLOT_KINDS) {
        const q = stockQuery({ niche, goals: [], design: { photoStyle: "" } }, k.type, k.orientation);
        expect(keys, `${niche} ${k.type}`).toContain(`${q.text}|${q.orientation}`);
      }
    // Every niche subject is seeded (the fallback of any plan exists).
    expect(all.find((q) => q.text === "dental clinic" && q.orientation === "landscape")?.cap).toBe(6);
    expect(all.find((q) => q.text === "dental care" && q.orientation === "landscape")?.cap).toBe(10);
    expect(all.find((q) => q.text === "dental clinic" && q.orientation === "portrait")?.cap).toBe(3);
    expect(all.find((q) => q.text === "dental clinic" && q.orientation === "square")?.cap).toBe(4);
    expect(all.find((q) => q.text === "small business")).toBeTruthy();
  });

  test("the subject of a query is the longest known niche term it starts with", () => {
    expect(querySubject("dental clinic interior daylight")).toEqual({
      subject: "dental clinic",
      section: "hero",
    });
    expect(querySubject("barber shop")?.subject).toBe("barber shop");
    expect(querySubject("team at work warm")).toEqual({ subject: "team at work", section: "about" });
    expect(querySubject("unknown thing")).toBeUndefined();
    expect(libraryCap({ query: "dental care close up", orientation: "landscape" })).toBe(10);
  });
});

describe("library index", () => {
  test("merge: one entry per stock photo, the cap only for added ones, base kept, grouped by query", () => {
    const a = entry({ query: "dental clinic" });
    const b = entry({ query: "bakery" });
    const base = index([a, b]);
    const dup = { ...entry({ query: "dental clinic daylight" }), provider: a.provider, id: a.id };
    const more = Array.from({ length: 8 }, () => entry({ query: "dental clinic" }));
    const merged = mergeLibraryIndex(base, [dup, ...more]);
    expect(merged.entries.filter((e) => e.id === a.id)).toHaveLength(1);
    // Cap 6 for a hero query: the base entry and five added ones.
    expect(merged.entries.filter((e) => e.query === "dental clinic")).toHaveLength(6);
    expect(merged.entries.map((e) => e.query)).toEqual(["bakery", ...Array(6).fill("dental clinic")]);
    // The pick order stays inside a query; the base entries are never dropped, even above a smaller cap.
    expect(merged.entries[1]).toEqual(a);
    expect(mergeLibraryIndex(merged, [], { cap: () => 1 }).entries).toHaveLength(7);
    // The same provider id from another stock is another photo.
    const px = entry({ query: "bakery", provider: "pixabay", id: b.id });
    expect(mergeLibraryIndex(merged, [px]).entries).toHaveLength(8);
  });

  test("stored form: the same index gives the same bytes; parse drops bad entries and refuses a broken file", () => {
    const i = mergeLibraryIndex(emptyLibraryIndex(), [
      entry({ query: "yoga studio", orientation: "portrait", height: 2400 }),
      entry({ query: "bakery", provider: "pixabay", authorUrl: undefined }),
    ]);
    const text = serializeLibraryIndex(i);
    expect(serializeLibraryIndex(parseLibraryIndex(text))).toBe(text);
    expect(parseLibraryIndex(new TextEncoder().encode(text))).toEqual(i);
    expect(text.split("\n")).toHaveLength(i.entries.length + 6);
    const bad = JSON.parse(text);
    bad.entries.push({ ...i.entries[0], id: "../x", pageUrl: "http://evil" }, { query: "x" });
    expect(parseLibraryIndex(JSON.stringify(bad)).entries).toEqual(i.entries);
    expect(parseLibraryIndex(null)).toEqual(emptyLibraryIndex());
    expect(() => parseLibraryIndex("{oops")).toThrow(/not JSON/);
    expect(() => parseLibraryIndex('{"version":2,"entries":[]}')).toThrow(/unknown format/);
  });
});

describe("library search (no network)", () => {
  const lib = index([
    entry({ query: "dental clinic interior", id: "1" }),
    entry({ query: "dental clinic", id: "2" }),
    entry({ query: "dental clinic", id: "3", provider: "pixabay", pageUrl: "https://pixabay.com/photos/3/" }),
    entry({ query: "dental clinic", id: "4", orientation: "portrait", width: 1200, height: 1800 }),
    entry({ query: "small business", id: "5" }),
    entry({ query: "team at work", id: "6" }),
    entry({ query: "bakery", id: "7" }),
  ]);
  const ids = (q: string, o: "landscape" | "portrait" | "square" = "landscape", n = 30) =>
    librarySearch(lib, { text: q, orientation: o }, n).map((h) => h.id);

  test("exact query, then the niche, then the generic subject of the same section; orientation always", () => {
    expect(ids("dental clinic interior")).toEqual(["1", "2", "3", "5"]);
    expect(ids("dental clinic warm calm")).toEqual(["1", "2", "3", "5"]);
    expect(ids("dental clinic", "portrait")).toEqual(["4"]);
    expect(ids("dental clinic", "square")).toEqual([]);
    expect(ids("dentist with patient")).toEqual(["6"]);
    expect(ids("unknown words")).toEqual(["5", "6"]);
    expect(ids("dental clinic", "landscape", 2)).toEqual(["2", "3"]);
  });

  test("a hit keeps its stock, author and links; the client reads the index once per TTL", async () => {
    let loads = 0;
    let t = 0;
    const client = createLibraryStockClient({
      load: async () => {
        loads++;
        return lib;
      },
      ttlMs: 1000,
      now: () => t,
    });
    expect(client.providers).toEqual(["pexels"]);
    const hits = await client.search("pexels", { text: "dental clinic", orientation: "landscape" }, 6);
    expect(hits[1]).toMatchObject({ provider: "pixabay", id: "3", pageUrl: "https://pixabay.com/photos/3/" });
    expect(client.fileOf(hits[1] as never)).toBe(lib.entries[2]?.file);
    expect(await client.download(hits[0] as never)).toEqual(new Uint8Array(0));
    await client.search("pexels", { text: "bakery", orientation: "landscape" }, 6);
    expect(loads).toBe(1);
    t = 5000;
    await client.search("pexels", { text: "bakery", orientation: "landscape" }, 6);
    expect(loads).toBe(2);
    await expect(client.download({ ...(hits[0] as never), id: "999" })).rejects.toBeInstanceOf(StockError);
    expect(client.fileOf({ provider: "pexels", id: "999" })).toBeUndefined();
  });

  test("an unreadable index is a stock error of the search (the stage keeps the theme graphic)", async () => {
    const client = createLibraryStockClient({
      load: async () => {
        throw new Error("S3 down");
      },
    });
    await expect(client.search("pexels", { text: "bakery", orientation: "landscape" }, 6)).rejects.toThrow(
      /BAD_RESPONSE/,
    );
  });
});

describe("photos stage on a library host", () => {
  test("picks the library copies with their author and licence; nothing downloaded or re-encoded", async () => {
    const p = plan("стоматология «Улыбка»", "светлые кабинеты, дневной свет");
    const exact = planSeedQueries(p, photoSlots(p));
    const entries: LibraryEntry[] = [];
    for (const q of exact) {
      const [w, h] =
        q.orientation === "portrait"
          ? [1200, 1800]
          : q.orientation === "square"
            ? [1400, 1400]
            : [1600, 1000];
      for (let i = 0; i < libraryCap({ query: q.text, orientation: q.orientation }); i++)
        entries.push(entry({ query: q.text, orientation: q.orientation, width: w, height: h }));
    }
    entries.push(
      entry({
        query: "dental clinic daylight",
        orientation: "square",
        provider: "pixabay",
        width: 1400,
        height: 1400,
      }),
    );
    const lib = mergeLibraryIndex(emptyLibraryIndex(), entries);
    const stock = createLibraryStockClient({ load: async () => lib });
    const stored: string[] = [];
    const host: PhotoHost = {
      stock,
      async store(hit, bytes) {
        expect(bytes.byteLength).toBe(0);
        const e = lib.entries.find((x) => x.provider === hit.provider && x.id === hit.id) as LibraryEntry;
        stored.push(e.file);
        return { id: e.file, width: e.width, height: e.height };
      },
    };
    for (const e of lib.entries) expect(fitsSlot(e, { type: "hero", orientation: e.orientation })).toBe(true);
    const r = await runPhotosStage({ plan: p, host, now: () => Date.parse("2026-10-07T10:00:00Z") });
    const slots = photoSlots(p);
    expect(r.picked).toBe(slots.length);
    expect(r.fallback).toBe(false);
    const photos = r.plan.design.photos ?? [];
    expect(photos.map((x) => x.file)).toEqual(stored);
    for (const ph of photos) {
      const e = lib.entries.find((x) => x.file === ph.file) as LibraryEntry;
      expect(ph).toMatchObject({
        provider: e.provider,
        stockId: e.id,
        author: e.author,
        pageUrl: e.pageUrl,
        ...STOCK_LICENSES[e.provider],
        width: e.width,
        height: e.height,
      });
    }
    expect(new Set(photos.map((x) => x.file)).size).toBe(photos.length);
    expect(r.note).toContain(`фото со стока: ${slots.length} из ${slots.length}`);
  });

  test("an empty library: the slots keep the theme graphic, never a failure", async () => {
    const p = plan("пекарня", "");
    const r = await runPhotosStage({
      plan: p,
      host: {
        stock: createLibraryStockClient({ load: async () => emptyLibraryIndex() }),
        store: async () => {
          throw new Error("never");
        },
      },
    });
    expect(r.picked).toBe(0);
    expect(r.note).toContain("сток не нашёл подходящих");
  });
});
