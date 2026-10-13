// V4-06 speed live probe: which model writes the page by sections — not by speed alone. The clinic's home page under
// the lead scenario is written by sections with each model put alone on the page routes, opened in the process
// Chromium (390/1440) and scored by the critic (critic_visual, another family, one cycle, no edits applied). Time, ₽
// and the score per model; the screenshots of every home page go to tools/llm-probe/out/. Skipped unless
// WIZARD_STAGE_PROBE names «quality» (GitHub Actions, stage-probe-a; models from WIZARD_PROBE_MODELS).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { runCritic, withSitePages } from "@wizard/agents/builder";
import type { BriefScenario } from "@wizard/appspec";
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
import { BRIEF, composeContext } from "../../../packages/agents/test/v3-compose-fixtures.js";
import { chromiumProvider } from "../src/agents/goal-browser.js";
import { criticInspector } from "../src/builds-v3/critic.js";

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

describe.skipIf(!ON || !hasChromium)("V4-06 speed: the quality of the page by model", () => {
  test(
    "home by sections per model: time, ₽ and the critic's score over real screenshots",
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
      const models = (process.env.WIZARD_PROBE_MODELS || "glm-5.3,kimi-k3").split(",").filter(Boolean);
      const browser = chromiumProvider({ slots: 1 });
      const inspect = criticInspector({ browser });
      const base = composeContext();
      const skeleton = await createPageComposer({ patterns: PATTERNS }).skeleton(base);
      const rows: Record<string, unknown>[] = [];
      mkdirSync(OUT, { recursive: true });
      try {
        for (const id of models) {
          const registry = only(id);
          const sink = new MemoryUsageSink();
          const router = createRouter({ mode: "live", registry, sink });
          const route = (i: RouteInput) => router.route({ ...i, orgPolicy: OPEN, ctx: { orgId: "probe" } });
          const ctx: V3BuildContext = { ...base, files: apply(base.files, skeleton), route, budgetRub: 150 };
          const t0 = Date.now();
          const r = await createPageComposer({
            patterns: PATTERNS,
            registry,
            sections: true,
            firstScreen: false,
          }).scenario(ctx, BRIEF.scenarios[0] as BriefScenario);
          const seconds = Math.round((Date.now() - t0) / 1000);
          const rub = Math.round(sink.records.reduce((s, x) => s + x.costRub, 0) * 100) / 100;
          const files = apply(ctx.files, r);
          const site = readSite(files) as SiteModel;
          const written = [...r.files.keys()].some((f) => f.startsWith("ui/sections/home-"));
          // The critic of another family (glm-5v-turbo heads critic_visual) over the screenshots; its edits are not kept.
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
            writeFileSync(new URL(`page-quality-${id}-${s.name}.jpg`, OUT), Buffer.from(s.data, "base64"));
          const cycle = report.cycles[0];
          const row = {
            model: id,
            written,
            seconds,
            rub,
            calls: sink.records.filter((x) => x.status === "ok").length,
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
      } finally {
        await browser.close();
      }
      writeFileSync(new URL("page-quality.jsonl", OUT), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
      const table = rows.map(
        (r) =>
          `| ${r.model} | ${r.written ? "✅" : "❌"} | ${r.seconds} | ${r.rub} | ${r.calls} | ${r.score ?? "—"} | ${r.polish ?? "—"} | ${(r.top as string[]).join("; ").replace(/\|/g, "\\|")} |`,
      );
      const summary = `## Качество главной по моделям (по секциям)\n\n| Модель | Код | с | ₽ | Вызовы | Оценка критика | Отделка | Главные замечания |\n|---|---|---|---|---|---|---|---|\n${table.join("\n")}\n`;
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      }
      expect(rows).toHaveLength(models.length);
    },
    60 * 60_000,
  );
});
