// V4-09: what the owner reads about the critic in the build's summary — one or two plain Russian phrases, no routes,
// anchors, keys or check codes (those stay in the staff report V4-04 and in CriticReport.cycles).
import type { SiteModel } from "../compose/site.js";
import type { EditOp } from "./ops.js";
import type { CheckCode, CodePatch } from "./rubric.js";

/** A section in the genitive: «заголовок первого экрана». */
const SECTION_GEN: Readonly<Record<string, string>> = {
  header: "шапки",
  hero: "первого экрана",
  services: "блока услуг",
  about: "блока «О нас»",
  testimonials: "блока отзывов",
  pricing: "блока цен",
  gallery: "галереи",
  team: "блока команды",
  faq: "блока вопросов",
  contacts: "блока контактов",
  cta: "блока с призывом",
  form: "формы заявки",
  catalog: "каталога",
  blog: "блога",
  footer: "подвала",
  signature: "фирменного блока",
};

/** What a deterministic check found and the critic fixed, as a noun phrase the owner reads in a list. */
const CHECK_FIXED: Readonly<Record<CheckCode, string>> = {
  RENDER: "страница с ошибкой",
  L11: "элемент за краем экрана",
  C08: "плохо читаемый текст",
  T16: "шрифт",
  CLS: "прыгающая при загрузке вёрстка",
  A01: "мелкие для пальца кнопки",
  A06: "структура заголовков",
  A08: "подписи кнопок и картинок",
  I03: "незагрузившаяся картинка",
  L13: "главная кнопка за первым экраном",
  M05: "скрытый после загрузки текст",
};

/** What is left to fix by hand, in the present tense. */
const CHECK_LEFT: Readonly<Record<CheckCode, string>> = {
  RENDER: "страница не открывается",
  L11: "элемент выходит за край экрана",
  C08: "текст плохо читается на фоне",
  T16: "не загружается шрифт",
  CLS: "вёрстка прыгает при загрузке",
  A01: "кнопки мелковаты для пальца",
  A06: "сбита структура заголовков",
  A08: "у кнопки или картинки нет подписи",
  I03: "не загружается картинка",
  L13: "главная кнопка не видна на первом экране телефона",
  M05: "текст скрыт после загрузки",
};

/** A page in the genitive: «главной», «страницы «Цены»». */
export function pageGen(site: SiteModel | null, route: string): string {
  if (route === "/") return "главной";
  const p = site?.pages.find((x) => x.route === route);
  return p ? `страницы «${p.nav || p.title}»` : "страницы";
}

/** A page with «на»: «на главной», «на странице «Цены»». */
export function pageAt(site: SiteModel | null, route: string): string {
  if (route === "/") return "на главной";
  const p = site?.pages.find((x) => x.route === route);
  return p ? `на странице «${p.nav || p.title}»` : "на одной из страниц";
}

function sectionGen(site: SiteModel | null, route: string, section: string): string {
  const s = site?.pages.find((p) => p.route === route)?.sections.find((x) => x.id === section);
  return SECTION_GEN[s?.type ?? section] ?? "блока";
}

/** One accepted edit of the critic, as the owner reads it: «заголовок первого экрана главной». */
export function ownerEdit(site: SiteModel | null, change: { op: EditOp } | { patch: CodePatch }): string {
  if ("patch" in change) {
    const page = site?.pages.find((p) => p.file === change.patch.file);
    if (page) return `вёрстка ${pageGen(site, page.route)}`;
    const sig = site?.pages.flatMap((p) => p.sections).some((s) => s.file === change.patch.file);
    return sig ? "вёрстка фирменного блока" : "вёрстка";
  }
  const op = change.op;
  switch (op.op) {
    case "set_text": {
      const last = op.path.split(".").at(-1) ?? "";
      const what = /title|heading|headline/i.test(last)
        ? "заголовок"
        : /label|button|cta|action/i.test(op.path)
          ? "надпись на кнопке"
          : "текст";
      return `${what} ${sectionGen(site, op.route, op.section)} ${pageGen(site, op.route)}`;
    }
    case "swap_variant":
      return `вид ${sectionGen(site, op.route, op.section)} ${pageGen(site, op.route)}`;
    case "reorder":
      return `порядок блоков ${pageGen(site, op.route)}`;
    case "drop_section":
      return `лишний блок ${pageGen(site, op.route)} убран`;
    case "token":
      return {
        density: "плотность вёрстки",
        radius: "скругления углов",
        display_size: "размер главного заголовка",
        muted_contrast: "контраст второстепенного текста",
      }[op.token];
  }
}

/** A deterministic fix (its CriticReport.fixes line ends with «(<code>)»): what was wrong, in plain words. */
export function ownerFix(line: string): string | null {
  const code = /\(([A-Z0-9]+)\)$/.exec(line)?.[1] as CheckCode | undefined;
  return code && code in CHECK_FIXED ? CHECK_FIXED[code] : null;
}

/** Plural of «место»: 1 место, 2 места, 5 мест. */
export const ruPlaces = (n: number): string =>
  n % 10 === 1 && n % 100 !== 11
    ? "место"
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
      ? "места"
      : "мест";

/** Plural of «замечание». */
export const ruRemarks = (n: number): string =>
  n % 10 === 1 && n % 100 !== 11
    ? "замечание"
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
      ? "замечания"
      : "замечаний";

/**
 * The owner's lines about the critic (one or two): what it improved (the first three places) and what is left by
 * hand. Scores, cycles and the technical lines stay in the staff report.
 */
export function ownerCriticNotes(o: {
  edits: readonly string[];
  fixes: readonly string[];
  left: readonly { code: CheckCode; route: string }[];
  site: SiteModel | null;
}): string[] {
  const out: string[] = [];
  const fixed = [...new Set(o.fixes.map(ownerFix).filter((x): x is string => x !== null))];
  const done = [...new Set(o.edits)];
  const n = done.length + fixed.length;
  if (n === 0) out.push("Посмотрел сайт глазами дизайнера на телефоне и компьютере — править нечего.");
  else {
    const list = [...done, ...fixed];
    out.push(
      `Посмотрел сайт глазами дизайнера и улучшил ${n} ${ruPlaces(n)}: ${list.slice(0, 3).join(", ")}${list.length > 3 ? " и другое" : ""}.`,
    );
  }
  const left = [
    ...new Set(
      o.left
        .filter((d) => d.code !== "RENDER")
        .map((d) => `${CHECK_LEFT[d.code]} ${pageAt(o.site, d.route)}`),
    ),
  ];
  if (left.length)
    out.push(`Стоит проверить вручную: ${left.slice(0, 2).join("; ")}${left.length > 2 ? " и ещё" : ""}.`);
  return out;
}
