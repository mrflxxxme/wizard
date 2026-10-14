// V4-06 inner pages live probe: the critic shoots only the home page, but the owner opens «Услуги» and «Запись» too.
// For the three V4 acceptance businesses (clinic, coffee house, beauty salon) the scenarios of the inner pages (the
// catalog /services, the booking /booking) are written by sections (the default since #194) on the skeleton, the pages
// opened in the process Chromium with the draft's demo rows (390/1440, whole page) and run through the in-page checks
// of the critic (no model judges them). Time, ₽, the sections and the problems per page; the screenshots go to
// tools/llm-probe/out/. Skipped unless WIZARD_STAGE_PROBE names «quality-inner» (GitHub Actions, stage-probe-a; models
// from WIZARD_PROBE_MODELS, businesses from WIZARD_PROBE_CASES).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { CRITIC_VIEWPORTS, seedHintsFromBrief, withSitePages } from "@wizard/agents/builder";
import {
  createRegistry,
  createRouter,
  getModel,
  MemoryUsageSink,
  type Registry,
  type RouteInput,
} from "@wizard/llm";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import {
  createPageComposer,
  readSite,
  type SiteModel,
} from "../../../packages/agents/src/builder/v3/compose/index.js";
import type { V3BuildContext, V3ComposeResult } from "../../../packages/agents/src/builder/v3/contract.js";
import { qualityCases } from "../../../packages/agents/test/v4-quality-fixtures.js";
import { chromiumProvider } from "../src/agents/goal-browser.js";
import { criticInspector, draftDemoRows } from "../src/builds-v3/critic.js";

const ON = (process.env.WIZARD_STAGE_PROBE ?? "").split(",").includes("quality-inner");
const OUT = new URL("../../../tools/llm-probe/out/", import.meta.url);
const OPEN = { ruOnly: false, t1Restricted: false };
const list = (v: string | undefined, d: string) => (v || d).split(",").filter(Boolean);

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

function apply(files: ReadonlyMap<string, string>, out: V3ComposeResult): Map<string, string> {
  const next = new Map(files);
  for (const [p, v] of out.files) v === null ? next.delete(p) : next.set(p, v);
  return next;
}

describe.skipIf(!ON || !hasChromium)("V4-06: the inner pages (/services, /booking) by sections", () => {
  test(
    "per business and model: time, ₽, sections and the in-page problems of each inner page, with screenshots",
    async () => {
      const reg0 = createRegistry({ buildDefaultTier: "T1" });
      const only = (id: string): Registry => {
        const m = getModel(reg0, id);
        const r = (ct: "page_compose" | "page_edit") => ({
          ...reg0.routes[ct],
          defaultTier: m.tier,
          chain: { [m.tier]: [id] },
        });
        return {
          ...reg0,
          routes: { ...reg0.routes, page_compose: r("page_compose"), page_edit: r("page_edit") },
        };
      };
      const models = list(process.env.WIZARD_PROBE_MODELS, "glm-5.3");
      const wanted = new Set(list(process.env.WIZARD_PROBE_CASES, "clinic,coffee,salon"));
      const cases = qualityCases().filter((c) => wanted.has(c.id));
      const browser = chromiumProvider({ slots: 1 });
      const rows: Record<string, unknown>[] = [];
      mkdirSync(OUT, { recursive: true });
      try {
        for (const c of cases) {
          const base = c.ctx;
          const hints = seedHintsFromBrief(base.spec, base.brief);
          const inspect = criticInspector({
            browser,
            data: (spec) => draftDemoRows(spec, base.systemId, hints),
          });
          const skeleton = await createPageComposer({ patterns: PATTERNS }).skeleton(base);
          const fonts = [...new Set([base.design.fonts.display.family, base.design.fonts.text.family])];
          for (const id of models) {
            const registry = only(id);
            let files = apply(base.files, skeleton);
            for (const { route, scenario } of c.inner) {
              const sink = new MemoryUsageSink();
              const router = createRouter({ mode: "live", registry, sink });
              // The tool's refusals the model was sent back (the last ones say why a page stayed as it was).
              const refusals: string[] = [];
              const routeFn = (i: RouteInput) => {
                const last = i.messages.at(-1);
                const text =
                  typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
                // Refusals of the tool and the page checks / G0 the sections or the page are sent back with.
                if (
                  (last?.role === "tool" && text.includes("INVALID_ARGS")) ||
                  (last?.role === "user" && /не прошл[аи]? проверк/.test(text))
                )
                  refusals.push(text.slice(-700));
                return router.route({ ...i, orgPolicy: OPEN, ctx: { orgId: "probe" } });
              };
              const ctx: V3BuildContext = { ...base, files, route: routeFn, budgetRub: 150 };
              const t0 = Date.now();
              const r = await createPageComposer({
                patterns: PATTERNS,
                registry,
                firstScreen: false,
              }).scenario(ctx, scenario);
              const seconds = Math.round((Date.now() - t0) / 1000);
              files = apply(ctx.files, r);
              const site = readSite(files) as SiteModel;
              const page = site.pages.find((p) => p.route === route);
              const out = await inspect({
                spec: withSitePages(base.spec, site),
                files,
                routes: [route],
                viewports: CRITIC_VIEWPORTS,
                shots: [
                  { route, width: 390, kind: "page", maxWidth: 390, maxHeight: 2400 },
                  { route, width: 1440, kind: "page", maxWidth: 360, maxHeight: 2400 },
                ],
                fonts,
              });
              const slug = route.replace(/\W+/g, "") || "home";
              for (const s of out.shots)
                writeFileSync(
                  new URL(`inner-${c.id}-${slug}-${id}-${s.width}.jpg`, OUT),
                  Buffer.from(s.data, "base64"),
                );
              const row = {
                case: c.id,
                route,
                model: id,
                written: [...r.files.keys()].some((f) => f.includes(`/${slug}-`)),
                seconds,
                rub: Math.round(sink.records.reduce((s, x) => s + x.costRub, 0) * 100) / 100,
                sections:
                  page?.sections.filter((x) => x.type !== "header" && x.type !== "footer").map((x) => x.id) ??
                  [],
                ok: out.ok,
                problems: out.problems
                  .slice(0, 8)
                  .map((p) => `${p.code} ${p.width}${p.section ? `#${p.section}` : ""} ${p.message_ru}`),
                notes: r.notes,
                refusals: refusals.slice(-3),
              };
              rows.push(row);
              console.log(`inner_page=${JSON.stringify(row)}`);
            }
          }
        }
      } finally {
        await browser.close();
      }
      writeFileSync(new URL("inner-pages.jsonl", OUT), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
      const table = rows.map(
        (r) =>
          `| ${r.case} | ${r.route} | ${r.model} | ${r.seconds} | ${r.rub} | ${(r.sections as string[]).join(", ")} | ${(r.problems as string[]).length} |`,
      );
      const summary = `## Внутренние страницы по секциям\n\n| Бизнес | Страница | Модель | с | ₽ | Секции | Проблем |\n|---|---|---|---|---|---|---|\n${table.join("\n")}\n`;
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      }
      expect(rows.length).toBeGreaterThan(0);
    },
    60 * 60_000,
  );
});
