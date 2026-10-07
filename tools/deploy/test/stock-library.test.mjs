// B2-43: the photo library filled from a GitHub runner (tools/deploy/stock-library.mjs) against fake stocks and an
// in-memory storage: queries filled in order within their caps (Pexels first, Pixabay for the rest), one copy per stock
// photo with its author and licence in the index, a repeated run asks nothing for full queries, the request cap stops
// a run and the next one goes on, a refused key leaves its stock for the run, and the output carries counts only —
// never a key, an S3 secret, an author or a URL. No network.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryFileStorage } from "../../../apps/runtime/src/files/storage.ts";
import { encodeJpeg, photo } from "../../../apps/runtime/test/media-helpers.ts";
import { fixtureImage } from "../../../packages/agents/src/builder/index.ts";
import { loadAgents } from "../stock-ci.mjs";
import {
  errorDetail,
  loadRuntime,
  MAX_PHOTO_FAILURES,
  main,
  runSeed,
  SEED_LIMITS,
  seedAnnotation,
} from "../stock-library.mjs";

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

describe("photo failures (the first live run: 386 downloads, every copy a TypeError)", () => {
  it(`stops after ${MAX_PHOTO_FAILURES} photos failing in a row and names the error with its cause`, async () => {
    const failing = {
      ...runtime,
      storeLibraryPhoto: async () => {
        const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
        throw new TypeError("fetch failed", { cause });
      },
    };
    const storage = new MemoryFileStorage();
    const s = stocks(STOCKS);
    const r = await seed(storage, s, { runtime: failing });
    expect(r).toMatchObject({ stopped: "failures", downloads: MAX_PHOTO_FAILURES, added: 0 });
    // Pexels 802, 803, then Pixabay 901–903; nothing after the stop.
    expect(s.calls.filter((c) => !c.includes("/api/") && !c.includes("/v1/"))).toHaveLength(5);
    const text = seedAnnotation(r);
    expect(text).toContain(`Остановлено после ${MAX_PHOTO_FAILURES} ошибок фото подряд`);
    expect(text).toContain("Pexels копия: TypeError: fetch failed (UND_ERR_SOCKET: other side closed) ×2");
    expect(text).toContain("Pixabay копия: TypeError: fetch failed (UND_ERR_SOCKET: other side closed) ×3");
  });

  it("error lines: codes of coded errors, class and message otherwise, never a URL", () => {
    expect(errorDetail(Object.assign(new Error("pixabay: HTTP (404)"), { code: "HTTP" }))).toBe("HTTP 404");
    expect(errorDetail(new TypeError("bad https://cdn.pixabay.com/get/x.jpg?token=abc here"))).toBe(
      "TypeError: bad <url> here",
    );
    expect(errorDetail(new Error("x".repeat(500))).length).toBeLessThanOrEqual(160);
  });
});

