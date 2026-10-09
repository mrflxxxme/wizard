// Texts of the three first screens (V3-09): the client's words from the brief. One model call writes three sets
// (headline, subheadline, button) in the voices of the three directions; without a model, on a refusal, an error, a
// timeout or a short budget — deterministic texts from the brief's goals and the system name. No invented facts
// (D49): numbers must come from the brief, superlatives, reviews and guarantees are refused.
import type { SystemBrief } from "@wizard/appspec";
import type { LlmMessage } from "@wizard/llm";
import { scrub } from "@wizard/pii";
import {
  type ArchetypeId,
  archetype as archetypeById,
  type DesignVoice,
  goalTags,
} from "@wizard/ui-kit/v3/design";
import { z } from "zod";
import type { ToolIssue } from "../../../core/tool.js";
import { VOICE_LABELS } from "../../v2/direction.js";

/** First-screen texts of a direction. */
export interface DirectionTexts {
  title: string;
  lead?: string;
  /** Label of the main button. */
  action: string;
}

/** What the texts may say: the facts of the brief (scrubbed of personal data before any model sees them). */
export interface DirectionFacts {
  name: string;
  niche: string;
  goals: string[];
  audience: string;
  /** Visitor and client scenarios «Когда …, система …» (must first). */
  scenarios: string[];
  outOfScope: string[];
}

export const TEXT_LIMITS = { title: 90, lead: 220, action: 32 } as const;

const clean = (s: string) => scrub(s).text.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** Facts of a brief for the first screens: the system name, the niche, goals, audience, visitor scenarios. */
export function briefFacts(brief: SystemBrief, name: string, niche: string): DirectionFacts {
  const visitor = brief.scenarios
    .filter((s) => s.actor === "visitor" || s.actor === "client")
    .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "must" ? -1 : 1))
    .slice(0, 6);
  return {
    name: clip(clean(name), 60),
    niche: clip(clean(niche), 160),
    goals: brief.goals.slice(0, 5).map((g) => clip(clean(g.text), 200)),
    audience: clip(clean(brief.audience), 400),
    scenarios: visitor.map((s) => clip(clean(`Когда ${s.when}, система ${s.then.join(", ")}`), 240)),
    outOfScope: brief.outOfScope.slice(0, 5).map((o) => clip(clean(o.text), 120)),
  };
}

/** Everything the texts may draw facts from, as one lower-case string. */
export const factsText = (f: DirectionFacts): string =>
  [f.name, f.niche, ...f.goals, f.audience, ...f.scenarios].join(" \n").toLowerCase().replace(/ё/g, "е");

const ACTIONS: Readonly<Record<string, readonly [string, string, string]>> = {
  booking: ["Записаться", "Выбрать время", "Записаться онлайн"],
  sales: ["Перейти в каталог", "Выбрать", "Смотреть каталог"],
  events: ["Записаться", "Зарегистрироваться", "Узнать подробности"],
  content: ["Читать", "Смотреть материалы", "Подписаться"],
  operations: ["Войти", "Открыть кабинет", "Войти в систему"],
  leads: ["Оставить заявку", "Связаться с нами", "Написать нам"],
};
const ACTION_ORDER = ["booking", "sales", "events", "leads", "content", "operations"] as const;

