// B2-38 (platform side of the stock photos): WIZARD_STOCK_MODE picks fixtures (default, no network), live, record or
// off; live keys come only from the platform secrets (secret://platform/stock/*) — without them no provider is on and the
// landings keep the theme graphic; a picked photo is copied into the photo library of the shared file storage; keys
// never reach the plan (its photos go into the compiled system) or errors.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureStockFetch, runPhotosStage } from "@wizard/agents/builder";
import type { SystemPlan } from "@wizard/appspec";
import { MemoryFileStorage } from "@wizard/runtime";
import { afterAll, describe, expect, test } from "vitest";
import { createPhotoHost, stockModeOf } from "../src/agents/stock.js";
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