// The CI job's own path: plain `node tools/deploy/stock-library.mjs seed` (tsx registered by the script), the real
// runtime photo library with its WASM worker, a real JPEG from the stock, the S3 client against a local S3 stub — only
// the stocks are faked (a --import preload, fake-stock-fetch.mjs). No network. This process loads @wizard/agents and
// with it the undici package, whose global dispatcher refused the S3 PUTs of the first live run (storage.ts put).
describe("stock-library CLI as the CI job runs it", () => {
  const BUCKET = "ab12-wizard-prod-files";
  const objects = new Map();
  const state = { resetAbove: Number.POSITIVE_INFINITY };
  let server;
  let endpoint = "";
  let dir = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "wz-stock-library-"));
    await writeFile(join(dir, "stock.jpg"), await encodeJpeg(photo(640, 400), 640, 400));
    server = createServer(async (req, res) => {
      // A network path that cuts large uploads (state.resetAbove): the check write must find it before the stocks.
      if (req.method === "PUT" && Number(req.headers["content-length"]) > state.resetAbove)
        return void req.socket.resetAndDestroy();
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const auth = String(req.headers.authorization ?? "");
      const hash = createHash("sha256").update(body).digest("hex");
      if (!auth.includes("Credential=S3ACCESSKEYID/") || req.headers["x-amz-content-sha256"] !== hash)
        return void res.writeHead(403).end();
      const prefix = `/${BUCKET}/`;
      if (!req.url.startsWith(prefix)) return void res.writeHead(404).end();
      const key = req.url.slice(prefix.length);
      if (req.method === "PUT") {
        objects.set(key, { body, meta: String(req.headers["x-amz-meta-wizard"]) });
        return void res.writeHead(200).end();
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        return void res.writeHead(204).end();
      }
      const o = objects.get(key);
      if (!o) return void res.writeHead(404).end();
      res.writeHead(200, { "x-amz-meta-wizard": o.meta, "content-length": o.body.length });
      res.end(req.method === "HEAD" ? undefined : o.body);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    endpoint = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const cli = async (args) => {
    const log = join(dir, `stock-${Math.random().toString(36).slice(2)}.log`);
    await writeFile(log, "");
    const env = Object.fromEntries(
      Object.entries({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PEXELS_API_KEY: PEXELS,
        WIZARD_FILES_STORAGE: "s3",
        WIZARD_S3_ENDPOINT: endpoint,
        WIZARD_S3_REGION: "ru-1",
        WIZARD_S3_BUCKET: BUCKET,
        // As a secret may come: with a newline (the pods get it trimmed, so does the seeding).
        WIZARD_S3_ACCESS_KEY_ID: "S3ACCESSKEYID\n",
        WIZARD_S3_SECRET_ACCESS_KEY: "s3-secret-value",
        FAKE_STOCK_JPEG: join(dir, "stock.jpg"),
        FAKE_STOCK_LOG: log,
      }).filter(([, v]) => v !== undefined),
    );
    const preload = pathToFileURL(join(import.meta.dirname, "fake-stock-fetch.mjs")).href;
    const script = join(import.meta.dirname, "..", "stock-library.mjs");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", preload, script, "seed", ...args],
      { env, timeout: 150_000 },
    );
    return { out: stdout, stockRequests: (await readFile(log, "utf8")).split("\n").filter(Boolean) };
  };

  it("one search and three downloads become three library copies and an index", async () => {
    objects.clear();
    state.resetAbove = Number.POSITIVE_INFINITY;
    const { out, stockRequests } = await cli(["--max-requests=4"]);
    expect(out).toContain("Добавлено фото: 3 (скачано 3; поисков: Pexels 1, Pixabay 0)");
    expect(out).not.toContain("Ошибки");
    expect(stockRequests).toEqual(["api.pexels.com", ...Array(3).fill("images.pexels.com")]);
    for (const bad of [PEXELS, "S3ACCESSKEYID", "s3-secret-value", "Фотограф", "https://"])
      expect(out).not.toContain(bad);
    const index = agents.parseLibraryIndex(objects.get(`wz_photos/${real.PHOTO_LIBRARY_INDEX_ID}`)?.body);
    expect(index.entries).toHaveLength(3);
    for (const e of index.entries) {
      const copy = objects.get(`wz_photos/${e.file}`);
      expect(copy).toBeDefined();
      expect(copy.body.subarray(8, 12).toString("latin1")).toBe("WEBP");
      expect(e).toMatchObject({ provider: "pexels", width: 640, height: 400 });
    }
    // The check object of the storage is removed.
    expect(objects.has(`wz_photos/${real.libraryPhotoId("library-check:v1")}`)).toBe(false);
  }, 180_000);

  it("a storage that cuts large uploads stops the run before any stock request, with the cause named", async () => {
    objects.clear();
    state.resetAbove = 16 * 1024;
    const { out, stockRequests } = await cli(["--max-requests=4"]);
    expect(stockRequests).toEqual([]);
    expect(out).toContain("Остановлено до запросов к стокам: запись в хранилище не проходит");
    expect(out).toContain(
      "проверка записи 256 КБ (1 КБ записался): хранилище put: TypeError: fetch failed (ECONNRESET",
    );
  }, 180_000);
});
