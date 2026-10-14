// V4-24: the facts a site of a business with a place cannot do without, asked by code (no model) as blocking questions
// of the first screens — within BLOCKING_QUESTIONS_CAP: where to find it (address, phone, opening hours) and, when a
// scenario promises the specialists, who they are (name and specialisation). The owner answers in his own words; the
// answer is kept in the brief as a fact of its question (brief.qa) and read back by the site's facts (the contacts
// section) and the seed hints (the directions of the staff). Nothing is invented: a skipped question leaves the site
// without it (V4-21 sends the promise to «Запросы на развитие»).
import type { SystemBrief } from "@wizard/appspec";
import type { FallbackQuestion } from "./fallback.js";

/** The question of the place: its text is the key of the answer in brief.qa. */
export const PLACE_QUESTION_TEXT = "Где вас найти: адрес, телефон и часы работы?";
/** The question of the specialists: its text is the key of the answer in brief.qa. */
export const STAFF_QUESTION_TEXT = "Кого из специалистов показать на сайте: имя и специализация?";
/** The question of the prices «от» of the main services: its text is the key of the answer in brief.qa. */
export const PRICE_QUESTION_TEXT = "Цены «от» на основные услуги: название — цена?";

export type FactQuestionKind = "place" | "staff" | "prices";

/** Businesses with a place the visitor comes to (a clinic, a café, a salon, a studio…). */
const PLACE_RE =
  /клиник|стоматолог|медцентр|салон|кофейн|кафе|ресторан|пекарн|кондитерск|студи[ияюей]|мастерск|барбершоп|парикмахер|фитнес|спортзал|бассейн|танц|школ[аыу]\s|детск\S*\s+(?:сад|центр|клуб)|автосервис|шиномонтаж|автомойк|ветеринар|ветклиник|массаж|спа\b|гостиниц|отел|хостел|магазин|ателье|химчистк|бар\b|кабинет|центр/i;
/** Only online: no place to come to. */
const ONLINE_RE = /только онлайн|интернет-магазин|онлайн[- ](?:школ|курс|магазин|сервис|консультац)/i;
const PHONE_RE = /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/;
const ADDRESS_RE =
  /(?:^|[\s,])(?:ул\.|улица|пр-т|проспект|пер\.|переулок|шоссе|наб\.|набережная|бульвар|пл\.|площадь)\s/i;
const HOURS_RE =
  /(?:(?:пн|вт|ср|чт|пт|сб|вс|будни|выходные|ежедневно|каждый день)[^\d;\n]{0,24})?\d{1,2}[:.]\d{2}\s*[-–—]\s*\d{1,2}[:.]\d{2}|круглосуточно|без выходных/gi;
/** The specialists of a business. */
const STAFF_RE =
  /врач|доктор|специалист|мастер(?!ск)|тренер|преподавател|педагог|сотрудник|команд[ауеы]|персонал/i;
/** A step that shows something to the visitor (as the promises of V4-21). */
const VIEW_RE =
  /(?:^|[\s,;—-])(?:видит|увидит|видно|смотрит|посмотр\p{L}*|просматрива\p{L}*|показ\p{L}*|изуча\p{L}*|знакомит\p{L}*|читает|узна[её]т|находит|найд[её]т|сравнива\p{L}*)/iu;
/** A list of the staff already in the owner's words («врачи: терапевт, хирург»). */
const STAFF_LIST_RE = /(?:врач|специалист|мастер|сотрудник|тренер)\S*\s*:\s*\S/i;
const PUBLIC = new Set(["visitor", "client"]);
/** A catalog of services or a menu the visitor chooses from (a shop's products carry their own prices). */
const SERVICES_RE = /услуг|меню|прайс|процедур|блюд|напитк/i;
/** Goods with a cart: the shop prices them itself. */
const GOODS_RE = /товар|корзин/i;
/** A price already in the owner's words: an amount in roubles or «от 3500». */
const PRICE_TEXT_RE = /\d[\d\s\u00a0]*\s?(?:₽|руб)|(?<!\p{L})от\s+\d/iu;

function texts(brief: SystemBrief, prompt: string | null): string[] {
  return [
    prompt ?? "",
    brief.audience,
    ...brief.goals.flatMap((g) => [g.text, g.success]),
    ...brief.scenarios.flatMap((s) => [s.when, ...s.then]),
    ...brief.qa.map((q) => q.a),
  ];
}

const answered = (brief: SystemBrief, text: string) => brief.qa.some((q) => q.q === text);

