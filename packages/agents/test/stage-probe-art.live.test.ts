// V4-07 live stage probe (plan v4 §5.2): the art director on the real models — three reference briefs, five directions
// each, checked by code with repairs, the three most different kept. Skipped unless WIZARD_STAGE_PROBE names «art»: it
// runs only in GitHub Actions (.github/workflows/stage-probe-a.yml). Prints one record per brief (directions, fonts,
// colours, repairs, ₽, seconds, diversity; never keys) and writes tools/llm-probe/out/stage-probe-art.jsonl.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRegistry, createRouter, MemoryUsageSink, type RouteInput } from "@wizard/llm";
import { designDiversity } from "@wizard/ui-kit/v3/design";
import { describe, expect, test } from "vitest";
import { type ArtDirectorInput, proposeDesignDirections } from "../src/builder/index.js";

const ON = (process.env.WIZARD_STAGE_PROBE ?? "").split(",").includes("art");
const OUT = new URL("../../../tools/llm-probe/out/", import.meta.url);

const BRIEFS: ArtDirectorInput[] = [
  {
    niche: "Пекарня «Колос» в Твери: хлеб на закваске, торты на заказ, доставка по городу",
    goals: ["Заказ торта с сайта", "Меню и цены на виду"],
    audience: "Семьи района, заказывают к праздникам",
    seed: "probe-1",
    brandColor: "#B5541B",
  },
  {
    niche: "Стоматология «Белая линия» в Казани: лечение, имплантация, детский приём",
    goals: ["Онлайн-запись к врачу", "Доверие: врачи и цены"],
    audience: "Взрослые и родители с детьми",
    seed: "probe-2",
  },
  {
    niche: "Автосервис «Гараж 42» в Екатеринбурге: ремонт подвески, шиномонтаж, диагностика",
    goals: ["Заявка на ремонт с сайта"],
    audience: "Владельцы машин 5–15 лет",
    seed: "probe-3",
  },
];

describe.skipIf(!ON)("V4-07 live stage probe: art director", () => {
  test(
    "five directions per brief, checked by code, three most different kept",
    async () => {
      const records: Record<string, unknown>[] = [];
      for (const input of BRIEFS) {
        const sink = new MemoryUsageSink();
        const router = createRouter({
          mode: "live",
          registry: createRegistry({ buildDefaultTier: "T1" }),
          sink,
        });
        const route = (i: RouteInput) =>
          router.route({ ...i, orgPolicy: { ruOnly: false, t1Restricted: false }, ctx: { orgId: "probe" } });
        const t0 = Date.now();
        const r = await proposeDesignDirections({ input, route });
        const rub = sink.records.reduce((s, x) => s + x.costRub, 0);
        const models = [...new Set(sink.records.filter((x) => x.status === "ok").map((x) => x.modelId))];
        records.push({
          niche: input.niche.slice(0, 40),
          ok: !!r.directions,
          note: r.note ?? null,
          calls: r.stats?.calls ?? 0,
          models,
          seconds: Math.round((Date.now() - t0) / 1000),
          rub: Math.round(rub * 100) / 100,
          minDistance: r.directions ? designDiversity(r.directions.map((d) => d.design)).minDistance : null,
          directions: (r.directions ?? []).map((d) => ({
            name: d.proposal.name,
            p: d.probability,
            base: d.proposal.base,
            scheme: d.proposal.scheme,
            colors: d.proposal.colors,
            fonts: `${d.proposal.fonts.display} + ${d.proposal.fonts.text}`,
            layout: d.proposal.layout,
          })),
        });
        console.log(`stage_probe_art=${JSON.stringify(records.at(-1))}`);
      }
      mkdirSync(OUT, { recursive: true });
      writeFileSync(
        new URL("stage-probe-art.jsonl", OUT),
        `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
      );
      const rows = records.map(
        (r) =>
          `| ${r.niche} | ${r.ok ? "✅" : `❌ ${r.note}`} | ${r.calls} | ${(r.models as string[]).join(", ")} | ${r.seconds} | ${r.rub} | ${r.minDistance ?? "—"} | ${(r.directions as { name: string; fonts: string }[]).map((d) => `${d.name} (${d.fonts})`).join("; ")} |`,
      );
      const summary = `## Живая проба арт-директора V4-07\n\n| Бриф | Итог | Вызовы | Модели | с | ₽ | Мин. расстояние | Направления |\n|---|---|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      }
      expect(records).toHaveLength(BRIEFS.length);
    },
    30 * 60_000,
  );
});
