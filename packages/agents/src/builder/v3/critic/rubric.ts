// Rubric of the visual critic (V3-13; docs/research/design-agent-catalog.md C): the axes 0–4 with their questions,
// a finding {sign, where, replace, severity, evidence} (a finding without a replacement or an observable sign is not
// accepted), the pass decision, the score that tells whether a cycle helped, and the codes of the deterministic checks
// (catalog B, column «код») the model is told about so that it does not repeat them.
import { z } from "zod";
import { editOpSchema } from "./ops.js";

/** Axes of one direction (axis 7 «различимость» compares directions — a build has one; axis 8 is `polish`). */
export const CRITIC_AXES = [
  "specificity",
  "first_screen",
  "typography",
  "color",
  "composition",
  "content",
] as const;
export type CriticAxis = (typeof CRITIC_AXES)[number];

/** Russian name and the questions of each axis (catalog C). */
export const AXIS_RUBRIC: Readonly<Record<CriticAxis, { label: string; questions: string }>> = {
  specificity: {
    label: "Конкретность",
    questions:
      "Сработает ли страница так же с логотипом конкурента? Угадывается ли эстетика по нише? Какие элементы взаимозаменяемы?",
  },
  first_screen: {
    label: "Первый экран, тест 5 секунд на 390",
    questions: "Понятно ли, что это, для кого и что сделать? Видна ли кнопка действия? Есть ли доминанта?",
  },
  typography: {
    label: "Типографика",
    questions:
      "Контраст пары реальный, а не два похожих гротеска? Иерархия видна при прищуре? Нет висячих предлогов и уродливых переносов?",
  },
  color: {
    label: "Цвет",
    questions:
      "Стратегия цвета исполнена? Акцент дисциплинирован (сигнал только у действия и выделения)? Нет ИИ-палитры и кремового фона по умолчанию?",
  },
  composition: {
    label: "Композиция и ритм",
    questions:
      "При прищуре видны главное, второе и группы? Плотность по классу системы? Нет шаблонных подпорок: eyebrow-подписи, нумерация 01/02/03, три одинаковые карточки?",
  },
  content: {
    label: "Содержание и доверие",
    questions:
      "Видны обязательные для ниши факты? Нет выдуманных доказательств, отзывов и цифр? Текст без признаков ИИ-письма?",
  },
};

export const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Score points a finding takes off (the score is 0–100 from the axes). */
const SEVERITY_PENALTY: Readonly<Record<Severity, number>> = { P0: 12, P1: 6, P2: 2, P3: 0 };

/** Widths of the screenshots (D77 (6)): phone, tablet, desktop. */
export const CRITIC_WIDTHS = [390, 768, 1440] as const;
export type CriticWidth = (typeof CRITIC_WIDTHS)[number];

