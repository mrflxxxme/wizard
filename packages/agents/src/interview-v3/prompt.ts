// Prompts of the v3 grill interview (C7 interview_v3). Static part — one system message (the cacheable prefix with the
// tree, the rules, the catalog and the platform limits); dynamic part — the user message: the owner's description,
// the brief so far, the blocking gaps found by code, the questions asked, the build queue and what happened now.
import type { SystemBrief } from "@wizard/appspec";
import type { LlmMessage } from "@wizard/llm";
import type { ModuleRegistry } from "@wizard/modules";
import { gapsPromptSection } from "../gaps.js";
import { goalsDigest, interviewCatalogDigest } from "../planner/catalog.js";
import { textRulesSection } from "../text-rules.js";
import type { BlockingGap } from "./gaps.js";
import {
  INTERVIEW_RESEARCH_LIMITS,
  type InterviewV3Session,
  MAX_V3_QUESTIONS,
  V3_TOPIC_LABELS,
  V3_TOPICS,
} from "./schemas.js";

const ROLE =
  "Ты — интервьюер Born to Build. По описанию нетехнического владельца бизнеса (или черновику брифа из его ТЗ) ты по одному вопросу выясняешь то, без чего нельзя собрать систему, и сразу записываешь ответы в бриф. Кратко, по-русски, простым языком.";

const RULES = [
  `Дерево вопросов: ${V3_TOPICS.map((t) => `${V3_TOPIC_LABELS[t]} (${t})`).join(" → ")}. Не перескакивай через тему с открытым блокирующим пробелом и не возвращайся к пройденной теме без причины.`,
  "Один вопрос за ход — submit_question. У вопроса 3–5 вариантов-кнопок, ровно один recommended: то, что лучше подходит этому бизнесу. recommendation — почему советуешь этот вариант (1–2 предложения), whyItMatters — что ответ меняет в системе.",
  "Не спрашивай того, что уже есть в описании, ответах или брифе.",
  `Факты о нише (типичные услуги, как устроена работа, требования закона) ищи сам через web_search и read_page, владельца о них не спрашивай. Лимит на интервью — ${INTERVIEW_RESEARCH_LIMITS.searches} поиска и ${INTERVIEW_RESEARCH_LIMITS.pages} страницы. Найденное запиши в facts с адресом источника; это справка для рекомендаций, а не факт для сайта.`,
  "Спрашивай только блокирующее: без ответа систему не собрать, или ответ сильно её меняет. Неблокирующее (тексты, мелкие настройки, контент) — defer_question с допущением: спросим во время сборки.",
  "Каждый ответ владельца сразу записывай в бриф через submit_brief_update: цели с признаком успеха, сценарии «Когда …, система …» (priority must — без них система не нужна), роли с доступами, данные с полями и сроком хранения, интеграции, «не входит». Требования, которых нет в сценариях (оплата, доставка, обмен с 1С), — в requirements. Свои решения за владельца — в assumptions.",
  "Когда блокирующих пробелов нет (код проверяет: цели, хотя бы один обязательный сценарий, роли, данные для разделов с данными) и важного больше не осталось, вызови finish_interview. Обычно хватает 5–10 вопросов.",
  `Лимит — ${MAX_V3_QUESTIONS} вопросов на интервью.`,
  "Не выдумывай цифры, цены, сроки, отзывы. Предположение называй предположением. В бриф не пиши персональные данные: имена, телефоны, почты, адреса людей; заглушки вида [ТЕЛЕФОН_1] не переносить.",
  "Если инструмент вернул ошибку — исправь именно её и вызови снова.",
];

/** Static system message of the v3 interview. */
export function interviewV3System(registry: ModuleRegistry): string {
  return [
    ROLE,
    "## Правила",
    RULES.map((r) => `- ${r}`).join("\n"),
    "## Словарь целей (ориентир для целей брифа)",
    goalsDigest(),
    "## Каталог модулей (moduleHint сценария — id модуля)",
    interviewCatalogDigest(registry),
    "## Чего платформа пока не умеет",
    gapsPromptSection("interview"),
    "## Тексты для владельца",
    textRulesSection("chat"),
  ].join("\n\n");
}

