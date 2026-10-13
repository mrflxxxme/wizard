// V4-10: the fill of the semantic photo library from CI — niches to their target with the queries spread, shards and
// manifest written as it goes, a second run fetching nothing, the stops (failures in a row, the Pexels hour), requested
// niches searched by their Russian text, and the files bucket found by the account key.
import { describe, expect, test } from "vitest";
import * as S from "../../../packages/agents/src/stock/index.ts";
import { bigEnough, MAX_FAILURES, REQUEST_TARGET, requestNiches, runFill, storageEnv } from "../fill.mjs";

const memory = () => {
  const map = new Map();
  return { map, get: async (n) => map.get(n) ?? null, put: async (n, d) => void map.set(n, d) };
};

/** A fake stock: `perSearch` distinct photos for every search; downloads count. */
const fakeStock = ({ perSearch = 10, providers = ["pexels", "pixabay"], fail = () => false } = {}) => {
  let n = 0;
  const log = { searches: [], downloads: 0 };
  return {
    log,
    providers,
    async search(provider, q, perPage) {
      log.searches.push({ provider, ...q });
      return Array.from({ length: Math.min(perSearch, perPage) }, () => {
        n++;
        return {
          provider,
          id: String(n),
          width: q.orientation === "portrait" ? 1000 : 1800,
          height: q.orientation === "portrait" ? 1500 : 1200,
          author: "Автор",
          pageUrl: `https://www.pexels.com/photo/${n}/`,
          downloadUrl: "https://images.pexels.com/x.jpg",
        };
      });
    },
    async download(hit) {
      log.downloads++;
      if (fail(hit)) throw Object.assign(new Error("boom"), { code: "HTTP" });
      return new Uint8Array([1, 2, 3]);
    },
  };
};

const uuid = (id) => `00000000-0000-5000-8000-${Number(id).toString(16).padStart(12, "0")}`;
const store = async (hit) => ({ id: uuid(hit.id), width: hit.width, height: hit.height });
const embed = async () => {
  const v = new Float32Array(S.EMBED_DIM);
  v[Math.floor(Math.random() * S.EMBED_DIM)] = 1;
  return { vector: v, color: "#a0b0c0", luma: 0.6 };
};
const fast = { sleep: async () => {}, delays: { pexels: 0, pixabay: 0, download: 0 } };
const niche = (slug, target, queries = ["a", "b"]) => ({ slug, name: `ниша ${slug}`, queries, target });

describe("runFill", () => {
  test("niches to target, queries spread, shards and manifest written; a second run fetches nothing", async () => {
    const objects = memory();
    const stock = fakeStock();
    const niches = [niche("dental", 12), niche("hair", 6, ["x", "y", "z"])];
    const s = await runFill({ S, stock, objects, store, embed, niches, ...fast });
    expect(s).toMatchObject({ filled: 2, added: 18, total: 18, stopped: null });
    const dental = await S.readShard(objects, "dental");
    expect(dental.entries).toHaveLength(12);
    expect(dental.entries.filter((e) => e.query === "a")).toHaveLength(6);
    expect(dental.entries[0]).toMatchObject({ provider: "pexels", author: "Автор", color: "#a0b0c0", luma: 0.6 });
    expect((await S.readManifest(objects)).shards.map((m) => [m.slug, m.count])).toEqual([
      ["dental", 12],
      ["hair", 6],
    ]);
    const lib = await S.loadSemanticLibrary(objects);
    expect(lib.size).toBe(18);

    const again = fakeStock();
    const s2 = await runFill({ S, stock: again, objects, store, embed, niches, ...fast });
    expect(s2).toMatchObject({ full: 2, added: 0 });
    expect(again.log.downloads).toBe(0);
  });

  test("a photo already in another shard is not fetched again", async () => {
    const objects = memory();
    await runFill({ S, stock: fakeStock({ perSearch: 4 }), objects, store, embed, niches: [niche("a", 4, ["q"])], ...fast });
    // The same ids again: the fake restarts its numbering.
    const s = await runFill({ S, stock: fakeStock({ perSearch: 4 }), objects, store, embed, niches: [niche("b", 2, ["q"])], ...fast });
    const b = await S.readShard(objects, "b");
    expect(b.entries.map((e) => e.id)).not.toContain("1");
    expect(s.added).toBe(2);
  });

  test("MAX_FAILURES photos failing in a row stop the run", async () => {
    const objects = memory();
    const stock = fakeStock({ fail: () => true });
    const s = await runFill({ S, stock, objects, store, embed, niches: [niche("a", 50)], concurrency: 1, ...fast });
    expect(s.stopped).toBe("failures");
    expect(stock.log.downloads).toBe(MAX_FAILURES);
    expect(s.errors[0]).toBe("pexels скачивание: HTTP");
  });

  test("Pexels stays under its hour: a wait past the time budget turns it off for the run", async () => {
    let t = 0;
    const objects = memory();
    const stock = fakeStock({ perSearch: 1 });
    const s = await runFill({
      S,
      stock,
      objects,
      store,
      embed,
      niches: [niche("a", 40, ["q1", "q2", "q3", "q4"])],
      limits: { minutes: 30, photos: 1000, pexelsPerHour: 2, perQuery: 0 },
      now: () => (t += 1000),
      ...fast,
    });
    expect(stock.log.searches.filter((x) => x.provider === "pexels")).toHaveLength(2);
    expect(stock.log.searches.some((x) => x.provider === "pixabay")).toBe(true);
    expect(s.searches.pexels).toBe(2);
  });

  test("a rate limit turns the provider off", async () => {
    const objects = memory();
    const stock = fakeStock();
    stock.search = async (provider) => {
      throw Object.assign(new Error(`${provider}: RATE_LIMITED`), { code: "RATE_LIMITED" });
    };
    const s = await runFill({ S, stock, objects, store, embed, niches: [niche("a", 10)], ...fast });
    expect(s.searches).toEqual({ pexels: 1, pixabay: 1 });
    expect(s.added).toBe(0);
  });
});

