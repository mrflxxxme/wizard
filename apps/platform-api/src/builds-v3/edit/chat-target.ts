// V4-24: a chat edit of a built v3 site without a chosen element, but with a clear goal («сделай первый экран короче»,
// «поменяй кнопку», «подвал светлее», «блок с ценами крупнее»): the section is found by the words and the request goes
// to «Укажи и измени» (point_edit) of that section — not to the brief and a rebuild, which would replace the owner's
// manual edits of the draft. No clear goal (none, or two of them) — null: the message goes to the interview as before.
import { readSite } from "@wizard/agents/builder";
import { kitElements } from "@wizard/build";

type SitePage = NonNullable<ReturnType<typeof readSite>>["pages"][number];
type SiteSection = SitePage["sections"][number];

/** A part of the page the owner names in words. */
export type ChatGoal =
  | "hero"
  | "header"
  | "footer"
  | "catalog"
  | "contacts"
  | "form"
  | "team"
  | "testimonials"
  | "faq"
  | "about"
  | "gallery";

/** The words of each part (stems, Russian) and the section types and ids that show it. */
const GOALS: readonly { goal: ChatGoal; words: RegExp; keys: readonly string[] }[] = [
  {
    goal: "hero",
    words: /перв\S*\s+экран|главн\S*\s+экран|заголов|баннер|кнопк|обложк/i,
    keys: ["hero"],
  },
  { goal: "header", words: /шапк|меню сайта|навигац/i, keys: ["header"] },
  { goal: "footer", words: /подвал|футер|низ сайта|низ страницы/i, keys: ["footer"] },
  {
    goal: "catalog",
    words: /цен|прайс|услуг|каталог|меню кафе|меню кофейн/i,
    keys: ["catalog", "pricing", "services", "prices", "menu"],
  },
  { goal: "contacts", words: /контакт|адрес|как (?:нас )?найти|как добраться/i, keys: ["contacts"] },
  { goal: "form", words: /форм|заявк/i, keys: ["form", "lead"] },
  {
    goal: "team",
    words: /врач|специалист|команд|мастер(?!ск)|сотрудник|тренер/i,
    keys: ["team", "doctors", "staff", "specialists"],
  },
  { goal: "testimonials", words: /отзыв/i, keys: ["testimonials", "reviews"] },
  { goal: "faq", words: /вопрос|faq/i, keys: ["faq"] },
  { goal: "about", words: /о нас|о клиник|о компани|о салон|о кофейн/i, keys: ["about"] },
  { goal: "gallery", words: /галере|фотограф/i, keys: ["gallery"] },
];

/** A request to change something (not a question, not a new feature). */
const EDIT_RE =
  /сдела|измен|поменя|замен|убер|убра|удали|добав|перепиш|короче|длиннее|крупн|мельч|ярч|светл|темн|тёмн|сократ|увелич|уменьш|передела|поправ|исправ|сдвин|выдел/i;

/** A new block, section or page — a change of the site's structure (the interview and a rebuild), not an edit. */
const NEW_PART_RE =
  /(?:добав|созда|сдела|встав)\S*\s+(?:ещё\s+|еще\s+|отдельн\S*\s+)?(?:нов\S*\s+)?(?:блок|секци|раздел|страниц)/i;

/**
 * The one part of the page the message names with a request to change it; null — none or more than one, or a new
 * block, section or page asked for.
 */
export function chatGoal(text: string): ChatGoal | null {
  if (!EDIT_RE.test(text) || NEW_PART_RE.test(text)) return null;
  const found = GOALS.filter((g) => g.words.test(text));
  return found.length === 1 ? (found[0] as (typeof GOALS)[number]).goal : null;
}

/** The section of a page the goal names: its type or id; the hero — also the first section of the body. */
function sectionOf(page: SitePage, goal: ChatGoal): SiteSection | null {
  const keys = GOALS.find((g) => g.goal === goal)?.keys ?? [];
  const hit = page.sections.find((s) => keys.includes(s.type) || keys.some((k) => s.id.includes(k)));
  if (hit) return hit;
  if (goal === "hero") return page.sections.find((s) => s.type !== "header") ?? null;
  return null;
}

/** The target of a point edit (routes/systems.ts targetSchema) for a section of the page. */
export interface ChatEditTarget {
  wzId: string;
  componentName: string;
  file: string;
  line: number;
  route: string;
  /** The section's anchor on the page. */
  section: string;
}

/**
 * The element of the section the message names on the page `route` of the draft (`files`: ui/site.json and the page
 * file at least): the wzId of its element in the page file (ui-kit, pattern or section written as code — the ids of
 * the build's wz-map). null — no clear goal, no such section or page, the page not composed by v3.
 */
export function chatEditTarget(
  text: string,
  files: ReadonlyMap<string, string>,
  route = "/",
): ChatEditTarget | null {
  const goal = chatGoal(text);
  if (!goal) return null;
  const site = readSite(files as Map<string, string>);
  const page = site?.pages.find((p) => p.route === route) ?? site?.pages.find((p) => p.route === "/");
  if (!page) return null;
  const section = sectionOf(page, goal);
  const source = files.get(page.file);
  if (!section || !source) return null;
  const elements = kitElements(page.file, source);
  const main = source.indexOf('<main id="main">');
  const mainEnd = source.indexOf("</main>");
  let at: number;
  if (section.type === "header") at = elements.findIndex((e) => main < 0 || e.start < main);
  else if (section.type === "footer") at = elements.findIndex((e) => mainEnd >= 0 && e.start > mainEnd);
  else {
    const anchor = source.indexOf(`<div id=${JSON.stringify(section.id)}>`);
    at = anchor < 0 ? -1 : elements.findIndex((e) => e.start > anchor);
  }
  const el = at >= 0 ? elements[at] : undefined;
  if (!el) return null;
  return {
    wzId: el.id,
    componentName: el.entry.componentName,
    file: page.file,
    line: el.entry.line,
    route: page.route,
    section: section.id,
  };
}
