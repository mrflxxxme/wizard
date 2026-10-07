// B2-38 (platform side of the stock photos): WIZARD_STOCK_MODE picks fixtures (default, no network), live, record or
// off; live keys come only from the platform secrets (secret://platform/stock/*) — without them no provider is on and the
// landings keep the theme graphic; a picked photo is copied into the photo library of the shared file storage; keys
// never reach the plan (its photos go into the compiled system) or errors.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyLibraryIndex,
  fixtureImage,
  fixtureStockFetch,
  type LibraryEntry,
  mergeLibraryIndex,
  runPhotosStage,
  STOCK_LICENSES,
  serializeLibraryIndex,
} from "@wizard/agents/builder";
import type { SystemPlan } from "@wizard/appspec";
import {
  MemoryFileStorage,
  PHOTO_LIBRARY_INDEX_ID,
  storeLibraryPhoto,
  writeLibraryIndex,
} from "@wizard/runtime";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
  createPhotoHost,
  libraryPhotoHost,
  STOCK_EGRESS_HOSTS,
  STOCK_KEY_ENV,
  stockEgressFetch,
  stockKeyOf,
  stockModeOf,
} from "../src/agents/stock.js";
import { SecretStore } from "../src/secrets/store.js";

const dir = mkdtempSync(join(tmpdir(), "wz-stock-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const plan: SystemPlan = {
  version: 1,
  niche: "барбершоп",
  goals: [{ id: "leads", statement: "Получать заявки с сайта" }],
  modules: [{ id: "landing" }, { id: "leads" }, { id: "notify" }],
  landing: {
    sections: [
      { type: "header", variant: "bar", content: {} },
      { type: "hero", variant: "split", content: { title: "Стрижки", cta: "Записаться" } },
      { type: "about", variant: "split", content: { title: "О нас", text: "Текст." } },
      { type: "lead_form", variant: "card", content: { title: "Оставьте заявку" } },
      { type: "footer", variant: "simple", content: {} },
    ],
  },
  design: {
    direction: { mood: ["уверенность"] },
    theme: "warm",
    accent: "#8A4B2A",
    fontPair: { heading: "Onest", body: "Onest" },
    photoStyle: "тёплый свет",
  },
  outOfScope: [],
  custom: [],
};

describe("stock mode and keys", () => {
  test("WIZARD_STOCK_MODE, else live/record with the models, else fixture", () => {
    expect(stockModeOf({})).toBe("fixture");
    expect(stockModeOf({ WIZARD_LLM_MODE: "live" })).toBe("live");
    expect(stockModeOf({ WIZARD_LLM_MODE: "record" })).toBe("record");
    expect(stockModeOf({ WIZARD_LLM_MODE: "live", WIZARD_STOCK_MODE: "off" })).toBe("off");
    expect(stockModeOf({ WIZARD_STOCK_MODE: "FIXTURE" })).toBe("fixture");
  });

  test("off → no host; live without platform keys → no provider (theme graphic), never a failure", async () => {
    expect(createPhotoHost({ mode: "off", secrets: null, storage: new MemoryFileStorage() })).toBeUndefined();
    const secrets = new SecretStore(join(dir, "empty.enc"), "k".repeat(32));
    const host = createPhotoHost({ mode: "live", secrets, storage: new MemoryFileStorage() });
    expect(host?.stock.providers).toEqual([]);
    const r = await runPhotosStage({ plan, host });
    expect(r).toMatchObject({ picked: 0, fallback: true });
    expect(r.plan.design.photos).toBeUndefined();
  });

  test("live with the Pexels key of the platform secrets: the key goes only into the request header", async () => {
    const secrets = new SecretStore(join(dir, "keys.enc"), "k".repeat(32));
    const ref = secrets.putPlatform("stock/pexels", "PEXELS-SECRET-777");
    expect(ref).toBe("secret://platform/stock/pexels");
    const seen: string[] = [];
    const inner = fixtureStockFetch();
    const storage = new MemoryFileStorage();
    const host = createPhotoHost({
      mode: "live",
      secrets,
      storage,
      fetch: async (u, init) => {
        const auth = new Headers(init?.headers).get("authorization");
        if (auth) seen.push(auth);
        expect(u).not.toContain("PEXELS-SECRET-777");
        return inner(u, init);
      },
    });
    expect(host?.stock.providers).toEqual(["pexels"]);
    const r = await runPhotosStage({ plan, host });
    expect(r.picked).toBe(2);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((h) => h === "PEXELS-SECRET-777")).toBe(true);
    // The copies are in the library (WebP variants), keyed by the stock photo.
    const keys = [...storage.objects.keys()];
    for (const p of r.plan.design.photos ?? []) expect(keys).toContain(`wz_photos/${p.file}`);
    const everything = JSON.stringify(r.plan);
    expect(everything).not.toContain("PEXELS-SECRET-777");
    expect(everything).not.toMatch(/secret:\/\//);
  }, 60_000);

  test("fixture mode needs no keys and no network", async () => {
    const storage = new MemoryFileStorage();
    const host = createPhotoHost({ mode: "fixture", secrets: null, storage });
    expect(host?.stock.providers).toEqual(["pexels", "pixabay"]);
    const r = await runPhotosStage({ plan, host });
    expect(r.picked).toBe(2);
    expect(r.plan.design.photos?.map((p) => p.slot)).toEqual(["top", "about"]);
  }, 60_000);
});

describe("stock keys of the release and the egress of live photos (B2-38 on the pilot)", () => {
  test("the release env wins over the platform secret; an empty env falls back to it; nothing is written", () => {
    const secrets = new SecretStore(join(dir, "env.enc"), "k".repeat(32));
    secrets.putPlatform("stock/pixabay", "PIXABAY-FROM-STORE");
    const env = { [STOCK_KEY_ENV.pexels]: " PEXELS-FROM-ENV ", [STOCK_KEY_ENV.pixabay]: "" };
    expect(stockKeyOf("pexels", secrets, env)).toBe("PEXELS-FROM-ENV");
    expect(stockKeyOf("pixabay", secrets, env)).toBe("PIXABAY-FROM-STORE");
    expect(stockKeyOf("pixabay", null, env)).toBeNull();
    // An unreadable store (another key) turns the provider off instead of failing the build.
    const broken = new SecretStore(join(dir, "env.enc"), "x".repeat(32));
    expect(stockKeyOf("pixabay", broken, {})).toBeNull();
    expect(secrets.getPlatform("secret://platform/stock/pexels")).toBeNull();
    const host = createPhotoHost({ mode: "live", secrets: null, storage: new MemoryFileStorage(), env });
    expect(host?.stock.providers).toEqual(["pexels"]);
  });

  test("live requests go only over https to the stock hosts", async () => {
    expect([...STOCK_EGRESS_HOSTS].sort()).toEqual(
      ["api.pexels.com", "cdn.pixabay.com", "images.pexels.com", "pixabay.com"].sort(),
    );
    const seen: string[] = [];
    const guarded = stockEgressFetch(async (u) => {
      seen.push(new URL(u).hostname);
      return new Response("{}", { status: 200 });
    });
    await guarded("https://api.pexels.com/v1/search?query=x");
    await guarded("https://cdn.pixabay.com/photo/a.jpg");
    await expect(guarded("https://example.com/a.jpg")).rejects.toThrow(/not allowed/);
    await expect(guarded("http://api.pexels.com/v1/search")).rejects.toThrow(/not allowed/);
    await expect(guarded("https://169.254.169.254/latest")).rejects.toThrow(/not allowed/);
    await expect(guarded("not a url")).rejects.toThrow(/bad url/);
    expect(seen).toEqual(["api.pexels.com", "cdn.pixabay.com"]);
  });

  test("a live build with env keys asks only the stock hosts and never shows a key", async () => {
    const hosts = new Set<string>();
    const inner = fixtureStockFetch();
    const env = { [STOCK_KEY_ENV.pexels]: "PEXELS-ENV-555", [STOCK_KEY_ENV.pixabay]: "PIXABAY-ENV-555" };
    const host = createPhotoHost({
      mode: "live",
      secrets: null,
      storage: new MemoryFileStorage(),
      env,
      fetch: async (u, init) => {
        hosts.add(new URL(u).hostname);
        return inner(u, init);
      },
    });
    expect(host?.stock.providers).toEqual(["pexels", "pixabay"]);
    const r = await runPhotosStage({ plan, host });
    expect(r.picked).toBe(2);
    for (const h of hosts) expect(STOCK_EGRESS_HOSTS).toContain(h);
    const everything = JSON.stringify(r.plan);
    expect(everything).not.toContain("PEXELS-ENV-555");
    expect(everything).not.toContain("PIXABAY-ENV-555");
  }, 60_000);
});

describe("library mode (B2-43: the photo library filled from CI, no stock from the server)", () => {
  /** Library copies and their index as the CI seeding leaves them (re-encoding faked: the pipeline has its own tests). */
  const seed = async (storage: MemoryFileStorage, entries: [string, "pexels" | "pixabay", number][]) => {
    const out: LibraryEntry[] = [];
    for (const [query, provider, id] of entries) {
      const copy = await storeLibraryPhoto(storage, fixtureImage(`${provider}:${id}`, 16, 10), {
        source: `${provider}:${id}`,
        process: async () => ({
          width: 1600,
          height: 1000,
          variants: [{ slot: 1600, width: 1600, height: 1000, data: new Uint8Array([1, 2, 3]) }],
        }),
      });
      out.push({
        query,
        orientation: "landscape",
        provider,
        id: String(id),
        file: copy.id,
        author: `Автор ${id}`,
        pageUrl: `https://${provider === "pexels" ? "www.pexels.com" : "pixabay.com"}/photo/${id}/`,
        ...STOCK_LICENSES[provider],
        width: copy.width,
        height: copy.height,
        pickedAt: "2026-10-07",
      });
    }
    await writeLibraryIndex(storage, serializeLibraryIndex(mergeLibraryIndex(emptyLibraryIndex(), out)));
  };

  test("WIZARD_STOCK_MODE=library: the builds take the library copies without the network or re-encoding", async () => {
    expect(stockModeOf({ WIZARD_STOCK_MODE: " Library ", WIZARD_LLM_MODE: "live" })).toBe("library");
    const storage = new MemoryFileStorage();
    await seed(storage, [
      ["barber shop", "pexels", 11],
      ["barber at work", "pixabay", 12],
      ["small business", "pexels", 13],
    ]);
    const puts = vi.spyOn(storage, "put");
    const net = vi.spyOn(globalThis, "fetch");
    const host = createPhotoHost({
      mode: "library",
      secrets: null,
      storage,
      env: { [STOCK_KEY_ENV.pexels]: "PEXELS-NEVER-USED" },
      fetch: async () => {
        throw new Error("no network in library mode");
      },
    });
    const r = await runPhotosStage({ plan, host });
    expect(r).toMatchObject({ picked: 2, fallback: false, providers: ["pexels", "pixabay"] });
    const photos = r.plan.design.photos ?? [];
    expect(photos.map((p) => [p.slot, p.provider, p.stockId, p.author])).toEqual([
      ["top", "pexels", "11", "Автор 11"],
      ["about", "pixabay", "12", "Автор 12"],
    ]);
    expect(photos[1]).toMatchObject({ ...STOCK_LICENSES.pixabay, width: 1600, height: 1000 });
    for (const p of photos) expect(storage.objects.has(`wz_photos/${p.file}`)).toBe(true);
    expect(puts).not.toHaveBeenCalled();
    expect(net).not.toHaveBeenCalled();
    net.mockRestore();
  });

  test("no index yet → theme graphics; a copy missing from the library fails only that pick", async () => {
    const empty = await runPhotosStage({
      plan,
      host: createPhotoHost({ mode: "library", secrets: null, storage: new MemoryFileStorage() }),
    });
    expect(empty).toMatchObject({ picked: 0 });
    expect(empty.note).toContain("сток не нашёл подходящих");
    const storage = new MemoryFileStorage();
    await seed(storage, [
      ["barber shop", "pexels", 21],
      ["barber shop", "pexels", 22],
      ["barber at work", "pexels", 23],
    ]);
    const first = [...storage.objects.keys()][0] as string;
    expect(first).not.toContain(PHOTO_LIBRARY_INDEX_ID);
    await storage.delete(first);
    const r = await runPhotosStage({ plan, host: libraryPhotoHost(storage) });
    expect(r.plan.design.photos?.map((p) => p.stockId)).toEqual(["22", "23"]);
    // The index is not a photo: the public route has nothing to serve under its id.
    expect((await storage.head(`wz_photos/${PHOTO_LIBRARY_INDEX_ID}`))?.image).toBeUndefined();
  });
});
