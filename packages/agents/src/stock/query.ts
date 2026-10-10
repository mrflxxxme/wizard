// Stock photo queries without a model (B2-38): the niche of the plan, the photo style of the design direction and the
// section a photo is for become an English search query by fixed dictionaries (stocks index English best). The same
// plan always gives the same queries, so a rebuild finds the same photos (and the platform cache answers them).
import type { SystemPlan } from "@wizard/appspec";
import type { PhotoOrientation, PhotoSectionType } from "@wizard/modules";

interface NicheTerms {
  /** Russian stems of the niche (lower case, «ё» as «е»; no word boundary escapes — they are ASCII-only in JS). */
  match: RegExp;
  /** First screen: the place and the service. */
  hero: string;
  /** «О нас»: people at work, the team. */
  about: string;
  /** Gallery and features: details of the work. */
  detail: string;
}

/** Niches of small businesses by Russian stems; the first match wins (specific before generic). */
export const NICHE_TERMS: readonly NicheTerms[] = [
  {
    match: /стомат|зуб|дантист|ортодонт/,
    hero: "dental clinic",
    about: "dentist with patient",
    detail: "dental care",
  },
  {
    match: /ветеринар|зоо|груминг|собак|кошк|питомц/,
    hero: "veterinary clinic",
    about: "vet with dog",
    detail: "pet grooming",
  },
  {
    match: /клиник|медиц|врач|терапевт|педиатр|анализ|здоровь/,
    hero: "medical clinic",
    about: "doctor consultation",
    detail: "medical office",
  },
  {
    match: /психолог|психотерап|коуч|консультант по отношениям/,
    hero: "calm therapy office",
    about: "counseling session",
    detail: "cozy armchair plants",
  },
  { match: /барбер|мужск.*стриж/, hero: "barber shop", about: "barber at work", detail: "barber tools" },
  {
    match: /парикмах|стриж|окрашиван|причес/,
    hero: "hair salon",
    about: "hairdresser at work",
    detail: "hair styling",
  },
  {
    match: /маникюр|педикюр|ногт|нейл/,
    hero: "nail salon",
    about: "manicure master",
    detail: "manicure close up",
  },
  {
    match: /бров|ресниц|косметолог|салон красоты|визаж|макияж|эпиляц/,
    hero: "beauty salon",
    about: "beautician at work",
    detail: "skincare cosmetics",
  },
  {
    match: /массаж|(^|[\s,])спа([\s,.]|$)|spa/,
    hero: "massage spa",
    about: "massage therapist",
    detail: "spa stones towels",
  },
  { match: /йог|пилатес|медитац/, hero: "yoga studio", about: "yoga class", detail: "yoga mat" },
  { match: /танц|хореограф|балет/, hero: "dance studio", about: "dance class", detail: "dance shoes" },
  {
    match: /фитнес|тренаж|трениров|спортзал|кроссфит|бокс|единоборств|спорт/,
    hero: "fitness gym",
    about: "personal trainer",
    detail: "gym equipment",
  },
  { match: /бассейн|плаван/, hero: "swimming pool", about: "swimming lesson", detail: "pool water" },
  {
    match: /детск.*сад|развивающ|детск.*центр|для детей|дошкол/,
    hero: "kids learning",
    about: "teacher with children",
    detail: "children toys",
  },
  {
    match: /английск|язык|репетитор|школ|курс|обучен|подготовк.*экзамен|егэ|огэ|урок/,
    hero: "tutoring lesson",
    about: "teacher and student",
    detail: "books notebook",
  },
  {
    match: /музык|вокал|гитар|фортепиан/,
    hero: "music lesson",
    about: "music teacher",
    detail: "musical instrument",
  },
  {
    match: /керами[кч]|гончар|глин[ая]|фарфор/,
    hero: "handmade ceramics",
    about: "potter at work",
    detail: "ceramic mugs",
  },
  {
    match: /рисован|живопис|художеств|арт-студ/,
    hero: "art studio",
    about: "art class",
    detail: "paint brushes",
  },
  {
    match: /фотограф|фотосесс|видеосъем|видеограф/,
    hero: "photo studio",
    about: "photographer at work",
    detail: "camera lens",
  },
  {
    match: /свадьб|праздник|мероприят|ивент|банкет|аниматор/,
    hero: "event celebration",
    about: "event planner",
    detail: "festive table decor",
  },
  {
    match: /кофейн|кофе|кафе|(^|[\s,])бар([\s,.]|$)/,
    hero: "cozy cafe",
    about: "barista at work",
    detail: "coffee cup",
  },
  {
    match: /пекарн|выпечк|кондитер|торт|десерт|хлеб/,
    hero: "bakery",
    about: "baker at work",
    detail: "fresh pastry",
  },
  {
    match: /ресторан|кухн|еда|доставк.*еды|кейтеринг|столов/,
    hero: "restaurant interior",
    about: "chef cooking",
    detail: "food plate",
  },
  { match: /цвет|флорист|букет/, hero: "flower shop", about: "florist at work", detail: "flower bouquet" },
  {
    match: /клининг|уборк|химчистк/,
    hero: "clean bright home",
    about: "cleaning service",
    detail: "cleaning supplies",
  },
  {
    match: /ремонт квартир|отделк|строит|дизайн интерьер|ремонт под ключ|плитк|сантехник|электрик/,
    hero: "renovated apartment interior",
    about: "renovation worker",
    detail: "interior details",
  },
  {
    match: /мебел|столяр|плотник/,
    hero: "furniture workshop",
    about: "carpenter at work",
    detail: "wood texture",
  },
  {
    match: /автосервис|авто|шиномонтаж|автомойк|детейлинг|машин/,
    hero: "car service garage",
    about: "car mechanic",
    detail: "car repair tools",
  },
  {
    match: /ремонт (техники|телефон|ноутбук|компьютер)|сервисн.*центр|электрони/,
    hero: "electronics repair",
    about: "technician at work",
    detail: "circuit board",
  },
  {
    match: /юрист|адвокат|юридич|нотариус/,
    hero: "law office",
    about: "lawyer consultation",
    detail: "documents signing",
  },
  {
    match: /бухгалт|налог|финанс|аудит/,
    hero: "accounting office",
    about: "accountant at work",
    detail: "financial documents",
  },
  {
    match: /недвижим|риелтор|риэлтор|аренд.*квартир|новостройк/,
    hero: "modern apartment",
    about: "real estate agent",
    detail: "house keys",
  },
  {
    match: /сплав|поход|рафтинг|байдар|каяк|снегоход|актив\S* (тур|отдых)|карели/,
    hero: "kayaking river forest",
    about: "hiking group nature",
    detail: "camping tent lake",
  },
  {
    match: /туризм|(^|[\s,])тур([\s,.]|$)|туры|путешеств|отел|гостиниц|хостел|глэмпинг/,
    hero: "travel destination",
    about: "travel guide",
    detail: "hotel room",
  },
  {
    match: /коворкинг|офис|бизнес-центр/,
    hero: "coworking space",
    about: "people working together",
    detail: "modern office desk",
  },
  {
    match: /прокат|аренд/,
    hero: "rental equipment",
    about: "staff helping customer",
    detail: "equipment close up",
  },
  {
    match: /магазин|бутик|одежд|товар/,
    hero: "boutique store",
    about: "shop assistant",
    detail: "products on shelves",
  },
];