/** What happened in this turn (the dynamic tail of the user message). */
export type V3TurnInput =
  | { kind: "start" }
  | {
      kind: "answer";
      question: string;
      answer: string;
      chosen: "recommended" | "option" | "custom" | "delegated";
    }
  | { kind: "skip" }
  | { kind: "cap" }
  | { kind: "wish"; text: string };

const CHOSEN: Record<string, string> = {
  recommended: "рекомендованный вариант",
  option: "один из вариантов",
  custom: "свой ответ",
  delegated: "«Решите за меня» — взят рекомендованный вариант",
};

/** The brief for the prompt: everything but the journal (sent as lines) and the capability map (code's). */
function briefJson(b: SystemBrief): string {
  const { qa: _qa, capability: _cap, ...rest } = b;
  return JSON.stringify(rest);
}

function task(input: V3TurnInput): string {
  switch (input.kind) {
    case "start":
      return "Начало интервью. Запиши в бриф всё, что уже ясно из описания (submit_brief_update), при необходимости найди факты о нише и задай первый блокирующий вопрос — или вызови finish_interview, если пробелов нет.";
    case "answer":
      return `Владелец ответил на вопрос «${input.question}»: «${input.answer}» (${CHOSEN[input.chosen]}). Запиши ответ в бриф и задай следующий блокирующий вопрос или вызови finish_interview.`;
    case "skip":
      return "Владелец нажал «Дальше решай сам»: остальное реши сам, вопросов больше не задавай. Заполни пробелы брифа рекомендуемыми решениями через submit_brief_update и каждое такое решение добавь в assumptions. Неблокирующее — defer_question. Потом finish_interview.";
    case "cap":
      return `Задано ${MAX_V3_QUESTIONS} вопросов — это предел. Вопросов больше не задавай: заполни оставшиеся пробелы рекомендуемыми решениями через submit_brief_update (каждое — в assumptions) и вызови finish_interview.`;
    case "wish":
      return `Бриф был готов, владелец пишет: «${input.text}». Внеси правку в бриф (submit_brief_update). Если правка открыла блокирующий пробел — задай вопрос, иначе вызови finish_interview.`;
  }
}

/** Messages of one interview turn. */
export function interviewV3Messages(
  registry: ModuleRegistry,
  s: InterviewV3Session,
  input: V3TurnInput,
  gaps: readonly BlockingGap[],
): LlmMessage[] {
  const parts = [
    "## Описание владельца",
    s.prompt ?? "",
    "## Бриф сейчас",
    briefJson(s.brief),
    "## Блокирующие пробелы (проверка кодом)",
    gaps.length
      ? gaps.map((g) => `- ${V3_TOPIC_LABELS[g.topic]} (${g.topic}): ${g.reasonRu}`).join("\n")
      : "нет",
    `## Вопросы и ответы (задано ${s.asked} из ${MAX_V3_QUESTIONS})`,
    s.brief.qa.length ? s.brief.qa.map((x) => `- ${x.q} — ${x.a}`).join("\n") : "пока нет",
  ];
  if (s.requirements.length)
    parts.push("## Другие требования", s.requirements.map((r) => `- ${r.text}`).join("\n"));
  if (s.deferred.length)
    parts.push(
      "## Очередь сборки (спросим во время сборки)",
      s.deferred.map((d) => `- ${d.text} — пока: ${d.assumption}`).join("\n"),
    );
  if (s.facts.length)
    parts.push("## Что известно о нише (из поиска)", s.facts.map((f) => `- ${f.text} (${f.url})`).join("\n"));
  parts.push("## Сейчас", task(input));
  return [
    { role: "system", content: interviewV3System(registry) },
    { role: "user", content: parts.join("\n\n") },
  ];
}
