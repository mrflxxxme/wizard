// V4-06 quality live probe: the home page of the three V4 acceptance businesses (clinic, coffee house, beauty salon) is
// written by each model alone on the page routes, by sections and as one page (WIZARD_PROBE_MODES), opened in the
// process Chromium (390/1440) with the draft's demo rows (the catalog filled as the visitor sees it) and scored by the
// critic (critic_visual, another family, one cycle, no edits applied). Time, ₽ and the score per business, mode and
// model; the screenshots go to tools/llm-probe/out/. Skipped unless WIZARD_STAGE_PROBE names «quality» (GitHub
// Actions, stage-probe-a; models from WIZARD_PROBE_MODELS, businesses from WIZARD_PROBE_CASES).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { runCritic, seedHintsFromBrief, withSitePages } from "@wizard/agents/builder";
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

const ON = (process.env.WIZARD_STAGE_PROBE ?? "").split(",").includes("quality");
const OUT = new URL("../../../tools/llm-probe/out/", import.meta.url);
const OPEN = { ruOnly: false, t1Restricted: false };

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

const list = (v: string | undefined, d: string) => (v || d).split(",").filter(Boolean);

describe.skipIf(!ON || !hasChromium)(
  "V4-06: the quality of the home page by business, mode and model",
  () => {
    test(
      "home per business, mode and model: time, ₽ and the critic's score over real screenshots",
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
        const modes = list(process.env.WIZARD_PROBE_MODES, "sections,page");
        const wanted = new Set(list(process.env.WIZARD_PROBE_CASES, "clinic,coffee,salon"));
        const cases = qualityCases().filter((c) => wanted.has(c.id));
        const browser = chromiumProvider({ slots: 1 });
        const rows: Record<string, unknown>[] = [];
        mkdirSync(OUT, { recursive: true });
        try {
          for (const c of cases) {
            const base = c.ctx;
            // The draft's demo rows, as the critic of a build sees them (V3-40): the catalog is filled on home.
            const hints = seedHintsFromBrief(base.spec, base.brief);
            const inspect = criticInspector({
              browser,
              data: (spec) => draftDemoRows(spec, base.systemId, hints),
            });
            const skeleton = await createPageComposer({ patterns: PATTERNS }).skeleton(base);
            for (const mode of modes)
              for (const id of models) {
                const registry = only(id);
                const sink = new MemoryUsageSink();
                const router = createRouter({ mode: "live", registry, sink });
                const route = (i: RouteInput) =>
                  router.route({ ...i, orgPolicy: OPEN, ctx: { orgId: "probe" } });
                const ctx: V3BuildContext = {
                  ...base,
                  files: apply(base.files, skeleton),
                  route,
                  budgetRub: 150,
                };
                const t0 = Date.now();
                const r = await createPageComposer({
                  patterns: PATTERNS,
                  registry,
                  sections: mode === "sections",
                  firstScreen: false,
                }).scenario(ctx, c.scenario);
                const seconds = Math.round((Date.now() - t0) / 1000);
                const rub = Math.round(sink.records.reduce((s, x) => s + x.costRub, 0) * 100) / 100;
                const files = apply(ctx.files, r);
                const site = readSite(files) as SiteModel;
                const home = site.pages.find((p) => p.route === "/");
                const written = [...r.files.keys()].some((f) => f.startsWith("ui/sections/home-"));
                // The critic of another family over the screenshots; its edits are not kept.
                const criticSink = new MemoryUsageSink();
                const criticRouter = createRouter({ mode: "live", registry: reg0, sink: criticSink });
                const shots: { name: string; data: string }[] = [];
                const report = await runCritic(
                  {
                    ...ctx,
                    files,
                    spec: withSitePages(ctx.spec, site),
                    route: (i) => criticRouter.route({ ...i, orgPolicy: OPEN, ctx: { orgId: "probe" } }),
                    budgetRub: 40,
                  },
                  {
                    inspect: async (input) => {
                      const out = await inspect(input);
                      for (const s of out.shots) shots.push({ name: `${s.width}-${s.kind}`, data: s.data });
                      return out;
                    },
                    verify: null,
                    registry: reg0,
                    maxCycles: 1,
                  },
                );
                for (const s of shots.slice(0, 2))
                  writeFileSync(
                    new URL(`page-quality-${c.id}-${mode}-${id}-${s.name}.jpg`, OUT),
                    Buffer.from(s.data, "base64"),
                  );
                const cycle = report.cycles[0];
                const row = {
                  case: c.id,
                  mode,
                  model: id,
                  written,
                  seconds,
                  rub,
                  calls: sink.records.filter((x) => x.status === "ok").length,
                  sections:
                    home?.sections
                      .filter((x) => x.type !== "header" && x.type !== "footer")
                      .map((x) => x.id) ?? [],
                  score: cycle?.score ?? null,
                  axes: cycle?.axes ?? null,
                  polish: cycle?.polish ?? null,
                  critic: cycle?.model ?? null,
                  top: cycle?.top.slice(0, 4).map((t) => `${t.severity} ${t.sign}`) ?? [],
                  notes: r.notes,
                };
                rows.push(row);
                console.log(`page_quality=${JSON.stringify(row)}`);
              }
          }
        } finally {
          await browser.close();
        }
        writeFileSync(
          new URL("page-quality.jsonl", OUT),
          `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
        );
        const table = rows.map(
          (r) =>
            `| ${r.case} | ${r.mode} | ${r.model} | ${(r.sections as string[]).length} | ${r.written ? "✅" : "❌"} | ${r.seconds} | ${r.rub} | ${r.calls} | ${r.score ?? "—"} | ${r.polish ?? "—"} | ${(r.top as string[]).join("; ").replace(/\|/g, "\\|")} |`,
        );
        const summary = `## Качество главной: бизнес × режим × модель\n\n| Бизнес | Режим | Модель | Секций | Код | с | ₽ | Вызовы | Оценка критика | Отделка | Главные замечания |\n|---|---|---|---|---|---|---|---|---|---|---|\n${table.join("\n")}\n`;
        console.log(summary);
        if (process.env.GITHUB_STEP_SUMMARY) {
          const { appendFileSync } = await import("node:fs");
          appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
        }
        expect(rows).toHaveLength(cases.length * modes.length * models.length);
      },
      60 * 60_000,
    );
  },
);
