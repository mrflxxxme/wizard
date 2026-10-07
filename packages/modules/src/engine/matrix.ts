// Minimal plans for the CI parameter matrix (specs/modules/modules.yaml#manifest.tests): the module under test with the
// row's parameters, the row's withModules (with the expectParams of the tested module's requires) and, when the
// landing is among them, a hero plus the sections the plan's modules need. No texts beyond neutral examples.
import {
  type GoalId,
  type PlanPhoto,
  type PlanSection,
  type SystemPlan,
  THEME_FONTS,
  THEME_PRESETS,
} from "@wizard/appspec";
import type { ModuleRegistry } from "../types.js";

export interface MatrixRow {
  name: string;
  params: Record<string, unknown>;
  withModules?: readonly string[];
  /** Landing sections of the row instead of the minimal ones (B2-35 section library rows). */
  sections?: readonly Record<string, unknown>[];
  /** Theme preset of the row's plan. */
  theme?: string;
  /** Stock photos of the row's plan (B2-38 landing rows with photos). */
  photos?: readonly Record<string, unknown>[];
}

/** The plan a matrix row of `moduleId` is compiled with (deterministic). */
export function matrixPlan(registry: ModuleRegistry, moduleId: string, row: MatrixRow): SystemPlan {
  const byId = new Map(registry.modules.map((d) => [d.manifest.id, d.manifest]));
  const m = byId.get(moduleId);
  if (!m) throw new Error(`module ${moduleId} is not in the registry`);
  const ids = [moduleId, ...(row.withModules ?? []).filter((w) => w !== moduleId)];
  const expect = new Map<string, Record<string, unknown>>();
  for (const id of ids)
    for (const r of byId.get(id)?.requires ?? [])
      if (r.expectParams) expect.set(r.module, { ...(expect.get(r.module) ?? {}), ...r.expectParams });
  const modules = ids.map((id) => {
    const params = id === moduleId ? { ...row.params } : { ...(expect.get(id) ?? {}) };
    return Object.keys(params).length ? { id, params } : { id };
  });
  const minimal: PlanSection[] = [
    { type: "header", variant: "bar", content: {} },
    {
      type: "hero",
      variant: "centered",
      content: { title: "Пример: заголовок первого экрана", cta: "Оставить заявку" },
    },
  ];
  if (ids.includes("catalog"))
    minimal.push({ type: "services", variant: "cards", content: { title: "Пример: услуги и цены" } });
  if (ids.includes("leads"))
    minimal.push({ type: "lead_form", variant: "card", content: { title: "Оставьте заявку" } });
  minimal.push({ type: "footer", variant: "simple", content: {} });
  const sections = row.sections ? (row.sections as unknown as PlanSection[]) : minimal;
  const goal = m.goals[0] as GoalId;
  return {
    version: 1,
    niche: "пример ниши",
    goals: [{ id: goal, statement: `Проверка модуля «${m.name}»` }],
    modules,
    ...(ids.includes("landing") ? { landing: { sections } } : {}),
    design: {
      direction: { mood: ["спокойствие"] },
      theme: row.theme ?? THEME_PRESETS[0],
      accent: "#2A7F9E",
      fontPair: { heading: THEME_FONTS[0], body: THEME_FONTS[0] },
      photoStyle: "светлые фото",
      ...(row.photos ? { photos: [...row.photos] as unknown as PlanPhoto[] } : {}),
    },
    outOfScope: [],
    custom: [],
  };
}