/** «Получать записи на приём с сайта» → «Запись на приём с сайта»: the owner's goal said to the visitor. */
export function visitorOffer(goal: string): string | null {
  const g = goal.trim().replace(/\.$/, "");
  const rules: [RegExp, (m: RegExpExecArray) => string][] = [
    [
      /^(?:получать|принимать|собирать|увеличить число|привлекать|больше)\s+(?:онлайн-)?запис[а-яё]*\s+(.+)$/i,
      (m) => `Запись ${m[1]}`,
    ],
    [/^(?:получать|принимать|собирать|привлекать|больше)\s+заявк[а-яё]*\s+(.+)$/i, (m) => `Заявка ${m[1]}`],
    [/^(?:получать|принимать|собирать|больше)\s+заказ[а-яё]*\s+(.+)$/i, (m) => `Заказ ${m[1]}`],
    [/^(?:продавать|продажа|продажи)\s+(.+)$/i, (m) => cap(m[1] as string)],
    [/^(?:показывать|рассказывать о|рассказать о)\s+(.+)$/i, (m) => cap(m[1] as string)],
  ];
  for (const [re, f] of rules) {
    const m = re.exec(g);
    if (m) return f(m);
  }
  return null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Texts by code: the system name (with the niche when the name does not say it), the first goal said to the visitor,
 * a button by the main goal; the three directions differ by the button label only. Facts come from the brief only.
 */
export function fallbackTexts(f: DirectionFacts, index: number): DirectionTexts {
  const tags = goalTags(f.niche, f.goals);
  const tag = ACTION_ORDER.find((t) => tags.includes(t)) ?? "leads";
  const action = (ACTIONS[tag] ?? ACTIONS.leads)?.[index % 3] ?? "Оставить заявку";
  const name = f.name || cap(f.niche) || "Ваш бизнес";
  const niche =
    f.niche
      .split(/[.!?\n]/)[0]
      ?.trim()
      .toLowerCase() ?? "";
  const withNiche = niche && !name.toLowerCase().includes(niche) ? `${name} — ${niche}` : name;
  const title = clip(withNiche.length <= TEXT_LIMITS.title ? withNiche : name, TEXT_LIMITS.title);
  const offer = f.goals.map(visitorOffer).find((x): x is string => !!x);
  const lead = offer
    ? clip(`${offer}.`, TEXT_LIMITS.lead)
    : f.goals[0]
      ? clip(`${cap(f.goals[0])}.`, TEXT_LIMITS.lead)
      : undefined;
  return { title, ...(lead && lead !== `${title}.` ? { lead } : {}), action };
}

/** Words a first screen must not say without a fact behind them (D49, catalog D1). */
const BANNED =
  /(?<![а-яa-z])(?:лучш[а-я]*|№\s?1|номер один|сам(?:ый|ая|ое|ые|ых) (?:лучш|выгодн|надежн|дешев|быстр|вкусн|крупн)[а-я]*|лидер[а-я]*|гарантир[а-я]*|гарант[ия][а-я]*|топ-?\d*|отзыв[а-я]*|уникальн[а-я]*|первый в)/i;
const COLOUR_OR_CSS = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(|var\(--|[{};]/i;
const PLACEHOLDER = /\[[A-ZА-ЯЁ_]+_\d+\]/;

/** Issues of a text against the facts of the brief: numbers not in the brief, superlatives, CSS, placeholders. */
export function inventedFacts(text: string, facts: string, path: string): ToolIssue[] {
  const issues: ToolIssue[] = [];
  const source = facts.replace(/\s+/g, "");
  for (const m of text.matchAll(/\d[\d\s.,]*\d|\d/g)) {
    const n = m[0].replace(/[\s.,]+/g, "");
    if (!source.includes(n))
      issues.push({
        path,
        code: "NO_FACTS",
        message: `Число «${m[0].trim()}» не из брифа: не добавляйте цифр, цен и сроков, которых нет в брифе.`,
      });
  }
  const banned = BANNED.exec(text);
  if (banned)
    issues.push({
      path,
      code: "NO_CLAIMS",
      message: `«${banned[0]}» — утверждение без факта в брифе: без превосходных степеней, отзывов и гарантий.`,
    });
  if (COLOUR_OR_CSS.test(text))
    issues.push({ path, code: "NO_CSS", message: "Только текст: без цветов и CSS." });
  if (PLACEHOLDER.test(text))
    issues.push({
      path,
      code: "PLACEHOLDER",
      message: "Не вставляйте заглушки вида [ТЕЛЕФОН_1]: пишите без них.",
    });
  if (!/[а-яё]/i.test(text)) issues.push({ path, code: "RUSSIAN", message: "Текст — по-русски." });
  return issues;
}

/** The tool of the texts call: three sets, one per direction. */
export const DIRECTION_TEXTS_TOOL = "submit_direction_texts";

const line = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(/^[^\n]*$/);

export function directionTextsSchema(ids: readonly ArchetypeId[]) {
  return z.strictObject({
    sets: z
      .array(
        z.strictObject({
          direction: z.enum(ids as [ArchetypeId, ...ArchetypeId[]]),
          title: line(8, TEXT_LIMITS.title),
          lead: line(20, TEXT_LIMITS.lead),
          action: line(2, TEXT_LIMITS.action),
        }),
      )
      .length(ids.length),
  });
}
export type DirectionTextsAnswer = z.output<ReturnType<typeof directionTextsSchema>>;

/** Semantic checks of the answer: each direction once, facts only from the brief. */
export function directionTextsIssues(v: DirectionTextsAnswer, facts: DirectionFacts): ToolIssue[] {
  const issues: ToolIssue[] = [];
  const seen = new Set<string>();
  const source = factsText(facts);
  v.sets.forEach((s, i) => {
    if (seen.has(s.direction))
      issues.push({
        path: `sets.${i}.direction`,
        code: "DUPLICATE",
        message: "Каждое направление — ровно один раз.",
      });
    seen.add(s.direction);
    for (const field of ["title", "lead", "action"] as const)
      issues.push(...inventedFacts(s[field], source, `sets.${i}.${field}`));
    if (s.action.split(/\s+/).length > 4)
      issues.push({ path: `sets.${i}.action`, code: "ACTION_LONG", message: "Кнопка — 1–3 слова." });
  });
  return issues;
}

const ROLE =
  "Ты — редактор сайтов Born to Build. Пишешь первый экран сайта клиента — заголовок, подзаголовок и надпись на главной кнопке — для трёх направлений оформления, каждое своим голосом.";

const RULES = [
  "Только факты из брифа ниже. Не добавляй цифр, цен, сроков, адресов, наград, отзывов, гарантий и слов «лучший», «№ 1», «уникальный» — их нет в брифе.",
  "Заголовок — до 90 знаков: что получает клиент, словами бизнеса. Без названия направления оформления.",
  "Подзаголовок — 1–2 предложения, 20–220 знаков: для кого и как это работает.",
  "Кнопка — 1–3 слова, действие по главной цели (записаться, оставить заявку, выбрать…).",
  "Три набора говорят об одном бизнесе, но тоном своего направления (голос указан).",
  "Обращение на «вы», без восклицательных знаков и без заглушек вида [ТЕЛЕФОН_1].",
  `Отвечай только вызовом ${DIRECTION_TEXTS_TOOL}. Если инструмент вернул ошибки — исправь именно их и вызови снова.`,
];

/** Messages of the texts call: the facts of the brief and the three directions with their voices. */
export function directionTextsMessages(
  facts: DirectionFacts,
  directions: readonly { archetype: ArchetypeId; voice: DesignVoice }[],
): LlmMessage[] {
  const list = directions.map((d) => {
    const a = archetypeById(d.archetype);
    return `- ${d.archetype} — «${a?.name ?? d.archetype}», голос: ${d.voice} — ${VOICE_LABELS[d.voice]}. ${a?.why ?? ""}`;
  });
  const business = [
    `Название: ${facts.name || "не указано"}`,
    `Ниша: ${facts.niche || "не указана"}`,
    `Цели: ${facts.goals.join("; ") || "не указаны"}`,
    facts.audience ? `Аудитория: ${facts.audience}` : "",
    facts.scenarios.length
      ? `Что делают посетители:\n${facts.scenarios.map((s) => `- ${s}`).join("\n")}`
      : "",
    facts.outOfScope.length ? `Не входит (не обещать): ${facts.outOfScope.join("; ")}` : "",
  ].filter(Boolean);
  return [
    { role: "system", content: [ROLE, "## Правила", RULES.map((r) => `- ${r}`).join("\n")].join("\n\n") },
    {
      role: "user",
      content: [
        `## Бизнес\n${business.join("\n")}`,
        `## Направления\n${list.join("\n")}`,
        `## Задача\nНапиши три набора текстов первого экрана и вызови ${DIRECTION_TEXTS_TOOL}.`,
      ].join("\n\n"),
    },
  ];
}
