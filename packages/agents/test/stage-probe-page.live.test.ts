// V4-06 live stage probe (plan v4 §5.2): the page as free code on the real models — the clinic of the compose fixtures,
// its home page under the lead scenario and the services page under the prices scenario, checked by the page lint, the
// SDK gate and the real G0; the home page's first screen gets the rival of another family (no browser here: the judge
// is not called). Skipped unless WIZARD_STAGE_PROBE names «page»: it runs only in GitHub Actions.
import { mkdirSync, writeFileSync } from "node:fs";
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
import { createPageComposer, readSite } from "../src/builder/v3/compose/index.js";
import { verifySystem } from "../src/builder/v3/compose/scenario.js";
import type { V3BuildContext, V3ComposeResult } from "../src/builder/v3/contract.js";
import { BRIEF, composeContext } from "./v3-compose-fixtures.js";

const ON = (process.env.WIZARD_STAGE_PROBE ?? "").split(",").includes("page");
const OUT = new URL("../../../tools/llm-probe/out/", import.meta.url);

function apply(files: ReadonlyMap<string, string>, out: V3ComposeResult): Map<string, string> {
  const next = new Map(files);
  for (const [p, v] of out.files) {
    if (v === null) next.delete(p);
    else next.set(p, v);
  }
  return next;
}

describe.skipIf(!ON)("V4-06 live stage probe: the page as code", () => {
  test(
    "home (lead) and services (prices) written as code by the real models",
    async () => {
      const reg0 = createRegistry({ buildDefaultTier: "T1" });
      // V4-06 speed: WIZARD_PROBE_SECTIONS=1 — the page by sections; WIZARD_PROBE_MODELS — models put alone on the
      // page routes (page_compose, page_edit), one run each; empty — the routes as they are.
      const sections = process.env.WIZARD_PROBE_SECTIONS === "1";
      const models = (process.env.WIZARD_PROBE_MODELS ?? "").split(",").filter(Boolean);
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
      const base = composeContext();
      const skeleton = await createPageComposer({ patterns: PATTERNS }).skeleton(base);
      const records: Record<string, unknown>[] = [];
      const runs = (models.length ? models : [""]).flatMap((m) =>
        ([BRIEF.scenarios[0], BRIEF.scenarios[1]] as BriefScenario[]).map((sc) => ({
          model: m,
          scenario: sc,
        })),
      );
      for (const { model, scenario } of runs) {
        const registry = model ? only(model) : reg0;
        const sink = new MemoryUsageSink();
        const router = createRouter({ mode: "live", registry, sink });
        const repairs: string[] = [];
        const route = (i: RouteInput) => {
          // The repair rounds of callTool: why the answer was refused (the last user message of the call).
          const last = i.messages.at(-1);
          if (i.messages.length > 2 && last && last.role !== "system")
            repairs.push(
              `${i.tools?.[0]?.name}: ${(typeof last.content === "string" ? last.content : JSON.stringify(last.content)).slice(0, 700)}`,
            );
          return router.route({
            ...i,
            orgPolicy: { ruOnly: false, t1Restricted: false },
            ctx: { orgId: "probe" },
          });
        };
        const ctx: V3BuildContext = { ...base, files: apply(base.files, skeleton), route, budgetRub: 150 };
        const t0 = Date.now();
        const g0: string[] = [];
        // The real G0, its refusals kept: why a page needed a fix round.
        const verify: typeof verifySystem = async (spec, f, focus) => {
          const out = await verifySystem(spec, f, focus);
          if (!out.ok) g0.push(...out.problems.slice(0, 4));
          return out;
        };
        const r = await createPageComposer({
          patterns: PATTERNS,
          registry,
          verify,
          sections,
          firstScreen: false,
        }).scenario(ctx, scenario);
        const files = apply(ctx.files, r);
        const site = readSite(files);
        const changed = [...r.files.keys()].filter((f) => f.startsWith("ui/sections/"));
        records.push({
          scenario: scenario.id,
          model: model || "route",
          mode: sections ? "sections" : "page",
          ok: changed.length > 0,
          seconds: Math.round((Date.now() - t0) / 1000),
          rub: Math.round(sink.records.reduce((s, x) => s + x.costRub, 0) * 100) / 100,
          calls: sink.records
            .filter((x) => x.status === "ok")
            .map((x) => `${x.callType}:${x.modelId}`)
            .join(", "),
          errors: sink.records.filter((x) => x.status !== "ok").map((x) => `${x.modelId}:${x.errorCode}`),
          sections: site?.pages
            .flatMap((p) =>
              p.sections.map((s) => `${p.route}#${s.id}:${s.type === "signature" ? "code" : s.pattern}`),
            )
            .join(" "),
          notes: r.notes,
          g0,
          repairs,
          heroChars: files.get(changed.find((f) => f.endsWith("-hero.tsx")) ?? "")?.length ?? 0,
        });
        console.log(`stage_probe_page=${JSON.stringify(records.at(-1))}`);
        const hero = changed.find((f) => f.endsWith("-hero.tsx"));
        if (hero) console.log(`hero_source ${hero}\n${files.get(hero)}`);
      }
      mkdirSync(OUT, { recursive: true });
      writeFileSync(
        new URL("stage-probe-page.jsonl", OUT),
        `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
      );
      const rows = records.map(
        (r) =>
          `| ${r.model} | ${r.scenario} | ${r.ok ? "✅" : "❌"} | ${r.seconds} | ${r.rub} | ${r.calls} | ${(r.notes as string[]).join(" / ").replace(/\|/g, "\\|")} |`,
      );
      const summary = `## Живая проба страницы кодом V4-06\n\n| Модель | Сценарий | Итог | с | ₽ | Вызовы | Заметки |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      }
      expect(records).toHaveLength(runs.length);
    },
    40 * 60_000,
  );
});
