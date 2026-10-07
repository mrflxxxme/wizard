// B2-38 acceptance (stock photos without the network): the query comes from the niche and the photo style of the
// design direction by dictionaries (no model), Pexels and Pixabay answers of tools/fixtures/stock are parsed into hits
// with author and links, downloads go only to the stock's image hosts (https, no redirects, size and type checked),
// keys never appear in errors, the photos stage records the copy, source, author and licence of every picture, and
// without a stock (no key, errors, time over) the landing keeps the theme graphic — the stage never fails.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SystemPlan } from "@wizard/appspec";
import { compilePlan, photoSlots } from "@wizard/modules";
import { describe, expect, test } from "vitest";
import {
  createStockClient,
  FIXTURE_KEYS,
  fixtureImage,
  fixtureStockFetch,
  nicheTerms,
  type PhotoHost,
  recordingStockFetch,
  runPhotosStage,
  STOCK_LICENSES,
  StockCache,
  type StockHit,
  sanitizeStockAnswer,
  scrubSecrets,
  stockQuery,
  styleTerms,
} from "../src/builder/index.js";
import { DEFAULT_REGISTRY } from "../src/planner/catalog.js";

const basePlan = (niche: string, photoStyle: string, sections?: SystemPlan["landing"]): SystemPlan => ({
  version: 1,
  niche,
  goals: [{ id: "leads", statement: "Получать заявки с сайта" }],
  modules: [{ id: "landing" }, { id: "leads" }, { id: "notify" }],
  landing: sections ?? {
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

/** The photo library of the tests: ids by source, as the runtime makes them (size of the downloaded picture). */
function memoryLibrary(): PhotoHost["store"] & { stored: string[] } {
  const stored: string[] = [];
  const fn = async (hit: StockHit, bytes: Uint8Array) => {
    stored.push(`${hit.provider}:${hit.id}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = stored.length.toString(16).padStart(12, "0");
    return { id: `00000000-0000-4000-8000-${n}`, width: view.getUint32(16), height: view.getUint32(20) };
  };
  return Object.assign(fn, { stored });
}

const fixtureHost = (keys: Partial<typeof FIXTURE_KEYS> = FIXTURE_KEYS) => {
  const store = memoryLibrary();
  return {
    host: { stock: createStockClient({ fetch: fixtureStockFetch(), keys }), store } satisfies PhotoHost,
    store,
  };
};

describe("queries by niche and style (no model)", () => {
  test("the niche picks the subject, the photo style adds at most two modifiers", () => {
    const dental = basePlan("стоматология «Улыбка»", "светлые кабинеты, дневной свет");
    expect(nicheTerms(dental).hero).toBe("dental clinic");
    expect(stockQuery(dental, "hero", "landscape")).toEqual({
      text: "dental clinic daylight",
      orientation: "landscape",
    });
    expect(stockQuery(dental, "about", "landscape").text).toBe("dentist with patient daylight");
    const barber = basePlan(
      "барбершоп на Петроградке",
      "мастер с клиентом, тёплый вечерний свет, крупный план",
    );
    expect(stockQuery(barber, "hero", "portrait").text).toBe("barber shop close up warm");
    expect(styleTerms("чистая квартира после ремонта, дневной свет, без людей")).toEqual([
      "interior",
      "daylight",
    ]);
    // A team photo keeps its people even when the style says «без людей».
    const renovation = basePlan("ремонт квартир под ключ", "без людей, дневной свет");
    expect(stockQuery(renovation, "hero", "landscape").text).toBe("renovated apartment interior daylight");
    expect(stockQuery(renovation, "about", "landscape").text).toBe("renovation worker daylight");
  });

  test("the same plan gives the same queries; different niches give different ones; unknown — generic", () => {
    const a = basePlan("школа английского языка", "занятия и общение");
    expect(stockQuery(a, "gallery", "landscape")).toEqual(stockQuery(a, "gallery", "landscape"));
    const niches = ["стоматология", "барбершоп", "йога-студия", "кофейня", "автосервис", "клининг", "юрист"];
    const texts = niches.map((n) => stockQuery(basePlan(n, "светлые фото"), "hero", "landscape").text);
    expect(new Set(texts).size).toBe(niches.length);
    expect(stockQuery(basePlan("что-то совсем особенное", "спокойные тона"), "hero", "landscape").text).toBe(
      "small business calm",
    );
  });
});

describe("stock client (recorded answers, no network)", () => {
  test("Pexels and Pixabay answers become hits with author, links and a download on the image hosts", async () => {
    const c = createStockClient({ fetch: fixtureStockFetch(), keys: FIXTURE_KEYS });
    expect(c.providers).toEqual(["pexels", "pixabay"]);
    const q = { text: "dental clinic daylight", orientation: "landscape" as const };
    const px = await c.search("pexels", q, 6);
    expect(px.length).toBeGreaterThan(5);
    expect(px[0]).toMatchObject({ provider: "pexels", author: expect.any(String) });
    expect(new URL(px[0]?.downloadUrl ?? "").hostname).toBe("images.pexels.com");
    expect(px[0]?.pageUrl).toMatch(/^https:\/\/www\.pexels\.com\/photo\//);
    const pb = await c.search("pixabay", q, 6);
    expect(pb[0]?.authorUrl).toMatch(/^https:\/\/pixabay\.com\/users\/[a-z_0-9]+-\d+\/$/);
    const bytes = await c.download(px[0] as StockHit);
    expect([...bytes.slice(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
  });

  test("a provider without a key is off; searches are cached; keys never appear in errors", async () => {
    let calls = 0;
    const urls: string[] = [];
    const inner = fixtureStockFetch();
    const fetch = async (u: string, init?: RequestInit) => {
      calls++;
      urls.push(u);
      return inner(u, init);
    };
    const c = createStockClient({ fetch, keys: { pixabay: "SECRET-KEY-123" }, cache: new StockCache() });
    expect(c.providers).toEqual(["pixabay"]);
    await expect(c.search("pexels", { text: "x", orientation: "landscape" }, 6)).rejects.toThrow(/NO_KEY/);
    const q = { text: "barber shop warm", orientation: "landscape" as const };
    await c.search("pixabay", q, 6);
    await c.search("pixabay", q, 6);
    expect(calls).toBe(1);
    expect(urls[0]).toContain("key=SECRET-KEY-123");
    const failing = createStockClient({
      fetch: async () => new Response("no", { status: 500 }),
      keys: { pixabay: "SECRET-KEY-123", pexels: "PEXELS-KEY-456" },
    });
    for (const p of ["pixabay", "pexels"] as const) {
      const e = await failing.search(p, q, 6).catch((x: Error) => x);
      expect(String((e as Error).message)).not.toMatch(/SECRET-KEY|PEXELS-KEY|https?:/);
    }
  });

  test("downloads: only stock image hosts over https, no redirects, image/* and at most maxBytes", async () => {
    const hit = (downloadUrl: string): StockHit => ({
      provider: "pexels",
      id: "1",
      width: 2000,
      height: 1300,
      author: "a",
      pageUrl: "https://www.pexels.com/photo/1/",
      downloadUrl,
    });
    const ok = (body: Uint8Array, type = "image/jpeg") =>
      new Response(body as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": type } });
    const c = (fetch: (u: string, i?: RequestInit) => Promise<Response>, maxBytes = 1000) =>
      createStockClient({ fetch, keys: FIXTURE_KEYS, maxBytes });
    const small = new Uint8Array(10);
    await expect(c(async () => ok(small)).download(hit("https://evil.example.com/a.jpg"))).rejects.toThrow(
      /HOST/,
    );
    await expect(c(async () => ok(small)).download(hit("http://images.pexels.com/a.jpg"))).rejects.toThrow(
      /HOST/,
    );
    let redirect: RequestRedirect | undefined;
    const r302 = c(async (_u, init) => {
      redirect = init?.redirect;
      return new Response(null, { status: 302, headers: { location: "https://evil.example.com/" } });
    });
    await expect(r302.download(hit("https://images.pexels.com/a.jpg"))).rejects.toThrow(/HTTP/);
    expect(redirect).toBe("manual");
    await expect(
      c(async () => ok(small, "text/html")).download(hit("https://images.pexels.com/a.jpg")),
    ).rejects.toThrow(/NOT_IMAGE/);
    await expect(
      c(async () => ok(new Uint8Array(5000))).download(hit("https://images.pexels.com/a.jpg")),
    ).rejects.toThrow(/TOO_LARGE/);
    expect((await c(async () => ok(small)).download(hit("https://images.pexels.com/a.jpg"))).byteLength).toBe(
      10,
    );
  });

  test("record mode keeps Pexels metadata without keys; the recording replays offline with the same picks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wz-stock-rec-"));
    try {
      const KEY = "PEXELS-RECORD-KEY-42";
      // Answers in the shape of the live Pexels API (no `wz`, real-looking hosts), a key slipped into a field.
      const live = async (u: string) => {
        const url = new URL(u);
        if (url.hostname !== "api.pexels.com") return fixtureStockFetch()(u);
        const o = url.searchParams.get("orientation") ?? "landscape";
        const [width, height, shift] =
          o === "portrait" ? [3000, 4500, 100] : o === "square" ? [4000, 4000, 200] : [6000, 4000, 0];
        return Response.json({
          page: 1,
          per_page: 15,
          total_results: 500,
          next_page: `https://api.pexels.com/v1/search/?page=2&key=${KEY}`,
          photos: Array.from({ length: 15 }, (_, i) => ({
            id: 7_000_000 + i + shift,
            width,
            height,
            url: `https://www.pexels.com/photo/real-${i}/`,
            photographer: `Photographer ${i}`,
            photographer_url: `https://www.pexels.com/@p${i}`,
            alt: `alt ${KEY}`,
            src: {
              original: `https://images.pexels.com/photos/${7_000_000 + i}/pexels-photo.jpeg`,
              large2x: `https://images.pexels.com/photos/${7_000_000 + i}/pexels-photo.jpeg?auto=compress&w=940`,
            },
          })),
        });
      };
      const plan = basePlan("барбершоп", "тёплый свет");
      const keys = { pexels: KEY };
      const recordHost = {
        stock: createStockClient({ fetch: recordingStockFetch(live, dir, { secrets: [KEY] }), keys }),
        store: memoryLibrary(),
      };
      const recorded = await runPhotosStage({ plan, host: recordHost });
      expect(recorded.picked).toBe(photoSlots(plan).length);
      expect(readdirSync(dir)).toEqual(["pexels.recorded.json"]);
      const text = readFileSync(join(dir, "pexels.recorded.json"), "utf8");
      expect(text).not.toContain(KEY);
      expect(text).not.toMatch(/next_page|"alt"/);
      // Replay: the same picks without the network; pictures in the photo's proportions.
      const replay = await runPhotosStage({
        plan,
        host: {
          stock: createStockClient({ fetch: fixtureStockFetch(dir), keys: FIXTURE_KEYS }),
          store: memoryLibrary(),
        },
      });
      const ids = (r: typeof replay) => r.plan.design.photos?.map((p) => `${p.provider}:${p.stockId}`);
      expect(ids(replay)).toEqual(ids(recorded));
      const top = replay.plan.design.photos?.find((p) => p.slot === "top");
      expect(top && top.height > top.width).toBe(true);
      expect(sanitizeStockAnswer("pixabay", { hits: [] })).toBeNull();
      expect(scrubSecrets({ u: `https://x/?q=1&key=${KEY}`, t: `a${KEY}b` }, [KEY])).toEqual({
        u: "https://x/?q=1",
        t: "ab",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fixture pictures are deterministic PNGs of the asked size", () => {
    const a = fixtureImage("/photos/1/x.jpeg", 64, 40);
    expect(a).toEqual(fixtureImage("/photos/1/x.jpeg", 64, 40));
    expect(a).not.toEqual(fixtureImage("/photos/2/x.jpeg", 64, 40));
    const v = new DataView(a.buffer, a.byteOffset);
    expect([v.getUint32(16), v.getUint32(20)]).toEqual([64, 40]);
  });
});

describe("photos stage of builder v2", () => {
  test("every slot gets a photo by niche and style; copy, source, author and licence are recorded", async () => {
    const plan = basePlan("стоматология «Улыбка»", "светлые кабинеты, дневной свет");
    const slots = photoSlots(plan);
    expect(slots.map((s) => s.slot)).toEqual([
      "top",
      "top-2",
      "top-3",
      "about",
      "gallery",
      "gallery-2",
      "gallery-3",
    ]);
    const { host, store } = fixtureHost();
    const r = await runPhotosStage({ plan, host, now: () => Date.parse("2026-10-07T10:00:00Z") });
    expect(r.fallback).toBe(false);
    expect(r.picked).toBe(slots.length);
    const photos = r.plan.design.photos ?? [];
    expect(photos.map((p) => p.slot)).toEqual(slots.map((s) => s.slot));
    expect(new Set(photos.map((p) => `${p.provider}:${p.stockId}`)).size).toBe(photos.length);
    expect(store.stored).toEqual(photos.map((p) => `${p.provider}:${p.stockId}`));
    for (const p of photos) {
      expect(p.file).toMatch(/^[0-9a-f-]{36}$/);
      expect(p.author.length).toBeGreaterThan(0);
      expect(p.pageUrl).toMatch(/^https:\/\//);
      expect({ license: p.license, licenseUrl: p.licenseUrl }).toEqual(STOCK_LICENSES[p.provider]);
      expect(p.pickedAt).toBe("2026-10-07");
      expect(p.alt).toContain("стоматология");
    }
    // The collage's first picture is portrait, the others square; the hero and the story are large enough.
    expect(photos.find((p) => p.slot === "top")?.height).toBeGreaterThan(
      photos.find((p) => p.slot === "top")?.width ?? 0,
    );
    expect(r.note).toBe(`фото со стока: ${slots.length} из ${slots.length} (pexels)`);
    // The plan with photos compiles: the landing shows them and «Источники фото» lists them.
    const c = compilePlan(r.plan, DEFAULT_REGISTRY);
    expect(c.ok ? [] : c.errors).toEqual([]);
    if (c.ok) {
      expect(c.files["ui/pages/SitePhotos.tsx"]).toContain(photos[0]?.file);
      expect(c.files["ui/pages/Home.tsx"]).toContain('image={photo("top")}');
      expect(c.files["ui/pages/Home.tsx"]).toContain('"href":"/photos"');
    }
  });

  test("Pexels without a key → Pixabay; the same plan picks the same photos", async () => {
    const plan = basePlan("барбершоп", "тёплый свет");
    const a = await runPhotosStage({ plan, host: fixtureHost({ pixabay: FIXTURE_KEYS.pixabay }).host });
    const b = await runPhotosStage({ plan, host: fixtureHost({ pixabay: FIXTURE_KEYS.pixabay }).host });
    expect(a.providers).toEqual(["pixabay"]);
    expect(a.plan.design.photos?.map((p) => p.stockId)).toEqual(b.plan.design.photos?.map((p) => p.stockId));
  });

  test("without a stock — no key, errors, time over — the slots keep the theme graphic and nothing throws", async () => {
    const plan = basePlan("стоматология", "светлые фото");
    const none = await runPhotosStage({ plan });
    expect(none).toMatchObject({ fallback: true, picked: 0 });
    expect(none.plan.design.photos).toBeUndefined();
    expect(none.note).toMatch(/графика оформления/);
    const noKeys = await runPhotosStage({ plan, host: fixtureHost({}).host });
    expect(noKeys).toMatchObject({ fallback: true, picked: 0 });
    const broken: PhotoHost = {
      stock: createStockClient({
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
        keys: FIXTURE_KEYS,
      }),
      store: memoryLibrary(),
    };
    const down = await runPhotosStage({ plan, host: broken });
    expect(down).toMatchObject({ fallback: true, picked: 0 });
    expect(down.note).toMatch(/сток ответил ошибкой/);
    const failingStore: PhotoHost = {
      ...fixtureHost().host,
      store: async () => Promise.reject(new Error("disk")),
    };
    const noCopy = await runPhotosStage({ plan, host: failingStore });
    expect(noCopy).toMatchObject({ fallback: true, picked: 0 });
    // B2-41: the first failure is named in the note (the D76 report shows it).
    expect(noCopy.note).toMatch(/сток ответил ошибкой \(копия (pexels|pixabay): disk/);
    let t = 0;
    const late = await runPhotosStage({ plan, host: fixtureHost().host, budgetMs: 10, now: () => (t += 50) });
    expect(late.picked).toBeLessThan(photoSlots(plan).length);
    expect(late.note).toMatch(/не уложились во время этапа/);
    // The theme graphic: the compiled landing has the slots but no stock photo.
    const c = compilePlan(none.plan, DEFAULT_REGISTRY);
    expect(c.ok && c.files["ui/pages/SitePhotos.tsx"]).toContain(
      "export const STOCK: Readonly<Record<string, StockPhoto>> = {};",
    );
  });

  test("photos off or no landing — the stage does nothing", async () => {
    const plan = basePlan("стоматология", "светлые фото");
    const off = {
      ...plan,
      modules: [{ id: "landing", params: { photos: false } }, { id: "leads" }, { id: "notify" }],
    };
    expect(await runPhotosStage({ plan: off, host: fixtureHost().host })).toMatchObject({
      picked: 0,
      fallback: false,
    });
    const { landing: _l, ...noLanding } = plan;
    const r = await runPhotosStage({
      plan: { ...noLanding, modules: [{ id: "leads" }] },
      host: fixtureHost().host,
    });
    expect(r.picked).toBe(0);
  });
});
