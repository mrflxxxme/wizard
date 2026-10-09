// Non-blocking questions of the build v3 (D77 (8): «неблокирующие вопросы — во время сборки»): the build asks and goes
// on with the recommended option; the owner answers in the brief — an entry of its «вопрос → ответ» journal (qa[]) with
// the question's text — or through the host, and the harness applies the answer in a later step (it re-reads the brief
// before each stage and each scenario). Plain code.
import type { SystemBrief } from "@wizard/appspec";
import type { V3BuildQuestion, V3QuestionAnswer } from "./types.js";

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'.,!?:;()\s]+/g, " ")
    .trim();

/**
 * Answers the brief's journal gives to the build questions: an entry whose question is the build question's text and
 * whose answer names one of its options (label or id). «Решите за меня» (delegated) is no answer — the default stays.
 */
export function briefAnswers(brief: SystemBrief, questions: readonly V3BuildQuestion[]): V3QuestionAnswer[] {
  const out: V3QuestionAnswer[] = [];
  for (const q of questions) {
    const entry = [...brief.qa].reverse().find((e) => norm(e.q) === norm(q.text) && e.chosen !== "delegated");
    if (!entry) continue;
    const a = norm(entry.a);
    const opt = q.options.find((o) => norm(o.label) === a || norm(o.id) === a);
    if (opt) out.push({ questionId: q.id, optionId: opt.id });
  }
  return out;
}

/** The latest answer per question: the host's answers win over the brief's (they are newer by construction). */
export function mergeAnswers(...lists: readonly (readonly V3QuestionAnswer[])[]): V3QuestionAnswer[] {
  const m = new Map<string, string>();
  for (const list of lists) for (const a of list) m.set(a.questionId, a.optionId);
  return [...m].map(([questionId, optionId]) => ({ questionId, optionId }));
}

/** Label of an option (the recommended one when the id is unknown). */
export function optionLabel(q: V3BuildQuestion, optionId: string): string {
  return (
    q.options.find((o) => o.id === optionId)?.label ??
    q.options.find((o) => o.id === q.recommended)?.label ??
    optionId
  );
}

/** The chat line of a question asked during the build: the build does not wait. */
export function questionText(q: V3BuildQuestion): string {
  const others = q.options
    .filter((o) => o.id !== q.recommended)
    .map((o) => `«${o.label}»`)
    .join(", ");
  return [
    `Вопрос по ходу сборки: ${q.text}`,
    `Пока собираю с вариантом «${optionLabel(q, q.recommended)}» — он рекомендованный${q.why ? `: ${q.why.charAt(0).toLowerCase()}${q.why.slice(1)}` : ""}.`,
    others ? `Другие варианты: ${others}.` : "",
    "Ответ можно дать в панели «Бриф», раздел «Вопросы и ответы», — сборка не ждёт и учтёт его на следующем шаге.",
  ]
    .filter(Boolean)
    .join(" ");
}
