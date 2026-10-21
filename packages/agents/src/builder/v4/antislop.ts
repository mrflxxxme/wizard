// Anti-slop of the editor (grill-11 (8), V5-03): the catalog's AI-phrase bans plus the clichés of site copy the editor
// also removes. Code checks the editor's answer; a phrase that survives goes back to it once, then the page keeps the
// copywriter's line and a note says so.
import { aiTextErrors, contentStrings } from "@wizard/ui-kit";

/** Clichés beyond the catalog's AI_PHRASES: empty greetings and claims no figure can back. */
const EXTRA: readonly { re: RegExp; why: string }[] = [
  { re: /добро пожаловать/iu, why: "пустое приветствие" },
  { re: /надёжн\p{L}* партн[её]р|лидер рынка|№\s?1 в/iu, why: "титул без доказательства" },
  { re: /мы рады предложить|рады видеть вас|будем рады помочь/iu, why: "вежливая вода" },
  { re: /современн\p{L}* (подход|технологи|решени)|комплексн\p{L}* (подход|решени)/iu, why: "канцелярит" },
  { re: /наша (миссия|цель) — |мы стремимся/iu, why: "миссия без дела" },
  { re: /!{2,}|\?!/u, why: "несколько знаков подряд" },
];

/** Reasons a string reads as slop (empty when clean). */
export const slopReasons = (s: string): string[] => [
  ...aiTextErrors(s),
  ...EXTRA.filter((p) => p.re.test(s)).map((p) => p.why),
];

/** Every slop hit in a value: `where` is the text found. */
export function slopIssues(v: unknown): { text: string; why: string }[] {
  return contentStrings(v).flatMap((text) => slopReasons(text).map((why) => ({ text, why })));
}

/** Human digest for a repair prompt. */
export const slopDigest = (hits: readonly { text: string; why: string }[]): string =>
  hits
    .slice(0, 12)
    .map((h) => `- «${h.text.slice(0, 90)}» — ${h.why}`)
    .join("\n");

/** Share of the page's sentences that carry a digit: the editor's «конкретика и цифры» measure. */
export function concreteShare(v: unknown): number {
  const parts = contentStrings(v).filter((s) => s.trim().length > 12);
  return parts.length ? parts.filter((s) => /\d/.test(s)).length / parts.length : 0;
}
