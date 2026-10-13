// V4-17 live measure (acceptance 4): the first screens as a stream on the real models — three reference briefs, the
// directions in parallel (the ideas call, then one call per direction), each preview built by the platform's own
// PreviewBuilds as soon as its direction is ready. Records per brief: seconds to the first screen (goal ≤ 45), to all
// three (≤ 90), ₽, calls, which directions came from the model. Skipped unless WIZARD_STAGE_PROBE names «stream»: it
// runs only in GitHub Actions (.github/workflows/directions-stream-probe.yml). WIZARD_PROBE_MODEL — models.yaml ids
// put at the head of the art_direction route, comma-separated (empty — the registry's route). Never prints keys.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import {
  ART_DIRECTION_CALL_TYPE,
  DIRECTIONS_BUDGET_RUB,
  directionsNiche,
  proposeDirections,
  RubWallet,
  type StoredDirection,
} from "@wizard/agents/builder";
import { type SystemBriefInput, systemBriefSchema } from "@wizard/appspec";
import { createRegistry, createRouter, MemoryUsageSink, type Registry, type RouteInput } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import { dentalBrief, shopBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import { PreviewBuilds } from "../src/directions/previews.js";

const ON = (process.env.WIZARD_STAGE_PROBE ?? "").split(",").includes("stream");
const MODELS = (process.env.WIZARD_PROBE_MODEL ?? "").split(",").map((m) => m.trim());
const OUT = new URL("../../../tools/llm-probe/out/", import.meta.url);

const bakery: SystemBriefInput = {
  goals: [
    { id: "g1", text: "Заказ торта на праздник с сайта", success: "20 заказов в месяц" },
    { id: "g2", text: "Меню и цены на виду", success: "меньше звонков с вопросом о ценах" },
  ],
  audience: "Семьи района, заказывают к праздникам",
};
const BRIEFS = [
  {
    label: "стоматология",
    name: "Стоматология «Улыбка»",
    request: "Сайт стоматологии с онлайн-записью",
    brief: dentalBrief(),
  },
  {
    label: "магазин",
    name: "Лавка «Чайный двор»",
    request: "Интернет-магазин чая с доставкой",
    brief: shopBrief(),
  },
  {
    label: "пекарня",
    name: "Пекарня «Колос»",
    request: "Пекарня в Твери: торты на заказ, доставка",
    brief: bakery,
  },
];

/** The registry with `model` at the head of the art_direction route (as the stage probe forces a model). */
function forced(reg: Registry, model: string): Registry {
  const def = reg.models.find((m) => m.id === model);
  if (!def) throw new Error(`модели ${model} нет в реестре`);
  const r = reg.routes[ART_DIRECTION_CALL_TYPE as keyof Registry["routes"]];
  return {
    ...reg,
    buildDefaultTier: def.tier === "T1" ? "T1" : reg.buildDefaultTier,
    models: reg.models.map((m) => (m.id === model ? { ...m, enabled: true } : m)),
    providers: { ...reg.providers, [def.provider]: { ...reg.providers[def.provider], enabled: true } },
    routes: r
      ? {
          ...reg.routes,
          [ART_DIRECTION_CALL_TYPE]: { ...r, defaultTier: def.tier, chain: { [def.tier]: [model] } },
        }
      : reg.routes,
  } as Registry;
}

const sec = (ms: number) => Math.round(ms / 100) / 10;

describe.skipIf(!ON)("V4-17 live measure: first screens as a stream", () => {
  test(
    "seconds to the first screen and to all three, ₽, on three briefs",
    async () => {
      const records: Record<string, unknown>[] = [];
      for (const model of MODELS)
        for (const b of BRIEFS) {
          const base = createRegistry({ buildDefaultTier: "T1" });
          const sink = new MemoryUsageSink();
          const router = createRouter({ mode: "live", registry: model ? forced(base, model) : base, sink });
          const route = (i: RouteInput) =>
            router.route({
              ...i,
              orgPolicy: { ruOnly: false, t1Restricted: false },
              ctx: { orgId: "probe" },
            });
          const previews = new PreviewBuilds();
          const key = "f".repeat(64);
          const ready: { n: number; s: number; source: string }[] = [];
          const builds: Promise<unknown>[] = [];
          const wallet = new RubWallet(DIRECTIONS_BUDGET_RUB);
          const t0 = Date.now();
          const p = await proposeDirections(
            {
              brief: systemBriefSchema.parse({ ...b.brief, design: { references: [] } }),
              name: b.name,
              niche: directionsNiche(b.name, b.request),
              seed: `probe-${b.label}`,
            },
            { route, wallet },
            {
              onDirection: (d: StoredDirection, pb) => {
                builds.push(
                  previews
                    .build(`${key.slice(0, 63)}${d.n}`, pb, d)
                    .then(() => ready.push({ n: d.n, s: sec(Date.now() - t0), source: d.textsSource })),
                );
              },
            },
          );
          await Promise.all(builds);
          const models = [...new Set(sink.records.filter((x) => x.status === "ok").map((x) => x.modelId))];
          records.push({
            brief: b.label,
            model: model || "по маршруту",
            firstS: Math.min(...ready.map((r) => r.s)),
            allS: Math.max(...ready.map((r) => r.s)),
            rub: p.costRub,
            calls: p.calls,
            fromModel: p.directions.filter((d) => d.textsSource === "model").length,
            models,
            names: p.directions.map((d) => d.name),
            notes: p.notes,
          });
          console.log(`stream_probe=${JSON.stringify(records.at(-1))}`);
        }
      mkdirSync(OUT, { recursive: true });
      writeFileSync(
        new URL("directions-stream.jsonl", OUT),
        `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
      );
      const rows = records.map(
        (r) =>
          `| ${r.brief} | ${r.model} | ${r.firstS} | ${r.allS} | ${r.rub} | ${r.calls} | ${r.fromModel}/3 | ${(r.models as string[]).join(", ")} | ${(r.names as string[]).join("; ")} |`,
      );
      const summary = `## Живой замер V4-17: первые экраны потоком\n\nЦель: первый экран ≤ 45 с, все три ≤ 90 с.\n\n| Бриф | Модель | Первый, с | Все, с | ₽ | Вызовы | От модели | Модели | Направления |\n|---|---|---|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      expect(records).toHaveLength(BRIEFS.length * MODELS.length);
    },
    60 * 60_000,
  );
});
