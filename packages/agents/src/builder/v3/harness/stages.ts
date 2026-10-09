// Stages of the harness v3 for people and the canvas: plain Russian labels, expected seconds for «осталось», the caps
// of a build and the budgets of its paid stages (product.yaml D77_v3 (10), (11); V3-13 «≤ 40 ₽» for the critic).
import type { V3Budgets, V3Limits, V3Stage } from "./types.js";

/** Labels of build_stage / step_started — what the client sees on the canvas. */
export const V3_STAGE_LABELS: Readonly<Record<V3Stage, string>> = {
  brief: "Перечитываю бриф",
  design: "Подбираю стиль",
  backend: "Собираю данные, права и автоматизации",
  skeleton: "Собираю каркас страниц",
  scenarios: "Довожу сценарии по одному",
  critic: "Смотрю на страницы глазами дизайнера",
  template_gate: "Проверяю, что сайт не похож на шаблон",
  techreview: "Провожу техревью",
  gates: "Проверяю, что всё работает",
};

/** Expected seconds of a stage (scenarios — per scenario); the sum is the «осталось» of a fresh build. */
export const V3_STAGE_ETA_SEC: Readonly<Record<V3Stage, number>> = {
  brief: 1,
  design: 20,
  backend: 3,
  skeleton: 60,
  scenarios: 90,
  critic: 120,
  template_gate: 30,
  techreview: 120,
  gates: 120,
};

/** Caps of D77: ≤ 300 ₽ target, 500 ₽ ceiling, 30 min ceiling, the skeleton preview ≤ 5 min after «Собрать». */
export const V3_BUILD_LIMITS: Readonly<V3Limits> = {
  capRub: 500,
  targetRub: 300,
  timeMs: 30 * 60_000,
  previewMs: 5 * 60_000,
};

/** Paid stages: the art director (one call), the critic (≤ 3 cycles), the techreview (≤ 2 rounds). */
export const DEFAULT_V3_BUDGETS: Readonly<V3Budgets> = {
  design: 10,
  critic: 40,
  techreview: 60,
  scenarioMin: 25,
};

const rubText = (x: number) => `${Math.round(x).toLocaleString("ru-RU")} ₽`;

/** The progress line of the spend: «потрачено 120 ₽ из 500 ₽». */
export function spendLine(spentRub: number, capRub: number): string {
  return `потрачено ${rubText(spentRub)} из ${rubText(capRub)}`;
}

/** Whole minutes for people: «30 мин». */
export const minutesText = (ms: number): string => `${Math.round(ms / 60_000)} мин`;

/** ₽ for people: «500 ₽». */
export const rubLabel = rubText;
