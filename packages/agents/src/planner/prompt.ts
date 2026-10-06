// Prompts of the beta v2 goal interview and planner (modules.yaml#ai_rules, grill-6 decisions 2, 3, 5). Static part —
// one system message (cacheable prefix, the catalog included); dynamic part — the user message.
import type { SystemPlan } from "@wizard/appspec";
import type { LlmMessage } from "@wizard/llm";
import type { ModuleRegistry } from "@wizard/modules";
import { gapsPromptSection } from "../gaps.js";
import { textRulesSection } from "../text-rules.js";
import { goalsDigest, interviewCatalogDigest, plannerCatalogDigest, sectionsDigest } from "./catalog.js";
import type { GoalAnswer, GoalQuestion, GoalsAnalysis } from "./schemas.js";
import { MAX_GOAL_QUESTIONS } from "./schemas.js";

const ROLE =
  "Ты — интервьюер Born to Build: по описанию нетехнического владельца бизнеса выясняешь цели и собираешь систему из готовых проверенных модулей. Кратко, по-русски, без жаргона.";

const INTERVIEW_RULES = [
  "Цели — 1–3 из словаря целей; statement — формулировка клиента его словами (без имён, телефонов, адресов людей).",
  "Ниша — 2–5 слов («стоматологическая клиника»).",
  "Роли — кто кроме владельца работает в системе; ресурсы — что записывают, продают или учитывают (врачи, кабинеты, услуги, инструмент).",
  "modules — модули каталога, которые закрывают цели (и доступные, и «скоро»). Чего нет ни в одном модуле — в outOfScope.",
  `Минимум вопросов: спрашивай только то, что нельзя вывести из описания и без чего нельзя выбрать цели, роли или параметры выбранных модулей. Не больше ${MAX_GOAL_QUESTIONS}; всё ясно — questions пустой.`,
  "Вопрос — кнопки: 2–4 варианта, ровно один recommended (то, что подходит большинству в этой нише). topic=params — укажи module и param из каталога.",
  "Отвечай только вызовом инструмента submit_goals.",
];

const PLANNER_RULES = [
  "Ты составляешь план системы (SystemPlan) — данные по схеме, код не пишешь. Отвечай только вызовом submit_plan.",
  "goals — 1–3 цели из словаря с формулировкой клиента. Каждую цель плана закрывает хотя бы один модуль плана; modules[].goals — какие цели плана закрывает модуль.",
  "modules — только доступные модули каталога с параметрами по их схеме. Обязательные связи (требует …) добавляй сам.",
  "landing — только вместе с модулем landing: секции из библиотеки, только перечисленные варианты, порядок: header первой, footer последней; hero обязателен.",
  "Тексты секций — только из описания и ответов клиента. Цены, адреса, отзывы, цифры, которых нет в описании, не придумывай: секцию не ставь или пиши «Пример: …».",
  "outOfScope — всё, что клиент просил и чего нет в доступных модулях: request — его просьба, replacement — ближайшая замена из плана или честное «пока нет», category, module — модуль-замена.",
  "custom — только небольшая доработка (не больше 2 экранов, 3 функций и 20 ₽ на всё) с описанием, что сделать; большое — в outOfScope, не дроби его ради лимита.",
  "design можно не заполнять — его подберёт дизайн-агент.",
  "Не клади в план персональные данные: имена, телефоны, почты, адреса людей. Заглушки вида [ТЕЛЕФОН_1] не переносить.",
  "Если инструмент вернул ошибки — исправь именно их и вызови submit_plan снова с полным планом.",
];

/** Static system message of the goal interview (the catalog is part of the cacheable prefix). */
export function interviewSystem(registry: ModuleRegistry): string {
  return [
    ROLE,
    "## Словарь целей",
    goalsDigest(),
    "## Каталог модулей",
    interviewCatalogDigest(registry),
    "## Возможности и ограничения платформы",
    gapsPromptSection("interview"),
    "## Правила",
    INTERVIEW_RULES.map((r) => `- ${r}`).join("\n"),
    "## Тексты для клиента",
    textRulesSection("chat"),
  ].join("\n\n");
}

/** Static system message of the planner. */
export function plannerSystem(registry: ModuleRegistry): string {
  return [
    ROLE,
    "## Словарь целей",
    goalsDigest(),
    "## Каталог модулей",
    plannerCatalogDigest(registry),
    "## Библиотека секций лендинга",
    sectionsDigest(registry),
    "## Правила",
    PLANNER_RULES.map((r) => `- ${r}`).join("\n"),
  ].join("\n\n");
}

/** Answered questions as «Вопрос — ответ» lines (recommendations marked). */
export function answerLines(questions: readonly GoalQuestion[], answers: readonly GoalAnswer[]): string[] {
  return answers.flatMap((a) => {
    const q = questions.find((x) => x.id === a.questionId);
    if (!q) return [];
    const label = a.text ?? q.options.find((o) => o.id === a.optionId)?.label ?? a.optionId ?? "";
    const where = q.module && q.param ? ` [${q.module}.${q.param}]` : "";
    return [`${q.text}${where} — ${label}${a.byRecommendation ? " (по рекомендации)" : ""}`];
  });
}

export function interviewMessages(registry: ModuleRegistry, brief: string): LlmMessage[] {
  return [
    { role: "system", content: interviewSystem(registry) },
    {
      role: "user",
      content: `## Описание клиента\n${brief}\n\n## Задача\nВыясни цели и вызови submit_goals.`,
    },
  ];
}

export interface PlannerPromptInput {
  brief: string;
  analysis: GoalsAnalysis | null;
  answers: string[];
  /** Wishes of the client about the previous plan (newest last). */
  edits: string[];
  previousPlan?: SystemPlan | null;
}

export function plannerMessages(registry: ModuleRegistry, input: PlannerPromptInput): LlmMessage[] {
  const parts = [`## Описание клиента\n${input.brief}`];
  if (input.analysis) {
    const { questions: _q, ...known } = input.analysis;
    parts.push(`## Что известно из интервью\n${JSON.stringify(known)}`);
  }
  if (input.answers.length) parts.push(`## Ответы клиента\n${input.answers.join("\n")}`);
  if (input.previousPlan) parts.push(`## Предыдущий план\n${JSON.stringify(input.previousPlan)}`);
  if (input.edits.length) parts.push(`## Пожелания к плану\n${input.edits.map((e) => `- ${e}`).join("\n")}`);
  parts.push("## Задача\nСоставь план системы и вызови submit_plan.");
  return [
    { role: "system", content: plannerSystem(registry) },
    { role: "user", content: parts.join("\n\n") },
  ];
}
