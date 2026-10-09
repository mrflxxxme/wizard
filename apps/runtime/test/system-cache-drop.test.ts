// V3-18: a loaded system leaving the SystemCache is reported (onDrop) — evicted, unpinned, pushed out of the LRU, gone
// from the registry (unpublished, deleted) or replaced by a new revision — with `last` telling whether another loaded
// copy of the deployment remains; the runtime frees its executor and, with the last copy, its sandbox slot.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { createInvalidationBus } from "../src/data/events.js";
import type { RegistryEntry, SystemEnv } from "../src/registry.js";
import { SystemCache } from "../src/system.js";
import { forumSpec } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "wz-cache-drop-"));
// Never connected: the cache only builds DataAccess objects here.
const sql = postgres("postgres://wizard@127.0.0.1:1/none", { max: 1 });
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await sql.end({ timeout: 0 });
});

function entry(systemId: string, slug: string, revision = 1): RegistryEntry {
  const dir = join(root, systemId, String(revision));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ specHash: `h${revision}`, bundleKey: "b" }));
  writeFileSync(join(dir, "spec.json"), JSON.stringify(forumSpec()));
  return {
    systemId,
    slug,
    env: "prod",
    revision,
    specHash: `h${revision}`,
    bundleKey: "b",
    publishedAt: new Date(0).toISOString(),
    suspended: false,
    features: { phoneOtp: false },
  };
}

function setup(capacity = 10) {
  const reg = new Map<string, RegistryEntry>();
  const drops: string[] = [];
  const cache = new SystemCache({
    sql,
    registry: { resolve: async (slug: string, env: SystemEnv) => reg.get(`${slug}:${env}`) ?? null },
    artifactsRoot: root,
    capacity,
    dbRole: null,
    bus: () => createInvalidationBus(),
    onDrop: (sys, last) =>
      drops.push(`${sys.entry.systemId}@${sys.entry.revision}:${last ? "last" : "kept"}`),
  });
  const publish = (e: RegistryEntry) => reg.set(`${e.slug}:${e.env}`, e);
  return { reg, drops, cache, publish };
}

describe("SystemCache.onDrop", () => {
  it("LRU overflow, unpublish and evict report the last copy; a new revision reports the replaced one as kept", async () => {
    const { reg, drops, cache, publish } = setup(1);
    publish(entry("aaaaaaaaaaaa", "a"));
    publish(entry("bbbbbbbbbbbb", "b"));
    await cache.resolve("a", "prod");
    await cache.resolve("b", "prod");
    expect(drops).toEqual(["aaaaaaaaaaaa@1:last"]);
    publish(entry("bbbbbbbbbbbb", "b", 2));
    await cache.resolve("b", "prod");
    expect(drops.at(-1)).toBe("bbbbbbbbbbbb@1:kept");
    reg.delete("b:prod");
    expect(await cache.resolve("b", "prod")).toBeNull();
    expect(drops.at(-1)).toBe("bbbbbbbbbbbb@2:last");
    publish(entry("aaaaaaaaaaaa", "a"));
    await cache.resolve("a", "prod");
    expect(cache.evict("aaaaaaaaaaaa", "prod")).toBe(true);
    expect(drops.at(-1)).toBe("aaaaaaaaaaaa@1:last");
    expect(cache.evict("aaaaaaaaaaaa", "prod")).toBe(false);
    expect(drops).toHaveLength(4);
  });

  it("unpin reports the last copy only when no other pinned slug of the system remains", () => {
    const { drops, cache } = setup();
    const spec = forumSpec();
    cache.pin({ systemKey: "cccccccccccc", env: "draft", spec, slug: "c1" });
    cache.pin({ systemKey: "cccccccccccc", env: "draft", spec, slug: "c2" });
    expect(cache.unpin("c1", "draft")).toBe(true);
    expect(cache.unpin("c1", "draft")).toBe(false);
    expect(cache.unpin("c2", "draft")).toBe(true);
    expect(drops).toEqual(["cccccccccccc@0:kept", "cccccccccccc@0:last"]);
  });
});