/** `<route>@<width>#<section id>` — the catalog's `<directionId>@<ширина>#<blockId>` with the page route. */
export const WHERE_RE = /^(\/[^\s@#]*)@(390|768|1440)#([A-Za-z0-9_-]{1,60})$/;

/** Splits `where` (null when malformed). */
export function parseWhere(where: string): { route: string; width: CriticWidth; section: string } | null {
  const m = WHERE_RE.exec(where.trim());
  return m ? { route: m[1] as string, width: Number(m[2]) as CriticWidth, section: m[3] as string } : null;
}

const axisScore = z.number().int().min(0).max(4);

/** A finding: the observed sign, where, how bad, the evidence, the replacement and the edit that applies it. */
export const findingSchema = z.object({
  sign: z.string().trim().min(3).max(200),
  where: z.string().trim().regex(WHERE_RE),
  severity: z.enum(SEVERITIES),
  evidence: z.string().trim().min(3).max(300),
  replace: z.string().trim().min(3).max(300),
  /** The closed operation that applies the replacement; null — only a person can apply it (a note). */
  edit: editOpSchema.nullable().optional(),
});
export type Finding = z.output<typeof findingSchema>;

/** submit_critique: axis scores, the polish verdict and the findings. */
export const critiqueSchema = z.object({
  axes: z.object({
    specificity: axisScore,
    first_screen: axisScore,
    typography: axisScore,
    color: axisScore,
    composition: axisScore,
    content: axisScore,
  }),
  /** Axis 8 «проработка». */
  polish: z.enum(["production", "draft"]),
  /** What is missing, in words (draft). */
  missing: z.string().trim().max(400).optional(),
  findings: z.array(findingSchema).max(12),
});
export type Critique = z.output<typeof critiqueSchema>;

/** 0–100: the mean axis score scaled, minus the findings by severity (a cycle helped when it grew). */
export function critiqueScore(c: Critique): number {
  const mean = CRITIC_AXES.reduce((s, a) => s + c.axes[a], 0) / CRITIC_AXES.length;
  const penalty = c.findings.reduce((s, f) => s + SEVERITY_PENALTY[f.severity], 0);
  return Math.max(0, Math.round(mean * 25) - penalty);
}

/** Catalog C «решение»: pass — no P0/P1, every axis ≥ 3, polish production. */
export function critiquePasses(c: Critique): boolean {
  return (
    !c.findings.some((f) => f.severity === "P0" || f.severity === "P1") &&
    CRITIC_AXES.every((a) => c.axes[a] >= 3) &&
    c.polish === "production"
  );
}

// ------------------------------------------------------------------------------------------- deterministic checks

/** Codes of the checks run in the browser without a model (catalog B ids; CLS and RENDER are ours). */
export const CHECK_CODES = [
  "RENDER",
  "L11",
  "C08",
  "T16",
  "CLS",
  "A01",
  "A06",
  "A08",
  "I03",
  "L13",
  "M05",
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

/** What each check catches (Russian, for the prompt and the notes) and how bad it is. */
export const CHECK_RUBRIC: Readonly<Record<CheckCode, { label: string; severity: Severity }>> = {
  RENDER: { label: "страница не отрисовалась или упала с ошибкой", severity: "P0" },
  L11: { label: "переполнение: страница шире экрана или элемент за краем", severity: "P1" },
  C08: { label: "низкий контраст текста (включая текст на фото и тёмную тему)", severity: "P1" },
  T16: { label: "шрифт дизайн-системы не загрузился — запасной шрифт", severity: "P2" },
  CLS: { label: "сдвиг вёрстки при загрузке (CLS > 0,1)", severity: "P2" },
  A01: { label: "тап-цель меньше 44×44 на телефоне и планшете", severity: "P2" },
  A06: { label: "заголовки: не один h1 или пропуск уровня", severity: "P2" },
  A08: { label: "доступность: кнопка или ссылка без имени, картинка без alt", severity: "P1" },
  I03: { label: "картинка не загрузилась", severity: "P1" },
  L13: { label: "кнопка первого экрана ниже сгиба на 390×844", severity: "P2" },
  M05: { label: "текст скрыт в покое (opacity 0 после загрузки)", severity: "P1" },
};

/** One problem of a deterministic check on one page at one viewport. */
export interface DeterministicProblem {
  code: CheckCode;
  route: string;
  width: number;
  scheme: "light" | "dark";
  /** Section id of the page (anchor of a body section, «header», «footer»); null — the page as a whole. */
  section: string | null;
  message_ru: string;
}

const PROBLEM_PENALTY: Readonly<Record<Severity, number>> = { P0: 8, P1: 4, P2: 2, P3: 1 };

/** Key of a problem across widths and schemes: one sign of one section counts once. */
export const problemKey = (p: Pick<DeterministicProblem, "code" | "route" | "section">) =>
  `${p.code}|${p.route}|${p.section ?? ""}`;

/** Weight of the problems (each key once, by its severity): an edit must not raise it. */
export function problemPenalty(problems: readonly DeterministicProblem[]): number {
  const keys = new Map<string, CheckCode>();
  for (const p of problems) keys.set(problemKey(p), p.code);
  let sum = 0;
  for (const code of keys.values()) sum += PROBLEM_PENALTY[CHECK_RUBRIC[code].severity];
  return sum;
}

/** Problems deduplicated by key, the widths and schemes they were seen at joined (for the prompt and the notes). */
export function problemDigest(problems: readonly DeterministicProblem[]): {
  key: string;
  code: CheckCode;
  route: string;
  section: string | null;
  where: string;
  message_ru: string;
}[] {
  const by = new Map<string, { p: DeterministicProblem; at: Set<string> }>();
  for (const p of problems) {
    const k = problemKey(p);
    const hit = by.get(k) ?? { p, at: new Set<string>() };
    hit.at.add(p.scheme === "dark" ? `${p.width} тёмная` : String(p.width));
    by.set(k, hit);
  }
  return [...by.entries()].map(([key, { p, at }]) => ({
    key,
    code: p.code,
    route: p.route,
    section: p.section,
    where: `${p.route}${p.section ? `#${p.section}` : ""} (${[...at].join(", ")})`,
    message_ru: p.message_ru,
  }));
}