/** Whether the brief needs the place question: a business with a place, no address or phone of it yet. */
export function needsPlace(brief: SystemBrief, prompt: string | null): boolean {
  if (answered(brief, PLACE_QUESTION_TEXT)) return false;
  const all = texts(brief, prompt).join("\n");
  const booking = brief.scenarios.some((s) => s.moduleHint === "booking");
  if (!booking && (!PLACE_RE.test(all) || ONLINE_RE.test(all))) return false;
  return !PHONE_RE.test(all) && !ADDRESS_RE.test(all);
}

/** Whether the brief needs the staff question: a public scenario shows the specialists, the brief does not list them. */
export function needsStaff(brief: SystemBrief, prompt: string | null): boolean {
  if (answered(brief, STAFF_QUESTION_TEXT)) return false;
  const shows = brief.scenarios.some(
    (s) => PUBLIC.has(s.actor) && [s.when, ...s.then].some((t) => VIEW_RE.test(t) && STAFF_RE.test(t)),
  );
  return shows && !texts(brief, prompt).some((t) => STAFF_LIST_RE.test(t));
}

/**
 * Whether the brief needs the prices question: a business with services or a menu (a clinic, a salon, a café) whose
 * brief names no price yet. A shop's products are priced in the shop itself.
 */
export function needsPrices(brief: SystemBrief, prompt: string | null): boolean {
  if (answered(brief, PRICE_QUESTION_TEXT)) return false;
  const all = texts(brief, prompt).join("\n");
  if (GOODS_RE.test(all)) return false;
  const booking = brief.scenarios.some((s) => s.moduleHint === "booking");
  const catalog = brief.scenarios.some((s) => s.moduleHint === "catalog");
  const offer = booking || ((catalog || PLACE_RE.test(all)) && SERVICES_RE.test(all));
  return offer && !PRICE_TEXT_RE.test(all);
}

/** The question of the place: the owner writes it in his words; the options are what to do without it. */
export function placeQuestion(): FallbackQuestion {
  return {
    topic: "content",
    text: PLACE_QUESTION_TEXT,
    whyItMatters:
      "Без адреса, телефона и часов работы на сайте не будет блока контактов — клиенту не найти вас.",
    recommendation:
      "Напишите своими словами в поле ответа, например: «Казань, ул. Баумана, 12; +7 843 000-00-00; пн–пт 9:00–20:00». Не готовы — соберём без контактов, добавите потом правкой.",
    options: [
      { id: "later", label: "Добавлю потом — пока без контактов", recommended: true },
      { id: "online", label: "У нас нет адреса — работаем онлайн", recommended: false },
      { id: "form", label: "Только форма заявки на сайте", recommended: false },
    ],
    allowDelegate: true,
    patches: {},
  };
}

/** The question of the specialists: names and specialisations as the owner writes them. */
export function staffQuestion(): FallbackQuestion {
  return {
    topic: "content",
    text: STAFF_QUESTION_TEXT,
    whyItMatters:
      "Сценарий обещает показать специалистов: без их имён на сайте будут только направления работы.",
    recommendation:
      "Напишите через запятую, например: «Анна Смирнова — терапевт, Игорь Ким — хирург». Можно пропустить — покажем направления работы, специалистов добавите потом.",
    options: [
      { id: "skip", label: "Пропустить — покажите направления работы", recommended: true },
      { id: "none", label: "Специалистов на сайте не показываем", recommended: false },
      { id: "later", label: "Добавлю потом правкой", recommended: false },
    ],
    allowDelegate: true,
    patches: {},
  };
}

/** The question of the prices «от»: each main service with its starting price, as the owner writes them. */
export function priceQuestion(): FallbackQuestion {
  return {
    topic: "content",
    text: PRICE_QUESTION_TEXT,
    whyItMatters:
      "Цена «от» — первое, что ищет клиент. Без цен покажем услуги без них: выдумывать цены мы не будем.",
    recommendation:
      "Напишите через точку с запятой, например: «Лечение кариеса — от 3500; Профессиональная чистка — 4000». Не готовы — соберём без цен, добавите потом правкой.",
    options: [
      { id: "later", label: "Добавлю потом — пока без цен", recommended: true },
      { id: "request", label: "Цены по запросу", recommended: false },
      { id: "none", label: "Цены на сайте не показываем", recommended: false },
    ],
    allowDelegate: true,
    patches: {},
  };
}

/** The next question of the facts the brief still needs (the place first), or null. */
export function nextFactQuestion(
  brief: SystemBrief,
  prompt: string | null,
): { kind: FactQuestionKind; question: FallbackQuestion } | null {
  if (needsPlace(brief, prompt)) return { kind: "place", question: placeQuestion() };
  if (needsStaff(brief, prompt)) return { kind: "staff", question: staffQuestion() };
  if (needsPrices(brief, prompt)) return { kind: "prices", question: priceQuestion() };
  return null;
}

