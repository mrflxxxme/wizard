// V3-13 acceptance (browser part): the critic's inspector in the process Chromium (builds-v3/critic.ts) on the clinic's
// composed site (V3-12 skeleton on the real pattern library) — built by buildSystem and opened without network at
// 390/768/1440 (light) and 390 (dark): screenshots downscaled to JPEG for the model, deterministic checks without a model
// (contrast, overflow, fonts, CLS, names) attributed to sections; then the whole critic hook: a section variant that
// overflows is swapped by code, two critic_visual cycles on recorded answers (T0, ≤ 40 ₽) with an edit re-checked by
// G0 and the browser; the result builds.
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import {
  CRITIC_VIEWPORTS,
  type CriticInspection,
  readSite,
  runCritic,
  shotPlan,
  withSitePages,
} from "@wizard/agents/builder";
import { buildSystem } from "@wizard/build";
import { PATTERNS, type PatternMeta } from "@wizard/ui-kit/v3/patterns";
import { afterAll, describe, expect, test } from "vitest";
import { siteFacts, siteFiles } from "../../../packages/agents/src/builder/v3/compose/index.js";
import { briefSite } from "../../../packages/agents/test/v3-brief-site.js";
import {
  criticContext,
  critique,
  critiqueLines,
  firstPrompt,
  fixtureRoute,
  registry,
} from "../../../packages/agents/test/v3-critic-fixtures.js";
import { EVAL_BRIEFS } from "../../../packages/agents/test/v3-eval-briefs.js";
import { chromiumProvider } from "../src/agents/goal-browser.js";
import { criticInspector, platformCritic } from "../src/builds-v3/critic.js";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const browser = chromiumProvider({ slots: 1 });
afterAll(() => browser.close());

const ctx = await criticContext();
const fonts = [ctx.design.fonts.display.family, ctx.design.fonts.text.family];
const routes = ctx.site.pages.map((p) => p.route);
const HOME = "ui/pages/site/Home.tsx";

/** The home page with problems put into its sections by hand (the build does not lint, the browser sees them). */
function brokenHome(src: string): string {
  return src
    .replace("\nimport ", '\nimport { useEffect, useState } from "react";\nimport ')
    .replace(
      "export default function",
      [
        "function Late() {",
        "  const [on, setOn] = useState(false);",
        "  useEffect(() => {",
        // 100 ms after the page is shown (the first paint waits for the data, @wizard/build): a block pushes the page.
        "    const t = setInterval(() => {",
        '      if (document.getElementById("root")?.style.opacity === "0") return;',
        "      clearInterval(t);",
        "      setTimeout(() => setOn(true), 100);",
        "    }, 10);",
        "    return () => clearInterval(t);",
        "  }, []);",
        "  return on ? <div style={{ height: 420 }} /> : null;",
        "}",
        "",
        "export default function",
      ].join("\n"),
    )
    .replace('<div id="hero">', '<div id="hero">\n          <Late />')
    .replace(
      '<div id="services">',
      [
        '<div id="services">',
        '          <div style={{ width: 1200, height: 8 }} className="bg-foreground" />',
        '          <p style={{ color: "#d6d6d6" }}>Светло-серый текст на светлом фоне</p>',
        '          <img src="/_wizard/photos/00000000-0000-4000-8000-000000000001/800" width={80} height={60} />',
      ].join("\n"),
    );
}