/** Generic terms when no niche matches. */
export const GENERIC_TERMS: Readonly<Omit<NicheTerms, "match">> = {
  hero: "small business",
  about: "team at work",
  detail: "workplace details",
};

/** Photo style (design direction, Russian) → English modifiers; the first two matches in this order are used. */
export const STYLE_TERMS: readonly { match: RegExp; terms: string }[] = [
  { match: /без людей|пуст|интерьер/, terms: "interior" },
  { match: /крупн|детал|макро/, terms: "close up" },
  { match: /(^|[\s,])рук(и|ами|а)?([\s,.]|$)/, terms: "hands" },
  { match: /дневн|солнечн|светл|окн/, terms: "daylight" },
  { match: /тепл|уют|мягк/, terms: "warm" },
  { match: /вечер|сумер|ночн/, terms: "evening" },
  { match: /студийн|однотон|минимал/, terms: "minimal" },
  { match: /растени|природ|зелен|дерев/, terms: "natural" },
  { match: /контраст|драм/, terms: "contrast" },
  { match: /насыщен|ярк|сочн/, terms: "colorful" },
  { match: /спокойн|воздух|тишин|нейтральн/, terms: "calm" },
  { match: /движен|динамич|энерг/, terms: "action" },
];

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Terms of the plan's niche (the niche line, then the goals' statements). */
export function nicheTerms(plan: Pick<SystemPlan, "niche" | "goals">): Omit<NicheTerms, "match"> {
  const texts = [plan.niche, ...plan.goals.map((g) => g.statement)].map(norm);
  for (const t of texts) {
    const hit = NICHE_TERMS.find((n) => n.match.test(t));
    if (hit) return { hero: hit.hero, about: hit.about, detail: hit.detail };
  }
  return GENERIC_TERMS;
}

/** Modifiers of a photo style (at most two). */
export function styleTerms(photoStyle: string): string[] {
  const s = norm(photoStyle);
  return STYLE_TERMS.filter((x) => x.match.test(s))
    .map((x) => x.terms)
    .slice(0, 2);
}

export interface StockQuery {
  /** English search text. */
  text: string;
  orientation: PhotoOrientation;
}

/** The query of a section's photos: niche terms by section, style modifiers («people» styles are not forced). */
export function stockQuery(
  plan: Pick<SystemPlan, "niche" | "goals"> & { design: Pick<SystemPlan["design"], "photoStyle"> },
  section: PhotoSectionType,
  orientation: PhotoOrientation,
): StockQuery {
  const n = nicheTerms(plan);
  const subject = section === "hero" ? n.hero : section === "about" ? n.about : n.detail;
  const mods = styleTerms(plan.design.photoStyle).filter((m) => !subject.includes(m));
  // A team photo «без людей» makes no sense: the about query keeps its people and drops «interior».
  const kept = section === "about" ? mods.filter((m) => m !== "interior") : mods;
  return { text: [subject, ...kept].join(" ").slice(0, 80), orientation };
}
