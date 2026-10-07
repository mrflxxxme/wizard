// B2-43: the photo library filled from a GitHub runner (tools/deploy/stock-library.mjs) against fake stocks and an
// in-memory storage: queries filled in order within their caps (Pexels first, Pixabay for the rest), one copy per stock
// photo with its author and licence in the index, a repeated run asks nothing for full queries, the request cap stops
// a run and the next one goes on, a refused key leaves its stock for the run, and the output carries counts only —
// never a key, an S3 secret, an author or a URL. No network.
import { describe, expect, it } from "vitest";
import { MemoryFileStorage } from "../../../apps/runtime/src/files/storage.ts";
import { fixtureImage } from "../../../packages/agents/src/builder/index.ts";
import { loadAgents } from "../stock-ci.mjs";
import { loadRuntime, main, runSeed, SEED_LIMITS, seedAnnotation } from "../stock-library.mjs";

const PEXELS = "pexels-SECRET-0123456789";
const PIXABAY = "53000000-pixabaySECRETkey";
const KEYS = { PEXELS_API_KEY: PEXELS, PIXABAY_API_KEY: PIXABAY };

const agents = await loadAgents();
const real = await loadRuntime();
/** The runtime with the re-encoding faked (the image pipeline has its own tests): a 1600-wide copy. */
const runtime = {
  ...real,
  storeLibraryPhoto: (storage, bytes, o) =>
    real.storeLibraryPhoto(storage, bytes, {
      ...o,
      process: async () => ({
        width: 1600,
        height: 1000,
        variants: [{ slot: 1600, width: 1600, height: 1000, data: new Uint8Array([7]) }],
      }),
    }),
};

/** Fake Pexels and Pixabay: `photos` per query text ([id, width, height]), pictures from the image hosts. */
function stocks({ pexels = {}, pixabay = {}, refuse = [] } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push(`${u.hostname}${u.pathname}`);
    if (u.hostname === "api.pexels.com") {
      if (refuse.includes("pexels")) return new Response("{}", { status: 401 });
      expect(new Headers(init?.headers).get("authorization")).toBe(PEXELS);
      const q = u.searchParams.get("query");
      return Response.json({
        photos: (pexels[q] ?? []).map(([id, width, height]) => ({
          id,
          width,
          height,
          url: `https://www.pexels.com/photo/${id}/`,
          photographer: `Фотограф ${id}`,
          photographer_url: `https://www.pexels.com/@p${id}`,
          src: { large2x: `https://images.pexels.com/photos/${id}/p.jpeg` },
        })),
      });
    }
    if (u.hostname === "pixabay.com" && u.pathname === "/api/") {
      if (refuse.includes("pixabay")) return new Response("[ERROR 400] Invalid API key", { status: 400 });
      const q = u.searchParams.get("q");
      return Response.json({
        hits: (pixabay[q] ?? []).map(([id, width, height]) => ({
          id,
          pageURL: `https://pixabay.com/photos/x-${id}/`,
          largeImageURL: `https://pixabay.com/get/${id}.jpg`,
          imageWidth: width,
          imageHeight: height,
          user: `user${id}`,
          user_id: id,
          type: "photo",
        })),
      });
    }
    if (["images.pexels.com", "pixabay.com"].includes(u.hostname)) {
      const png = fixtureImage(u.pathname, 16, 10);
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response("no", { status: 404 });
  };
  return { fetch, calls };
}

const seedQ = (text, type, orientation, cap) => ({ text, type, orientation, cap });
const QUERIES = [
  seedQ("dental clinic daylight", "hero", "landscape", 4),
  seedQ("dental care", "features", "landscape", 3),
  seedQ("yoga studio", "hero", "portrait", 2),
];
const client = (s, keys = { pexels: PEXELS, pixabay: PIXABAY }) =>
  agents.createStockClient({ fetch: s.fetch, keys });
