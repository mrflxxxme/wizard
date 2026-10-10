// V3-14 acceptance in chromium (the metric of the template gate, no model). Calibration: generated one-page sites of
// one niche (v3-template-gate-fixtures.ts) are fingerprinted the way the gate does it (capturePage: DOM_SKETCH_SCRIPT
// shapes + pHash/dHash of the first screen and the full page at 390 and 1440 px) — every near-duplicate (the same
// section variants with other texts, palette, a dark theme, fonts and spacing) is at or above TEMPLATE_THRESHOLD; a
// site with half of its sections in other variants and a site with every section in another variant are below it.
// Then the production path: sites composed by the V3-12 composer on the ui-kit library, built by buildSystem and served
// inside the browser context (captureSite) — a re-coloured copy is a template, a composition of another archetype is
// not. The scores go to test-results/template-gate.json (git-ignored) for the record.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import {
  createPageComposer,
  readSite,
  type SiteModel,
  type V3BuildContext,
  withSitePages,
} from "@wizard/agents/builder";
import {
  type PageView,
  type SiteFingerprint,
  siteSimilarity,
  siteStructure,
  TEMPLATE_THRESHOLD,
  TEMPLATE_VIEWPORTS,
  type TemplateViewportId,
} from "@wizard/gates";
import { designSystemV3 } from "@wizard/ui-kit/v3/design";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { composeContext } from "../../../packages/agents/test/v3-compose-fixtures.js";
import { capturePage, captureSite, settlePage, TEMPLATE_MAX_PAGES } from "../src/builds-v3/template-gate.js";
import {
  type FixtureSite,
  fixtureLookup,
  fixtureSite,
  LOOKS,
  mixVariants,
  otherVariants,
  randomVariants,
} from "./v3-template-gate-fixtures.js";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync("/opt/pw-browsers"))
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers";
const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const ARTIFACTS = join(import.meta.dirname, "../test-results");
const scores: Record<string, Record<string, number>> = {};
const record = (group: string, pair: string, score: number) => {
  scores[group] ??= {};
  (scores[group] as Record<string, number>)[pair] = Math.round(score * 1000) / 1000;
};

let browser: Browser;

beforeAll(async () => {
  if (hasChromium) browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  if (Object.keys(scores).length) {
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, "template-gate.json"), `${JSON.stringify(scores, null, 1)}\n`);
  }
});

/** The fingerprint of a generated site: its structure and its views rendered from the static HTML (no network). */
async function fingerprint(f: FixtureSite): Promise<SiteFingerprint> {
  const views: Partial<Record<TemplateViewportId, PageView>> = {};
  for (const vp of TEMPLATE_VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    await context.route("**/*", (r) => r.abort());
    const page = await context.newPage();
    await page.setContent(f.html);
    await settlePage(page);
    views[vp.id] = await capturePage(page);
    await context.close();
  }
  const s = siteStructure(f.site, fixtureLookup);
  return { version: 1, pages: s.pages.map((p) => ({ ...p, views })) };
}

const BASES = [11, 23, 37, 41].map((seed) => ({ seed, variants: randomVariants(seed) }));

describe.skipIf(!hasChromium)(
  "template metric in chromium: generated near-duplicates vs different sites",
  () => {
    const near: { pair: string; score: number }[] = [];
    const half: { pair: string; score: number }[] = [];
    const diff: { pair: string; score: number }[] = [];

    beforeAll(async () => {
      for (const b of BASES) {
        const base = await fingerprint(fixtureSite(`base${b.seed}`, b.variants, b.seed, LOOKS[0] as never));
        const add = (list: typeof near, group: string, pair: string, other: SiteFingerprint) => {
          const score = siteSimilarity(other, base).score;
          list.push({ pair, score });
          record(group, pair, score);
        };
        // Near-duplicates: the same variants; other texts, palette (look 3 is dark), fonts and spacing.
        for (const [k, look] of LOOKS.entries()) {
          if (k === 0) continue;
          const copy = await fingerprint(fixtureSite(`near${b.seed}-${k}`, b.variants, b.seed * 7 + k, look));
          add(near, "near_duplicate", `base${b.seed}~look${k}`, copy);
        }
        // Half of the sections in other variants (other texts, another look).
        const mixed = await fingerprint(
          fixtureSite(`mix${b.seed}`, mixVariants(b.variants, 4, b.seed * 17), b.seed * 3, LOOKS[1] as never),
        );
        add(half, "half_shared", `base${b.seed}~half`, mixed);
        // Different sites of the niche: every section in another variant (other texts; the same texts and look).
        for (const k of [1, 2, 3]) {
          const v = otherVariants(b.variants, b.seed * 13 + k);
          const texts = k === 3 ? b.seed : b.seed * 5 + k;
          const other = await fingerprint(
            fixtureSite(`diff${b.seed}-${k}`, v, texts, LOOKS[k === 2 ? 1 : 0] as never),
          );
          add(diff, "different", `base${b.seed}≠v${k}`, other);
        }
      }
    }, 240_000);

    test("near-duplicates are at or above the threshold; half-shared and different sites are below it", () => {
      expect(near).toHaveLength(12);
      expect(half).toHaveLength(4);
      expect(diff).toHaveLength(12);
      for (const n of near) expect(n.score, n.pair).toBeGreaterThanOrEqual(TEMPLATE_THRESHOLD);
      for (const h of half) expect(h.score, h.pair).toBeLessThan(TEMPLATE_THRESHOLD);
      for (const d of diff) expect(d.score, d.pair).toBeLessThan(TEMPLATE_THRESHOLD);
      // The groups are ordered with room between them: copies ≫ half-shared ≫ different.
      const min = (xs: { score: number }[]) => Math.min(...xs.map((x) => x.score));
      const max = (xs: { score: number }[]) => Math.max(...xs.map((x) => x.score));
      expect(max(diff)).toBeLessThan(min(half));
      expect(max(diff)).toBeLessThan(TEMPLATE_THRESHOLD - 0.2);
    });
  },
);

