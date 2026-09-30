// System slug (runtime.yaml#routing.system_slug) and schema_key (db.yaml#systems).
import { randomBytes } from "node:crypto";

export const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "www",
  "mail",
  "smtp",
  "mx",
  "mta-sts",
  "autodiscover",
  "autoconfig",
  "api",
  "admin",
  "status",
  "static",
  "cdn",
  "abuse",
  "security",
  "wizard",
]);

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

export function nameFromPrompt(prompt: string): string {
  const first =
    prompt
      .trim()
      .split(/[.!?\n]/)[0]
      ?.trim() ?? "";
  const name = (first || prompt.trim()).slice(0, 60).trim();
  return name || "Новая система";
}
