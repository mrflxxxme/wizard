// Copy of the skeleton without a model (V3-18): the first screen's heading and lead, the label of the main action, the
// headings of the module forms and the SEO titles, from the brief's facts in a fixed order — the business name the
// owner gave (quoted in his first words, else the system's name when it is his), what the business is and offers in his
// words («студия дизайна интерьеров»; the services the brief or he lists), the place («в Казани»), then the niche its
// keywords give; the visitor's goals said to the visitor («Выберите тур и оставьте заявку на заезд»), the button he
// quotes («Обсудить проект»). Plain rules, Russian, nothing invented (D49): never a placeholder name («Проверка»),
// never a niche label less specific than his words, never the audience as a heading, never the first words of a
// sentence cut off, never the planner's placeholders (a heading equal to the niche, «Связаться»).
import type { BriefScenario, SystemBrief } from "@wizard/appspec";
import { siteName } from "@wizard/modules";

/** Texts of the skeleton the brief gives. */
export interface BriefCopy {
  /**
   * Heading of the first screen (≤ 60): what the business is in the owner's words with its name and place («Студия
   * дизайна интерьеров «Линия» в Екатеринбурге»), else the niche of the brief with the place, else the name.
   */
  title: string;
  /** Lead of the first screen (≤ 260): 2–4 services the brief or the owner lists, else the visitor's action. */
  lead?: string;
  /** The services (or goods) the brief or the owner lists, 2–8 of them as he wrote them (V3-18: «Услуги» on home). */
  services?: string[];
  /**
   * What the catalog shows, as a plural noun of the brief, lower case («туры», «изделия»): the catalog's page and
   * headings say it instead of «Услуги и цены» (V3-18).
   */
  catalog?: string;
  /** The button the brief quotes for a request («Обсудить проект»), ≤ 40. */
  action?: string;
  /** Heading of the request form: the quoted button, else «Заявка на <что>». */
  leadForm?: string;
  /** Heading of the booking form («Запись к врачам онлайн на свободное время»). */
  booking?: string;
  /** What the business is with its place, first letter lower case («стоматологическая клиника в Казани»). */
  about: string;
  /** The business name the owner gave («Линия»): quoted in his words, else the system's name when it is his. */
  brand?: string;
  /** SEO title of the home page (≤ 70): «<brand> — <about>», else <About>. */
  home: string;
  /**
   * The site's name (≤ 60): the header and footer brand, og:site_name, the end of the other pages' SEO titles — the
   * brand, else <About>.
   */
  site: string;
}

export interface CopyInput {
  name: string;
  /** The plan's niche and whether its keywords gave it (else it is the first words of the brief, not a phrase). */
  niche: string;
  keywordNiche: boolean;
  brief: Pick<SystemBrief, "audience" | "goals" | "scenarios">;
  /**
   * The owner's own words about the business (the system's first message), when the host has them: the business name
   * he quotes, what the business is, its place and what it offers are read from its first sentences.
   */
  request?: string;
}

