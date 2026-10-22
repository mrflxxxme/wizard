import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkEffects, summarizeLighthouse } from "../src/index.js";

const still = "const m=matchMedia('(prefers-reduced-motion: reduce)');requestAnimationFrame(()=>{});";
const light = (id: string) => ({ id, kind: "light" as const, js: still });
const heavy = (id: string, js = still) => ({ id, kind: "heavy" as const, js });
const codes = (r: ReturnType<typeof checkEffects>) => r.violations.map((v) => v.code);

describe("effects gate", () => {
  it("passes one heavy effect plus light ones", () => {
    const r = checkEffects([{ page: "/", effects: [heavy("shader"), light("reveal"), light("count-up")] }]);
    expect(r).toEqual({ ok: true, violations: [] });
  });
  it("is red for a page with two heavy effects", () => {
    const r = checkEffects([{ page: "/", effects: [heavy("shader"), heavy("parallax")] }]);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(["heavy-count"]);
  });
  it("is red for an effect over 40 KB gzip", () => {
    const big = `${still}/*${randomBytes(45 * 1024).toString("base64")}*/`;
    expect(codes(checkEffects([{ page: "/", effects: [heavy("big", big)] }]))).toEqual(["js-weight"]);
  });
  it("is red for motion without a reduced-motion fallback", () => {
    const r = checkEffects([
      { page: "/", effects: [light("x")].map((e) => ({ ...e, js: "requestAnimationFrame(f)" })) },
    ]);
    expect(codes(r)).toEqual(["reduced-motion"]);
  });
  it("checks Lighthouse mobile perf ≥ 85 and LCP ≤ 2.5 s", () => {
    const pages = [{ page: "/", effects: [heavy("shader")] }];
    expect(checkEffects(pages, { "/": { performance: 0.85, lcpMs: 2500 } }).ok).toBe(true);
    expect(codes(checkEffects(pages, { "/": { performance: 0.84, lcpMs: 2600 } }))).toEqual([
      "lighthouse-perf",
      "lighthouse-lcp",
    ]);
  });
  it("reads a Lighthouse report", () => {
    const s = summarizeLighthouse({
      categories: { performance: { score: 0.9 } },
      audits: { "largest-contentful-paint": { numericValue: 1800 } },
    });
    expect(s).toEqual({ performance: 0.9, lcpMs: 1800 });
  });
});
