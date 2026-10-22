// V5-10: the report's home snapshots in the evaluation stand's layout <dir>/<brief>/{1440,390}.png.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileStorage } from "@wizard/runtime";
import { expect, test } from "vitest";
import { exportEvalShots } from "../src/builds-v3/report/eval-export.js";
import { shotRoutes } from "../src/builds-v3/report/shots.js";
import type { BuildReport } from "../src/builds-v3/report/types.js";

const bytes = (s: string) => new TextEncoder().encode(s);

test("home snapshots are written as <brief>/{1440,390}.png; inner pages are skipped", async () => {
  const stored = new Map([
    ["k1", "d1440"],
    ["k2", "d390"],
    ["k3", "dinner"],
  ]);
  const files = {
    get: async (k: string) => ({ data: bytes(stored.get(k) ?? ""), meta: { mime: "image/jpeg" } }),
  } as unknown as FileStorage;
  const report = {
    records: null,
    shots: [
      { route: "/", width: 1440, key: "k1", mime: "image/jpeg" },
      { route: "/", width: 390, key: "k2", mime: "image/jpeg" },
      { route: "/prices", width: 1440, key: "k3", mime: "image/jpeg" },
    ],
  } as unknown as BuildReport;
  const dir = mkdtempSync(join(tmpdir(), "wz-v5-shots-"));
  try {
    const done = await exportEvalShots(files, report, "b01", dir, async (d) => d);
    expect(done).toEqual([1440, 390]);
    expect(readFileSync(join(dir, "b01", "1440.png"), "utf8")).toBe("d1440");
    expect(readFileSync(join(dir, "b01", "390.png"), "utf8")).toBe("d390");
    await expect(exportEvalShots(files, report, "../x", dir, async (d) => d)).rejects.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shot routes: the home page first, the site model's pages after, no duplicates", () => {
  const site = { pages: [{ route: "/prices" }, { route: "/" }, { route: "/about" }] };
  const m = new Map([["ui/site.json", JSON.stringify(site)]]);
  expect(shotRoutes(m)).toEqual(["/", "/prices", "/about"]);
  expect(shotRoutes(new Map())).toEqual(["/"]);
});
