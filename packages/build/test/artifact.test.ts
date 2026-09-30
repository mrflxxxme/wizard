// writeArtifact: runtime.yaml#system_loading.artifact_layout.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { specHash, writeArtifact } from "../src/index.js";
import { build, forumFiles, loadForum } from "./helpers.js";

const base = mkdtempSync(join(tmpdir(), "wz-artifact-test-"));
const root = join(base, ".data/artifacts");
const SYSTEM = "forum0000001";
afterAll(() => rmSync(base, { recursive: true, force: true }));

function tree(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name).slice(dir.length + 1))
    .sort();
}

describe("writeArtifact", () => {
  test("forum draft → .data/artifacts/<id>/<rev>/… with specHash and bundleKey", async () => {
    const r = await build();
    const w = writeArtifact(root, SYSTEM, 1, r);
    expect(w.dir).toBe(join(root, SYSTEM, "1"));
    expect(w.bundleKey).toBe(`${SYSTEM}/1`);
    const files = tree(w.dir);
    expect(files).toEqual(
      [
        "client/index.html",
        r.manifest.entry.script.replace(/^/, "client/"),
        "manifest.json",
        "server/functions.mjs",
        "spec.json",
        "wz-map.json",
      ].sort(),
    );
    const manifest = JSON.parse(readFileSync(join(w.dir, "manifest.json"), "utf8"));
    expect(manifest.specHash).toBe(specHash(loadForum()));
    expect(manifest.bundleKey).toBe(`${SYSTEM}/1`);
    expect(manifest.specHash).toBe(specHash(JSON.parse(readFileSync(join(w.dir, "spec.json"), "utf8"))));
    expect(readFileSync(join(w.dir, "server/functions.mjs"), "utf8")).toBe(r.serverFunctions);
    expect(JSON.parse(readFileSync(join(w.dir, "wz-map.json"), "utf8"))).toEqual(r.wzMap);
    expect(readdirSync(join(root, SYSTEM))).toEqual(["1"]); // no staging leftovers
  });

  test("prod: no wz-map.json", async () => {
    const w = writeArtifact(root, SYSTEM, 2, await build({ env: "prod" }));
    expect(existsSync(join(w.dir, "wz-map.json"))).toBe(false);
    expect(readFileSync(join(w.dir, "client/index.html"), "utf8")).not.toContain("bridge.js");
  });

  test("revisions are immutable: same build is a no-op, different build throws", async () => {
    const again = writeArtifact(root, SYSTEM, 1, await build());
    expect(again.bundleKey).toBe(`${SYSTEM}/1`);
    const files = forumFiles();
    files.set("ui/Landing.tsx", (files.get("ui/Landing.tsx") ?? "").replace("по промокоду", "по коду"));
    const other = await build({ files });
    expect(() => writeArtifact(root, SYSTEM, 1, other)).toThrow(/already exists/);
  });

  test("refuses failed builds and bad ids", async () => {
    const files = forumFiles();
    files.delete("ui/Scanner.tsx");
    const failed = await build({ files });
    expect(() => writeArtifact(root, SYSTEM, 3, failed)).toThrow(/build failed/);
    const ok = await build();
    for (const id of ["../escape0000", "FORUM0000001", "short"]) {
      expect(() => writeArtifact(root, id, 3, ok)).toThrow(/invalid systemId/);
    }
    expect(() => writeArtifact(root, SYSTEM, 0, ok)).toThrow(/invalid revision/);
    const evil = { ...ok, client: new Map([["../../x.js", new Uint8Array()]]) };
    expect(() => writeArtifact(root, SYSTEM, 3, evil)).toThrow(/invalid client path/);
  });
});
