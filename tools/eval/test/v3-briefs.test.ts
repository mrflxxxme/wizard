// V3-18: the briefs of checkpoint 1 (D77_v3 (12), docs/plans/2026-10-08-v3.md §3: 4 briefs of classes 1–3; V3-23 adds
// the shop of class 4) — the format of v3 briefs (lib/briefs.mjs), the set, no personal data in the texts and in the
// ТЗ files besides the canaries. V3-40: the final set of 12 briefs (loadBriefs("v3-final")), the checkpoint set unchanged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { detect } from "../../../packages/pii/src/index.ts";
import {
  briefProblems,
  isV3Brief,
  loadBriefs,
  V3_CLASSES,
  V3_FINAL_SET,
  V3_TOPICS,
} from "../lib/briefs.mjs";

const v3 = loadBriefs("v3");
const final = loadBriefs("v3-final");
const allow = readFileSync(join(import.meta.dirname, "..", "pii-allowlist.txt"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

describe("v3 briefs (checkpoint 1)", () => {
  test("5 briefs: two business sites, booking with a client cabinet, a CRM, a shop (V3-23); one with a ТЗ file", () => {
    expect(v3.map((b) => b.id)).toEqual([
      "v3-01-interior-studio",
      "v3-02-dental-booking",
      "v3-03-cleaning-crm",
      "v3-04-karelia-tours",
      "v3-05-ceramics-shop",
    ]);
    expect(v3.map((b) => b.class)).toEqual(["site", "booking", "crm", "site", "shop"]);
    expect(v3.every((b) => b.segment === "v3" && V3_CLASSES.includes(b.class))).toBe(true);
    expect(v3.filter((b) => b.tz).map((b) => b.id)).toEqual(["v3-03-cleaning-crm"]);
    // Every brief exercises the interview: answers by stem, «Решите за меня» and an own text somewhere in the set.
    const values = v3.flatMap((b) => Object.values(b.answers ?? {}));
    expect(values).toContain("delegate");
    expect(values.some((v) => typeof v === "object")).toBe(true);
    expect(values.some((v) => typeof v === "string" && !["delegate", "recommended"].includes(v))).toBe(true);
    expect(v3.every((b) => Object.keys(b.answers ?? {}).every((k) => V3_TOPICS.includes(k)))).toBe(true);
    expect(v3.every((b) => (b.canaries ?? []).length > 0)).toBe(true);
    expect(new Set(v3.map((b) => b.direction ?? 1)).size).toBeGreaterThan(1);
  });

  test("V3-40: the final set — 12 briefs, 3 per class, the checkpoint briefs among them; varied answers and directions", () => {
    expect(final).toHaveLength(V3_FINAL_SET.total);
    for (const c of V3_CLASSES)
      expect(final.filter((b) => b.class === c).length, c).toBe(V3_FINAL_SET.perClass);
    expect(v3.every((b) => final.some((x) => x.id === b.id))).toBe(true);
    expect(final.every((b) => b.segment === "v3" && (b.canaries ?? []).length > 0)).toBe(true);
    expect(final.every((b) => Object.keys(b.answers ?? {}).every((k) => V3_TOPICS.includes(k)))).toBe(true);
    // Every brief is its own business: unique titles and canaries; a ТЗ file of each format in the set.
    expect(new Set(final.map((b) => b.title)).size).toBe(final.length);
    expect(new Set(final.flatMap((b) => b.canaries)).size).toBe(final.flatMap((b) => b.canaries).length);
    expect(new Set(final.filter((b) => b.tz).map((b) => b.tz.format))).toEqual(new Set(["md", "txt"]));
    expect(new Set(final.map((b) => b.direction ?? 1))).toEqual(new Set([1, 2, 3, "delegate"]));
  });

  test("the default set and the mvp set leave the v3 briefs out", () => {
    expect(loadBriefs().some((b) => isV3Brief(b.id))).toBe(false);
    expect(loadBriefs("mvp").some((b) => isV3Brief(b.id))).toBe(false);
    expect(loadBriefs("v3-02-dental-booking").map((b) => b.id)).toEqual(["v3-02-dental-booking"]);
  });

  test("format problems of a v3 brief are named in Russian", () => {
    const base = { ...v3[0] };
    expect(briefProblems(base, `${base.id}.json`)).toEqual([]);
    expect(briefProblems({ ...base, class: "portal" }).join("; ")).toMatch(/class: одно из site/);
    expect(briefProblems({ ...base, answers: { pricing: "x" } }).join("; ")).toMatch(
      /answers\.pricing: тема/,
    );
    expect(briefProblems({ ...base, answers: { goals: { text: "" } } }).join("; ")).toMatch(/answers\.goals/);
    expect(briefProblems({ ...base, rest_after: 0 }).join("; ")).toMatch(/rest_after/);
    expect(briefProblems({ ...base, tz: { format: "pdf", text: "x" } }).join("; ")).toMatch(/tz:/);
    expect(briefProblems({ ...base, direction: 4 }).join("; ")).toMatch(/direction/);
  });

  test("packages/pii finds nothing in the texts and the ТЗ files besides the canaries", () => {
    for (const b of final)
      for (const text of [b.text, b.tz?.text ?? ""]) {
        const found = detect(text)
          .map((d) => text.slice(d.start, d.end))
          .filter(
            (v) =>
              !allow.includes(v) && !(b.canaries ?? []).some((c: string) => c.includes(v) || v.includes(c)),
          );
        expect(found, b.id).toEqual([]);
      }
  });
});
