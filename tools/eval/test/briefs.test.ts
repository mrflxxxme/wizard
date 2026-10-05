// M0-18 / M2-12: brief set (eval.yaml#briefs): gd-* ids, M0 and M2 composition, no PII outside canaries/allowlist.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { detect } from "../../../packages/pii/src/index.ts";
import { BRIEFS_DIR, briefProblems, loadBriefs, M0_SET, M2_SET } from "../lib/briefs.mjs";

const briefs = loadBriefs();
const allow = readFileSync(join(import.meta.dirname, "..", "pii-allowlist.txt"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

describe("brief set", () => {
  test("every file passes the format of eval.yaml#briefs.format", () => {
    for (const f of readdirSync(BRIEFS_DIR).filter((x) => x.endsWith(".json"))) {
      const b = JSON.parse(readFileSync(join(BRIEFS_DIR, f), "utf8"));
      expect(briefProblems(b, f), f).toEqual([]);
    }
  });

  test("no cg-* ids left; M0 composition (≥ 12, ≥ 5 ev, ≥ 3 gd, ≥ 4 hz, ≥ 4 with canaries)", () => {
    const ids = briefs.map((b) => b.id);
    expect(ids.filter((id) => id.startsWith("cg-"))).toEqual([]);
    const count = (p: string) => ids.filter((id) => id.startsWith(`${p}-`)).length;
    expect(briefs.length).toBeGreaterThanOrEqual(M0_SET.total);
    expect(count("ev")).toBeGreaterThanOrEqual(M0_SET.ev);
    expect(count("gd")).toBeGreaterThanOrEqual(M0_SET.gd);
    expect(count("hz")).toBeGreaterThanOrEqual(M0_SET.hz);
    expect(briefs.filter((b) => b.canaries?.length).length).toBeGreaterThanOrEqual(M0_SET.canaries);
  });

  test("M2-12: M2 composition (≥ 30 briefs, ≥ 10 horizontal outside the two proving grounds — L4-28)", () => {
    expect(briefs.length).toBeGreaterThanOrEqual(M2_SET.total);
    const hz = briefs.filter((b) => b.segment === "horizontal");
    expect(hz.length).toBeGreaterThanOrEqual(M2_SET.hz);
    expect(hz.every((b) => b.id.startsWith("hz-"))).toBe(true);
    // Titles are unique: every brief is its own scenario.
    expect(new Set(briefs.map((b) => b.title)).size).toBe(briefs.length);
  });

  test("canary kinds: Latin full name, @handle, non-RU phone are all present in the set", () => {
    const all = briefs.flatMap((b) => b.canaries ?? []);
    expect(all.some((c) => /^[A-Z][a-z]+ [A-Z][A-Za-z-]+$/.test(c))).toBe(true);
    expect(all.some((c) => /^@[a-z0-9_]+$/.test(c))).toBe(true);
    expect(all.some((c) => /^\+(?!7)\d[\d ]+$/.test(c))).toBe(true);
  });

  test("packages/pii finds nothing in brief texts besides canaries and the allowlist", () => {
    for (const b of [...briefs, ...loadBriefs("mvp")]) {
      const found = detect(b.text)
        .map((d) => b.text.slice(d.start, d.end))
        .filter(
          (v) =>
            !allow.includes(v) && !(b.canaries ?? []).some((c: string) => c.includes(v) || v.includes(c)),
        );
      expect(found, b.id).toEqual([]);
    }
  });

  test("loadBriefs: subset by ids, unknown id throws", () => {
    expect(loadBriefs("ev-01-forum-registration").map((b) => b.id)).toEqual(["ev-01-forum-registration"]);
    expect(() => loadBriefs("cg-01-cake-preorder")).toThrow(/неизвестные брифы/);
  });
});