const LIMITS = { title: 60, lead: 260, action: 40, form: 80, seo: 70 } as const;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const low = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
/** «а, б, в» → «а, б и в». */
const listOf = (xs: readonly string[]) =>
  xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} и ${xs[xs.length - 1]}`;

/** The visitor's 3rd-person verbs (singular and plural) said to him: «оставляет» → «оставьте». */
const IMPERATIVE: Readonly<Record<string, string>> = {
  оставляет: "оставьте",
  оставляют: "оставьте",
  выбирает: "выберите",
  выбирают: "выберите",
  записывается: "запишитесь",
  записываются: "запишитесь",
  смотрит: "посмотрите",
  смотрят: "посмотрите",
  читает: "читайте",
  читают: "читайте",
  заказывает: "закажите",
  заказывают: "закажите",
  покупает: "купите",
  покупают: "купите",
  бронирует: "забронируйте",
  бронируют: "забронируйте",
  узнаёт: "узнайте",
  узнает: "узнайте",
  узнают: "узнайте",
  получает: "получите",
  получают: "получите",
  отправляет: "отправьте",
  отправляют: "отправьте",
  звонит: "позвоните",
  звонят: "позвоните",
  пишет: "напишите",
  пишут: "напишите",
  находит: "найдите",
  находят: "найдите",
  регистрируется: "зарегистрируйтесь",
  регистрируются: "зарегистрируйтесь",
  подписывается: "подпишитесь",
  подписываются: "подпишитесь",
  приходит: "приходите",
  приходят: "приходите",
  оплачивает: "оплатите",
  оплачивают: "оплатите",
};

/** Site mechanics at the end of a visitor's action: not said to him on the site itself. */
const SITE_TAIL = /\s+(?:с любой страницы сайта|на любой странице сайта|на сайте|с сайта|через сайт)$/i;

const PUBLIC_ACTORS: ReadonlySet<string> = new Set(["visitor", "client"]);

/**
 * A visitor's action said to him: «Посетитель выбирает тур и оставляет заявку на заезд» → «Выберите тур и оставьте
 * заявку на заезд». The first word is the verb, or the subject followed by the verb; every known verb of the clause
 * turns into the imperative. null — the sentence is not a visitor's action (an internal goal of the owner).
 */
export function toVisitor(sentence: string): string | null {
  const s = clean(sentence)
    .replace(/[.!]+$/, "")
    .replace(/^когда\s+/i, "");
  const words = s.split(" ");
  const verbAt = IMPERATIVE[low(words[0] ?? "")] ? 0 : IMPERATIVE[low(words[1] ?? "")] ? 1 : -1;
  if (verbAt < 0) return null;
  // Clauses joined by «и» or a comma: each that starts with a known verb is said to the visitor; the sentence ends
  // before the first one that does not («…и сами видят, что с ней» stays out — never half a sentence in the 3rd person).
  const clauses = words
    .slice(verbAt)
    .join(" ")
    .split(/(\s+и\s+|,\s+)/);
  const out: string[] = [];
  for (let i = 0; i < clauses.length; i += 2) {
    const clause = clauses[i] ?? "";
    const first = clause.split(" ")[0] ?? "";
    if (i > 0 && !IMPERATIVE[low(first)]) break;
    if (i > 0) out.push(clauses[i - 1] ?? " ");
    out.push(
      clause
        .split(" ")
        .map((w) => IMPERATIVE[low(w)] ?? w)
        .join(" "),
    );
  }
  return cap(out.join("").replace(SITE_TAIL, ""));
}

/** Countries and regions wider than a locality («в России», «по РФ»): not where the business is. */
const COUNTRY = /^(?:Росси|РФ$|Беларус|Белорусс|Казахстан|СНГ$|Европ|Мир$|Миру$)/u;
/** A delivery or shipping scope right before a place («доставка по Москве», «отправляем по всей стране»). */
const DELIVERY_BEFORE =
  /(?:достав|отправ|пересыл|высыла|шл[её]м|везём|везем)[\p{L}]*(?:\s+[\p{L}-]+){0,3}\s*$/iu;

/**
 * A place of a text that says where the business is (V3-18): not a country («в России», «по РФ») and not the scope
 * of a delivery («доставка по России», «отправляем в Казань»).
 */
function localPlace(text: string, at: number, name: string): boolean {
  if (COUNTRY.test(name)) return false;
  const before =
    text
      .slice(Math.max(0, at - 60), at)
      .split(/[.;:!?]/)
      .at(-1) ?? "";
  return !DELIVERY_BEFORE.test(before);
}

/** The first place the brief names: «в Казани», «по Карелии» (a preposition and a capitalised name). */
export function placeOf(texts: readonly string[]): string | undefined {
  const re = /(?:^|[\s,(«])([ВвПп]о?)\s+([А-ЯЁ][а-яё]+(?:-[А-ЯЁ]?[а-яё]+)?|РФ)(?=$|[\s,.;:)»])/gu;
  for (const t of texts)
    for (const m of t.matchAll(re))
      if (localPlace(t, m.index ?? 0, m[2] as string)) return `${(m[1] as string).toLowerCase()} ${m[2]}`;
  return undefined;
}

/**
 * Lists the steps show: «показывает разделы: торты, пирожные» → {what: «разделы», items: [«торты», «пирожные»]}
 * (2–8 items of ≤ 60 characters each).
 */
export function shownLists(steps: readonly string[]): { what: string; items: string[] }[] {
  const out: { what: string; items: string[] }[] = [];
  for (const step of steps) {
    const m = /^показыва\S*\s+([^:]{1,40}):\s*(.+)$/i.exec(clean(step));
    if (!m) continue;
    const items = (m[2] as string)
      .replace(/[.]$/, "")
      .split(/,\s*|\s+и\s+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (items.length >= 2 && items.length <= 8 && items.every((x) => x.length <= 60))
      out.push({ what: (m[1] as string).trim(), items });
  }
  return out;
}

/** «показывает услуги: дизайн квартиры, дизайн дома, авторский надзор, комплектация» → the listed services. */
export function listedServices(steps: readonly string[]): string[] | null {
  return shownLists(steps)[0]?.items ?? null;
}

/** Generic words of a list that say nothing about the offer. */
const GENERIC = /^(?:услуг|товар|позици|цен|каталог|список|прайс|вариант|предложени)/i;

/**
 * What a catalog shows, as a noun: «показывает туры с ценой и длительностью» → «туры» (the head before «с», «:»,
 * «,»); null for generic words («услуги с ценами»).
 */
export function catalogNoun(steps: readonly string[]): string | null {
  for (const step of steps) {
    const m = /^показыва\S*\s+(.+)$/i.exec(clean(step));
    if (!m) continue;
    const head = (m[1] as string).split(/\s+(?:с|со|по|для|от|в)\s+|[:,«(]/)[0]?.trim() ?? "";
    if (!head || GENERIC.test(head) || head.split(" ").length > 3) continue;
    return head;
  }
  return null;
}

/** A plural noun in the nominative (the last word: «туры», «авторские изделия»), not a genitive («мастеров»). */
const PLURAL_RE = /(?:ы|и|а|я)$/u;

/** A button the brief quotes («Обсудить проект»): an infinitive first, ≤ 40 characters. */
export function quotedAction(texts: readonly string[]): string | undefined {
  for (const t of texts)
    for (const m of t.matchAll(/«([^«»]{3,40})»/g)) {
      const label = (m[1] as string).trim();
      if (/^[А-ЯЁ][а-яё]*(?:ть|ться|ти)(?:\s|$)/u.test(label)) return label;
    }
  return undefined;
}

/** «оставляет заявку на уборку на сайте» → «уборку»: what a request is for. */
function requestFor(texts: readonly string[]): string | undefined {
  for (const t of texts) {
    const m = /заявк[уаи]\s+на\s+([^,.;«»]+)/i.exec(clean(t).replace(SITE_TAIL, ""));
    const what = m?.[1]?.replace(SITE_TAIL, "").trim();
    if (what && what.split(" ").length <= 4) return what;
  }
  return undefined;
}

/** «Пациенты записываются к врачам онлайн на свободное время» → «Запись к врачам онлайн на свободное время». */
function bookingOf(texts: readonly string[]): string | undefined {
  for (const t of texts) {
    const m = /записыва\S*\s+((?:к|на|в)\s+[^,.;]+)/i.exec(clean(t).replace(SITE_TAIL, ""));
    const what = m?.[1]?.trim();
    if (what) {
      const out = `Запись ${what}`;
      if (out.length <= LIMITS.form) return out;
    }
  }
  return undefined;
}

const scenarioTexts = (scenarios: readonly BriefScenario[]) => scenarios.flatMap((s) => [s.when, ...s.then]);

/** Names of a test or a draft («Проверка», «Тест 2», «Новая система»): never shown as the business name. */
const PLACEHOLDER_NAME =
  /^(?:проверка|тест|test|testing|пример|example|demo|демо|черновик|sample|новая система|без названия)(?![\p{L}])/iu;

/** A name of a test or a draft, not of a business. */
export const isPlaceholderName = (name: string): boolean => PLACEHOLDER_NAME.test(clean(name));

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Sentences of the owner's text (the first `max`). */
function sentencesOf(text: string, max = 3): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(clean)
    .filter(Boolean)
    .slice(0, max);
}

/**
 * Head nouns of what a business is («студия», «клиника», «турфирма», «мастерская»), nominative singular: the phrase
 * of the owner's words around one is what the business is.
 */
const BUSINESS_HEAD =
  /^(?:тур|вет|авто|фото|арт|кофе)?(?:студия|клиника|компания|фирма|агентство|мастерская|салон|магазин|интернет-магазин|бюро|ателье|школа|центр|кафе|ресторан|кофейня|пекарня|кондитерская|барбершоп|сервис|служба|цех|ферма|питомник|гостиница|отель|хостел|лаборатория|галерея|клуб|бригада|стоматология|типография|мойка|прокат|театр|издательство|производство|артель|бутик|шоурум|практика)$/u;
/** Words before the business phrase that say who speaks («Мы», «У нас»). */
const SPEAKER: ReadonlySet<string> = new Set([
  "мы",
  "у",
  "нас",
  "меня",
  "я",
  "это",
  "наш",
  "наша",
  "наше",
  "—",
  "–",
]);
/** Adjectives of size or praise: not what the business is («небольшая турфирма» → «турфирма»). */
const VAGUE_ADJ = /^(?:небольш|маленьк|крупн|молод|нов|современн|уютн|лучш|хорош|отличн)/u;
const ADJ = /(?:ая|яя|ое|ее|ый|ий|ой|ые|ие)$/u;
/** Endings of a genitive tail («студия дизайна интерьеров», «клиника эстетической медицины»). */
const GENITIVE = /(?:а|я|ов|ев|ей|ий|ых|их|ого|его|ой|ы|и)$/u;
const PREPOSITIONS: ReadonlySet<string> = new Set(
  "в во на по из с со к для от до и или а но при за под над у о об про".split(" "),
);

/** A word without the punctuation around it. */
const bare = (w: string) => w.replace(/^[«"(]+|[»",.:;!?)]+$/gu, "");

interface Business {
  /** What the business is in the owner's words, lower case («студия дизайна интерьеров»). */
  what: string;
  /** The sentence that says it. */
  sentence: string;
}

/**
 * What the business is in the owner's words: a head noun among the first words of one of his first sentences, after
 * at most «Мы», «У нас», with its adjectives (size and praise dropped) and its genitive tail — «Мы небольшая
 * керамическая мастерская из Твери» → «керамическая мастерская». null — no such sentence.
 */
export function businessOf(request: string): Business | null {
  for (const sentence of sentencesOf(request)) {
    const words = sentence.split(" ");
    const at = words.findIndex((w, i) => i < 8 && BUSINESS_HEAD.test(low(bare(w))));
    if (at < 0) continue;
    let from = at;
    while (from > 0) {
      const prev = words[from - 1] as string;
      if (bare(prev) !== prev || !ADJ.test(low(prev))) break;
      from--;
    }
    if (!words.slice(0, from).every((w) => SPEAKER.has(low(bare(w))))) continue;
    const head = words.slice(from, at + 1).map((w) => low(bare(w)));
    const phrase = [...head.slice(0, -1).filter((w) => !VAGUE_ADJ.test(w)), head.at(-1) as string];
    // The genitive tail ends at punctuation, a quote, a preposition or a word that is not genitive.
    if (bare(words[at] as string) === words[at])
      for (const raw of words.slice(at + 1, at + 4)) {
        const w = bare(raw);
        if (
          !w ||
          /^[«"]/.test(raw) ||
          PREPOSITIONS.has(low(w)) ||
          !/^[а-яё-]+$/u.test(w) ||
          !GENITIVE.test(w)
        )
          break;
        phrase.push(w);
        if (w !== raw) break;
      }
    return { what: phrase.join(" "), sentence };
  }
  return null;
}

/** The business name the owner quotes in the sentence that says what the business is: «Линия». */
export function quotedName(sentence: string): string | undefined {
  for (const m of sentence.matchAll(/«([^«»]{2,40})»/g)) {
    const name = clean(m[1] as string);
    if (/^[\p{Lu}\d]/u.test(name) && !/^[А-ЯЁ][а-яё]*(?:ть|ться|ти)(?:\s|$)/u.test(name)) return name;
  }
  return undefined;
}

/** The name the owner gives in so many words: «называется «Глина»», «под названием «Глина»», «бренд «Глина»». */
export function namedAs(request: string): string | undefined {
  const m = /(?:называ[\p{L}]*|под названием|бренд|марк[аой])\s*[—:-]?\s*«([^«»]{2,40})»/iu.exec(
    clean(request),
  );
  return m ? quotedName(`«${m[1] as string}»`) : undefined;
}

interface Places {
  /** «в Казани»: where the business is. */
  in?: string;
  /** «по Карелии»: where its offer goes. */
  along?: string;
  /** «из Твери»: where it comes from. */
  from?: string;
}

/** Places a text names: «в Казани», «по Карелии», «из Твери» (a preposition and a capitalised name). */
function placesIn(text: string): Places {
  const out: Places = {};
  const re = /(?:^|[\s,(«])(в|во|по|из)\s+([А-ЯЁ][а-яё]+(?:-[А-ЯЁ]?[а-яё]+)?|РФ)(?=$|[\s,.;:)»])/gu;
  for (const m of text.matchAll(re)) {
    if (!localPlace(text, m.index ?? 0, m[2] as string)) continue;
    const prep = (m[1] as string).toLowerCase();
    const key = prep === "из" ? "from" : prep === "по" ? "along" : "in";
    out[key] ??= `${prep} ${m[2]}`;
  }
  return out;
}

/** Workers before a colon («пять врачей: терапевт, …»): the list names the staff, not the offer. */
const STAFF =
  /^(?:врач|мастер|сотрудник|специалист|дизайнер|тренер|человек|преподавател|педагог|менеджер|бригад|юрист|психолог|стилист|парикмахер|повар|гид|инструктор)/u;
/** Words that end a list of the offer («…, вазы ручной работы, многие вещи в одном экземпляре»). */
const LIST_END =
  /^(?:многие|многое|все|всё|некоторые|каждый|каждая|большинство|часть|также|а также|ещё|еще)(?![\p{L}])/u;

/** Items of a list the owner wrote: 2 and more, each ≤ 60 characters and 6 words, no digits; elided heads restored. */
function listItems(text: string): string[] | null {
  const raw = text
    .replace(/[.!?]+$/, "")
    .split(/,\s*|\s+и\s+/)
    .map(clean);
  const out: string[] = [];
  for (const item of raw) {
    if (!item || LIST_END.test(low(item))) break;
    if (/\d/.test(item) || item.length > 60 || item.split(" ").length > 6 || /[«»:;()]/.test(item))
      return null;
    const prev = out.at(-1);
    // «уборка квартир после ремонта, офисов» → «уборка офисов»: a lone genitive plural takes the head before it.
    out.push(
      prev?.includes(" ") && !item.includes(" ") && /(?:ов|ев|ей)$/u.test(item)
        ? `${prev.split(" ")[0]} ${item}`
        : item,
    );
  }
  return out.length >= 2 ? out : null;
}

/**
 * What the business offers in the owner's words: the list after a colon of the sentence that says what it is («У нас
 * клининговая компания в Новосибирске: уборка квартир после ремонта, офисов и мойка окон»), else the services he
 * lists in parentheses or after a colon («страницы услуг (дизайн-проект квартиры, …)»). A list of the staff is not
 * the offer.
 */
export function offerOf(request: string, business: Business | null): string[] | null {
  const colon = business ? /^(.*?):\s*(.+)$/u.exec(business.sentence) : null;
  if (colon) {
    const last = low(bare((colon[1] as string).split(" ").at(-1) ?? ""));
    const items = STAFF.test(last) ? null : listItems(colon[2] as string);
    if (items) return items;
  }
  const services = /услуг\S*\s*(?:\(([^)]+)\)|:\s*([^.;]+))/iu.exec(clean(request));
  return services ? listItems((services[1] ?? services[2]) as string) : null;
}

/** The first candidate that fits `max` characters. */
const firstFit = (max: number, ...xs: (string | null | undefined)[]): string | undefined =>
  xs.find((x): x is string => typeof x === "string" && x.length > 0 && x.length <= max);

/**
 * The name of a new system from the owner's first words (V3-18; the cabinet, the letters, the platform list): the
 * business name he quotes («Линия»), else what the business is («Клининговая компания»), ≤ 40 characters, never cut.
 * null — his words name neither.
 */
export function businessName(request: string): string | null {
  const b = businessOf(request);
  return (b && firstFit(40, quotedName(b.sentence), cap(b.what))) || null;
}

/** A visitor's step of a form, a cart or a cabinet: not a lead of the first screen. */
const FORM_STEP_RE =
  /^(?:Выберите|Укажите|Положите|Добавьте|Оплатите|Введите|Нажмите|Перейдите|Откройте|Войдите|Оформите|Заполните|Отследите|Подтвердите)(?![\p{L}])/u;

/**
 * The skeleton's texts of a brief (deterministic: the same brief gives the same texts), from its facts in a fixed
 * order: the business name the owner gave, what the business is and offers in his words, the place — never a
 * placeholder name, never a niche label less specific than his words, never a phrase cut off.
 */
export function briefCopy(input: CopyInput): BriefCopy {
  const { brief } = input;
  const name = clean(input.name);
  const request = clean(input.request ?? "");
  const visitor = brief.scenarios.filter((s) => PUBLIC_ACTORS.has(s.actor));
  const goals = brief.goals.map((g) => g.text);
  const visitorTexts = [...goals, ...scenarioTexts(visitor)];
  const catalog = visitor.filter((s) => s.moduleHint === "catalog" || /каталог|услуг|цен/i.test(s.when));
  const steps = catalog.flatMap((s) => s.then);
  const business = request ? businessOf(input.request as string) : null;

  // The business name: the one the owner quotes, else the system's name when he gave it — never a placeholder of a
  // test, the start of his text the platform named the system after, or the niche itself.
  const own =
    name &&
    name.length <= 40 &&
    !/[,.:;!?]/.test(name) &&
    !isPlaceholderName(name) &&
    !(request && norm(request).startsWith(norm(name))) &&
    !(request && norm(siteName(request)) === norm(name)) &&
    norm(name) !== norm(input.niche) &&
    norm(name) !== norm(business?.what ?? "")
      ? name
      : undefined;
  const brand =
    (business ? quotedName(business.sentence) : undefined) ??
    (request ? namedAs(input.request as string) : undefined) ??
    own;

  // The place: of the owner's sentence about the business, else of the brief. «в X» belongs to the business, «по X»
  // to what it offers (the catalog's noun: «Туры по Карелии»), «из X» to where the business comes from.
  const said = business ? placesIn(business.sentence) : {};
  const briefPlace = placeOf([brief.audience, ...goals, ...scenarioTexts(brief.scenarios)]);
  const known = briefPlace ? placesIn(briefPlace) : {};
  const place: Places = {
    ...((said.in ?? known.in) ? { in: said.in ?? known.in } : {}),
    ...((said.along ?? known.along) ? { along: said.along ?? known.along } : {}),
    ...(said.from ? { from: said.from } : {}),
  };
  const offer = catalogNoun(steps);

  // What the business is: the owner's words, else the keywords' niche — never a niche label less specific than his
  // words («ремонт и отделка» for a studio of interior design); else what its catalog shows («Туры по Карелии»).
  const what = business?.what ?? (input.keywordNiche ? input.niche : null);
  let subject: string | null = null;
  let at = "";
  if (what && place.in) at = place.in;
  else if (place.along && offer) subject = `${offer} ${place.along}`;
  else if (what) at = place.from ?? place.along ?? "";
  else if (offer) subject = offer;
  if (what && !subject) subject = at ? `${what} ${at}` : what;
  const ofWhat = !!what && subject?.startsWith(what) === true;

  const title =
    (brand && ofWhat && business
      ? firstFit(
          LIMITS.title,
          `${cap(what as string)} «${brand}»${at ? ` ${at}` : ""}`,
          `${cap(what as string)} «${brand}»`,
          `${brand} — ${what}`,
        )
      : undefined) ??
    (brand && subject ? firstFit(LIMITS.title, `${brand} — ${subject}`) : undefined) ??
    (subject ? firstFit(LIMITS.title, cap(subject), what ? cap(what) : undefined) : undefined) ??
    firstFit(LIMITS.title, brand) ??
    (isPlaceholderName(name) ? cap(input.niche) : name).slice(0, LIMITS.title);

  // The lead: 2–4 services the brief lists, else the offer in the owner's words, else the visitor's action.
  const services = listedServices(steps) ?? (request ? offerOf(input.request as string, business) : null);
  // A step of a form or a purchase («Выберите товары», «Укажите адрес») says nothing about the business: no lead
  // rather than that (V3-40: the shops' first screens read «Выберите доставку (…)»).
  const action = visitorTexts.map(toVisitor).find((x): x is string => !!x && !FORM_STEP_RE.test(x));
  let lead = services ? `${cap(listOf(services.slice(0, 4)))}.` : action ? `${action}.` : undefined;
  if (lead && (lead.length > LIMITS.lead || lead.toLowerCase() === `${title.toLowerCase()}.`))
    lead = undefined;

  // The button the owner names: in the brief, else in his words.
  const button =
    quotedAction(visitorTexts) ??
    (request ? quotedAction(sentencesOf(input.request as string, 50)) : undefined);
  const wanted = requestFor(visitorTexts);
  const leadForm = button ?? (wanted ? `Заявка на ${wanted}` : undefined);
  const booking = bookingOf(visitorTexts);

  const about = subject ? low(subject) : (brand ?? (isPlaceholderName(name) ? input.niche : name));
  const About = cap(about);
  const home =
    (brand && norm(about) !== norm(brand)
      ? firstFit(LIMITS.seo, `${brand} — ${about}`, what ? `${brand} — ${what}` : undefined)
      : undefined) ??
    firstFit(LIMITS.seo, About, brand) ??
    title;
  return {
    title,
    ...(lead ? { lead } : {}),
    ...(services ? { services } : {}),
    ...(offer && PLURAL_RE.test(offer) && offer.length <= 30 ? { catalog: low(offer) } : {}),
    ...(button ? { action: button } : {}),
    ...(leadForm && leadForm.length <= LIMITS.form ? { leadForm } : {}),
    ...(booking ? { booking } : {}),
    about,
    ...(brand ? { brand } : {}),
    home,
    // The header's brand too (brandSlot ≤ 60).
    site: firstFit(LIMITS.title, brand, About, what ? cap(what) : undefined) ?? title,
  };
}