describe("requested niches", () => {
  test("most asked first, searched by their Russian text", () => {
    const list = requestNiches(S, {
      version: 2,
      requests: [
        { text: "ремонт лодок", count: 1, at: "2026-10-13T10:00:00Z" },
        { text: "ёлочные игрушки", count: 3, at: "2026-10-13T11:00:00Z" },
      ],
    });
    expect(list.map((n) => [n.name, n.lang, n.target])).toEqual([
      ["ёлочные игрушки", "ru", REQUEST_TARGET],
      ["ремонт лодок", "ru", REQUEST_TARGET],
    ]);
    expect(list[1].slug).toBe(S.requestSlug("ремонт лодок"));
  });

  test("the language reaches the stock search", async () => {
    const objects = memory();
    const stock = fakeStock({ perSearch: 3 });
    const [n] = requestNiches(S, { version: 2, requests: [{ text: "ремонт лодок", count: 1, at: "x" }] });
    await runFill({ S, stock, objects, store, embed, niches: [{ ...n, target: 3 }], ...fast });
    expect(stock.log.searches[0]).toMatchObject({ text: "ремонт лодок", lang: "ru", page: 1 });
  });
});

describe("helpers", () => {
  test("bigEnough: a first screen in either orientation", () => {
    expect(bigEnough({ width: 1600, height: 1000 })).toBe(true);
    expect(bigEnough({ width: 800, height: 1200 })).toBe(true);
    expect(bigEnough({ width: 1100, height: 900 })).toBe(false);
    expect(bigEnough({ width: 2000, height: 600 })).toBe(false);
  });

  test("storageEnv: the files bucket of the environment by the account key", async () => {
    const xml = (names) => `<ListAllMyBucketsResult><Buckets>${names.map((n) => `<Bucket><Name>${n}</Name></Bucket>`).join("")}</Buckets></ListAllMyBucketsResult>`;
    const env = { WIZARD_FILES_STORAGE: "s3", WIZARD_S3_ACCESS_KEY_ID: " id ", WIZARD_S3_SECRET_ACCESS_KEY: "secret", DEPLOY_ENV: "staging" };
    const f = (names) => async () => new Response(xml(names), { status: 200 });
    const out = await storageEnv(env, { fetch: f(["ab12-wizard-prod-files", "ab12-wizard-staging-files", "ab12-wizard-staging-backups"]) });
    expect(out).toMatchObject({ WIZARD_S3_BUCKET: "ab12-wizard-staging-files", WIZARD_S3_ACCESS_KEY_ID: "id" });
    expect(out.WIZARD_S3_ENDPOINT).toMatch(/^https:\/\//);
    await expect(storageEnv(env, { fetch: f(["ab12-wizard-prod-files"]) })).rejects.toThrow("найдено 0");
    expect((await storageEnv({ ...env, WIZARD_S3_BUCKET: "given" }, { fetch: f([]) })).WIZARD_S3_BUCKET).toBe("given");
  });
});

test("statusText: the catalog in order with counts, then the requested niches", async () => {
  const { statusText } = await import("../fill.mjs");
  const text = statusText(S, {
    version: 2,
    model: S.SEMANTIC_MODEL,
    shards: [
      { slug: "dental", name: "стоматология", count: S.NICHE_TARGET, updatedAt: "x" },
      { slug: "req-abc", name: "ремонт лодок", count: 40, updatedAt: "x" },
    ],
  });
  expect(text.split("\n")[0]).toBe(
    `всего фото: ${S.NICHE_TARGET + 40}; ниш каталога заполнено: 1 из ${S.CATALOG.length}; запрошенных ниш: 1`,
  );
  expect(text).toContain(`| стоматология | ${S.NICHE_TARGET} |`);
  expect(text).toContain("| ремонт лодок (запрос) | 40 |");
  expect(text).toContain("| клининг | 0 |");
});
