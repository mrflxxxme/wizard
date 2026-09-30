// M0-26: unloadSystem drops a pinned (G1) system; /_wizard/health on a system host reports {system, env, revision};
// DbRegistry falls back when platform.deployments does not know the host (or does not exist).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbRegistry, MemoryRegistry, testModeSecrets } from "../src/index.js";
import { forumSpec, type Harness, harness, request } from "./helpers.js";

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.close();
});

describe("unloadSystem", () => {
  it("a pinned system serves health with its revision until it is unloaded", async () => {
    const host = "g1-unload--draft.localhost:4100";
    await h.system("g1-unload", forumSpec());
    const res = await h.rt.fetch(request("GET", host, "/_wizard/health"));
    expect(await res.json()).toEqual({ status: "ok", system: "g1-unload", env: "draft", revision: 0 });
    const size = h.rt.systems.size;
    expect(h.rt.unloadSystem({ slug: "g1-unload", env: "draft" })).toBe(true);
    expect(h.rt.systems.size).toBe(size - 1);
    expect(h.rt.unloadSystem({ slug: "g1-unload", env: "draft" })).toBe(false);
    expect((await h.rt.fetch(request("GET", host, "/_wizard/health"))).status).toBe(404);
  });
});

describe("DbRegistry", () => {
  it("unknown slug → fallback registry", async () => {
    const entry = {
      systemId: "abcdefabcdef",
      slug: "shop",
      env: "draft" as const,
      revision: 3,
      specHash: "h",
      bundleKey: "abcdefabcdef/3",
      publishedAt: "",
      suspended: false,
      features: { phoneOtp: false },
    };
    const reg = new DbRegistry(h.sql, new MemoryRegistry([entry]));
    expect(await reg.resolve("shop", "draft")).toEqual(entry);
    expect(await new DbRegistry(h.sql).resolve("shop", "draft")).toBeNull();
  });
});

describe("testModeSecrets", () => {
  it("gives every system the same in-memory qr_signing_key and nothing else", async () => {
    const f = testModeSecrets();
    const a = await f("aaa_g1_1", "draft").get("qr_signing_key");
    expect(await f("bbb", "draft").get("qr_signing_key")).toBe(a);
    await expect(f("aaa", "draft").get("telegram_bot_token")).rejects.toThrow();
  });
});
