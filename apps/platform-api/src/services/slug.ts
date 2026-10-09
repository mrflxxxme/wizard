// System slug (runtime.yaml#routing.system_slug) and schema_key (db.yaml#systems).
import { randomBytes } from "node:crypto";
import { businessName } from "@wizard/agents/builder";
import { siteName } from "@wizard/agents/planner";
import { RESERVED_SYSTEM_SLUGS } from "@wizard/runtime";

export const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
/** Shared with runtime routing (L3-29): one list for generated slugs and hosts the runtime refuses. */
export const RESERVED_SLUGS: ReadonlySet<string> = RESERVED_SYSTEM_SLUGS;

const TR: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

export function randomKey(n: number): string {
  const b = randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += ALNUM[(b[i] as number) % ALNUM.length];
  return s;
}

export function slugBase(prompt: string): string {
  const latin = [...prompt.toLowerCase()].map((ch) => TR[ch] ?? ch).join("");
  const words = latin
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 2)
    .slice(0, 3);
  let base = words.join("-").slice(0, 20).replace(/-+$/, "");
  if (!/^[a-z]/.test(base)) base = `app${base ? `-${base}` : ""}`.slice(0, 20).replace(/-+$/, "");
  return base.length >= 2 ? base : "app";
}

export function makeSlug(prompt: string): string {
  const slug = `${slugBase(prompt)}-${randomKey(5)}`;
  return SLUG_RE.test(slug) && !slug.includes("--") && !RESERVED_SLUGS.has(slug)
    ? slug
    : `app-${randomKey(8)}`;
}

const DEFAULT_NAME = "Новая система";

/** The name createSystem gave before V3-18: the first sentence of the brief cut at 60 characters. */
function legacyName(prompt: string): string {
  const first =
    prompt
      .trim()
      .split(/[.!?\n]/)[0]
      ?.trim() ?? "";
  return (first || prompt.trim()).slice(0, 60).trim() || DEFAULT_NAME;
}

/**
 * Name of a new system from its first message (V3-18): the business name the owner quotes («Линия»), else what the
 * business is in his words («Клининговая компания»); else a short name of his first clause cut on a word boundary
 * (siteName) — never a sentence cut in the middle of a word.
 */
export function nameFromPrompt(prompt: string): string {
  return businessName(prompt) ?? (siteName(prompt) || DEFAULT_NAME);
}

/**
 * B2-44: the system still has a name createSystem derived from its brief that is not a name of the business — the
 * short first clause (or, for systems made before V3-18, its first sentence cut at 60 characters); the owner has not
 * named it, and the plan's short name replaces it. A business name taken from his words («Линия») counts as his.
 * Without the brief the name counts as the owner's.
 */
export function isAutoName(name: string, brief: string | null | undefined): boolean {
  if (typeof brief !== "string") return false;
  if (name === legacyName(brief)) return true;
  return businessName(brief) === null && name === nameFromPrompt(brief);
}
