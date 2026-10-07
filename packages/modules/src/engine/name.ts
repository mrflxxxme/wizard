// Short name of a compiled system (B2-44): the site header, <title>, the cabinet and the e-mails show spec.app.name.
// It comes from the plan's niche, normalized deterministically — never the raw brief («…, нужен сайт где люди…»).

/** Longest site name (characters); a longer text is cut on a word boundary. */
export const MAX_SITE_NAME = 40;
/** Name when nothing usable is left. */
export const DEFAULT_SITE_NAME = "Новая система";

/** A wish at the start of a brief («нужен сайт…», «хочу…»): dropped. */
const LEAD =
  /^(?:(?:мне|нам)\s+)?(?:нужен|нужна|нужно|нужны|надо|хочу|хотим|сделайте|сделай|создайте|создай)\s+/iu;
/** Words that open a clause of wishes or details: the name ends before them. */
const STOP = new Set([
  "нужен",
  "нужна",
  "нужно",
  "нужны",
  "надо",
  "хочу",
  "хотим",
  "чтобы",
  "где",
  "который",
  "которая",
  "которое",
  "которые",
  "пожалуйста",
]);
/** Prepositions and conjunctions a name never ends with (a cut on a word boundary may leave them). */
const TAIL = new Set([
  "а",
  "без",
  "в",
  "во",
  "для",
  "до",
  "за",
  "и",
  "из",
  "или",
  "к",
  "на",
  "над",
  "но",
  "о",
  "об",
  "от",
  "по",
  "под",
  "при",
  "про",
  "с",
  "со",
  "у",
  "через",
]);

/**
 * A short name from a niche or a title: the first clause (up to . ! ? ; : , or a dash), without a leading wish and
 * without a trailing clause of wishes, at most `max` characters cut on a word boundary, no trailing punctuation, the
 * first letter upper-case. Empty when nothing is left.
 */
export function siteName(text: string, max = MAX_SITE_NAME): string {
  const clause =
    text
      .replace(/[«»"“”„]/gu, "")
      .replace(/\s+/gu, " ")
      .trim()
      .split(/[.!?;:,(\n]|\s[—–-]\s/u)[0] ?? "";
  const words = clause.trim().replace(LEAD, "").split(" ").filter(Boolean);
  const stop = words.findIndex((w, i) => i > 0 && STOP.has(w.toLowerCase()));
  const out: string[] = [];
  for (const w of stop > 0 ? words.slice(0, stop) : words) {
    if ([...out, w].join(" ").length > max) break;
    out.push(w);
  }
  if (out.length === 0 && words[0]) out.push(words[0].slice(0, max));
  while (out.length > 1 && TAIL.has((out.at(-1) as string).toLowerCase())) out.pop();
  const name = out
    .join(" ")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N})]+$/u, "");
  return name ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : "";
}

/** Name of a system built by a plan when its owner has not named it: the plan's niche, normalized (siteName). */
export function planSiteName(plan: { niche: string }): string {
  return siteName(plan.niche) || DEFAULT_SITE_NAME;
}