/** A site of the V3-12 composer (skeleton, no model) for the clinic plan: its model, spec and files. */
async function composed(o: { systemId: string; archetype: string; brandColor: string; seed: number }) {
  const base = composeContext({ systemId: o.systemId });
  const ctx: V3BuildContext = {
    ...base,
    design: designSystemV3({
      archetype: o.archetype as never,
      brandColor: o.brandColor,
      seed: o.seed,
      niche: base.design.niche,
    }),
  };
  const out = await createPageComposer().skeleton(ctx);
  const files = new Map(ctx.files);
  for (const [p, v] of out.files) v === null ? files.delete(p) : files.set(p, v);
  const site = readSite(files) as SiteModel;
  return { site, spec: withSitePages(ctx.spec, site), files };
}

describe.skipIf(!hasChromium)("captureSite: composed sites built and served in the browser context", () => {
  let a: SiteFingerprint;
  let recoloured: SiteFingerprint;
  let other: SiteFingerprint;
  let siteA: SiteModel;
  let siteB: SiteModel;

  beforeAll(async () => {
    const sa = await composed({
      systemId: "sys-a",
      archetype: "calm_medical",
      brandColor: "#2a7f9e",
      seed: 7,
    });
    const sr = await composed({
      systemId: "sys-a",
      archetype: "calm_medical",
      brandColor: "#b04a2f",
      seed: 7,
    });
    const sb = await composed({
      systemId: "sys-b",
      archetype: "bold_poster",
      brandColor: "#5b3fd1",
      seed: 19,
    });
    siteA = sa.site;
    siteB = sb.site;
    const log: unknown[] = [];
    const opts = { log: (msg: string, err: unknown) => log.push([msg, String(err)]) };
    a = await captureSite(browser, sa, opts);
    recoloured = await captureSite(browser, sr, opts);
    other = await captureSite(browser, sb, opts);
    expect(log).toEqual([]);
    record("composed", "recoloured", siteSimilarity(recoloured, a).score);
    record("composed", "other_archetype", siteSimilarity(other, a).score);
  }, 300_000);

  test("every public page keeps its structure; the first pages are rendered at 390 and 1440 px", () => {
    expect(a.pages.map((p) => p.route)).toEqual(siteA.pages.map((p) => p.route));
    const home = a.pages.find((p) => p.route === "/");
    expect(home?.sections.map((s) => s.type)).toEqual(siteA.pages[0]?.sections.map((s) => s.type));
    // Library patterns carry their layout family and variant.
    expect(home?.sections.filter((s) => s.type !== "signature").every((s) => s.layout && s.variant)).toBe(
      true,
    );
    const rendered = a.pages.filter((p) => p.views);
    expect(rendered.length).toBe(Math.min(TEMPLATE_MAX_PAGES, a.pages.length));
    for (const p of rendered) {
      expect(Object.keys(p.views ?? {}).sort()).toEqual(["1440", "390"]);
      for (const v of Object.values(p.views ?? {})) {
        expect(v.shapes.length).toBeGreaterThanOrEqual(3);
        expect(v.first.p).toMatch(/^[0-9a-f]{16}$/);
        expect(v.full.d).toMatch(/^[0-9a-f]{16}$/);
      }
    }
    // The page frame is seen section by section: the home page renders its header, body sections and footer.
    // (V3-18: a preview of the catalog on home renders nothing while the catalog is empty, as here.)
    expect(home?.views?.["1440"]?.shapes.length).toBe(
      siteA.pages[0]?.sections.filter((s) => s.props.preview !== true).length,
    );
  });

  test("a re-coloured copy is a template; a site of another archetype and seed is not", () => {
    expect(siteSimilarity(recoloured, a).score).toBeGreaterThanOrEqual(TEMPLATE_THRESHOLD);
    const patterns = (s: SiteModel) => s.pages[0]?.sections.map((x) => x.pattern) ?? [];
    const shared = patterns(siteB).filter((p) => patterns(siteA).includes(p)).length;
    expect(shared).toBeLessThan(patterns(siteB).length / 2);
    expect(siteSimilarity(other, a).score).toBeLessThan(TEMPLATE_THRESHOLD);
  });
});