/** Whether a question text is one of the fact questions (its answer ends the turn without a model call). */
export const isFactQuestion = (text: string): boolean =>
  text === PLACE_QUESTION_TEXT || text === STAFF_QUESTION_TEXT || text === PRICE_QUESTION_TEXT;

/**
 * The phone of the business in the owner's answer to the place question, taken out of the text before it is scrubbed
 * (D79 (3): the build stages go to the allowlist models unmasked; the owner gives this phone to publish it on his site —
 * not the end users' data). Only this answer and only the phone; the rest is scrubbed as every answer.
 */
export function splitPlacePhone(text: string): { rest: string; phone: string | null } {
  const phone = PHONE_RE.exec(text)?.[0]?.trim() ?? null;
  return {
    rest: phone
      ? text
          .replace(phone, " ")
          .replace(/\s{2,}/g, " ")
          .trim()
      : text,
    phone,
  };
}

/** The owner's own answer of a fact question (a button answer is no fact). */
function ownAnswer(brief: Pick<SystemBrief, "qa">, text: string): string | null {
  const q = brief.qa.find((x) => x.q === text && x.chosen === "custom");
  return q?.a.trim() || null;
}

/** Where to find the business, as the owner wrote it: the address, the phone and the opening hours (each if given). */
export function placeFacts(brief: Pick<SystemBrief, "qa">): {
  address?: string;
  phone?: string;
  hours?: string;
} {
  const a = ownAnswer(brief, PLACE_QUESTION_TEXT);
  if (!a) return {};
  const phone = PHONE_RE.exec(a)?.[0]?.trim();
  const hours = [...a.matchAll(HOURS_RE)].map((m) => m[0].trim()).join(", ");
  // The address: what is left of the parts once the phone, the hours, an e-mail and the labels are taken out.
  const address = a
    .split(/[;\n]+/)
    .map((p) =>
      p
        .replace(PHONE_RE, "")
        .replace(HOURS_RE, "")
        .replace(/[^\s@,;]+@[^\s@,;]+/g, "")
        .replace(
          /(?<!\p{L})(?:адрес|телефон|тел\.?|часы работы|часы|режим работы|график)(?!\p{L})\s*:?/giu,
          "",
        )
        .replace(/^[\s,.:—–-]+|[\s,.:—–-]+$/g, "")
        .trim(),
    )
    .filter((p) => /\p{L}{2,}/u.test(p) && p.length >= 5 && !/^телефон$/i.test(p))
    .join(", ");
  return {
    ...(address ? { address: address.slice(0, 140) } : {}),
    ...(phone ? { phone } : {}),
    ...(hours ? { hours: hours.slice(0, 120) } : {}),
  };
}

/** The specialists as the owner wrote them («Анна Смирнова — терапевт»), each one entry; [] — none given. */
export function staffFacts(brief: Pick<SystemBrief, "qa">): string[] {
  const a = ownAnswer(brief, STAFF_QUESTION_TEXT);
  if (!a) return [];
  return a
    .split(/[,;\n]+/)
    .map((x) => x.replace(/^[\s\-–—•]+|[\s.]+$/g, "").trim())
    .filter((x) => /\p{L}{2,}/u.test(x))
    .slice(0, 12);
}

/** One priced service of the owner's answer: «Лечение кариеса — от 3 500 ₽» → {name, price: 3500}. */
const PRICED_RE =
  /^(.+?)[\s—–:-]*(?<!\p{L})(?:от\s*)?(\d{1,3}(?:[\s\u00a0]\d{3})+|\d+)(?:[.,]\d{1,2})?\s*(?:₽|руб\.?|рублей|р\.?)?$/iu;

/** The services with their prices «от» as the owner wrote them, in his order; [] — none given (a button is no fact). */
export function priceFacts(brief: Pick<SystemBrief, "qa">): { name: string; price: number }[] {
  const a = ownAnswer(brief, PRICE_QUESTION_TEXT);
  if (!a) return [];
  const out: { name: string; price: number }[] = [];
  for (const part of a.split(/[;\n]+|,(?=\s*\p{Lu})/u)) {
    const m = PRICED_RE.exec(part.trim());
    if (!m) continue;
    const name = (m[1] as string)
      .replace(/[\s—–:-]+$/u, "")
      .replace(/\s+от$/iu, "")
      .trim();
    const price = Number((m[2] as string).replace(/[\s\u00a0]/g, ""));
    if (/\p{L}{2,}/u.test(name) && price > 0 && !out.some((x) => x.name.toLowerCase() === name.toLowerCase()))
      out.push({ name, price });
  }
  return out.slice(0, 12);
}
