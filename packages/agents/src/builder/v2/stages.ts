// Stages of the builder v2 for people and the canvas (B2-25): plain Russian labels, expected seconds for «осталось»,
// budgets in ₽ (specs/agents/builder.yaml#v2.stages, #v2.budgets; D76 (9)).
import type { V2Budgets, V2Stage } from "./types.js";

/** Labels of event build_stage / step_started — what the client sees on the canvas. */
export const STAGE_LABELS: Readonly<Record<V2Stage, string>> = {
  plan: "Сверяю план",
  texts: "Пишу тексты",
  design: "Подбираю оформление",
  compile: "Собираю экраны и данные",
  custom: "Дописываю недостающее",
  gates: "Проверяю, что всё работает",
};

/** Expected seconds of a stage (models on recorded answers + the gates); the sum is the «осталось» of a fresh build. */
export const STAGE_ETA_SEC: Readonly<Record<V2Stage, number>> = {
  plan: 1,
  texts: 45,
  design: 20,
  compile: 5,
  custom: 0,
  gates: 90,
};

/** Default budgets (₽): texts and design are a few calls each; the whole build without custom code ≤ 15 ₽. */
export const DEFAULT_V2_BUDGETS: V2Budgets = { texts: 5, design: 3, custom: 20, total: 15 };

/** «Осталось» in seconds: the stages from `from` (inclusive) on that will run. */
export function remainingSec(stages: readonly V2Stage[], from: number, customOn: boolean): number {
  return stages.slice(from).reduce((s, st) => s + (st === "custom" && customOn ? 120 : STAGE_ETA_SEC[st]), 0);
}