describe.skipIf(!hasChromium)("V3-13 critic in Chromium", () => {
  test("screenshots at 390/768/1440 for the model and a clean site without problems", async () => {
    const r = await criticInspector({ browser })({
      spec: ctx.spec,
      files: ctx.files,
      routes,
      viewports: CRITIC_VIEWPORTS,
      shots: shotPlan(ctx.site),
      fonts,
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.stubPhotos).toBe(true);
    expect(
      r.shots.map((s) => `${s.route}@${s.width}:${s.kind} ${s.px.width}×${s.px.height <= s.maxHeight}`),
    ).toEqual(["/@390:screen 390×true", "/@1440:page 360×true"]);
    for (const s of r.shots) {
      expect(s.mime).toBe("image/jpeg");
      expect(Buffer.from(s.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
      // Small images keep a cycle cheap: ≤ 60 KB each.
      expect(s.data.length).toBeLessThan(80_000);
    }
    expect(r.shots[0]?.sections.slice(0, 2)).toEqual(["header", "hero"]);
    expect(r.shots[1]?.sections[0]).toMatch(/^header 0–\d+$/);
  }, 120_000);

  test("V3-18: every page of the eval brief sites loads without a layout shift and without other problems", async () => {
    // The paid checkpoint: CLS > 0,1 on /#hero, /blog, /services, /booking, the header, the footer — the fallback font
    // swapped for the design one, sections bound to data jumped from their loading state to the loaded one.
    const found: string[] = [];
    for (const [id, input] of Object.entries(EVAL_BRIEFS)) {
      const b = await briefSite(id, input);
      if (!b.site.pages.length) continue;
      const r = await criticInspector({ browser })({
        spec: withSitePages(b.spec, b.site),
        files: b.files,
        routes: b.site.pages.map((p) => p.route.replace(/:\w+/g, "x")),
        viewports: CRITIC_VIEWPORTS,
        shots: [],
        fonts: [b.ctx.design.fonts.display.family, b.ctx.design.fonts.text.family],
      });
      expect(r.ok, r.error).toBe(true);
      for (const p of r.problems)
        found.push(`${id} ${p.code} ${p.route}@${p.width} ${p.scheme}: ${p.message_ru}`);
    }
    expect(found).toEqual([]);
  }, 300_000);

  test("deterministic checks without a model: overflow, contrast, CLS, fonts, alt — by section", async () => {
    const files = new Map(ctx.files);
    files.set(HOME, brokenHome(ctx.files.get(HOME) ?? ""));
    const r: CriticInspection = await criticInspector({ browser })({
      spec: ctx.spec,
      files,
      routes: ["/"],
      viewports: CRITIC_VIEWPORTS,
      shots: [],
      fonts: [...fonts, "Несуществующий Гротеск"],
    });
    expect(r.ok, r.error).toBe(true);
    const at = (code: string) => r.problems.filter((p) => p.code === code);
    // Overflow on the phone and the tablet, not on the desktop.
    expect([...new Set(at("L11").map((p) => `${p.section}@${p.width}`))].sort()).toEqual([
      "services@390",
      "services@768",
    ]);
    expect(at("C08").some((p) => p.section === "services" && p.message_ru.includes("Светло-серый"))).toBe(
      true,
    );
    expect(at("CLS").length).toBeGreaterThan(0);
    expect(at("CLS")[0]?.message_ru).toMatch(/CLS \d\.\d{3}/);
    expect(at("T16").map((p) => p.message_ru)).toContain(
      "шрифт «Несуществующий Гротеск» не объявлен на странице",
    );
    expect(
      at("A08").some((p) => p.section === "services" && p.message_ru.startsWith("картинка без alt")),
    ).toBe(true);
    // The design fonts themselves load (no fallback).
    expect(at("T16").every((p) => p.message_ru.includes("Несуществующий"))).toBe(true);
    // The light grey holds on the dark page; problems of the dark theme say so.
    expect(
      at("C08")
        .filter((p) => p.message_ru.includes("Светло-серый"))
        .map((p) => p.scheme),
    ).not.toContain("dark");
    expect(at("L11").some((p) => p.scheme === "dark" && p.message_ru.endsWith("(тёмная тема)"))).toBe(true);
  }, 120_000);

  test("the critic hook end to end: code swaps an overflowing variant, 2 model cycles on T0, edits re-checked", async () => {
    // A services variant that is too wide on phones (outside the library: only this test has it).
    const base = PATTERNS.find((p) => p.id === "services-editorial") as PatternMeta;
    const wide: PatternMeta = {
      ...base,
      id: "services-wide",
      variant: "wide",
      file: "ui/patterns/services-wide.tsx",
      source: base.source.replace(
        /<section([^>]*)>/,
        '<section$1>\n      <div className="h-2 bg-foreground" style={{ width: 1100 }} />',
      ),
    };
    const library = [...PATTERNS, wide];
    const site = structuredClone(ctx.site);
    const services = site.pages[0]?.sections.find((s) => s.id === "services");
    if (services) services.pattern = "services-wide";
    const files = new Map(ctx.files);
    for (const [p, v] of siteFiles(site, siteFacts(ctx).name, ctx.design, ctx.files, new Map(), library))
      v === null ? files.delete(p) : files.set(p, v);
    const fx = fixtureRoute(
      critiqueLines(firstPrompt(ctx), [
        critique(2, [
          {
            sign: "форма заявки ниже услуг уводит действие вниз",
            where: "/@390#form",
            severity: "P1",
            evidence: "изображение 4, форма внизу",
            replace: "форма сразу после первого экрана",
            edit: { op: "reorder", route: "/", order: ["hero", "form", "services"] },
          },
        ]),
        critique(3, [], "production"),
      ]),
    );
    const started = Date.now();
    const r = await runCritic({ ...ctx, files, site, route: fx.route } as typeof ctx, {
      inspect: criticInspector({ browser }),
      patterns: library,
      registry,
    });
    const ms = Date.now() - started;
    expect(r.status).toBe("done");
    expect(r.fixes).toEqual([
      expect.stringMatching(/^\/#services: вариант services-wide → services-\S+ \(L11\)$/),
    ]);
    expect(r.before.penalty).toBeGreaterThan(0);
    expect(r.after.penalty).toBe(0);
    expect(r.stop).toBe("pass");
    expect(r.cycles.map((c) => `${c.n}:${c.tier}:${c.model}`)).toEqual(["1:T0:kimi-k2.6", "2:T0:kimi-k2.6"]);
    expect(r.cycles[0]?.applied).toEqual(["/: порядок секций hero → form → services"]);
    expect(r.rolledBack).toEqual([]);
    expect(r.spentRub).toBeLessThanOrEqual(40);
    // Real screenshots went to the model: two images per call (CRITIC_MAX_IMAGES).
    for (const c of fx.calls) {
      const user = c.messages.find((m) => m.role === "user");
      expect(user && "attachments" in user ? user.attachments?.length : 0).toBe(2);
    }
    // The result builds and the site model has the changes.
    const out = new Map(files);
    for (const [p, v] of r.files) v === null ? out.delete(p) : out.set(p, v);
    expect(readSite(out)?.pages[0]?.sections.map((s) => s.id)).toEqual([
      "header",
      "hero",
      "form",
      "services",
      "footer",
    ]);
    expect(out.has("ui/patterns/services-wide.tsx")).toBe(false);
    const built = await buildSystem({ spec: ctx.spec, files: out, env: "prod" });
    expect(built.ok, JSON.stringify(built.errors)).toBe(true);
    // The stage stays within its time (D77 (10): the critic's ETA is 2 min).
    expect(ms).toBeLessThan(240_000);
  }, 300_000);

  test("platformCritic is a stage hook: files layer and notes", async () => {
    const fx = fixtureRoute(critiqueLines(firstPrompt(ctx), [critique(3, [], "production")]));
    const out = await platformCritic(browser, { registry, verify: null })({ ...ctx, route: fx.route });
    expect(out.status).toBe("done");
    expect(out.files?.size ?? 0).toBe(0);
    expect(out.notes?.[0]).toMatch(
      /^Посмотрел сайт на телефоне, планшете и компьютере глазами дизайнера: 1 круг, оценка 75 из 100\.$/,
    );
    expect(out.note).toContain("стоп pass");
  }, 120_000);
});
