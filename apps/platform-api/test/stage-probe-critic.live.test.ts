// V4-09 live stage probe (plan v4 §5.2): the critic v4 on the real models over real screenshots — the clinic's composed
// site opened in the process Chromium (390/1440), its page author set to Kimi K3 so the critic must be of another family.
// The same site is scored three times (one cycle each): the spread must stay ≤ 10 points; then one full run (≤ 2
// cycles) shows the edits. The screenshots and the answers go to tools/llm-probe/out/. Skipped unless
// WIZARD_STAGE_PROBE names «critic»: it runs only in GitHub Actions (stage-probe-a).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { type CriticReport, runCritic } from "@wizard/agents/builder";
import { createRegistry, createRouter, MemoryUsageSink, modelFamilyOf, type RouteInput } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import { criticContext } from "../../../packages/agents/test/v3-critic-fixtures.js";
import { chromiumProvider } from "../src/agents/goal-browser.js";
import { criticInspector } from "../src/builds-v3/critic.js";

const ON = (process.env.WIZARD_STAGE_PROBE ?? "").split(",").includes("critic");
const OUT = new URL("../../../tools/llm-probe/out/", import.meta.url);
const AUTHOR = "kimi-k3";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!ON || !hasChromium)("V4-09 live stage probe: the critic of another family", () => {
  test(
    "three scores of one site differ by ≤ 10; a full run of ≤ 2 cycles",
    async () => {
      const registry = createRegistry({ buildDefaultTier: "T1" });
      const browser = chromiumProvider({ slots: 1 });
      const base = await criticContext({ budgetRub: 40 });
      const site = { ...base.site, pages: base.site.pages.map((p) => ({ ...p, author: AUTHOR })) };
      const sink = new MemoryUsageSink();
      const router = createRouter({ mode: "live", registry, sink });
      const route = (i: RouteInput) =>
        router.route({ ...i, orgPolicy: { ruOnly: false, t1Restricted: false }, ctx: { orgId: "probe" } });
      const shots: { name: string; data: string }[] = [];
      const inner = criticInspector({ browser });
      const inspect: typeof inner = async (input) => {
        const r = await inner(input);
        for (const s of r.shots)
          shots.push({ name: `${s.route.replace(/\W+/g, "_")}${s.width}-${s.kind}`, data: s.data });
        return r;
      };
      const ctx = { ...base, site, route };
      const runs: { kind: string; report: CriticReport; seconds: number }[] = [];
      try {
        for (const kind of ["score-1", "score-2", "score-3", "full"]) {
          const t0 = Date.now();
          const report = await runCritic(ctx, {
            inspect,
            verify: null,
            registry,
            maxCycles: kind === "full" ? 2 : 1,
          });
          runs.push({ kind, report, seconds: Math.round((Date.now() - t0) / 1000) });
        }
      } finally {
        await browser.close();
      }
      mkdirSync(OUT, { recursive: true });
      for (const s of shots.slice(0, 2))
        writeFileSync(new URL(`stage-probe-critic-${s.name}.jpg`, OUT), Buffer.from(s.data, "base64"));
      const records = runs.map((r) => ({
        kind: r.kind,
        seconds: r.seconds,
        rub: r.report.spentRub,
        stop: r.report.stop,
        cycles: r.report.cycles.map((c) => ({
          score: c.score,
          model: c.model,
          axes: c.axes,
          polish: c.polish,
          applied: c.applied,
          rejected: c.rejected.map((x) => x.reason_ru),
          top: c.top,
        })),
      }));
      writeFileSync(
        new URL("stage-probe-critic.jsonl", OUT),
        `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
      );
      for (const r of records) console.log(`stage_probe_critic=${JSON.stringify(r)}`);
      const scores = runs.slice(0, 3).map((r) => r.report.cycles[0]?.score ?? Number.NaN);
      const models = runs.flatMap((r) => r.report.cycles.map((c) => c.model ?? "?"));
      const rows = records.map(
        (r) =>
          `| ${r.kind} | ${r.cycles.map((c) => c.score).join(" → ")} | ${r.stop} | ${r.seconds} | ${r.rub} | ${r.cycles.map((c) => c.model).join(", ")} | ${r.cycles
            .flatMap((c) => c.applied)
            .join("; ")
            .replace(/\|/g, "\\|")} |`,
      );
      const summary = `## Живая проба критика V4-09\n\nРазброс оценки трёх повторов: ${Math.max(...scores) - Math.min(...scores)} (оценки ${scores.join(", ")})\n\n| Прогон | Оценки | Стоп | с | ₽ | Модели | Правки |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      }
      expect(scores.every(Number.isFinite)).toBe(true);
      expect(Math.max(...scores) - Math.min(...scores)).toBeLessThanOrEqual(10);
      expect(runs.at(-1)?.report.cycles.length).toBeLessThanOrEqual(2);
      for (const m of models) expect(modelFamilyOf(registry, m)).not.toBe(modelFamilyOf(registry, AUTHOR));
    },
    40 * 60_000,
  );
});