const seed = (storage, s, o = {}) =>
  runSeed({ agents, runtime, storage, client: client(s), queries: QUERIES, sleep: async () => {}, ...o });
const indexOf = async (storage) => agents.parseLibraryIndex(await real.readLibraryIndex(storage));

const STOCKS = {
  pexels: {
    // 801: too narrow for the first screen; 803 repeats in the next query (one copy per photo).
    "dental clinic daylight": [
      [801, 1000, 600],
      [802, 1900, 1200],
      [803, 1900, 1250],
    ],
    "dental care": [
      [803, 1900, 1250],
      [804, 1600, 1000],
      [805, 1600, 1000],
      [806, 1600, 1000],
    ],
    "yoga studio": [
      [807, 1900, 1200],
      [808, 1300, 1950],
    ],
  },
  pixabay: {
    "dental clinic daylight": [
      [901, 1920, 1280],
      [902, 1920, 1280],
      [903, 1920, 1280],
    ],
    "yoga studio": [[904, 1280, 1920]],
  },
};

describe("photo library seeding (B2-43)", () => {
  it("fills the queries in order: Pexels first, Pixabay for the rest, fitting photos only, one copy each", async () => {
    const storage = new MemoryFileStorage();
    const s = stocks(STOCKS);
    const r = await seed(storage, s);
    const index = await indexOf(storage);
    const by = (q) => index.entries.filter((e) => e.query === q).map((e) => `${e.provider}:${e.id}`);
    expect(by("dental clinic daylight")).toEqual(["pexels:802", "pexels:803", "pixabay:901", "pixabay:902"]);
    expect(by("dental care")).toEqual(["pexels:804", "pexels:805", "pexels:806"]);
    expect(by("yoga studio")).toEqual(["pexels:808", "pixabay:904"]);
    expect(r).toMatchObject({
      before: 0,
      after: 9,
      added: 9,
      downloads: 9,
      searches: { pexels: 3, pixabay: 2 },
      complete: 3,
      errors: [],
      stopped: null,
    });
    const e = index.entries.find((x) => x.id === "901");
    expect(e).toMatchObject({
      orientation: "landscape",
      author: "user901",
      authorUrl: "https://pixabay.com/users/user901-901/",
      pageUrl: "https://pixabay.com/photos/x-901/",
      ...agents.STOCK_LICENSES.pixabay,
      width: 1600,
      height: 1000,
    });
    expect(e.file).toBe(real.libraryPhotoId("pixabay:901"));
    for (const x of index.entries) expect(await real.libraryPhoto(storage, x.file)).not.toBeNull();
    // Neither the index nor the copies carry a key.
    const all = [...storage.objects.values()].map((o) => new TextDecoder().decode(o.data)).join("\n");
    expect(all).not.toContain(PEXELS);
    expect(all).not.toContain(PIXABAY);
  });

  it("a repeated run asks nothing for full queries; a fuller cap adds only what is missing", async () => {
    const storage = new MemoryFileStorage();
    await seed(storage, stocks(STOCKS));
    const before = await real.readLibraryIndex(storage);
    const again = stocks(STOCKS);
    const r = await seed(storage, again);
    expect(again.calls).toEqual([]);
    expect(r).toMatchObject({ full: 3, added: 0, complete: 3 });
    expect(await real.readLibraryIndex(storage)).toEqual(before);
    const more = stocks(STOCKS);
    const r2 = await seed(storage, more, {
      queries: [seedQ("dental care", "features", "landscape", 4)],
    });
    expect(r2.added).toBe(0);
    expect(more.calls).toEqual(["api.pexels.com/v1/search", "pixabay.com/api/"]);
  });

  it("the request cap stops a run (the index keeps what was copied); the next run goes on", async () => {
    const storage = new MemoryFileStorage();
    const limits = { ...SEED_LIMITS, requests: 4 };
    const first = await seed(storage, stocks(STOCKS), { limits });
    expect(first).toMatchObject({ stopped: "requests", added: 2, after: 2 });
    expect(seedAnnotation(first, limits)).toContain(
      "Остановлено на лимите запросов (4): следующий выкат продолжит",
    );
    const next = await seed(storage, stocks(STOCKS));
    expect(next.before).toBe(2);
    expect(next.after).toBe(9);
  });

  it("a refused key leaves its stock for the run; the other one fills the queries", async () => {
    const storage = new MemoryFileStorage();
    const s = stocks({ ...STOCKS, refuse: ["pexels"] });
    const r = await seed(storage, s);
    expect(r.searches.pexels).toBe(1);
    expect(r.errors).toContain("Pexels поиск: HTTP 401");
    expect((await indexOf(storage)).entries.every((e) => e.provider === "pixabay")).toBe(true);
    expect(seedAnnotation(r)).toMatch(/^::warning title=Библиотека фото::/);
  });

  it("an unreadable index stops the run before anything is written", async () => {
    const storage = new MemoryFileStorage();
    await real.writeLibraryIndex(storage, "{broken");
    await expect(seed(storage, stocks(STOCKS))).rejects.toThrow(/not JSON/);
    expect(new TextDecoder().decode(await real.readLibraryIndex(storage))).toBe("{broken");
  });
});

describe("stock-library CLI", () => {
  const run = async (argv, env, extra = {}) => {
    const logs = [];
    const code = await main(argv, {
      env,
      agents,
      runtime,
      log: (l) => logs.push(l),
      sleep: async () => {},
      ...extra,
    });
    return { code, out: logs.join("\n") };
  };

  it("seed over the catalog queries: counts only in one annotation, never a key, an author or a URL", async () => {
    const storage = new MemoryFileStorage();
    const s = stocks({ pexels: { "dental clinic": [[811, 1900, 1200]] } });
    const { code, out } = await run(["seed", "--max-requests=60"], KEYS, { storage, fetch: s.fetch });
    expect(code).toBe(0);
    expect(out).toMatch(/^::(notice|warning) title=Библиотека фото::Добавлено фото: 1 /);
    expect(out).toContain("лимите запросов (60)");
    for (const bad of [PEXELS, PIXABAY, "Фотограф", "https://", "pexels.com"]) expect(out).not.toContain(bad);
    expect((await indexOf(storage)).entries.map((e) => e.id)).toEqual(["811"]);
  });

  it("no keys or no storage: a warning and exit 0 without a request; wrong usage: exit 2", async () => {
    const s = stocks(STOCKS);
    const none = await run(["seed"], {}, { fetch: s.fetch });
    expect(none).toMatchObject({ code: 0 });
    expect(none.out).toContain("::warning title=Библиотека фото::нет ключей стоков");
    const nostore = await run(["seed"], KEYS, { fetch: s.fetch });
    expect(nostore.out).toContain("хранилище не задано");
    expect(s.calls).toEqual([]);
    expect((await run(["record"], KEYS)).code).toBe(2);
    expect((await run(["seed", "--max-requests=abc"], KEYS)).code).toBe(2);
  });

  it("a storage failure is a warning with the keys and the S3 secret scrubbed", async () => {
    const env = {
      ...KEYS,
      WIZARD_S3_ACCESS_KEY_ID: "S3ACCESSKEYID",
      WIZARD_S3_SECRET_ACCESS_KEY: "s3-secret-value",
    };
    const storage = {
      kind: "s3",
      get: async () => {
        throw new Error(`S3 403 for S3ACCESSKEYID / s3-secret-value / ${PEXELS}`);
      },
    };
    const { code, out } = await run(["seed"], env, { storage, fetch: stocks(STOCKS).fetch });
    expect(code).toBe(0);
    expect(out).toContain(
      "::warning title=Библиотека фото::библиотека не пополнена: S3 403 for *** / *** / ***",
    );
  });
});
