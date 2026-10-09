// Plausible non-personal seed values (qa.yaml#seed.rules MAY-hint, done in code): titles, descriptions, prices and
// capacities by entity/field name, label and type. Only fields with pii=none reach this module; people-shaped values
// stay in the synthetic dictionary of seed.ts. Deterministic: every value comes from a faker instance seeded by
// (key, entity, field, row).
import { createHash } from "node:crypto";
import { base, Faker, ru } from "@faker-js/faker";
import type { AppSpec, Entity, Field } from "@wizard/appspec";
import { detect } from "@wizard/pii";

export interface RealCtx {
  key: string;
  /** Lower-cased domain text of the spec (app name, description, entity labels): see domainHint. */
  hint: string;
  entity: Entity;
  field: Field;
  /** Row index inside the entity. */
  i: number;
  /** Generator-wide counter: unique fields derive from it. */
  n: number;
}

const faker = new Faker({ locale: [ru, base] });

function seedOf(...parts: (string | number)[]): number {
  return createHash("sha256").update(parts.join("\u0000")).digest().readUInt32BE(0);
}

/** Domain text for the hints: app name, description, entity names and labels. */
export function domainHint(spec: AppSpec): string {
  return [spec.app.name, spec.app.description ?? "", ...spec.entities.flatMap((e) => [e.name, e.label])]
    .join(" ")
    .toLowerCase();
}

/**
 * Row `i` of a list, rotated by a key-dependent offset: rows of one entity never repeat before the list ends.
 * `group` shares the offset between fields of one row (name ↔ description ↔ price).
 */
function rotate<T>(list: readonly T[], c: RealCtx, group?: string): T {
  const off = seedOf(c.key, c.entity.name, group ?? c.field.name) % list.length;
  return list[(off + c.i) % list.length] as T;
}

function rng(c: RealCtx): Faker {
  faker.seed(seedOf(c.key, c.entity.name, c.field.name, c.i, c.n));
  return faker;
}

const test = (re: RegExp, ...s: (string | undefined)[]) => s.some((x) => x !== undefined && re.test(x));
const fieldIs = (c: RealCtx, name: RegExp, label?: RegExp) =>
  test(name, c.field.name) || (label !== undefined && test(label, c.field.label));
const entityIs = (c: RealCtx, name: RegExp, label?: RegExp) =>
  test(name, c.entity.name) || (label !== undefined && test(label, c.entity.label));

/** Enum value the seed puts into row `i` (seed.ts: opts[i % len]). */
function enumAt(e: Entity, i: number, ...names: string[]): string | undefined {
  const f = e.fields.find((x) => x.type === "enum" && (names.length === 0 || names.includes(x.name)));
  const opts = f?.enum ?? [];
  return opts.length ? opts[i % opts.length]?.value : undefined;
}

// ------------------------------------------------------------------ vocabulary (fictional, no people)
const TICKET_TYPES: Record<string, { name: string; about: string; price: number; capacity: number }> = {
  standard: {
    name: "Стандарт",
    about: "Доступ ко всем потокам, кофе-брейки и материалы форума",
    price: 4900,
    capacity: 400,
  },
  vip: {
    name: "VIP",
    about: "Первые ряды, VIP-зона с обедом, нетворкинг со спикерами и записи докладов",
    price: 14900,
    capacity: 60,
  },
  partner: {
    name: "Партнёрский",
    about: "Бесплатный билет по промокоду компании-партнёра",
    price: 0,
    capacity: 150,
  },
  student: {
    name: "Студенческий",
    about: "Для студентов очной формы по студенческому билету",
    price: 1900,
    capacity: 80,
  },
  online: { name: "Онлайн", about: "Трансляция всех потоков и записи докладов", price: 1500, capacity: 1000 },
  free: { name: "Бесплатный", about: "Вход на открытые сессии и выставку", price: 0, capacity: 300 },
};
const TICKET_ORDER = ["standard", "vip", "partner", "student", "online"];

const STREAMS = [
  {
    name: "Ритейл-технологии",
    about: "Автоматизация магазинов, кассы самообслуживания и электронные ценники",
  },
  {
    name: "Маркетинг и лояльность",
    about: "Программы лояльности, персональные предложения и работа с отзывами",
  },
  { name: "Логистика и склад", about: "Доставка последней мили, WMS и управление запасами" },
  { name: "Данные и аналитика", about: "Прогноз спроса, аналитика продаж и A/B-тесты в офлайне" },
  {
    name: "E-commerce и маркетплейсы",
    about: "Собственный интернет-магазин против маркетплейсов: экономика и кейсы",
  },
  { name: "Команда и сервис", about: "Найм, обучение персонала и стандарты обслуживания" },
];

const TALKS = [
  "Как сократить очереди на кассах вдвое",
  "Электронные ценники: опыт внедрения в сети",
  "Персональные предложения без утечек данных",
  "Прогноз спроса для свежих продуктов",
  "Склад за 90 дней: запуск WMS без остановки продаж",
  "Программа лояльности, которая окупается",
  "Маркетплейс или свой сайт: считаем экономику",
  "Панельная дискуссия: будущее офлайн-магазинов",
  "Кассы самообслуживания: ошибки первого года",
  "Открытие форума и итоги года в ритейле",
];
const ABSTRACTS = [
  "Разберём кейс сети из 40 магазинов: что изменили в процессах, какие метрики выросли и что не сработало.",
  "Покажем пошаговый план внедрения, бюджет и сроки, а также типичные ошибки команды на старте.",
  "Поделимся цифрами до и после, расскажем о выборе подрядчика и о том, как убедить руководство.",
  "Практический доклад с примерами дашбордов и шаблонами, которые можно забрать себе.",
  "Сравним три подхода на реальных данных и обсудим, какой подходит небольшим сетям.",
];
const ROOMS = ["Большой зал", "Зал А", "Зал Б", "Лекторий", "Малый зал", "Амфитеатр"];
const GATES = ["Главный вход", "Вход А", "Вход Б", "Служебный вход"];
const COMPANIES = [
  "ООО «Полярная звезда»",
  "АО «Балтийский торговый дом»",
  "ООО «Ладога Маркет»",
  "ООО «Вкусный квартал»",
  "ООО «Невская логистика»",
  "АО «Онежская торговля»",
  "ООО «Северный склад»",
  "ООО «Белые ночи ритейл»",
];
const MOD_COMMENTS = [
  "Хорошая тема, сократите до 20 минут",
  "Добавьте больше цифр и один живой кейс",
  "Похожий доклад уже есть в программе",
  "Берём в поток, пришлите слайды за неделю",
];
const PROMO_PREFIX = ["NORD", "RETAIL", "PARTNER", "FORUM", "SEVER"];

const CAKES = [
  { name: "Торт «Наполеон»", about: "Тонкие слоёные коржи и заварной крем на сливочном масле", price: 3200 },
  { name: "Торт «Медовик»", about: "Медовые коржи со сметанным кремом", price: 2900 },
  { name: "Торт «Красный бархат»", about: "Бисквит с какао и крем-чиз", price: 3900 },
  { name: "Чизкейк «Нью-Йорк»", about: "Классический запечённый чизкейк на песочной основе", price: 3500 },
  { name: "Торт «Прага»", about: "Шоколадный бисквит, пропитка и шоколадная глазурь", price: 3400 },
  { name: "Торт «Птичье молоко»", about: "Нежное суфле на агаре в шоколаде", price: 3100 },
  { name: "Морковный торт", about: "Пряный бисквит с грецким орехом и сливочным кремом", price: 3300 },
  { name: "Торт «Павлова»", about: "Хрустящая меренга, маскарпоне и свежие ягоды", price: 3600 },
];
const CAKE_OPTIONS: Record<string, { title: string; price: number; kg?: number }[]> = {
  weight: [
    { title: "1 кг", price: 0, kg: 1 },
    { title: "1,5 кг", price: 1200, kg: 1.5 },
    { title: "2 кг", price: 2400, kg: 2 },
    { title: "3 кг", price: 4800, kg: 3 },
  ],
  filling: [
    { title: "Вишня", price: 300 },
    { title: "Солёная карамель", price: 400 },
    { title: "Клубника со сливками", price: 500 },
    { title: "Манго и маракуйя", price: 600 },
  ],
  decor: [
    { title: "Свежие ягоды", price: 500 },
    { title: "Надпись шоколадом", price: 200 },
    { title: "Съедобное фото", price: 700 },
    { title: "Живые цветы", price: 900 },
  ],
};
const INSCRIPTIONS = [
  "С днём рождения!",
  "С юбилеем!",
  "Поздравляем с выпускным!",
  "Счастья и любви!",
  "С праздником!",
];
const ORDER_NOTES = [
  "Без орехов, пожалуйста",
  "Упаковать в коробку с лентой",
  "Заберём после 18:00",
  "Свечи не нужны",
  "Позвоним за час до выезда",
];
/**
 * Round prices by the niche of the spec (₽, multiples of 100) for required money fields without a domain vocabulary;
 * an optional price stays empty («по запросу») — the owner sets it (D49: nothing invented beyond a plausible demo).
 */
const NICHE_PRICES: readonly [RegExp, readonly number[]][] = [
  [
    /(?<![а-яё])(?:тур(?!ник)|отел)|путешеств|гостиниц|хостел|отдых|экскурс/,
    [15000, 24000, 32000, 45000, 60000],
  ],
  [/ремонт|отделк|строит|интерьер|мебел|клининг|уборк/, [5000, 12000, 25000, 40000, 80000]],
  [/клиник|стомат|врач|медиц|ветеринар/, [1500, 2500, 3500, 5000, 7000]],
  [/салон|красот|маникюр|барбер|парикмах|стрижк|массаж|космет|ресниц|бров/, [1200, 1800, 2500, 3200, 4500]],
  [
    /школ|курс|обучен|репетит|урок|заняти|тренир|фитнес|(?<![а-яё])йог(?!урт)/,
    [1500, 2500, 4000, 6000, 9000],
  ],
  [/кафе(?!др)|кофе|ресторан|пицц|бургер|суши|обед/, [300, 400, 500, 700, 900]],
];
const DEFAULT_PRICES = [1000, 1500, 2000, 3000, 5000];
const nichePrices = (hint: string) => NICHE_PRICES.find(([re]) => re.test(hint))?.[1] ?? DEFAULT_PRICES;
/** Service durations on the booking grid (minutes). */
const DURATIONS = [60, 90, 30, 120];
const HOURS = ["Пн–Пт 10:00–19:00", "Ежедневно 10:00–20:00", "Пн–Сб 09:00–21:00"];

// ------------------------------------------------------------------ domains
const isTicketType = (c: RealCtx) => entityIs(c, /ticket_?type|pass_type/, /тип билета|вид билета/i);
const isStream = (c: RealCtx) => entityIs(c, /^(stream|track|section)s?$/, /^(поток|трек|секция)/i);
const isTalk = (c: RealCtx) =>
  entityIs(c, /session|talk|speaker_application|lecture/, /доклад|сесси|заявка спикера/i);
const BAKERY = /торт|кондитер|выпеч|пекар|десерт/;
const isCake = (c: RealCtx) =>
  entityIs(c, /^(product|cake|dessert)s?$/, /изделие|торт|десерт/i) &&
  !entityIs(c, /option/) &&
  (BAKERY.test(c.hint) || entityIs(c, /cake/, /торт/i));
const isProductOption = (c: RealCtx) => entityIs(c, /option/, /опци/i) && BAKERY.test(c.hint);
const isOrder = (c: RealCtx) => entityIs(c, /order/, /заказ/i);

const NAME_RE = /^(name|title|label|caption)$/;
const NAME_LABEL = /^(название|наименование|заголовок)/i;
const DESC_RE = /description|about|details|summary|includes/;
const DESC_LABEL = /описание|что входит|подробн/i;
const SLUG_RE = /(^|_)slug$|^permalink$|^url_?path$/;
const SLUG_LABEL = /латиниц|^адрес (статьи|страницы|рубрики|раздела)|^slug|^url/i;
const ADDRESS_RE = /(^|_)address$|^location$/;
const ADDRESS_LABEL = /^адрес$|^адрес (пункта|точки|магазина|офиса|филиала)/i;
const HOURS_RE = /hours|schedule|opening|work_?time/;
const HOURS_LABEL = /часы работы|режим работы|график работы/i;
const SKU_RE = /^(sku|vendor_code|article_?(no|number|code))$/;
const SKU_LABEL = /^артикул/i;
/** A place a visitor comes to (pickup point, branch, office): its address is the business's, not a person's. */
const isPlace = (c: RealCtx) =>
  entityIs(c, /point|branch|office|store|location/, /пункт|филиал|офис|магазин|точк/i);

const fieldTest = (f: Pick<Field, "name" | "label">, name: RegExp, label: RegExp) =>
  name.test(f.name) || label.test(f.label);
/** Search-engine fields (seo_title, seo_description): empty by default, the page falls back to its title. */
const SEO_RE = /(^|_)(seo|meta|og)(_|$)/;
const SEO_LABEL = /поисков/i;
/** Title-like field (name, title): what a slug and a hint of the brief are about. */
export const isNameField = (f: Pick<Field, "name" | "label">) =>
  fieldTest(f, NAME_RE, NAME_LABEL) && !fieldTest(f, SEO_RE, SEO_LABEL);
/** Free-text field of a row (description, about, a text): dropped when the row's name comes from a hint. */
export const isDescriptionField = (f: Pick<Field, "name" | "label" | "type">) =>
  f.type === "text" || fieldTest(f, DESC_RE, DESC_LABEL);
/** Address part of a page URL (slug): Latin, digits and hyphens. */
export const isSlugField = (f: Pick<Field, "name" | "label" | "type">) =>
  f.type === "string" && fieldTest(f, SLUG_RE, SLUG_LABEL);

const TRANSLIT: Readonly<Record<string, string>> = {
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
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

/** «Дизайн квартиры» → «dizayn-kvartiry»: Latin lower case, digits and hyphens, at most `max` characters. */
export function slugify(text: string, max = 80): string {
  const s = [...text.toLowerCase()]
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf("-");
  return (at > 0 ? cut.slice(0, at) : cut).replace(/-+$/, "");
}

/** «Раздел магазина» → «Раздел»: the entity's label without the module's qualifier, for a neutral row name. */
function neutralLabel(e: Entity): string {
  const label = e.label.trim() || e.name;
  const m = /^(Раздел|Категория|Рубрика|Группа)\s+\S+$/iu.exec(label);
  const out = m ? (m[1] as string) : label;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function ticketKind(c: RealCtx): keyof typeof TICKET_TYPES {
  const v = enumAt(c.entity, c.i);
  if (v && v in TICKET_TYPES) return v as keyof typeof TICKET_TYPES;
  return (TICKET_ORDER[c.i % TICKET_ORDER.length] ?? "standard") as keyof typeof TICKET_TYPES;
}

function stringValue(c: RealCtx): string | null | undefined {
  const f = rng(c);
  const unique = c.field.unique === true;
  if (fieldIs(c, /promo|coupon|voucher/, /промокод|купон/i)) return `${rotate(PROMO_PREFIX, c)}${10 + c.n}`;
  if (fieldIs(c, /(provider|external|payment)_?(payment_)?id$/, /id платежа/i)) {
    // ~0.3% of random UUIDs hold a digit run that reads as a phone/INN/account; draw again (attempt 0 keeps the
    // original value, so existing seeds do not change).
    for (let k = 0; k < 16; k++) {
      f.seed(k === 0 ? seedOf(c.key, "provider-id", c.n) : seedOf(c.key, "provider-id", c.n, k));
      const id = f.string.uuid();
      if (detect(id).length === 0) return id;
    }
    return undefined;
  }
  // A page address: Latin from the entity's label and the counter (unique); the seed re-derives it from the row's title.
  if (isSlugField(c.field)) return `${slugify(neutralLabel(c.entity)) || "item"}-${c.n}`;
  if (fieldIs(c, SKU_RE, SKU_LABEL)) return `A-${String(unique ? c.n : c.i + 1).padStart(4, "0")}`;
  if (unique) return undefined;
  if (fieldIs(c, /company|organization|org_name|employer/, /компани|организац/i)) return rotate(COMPANIES, c);
  if (fieldIs(c, /room|hall|venue|auditorium/, /^(зал|аудитория|помещение)/i)) return rotate(ROOMS, c);
  if (fieldIs(c, /gate|checkpoint|entrance/, /^(вход|точка прохода|кпп)/i)) return rotate(GATES, c);
  if (fieldIs(c, /device/, /устройств/i)) return `tsd-${String((c.i % 9) + 1).padStart(2, "0")}`;
  if (fieldIs(c, /inscription|greeting/, /надпись/i)) return rotate(INSCRIPTIONS, c);
  if (fieldIs(c, /topic|subject/, /^тема/i)) return rotate(TALKS, c);
  if (fieldIs(c, HOURS_RE, HOURS_LABEL)) return rotate(HOURS, c);
  // A business's address (a pickup point): obviously a demo street of the synthetic dictionary, never a real one.
  if (fieldIs(c, ADDRESS_RE, ADDRESS_LABEL) && (isPlace(c) || c.field.required))
    return `ул. Тестовая, д. ${c.i + 1}`;
  if (fieldIs(c, SEO_RE, SEO_LABEL)) return c.field.required ? undefined : null;
  if (isNameField(c.field)) {
    if (isTicketType(c)) return TICKET_TYPES[ticketKind(c)]?.name;
    if (isStream(c)) return rotate(STREAMS, c, "row").name;
    if (isTalk(c)) return rotate(TALKS, c);
    if (isCake(c)) return rotate(CAKES, c, "row").name;
    if (isProductOption(c)) {
      const opts = CAKE_OPTIONS[enumAt(c.entity, c.i) ?? ""];
      if (opts) return opts[Math.floor(c.i / 3) % opts.length]?.title;
    }
    // No vocabulary: the entity's label and the row's number («Услуга 1»), never an invented adjective.
    return `${neutralLabel(c.entity)} ${c.i + 1}`;
  }
  if (c.field.type === "text" || fieldIs(c, DESC_RE, DESC_LABEL)) return textValue(c);
  // Any other optional text stays empty: a «<label> N» placeholder would show on the preview.
  return c.field.required ? undefined : null;
}

/** Description-like text: a domain vocabulary, else empty (an optional field) — never an invented claim (D49). */
function textValue(c: RealCtx): string | null | undefined {
  if (fieldIs(c, /abstract/, /описание доклада|тезисы/i)) return rotate(ABSTRACTS, c);
  if (fieldIs(c, /moderator|review|comment/, /комментарий модератора|рецензи/i) && isTalk(c))
    return rotate(MOD_COMMENTS, c);
  if (fieldIs(c, /note|comment|wish/, /комментарий|пожелани|примечани/i) && isOrder(c))
    return rotate(ORDER_NOTES, c);
  if (isTicketType(c)) return TICKET_TYPES[ticketKind(c)]?.about ?? "";
  if (isStream(c)) return rotate(STREAMS, c, "row").about;
  if (isCake(c)) return rotate(CAKES, c, "row").about;
  if (isTalk(c)) return rotate(ABSTRACTS, c);
  return c.field.required ? undefined : null;
}

const clamp = (v: number, f: Field) => Math.min(Math.max(v, f.min ?? v), f.max ?? v);
const round100 = (v: number) => Math.round(v / 100) * 100;

function moneyValue(c: RealCtx): number | null | undefined {
  if (c.field.unique) return undefined;
  let v: number | undefined;
  if (isTicketType(c)) v = TICKET_TYPES[ticketKind(c)]?.price;
  else if (isProductOption(c)) {
    const opts = CAKE_OPTIONS[enumAt(c.entity, c.i) ?? ""];
    v = opts?.[Math.floor(c.i / 3) % opts.length]?.price;
  } else if (isCake(c) || isOrder(c)) {
    const total = rotate(CAKES, c, "row").price + 500 * (c.i % 3);
    if (fieldIs(c, /prepay|deposit|advance/, /предоплат|аванс/i)) v = round100(total / 2);
    else if (fieldIs(c, /remaining|balance|due/, /доплат|остаток/i)) v = total - round100(total / 2);
    else v = total;
  } else if (BAKERY.test(c.hint) && fieldIs(c, /amount|sum|total|price|cost/)) {
    v = round100(rotate(CAKES, c).price / 2);
  } else if (!c.field.required) {
    // An optional price without a vocabulary stays empty: the showcase says «по запросу» until the owner sets it.
    return null;
  }
  v ??= rotate(nichePrices(c.hint), c, "row");
  const lo = c.field.min ?? 0;
  if (v < lo || (c.field.max !== undefined && v > c.field.max)) return undefined;
  return v;
}

function intValue(c: RealCtx): number | undefined {
  const f = rng(c);
  if (fieldIs(c, /(^|_)(number|num|no)$/, /^номер/i) && c.field.unique) return clamp(1000 + c.n, c.field);
  if (c.field.unique) return undefined;
  if (fieldIs(c, /sort|order|position|priority|rank/, /порядок|позици/i)) return clamp(c.i + 1, c.field);
  if (fieldIs(c, /used|sold|taken|issued/, /использовано|продано|выдано/i)) return clamp(c.i % 4, c.field);
  // A line of an order: one to three pieces, not a stock-sized quantity.
  if (isOrder(c) && fieldIs(c, /^(qty|quantity)$/, /^количеств/i))
    return clamp(rotate([1, 2, 1, 3], c), c.field);
  if (
    fieldIs(
      c,
      /capacity|total|limit|seats|quota|stock|quantity|qty|places/,
      /вместимост|всего|лимит|мест|в день|остаток/i,
    )
  ) {
    let v: number;
    if (isTicketType(c)) v = TICKET_TYPES[ticketKind(c)]?.capacity ?? 100;
    else if (isStream(c)) v = rotate([300, 200, 150, 250, 120, 180], c);
    else if (test(/в день/i, c.field.label) || entityIs(c, /slot|day/)) v = rotate([10, 12, 8, 15, 6], c);
    else v = rotate([20, 30, 50, 25, 40], c);
    return clamp(v, c.field);
  }
  // Durations on the booking grid (30/60/90/120 min), never a random number of minutes.
  if (fieldIs(c, /duration|minutes/, /длительн/i)) return clamp(rotate(DURATIONS, c), c.field);
  if (fieldIs(c, /weight|(^|_)grams?$/, /^вес/i)) return clamp(rotate([250, 500, 1000, 1500], c), c.field);
  const lo = c.field.min ?? 1;
  const hi = c.field.max ?? Math.max(lo + 100, 100);
  return f.number.int({ min: Math.ceil(lo), max: Math.max(Math.ceil(lo), Math.floor(hi)) });
}

function decimalValue(c: RealCtx): number | null | undefined {
  if (c.field.unique) return undefined;
  if (fieldIs(c, /weight|kg|mass/, /вес/i)) {
    const opts = isProductOption(c) ? CAKE_OPTIONS[enumAt(c.entity, c.i) ?? ""] : undefined;
    if (isProductOption(c) && !opts?.[0]?.kg) return c.field.required ? undefined : null;
    const kg = opts?.[Math.floor(c.i / 3) % opts.length]?.kg ?? rotate([1, 1.5, 2, 2.5], c);
    return clamp(kg, c.field);
  }
  return undefined;
}

function boolValue(c: RealCtx): boolean | undefined {
  if (
    fieldIs(
      c,
      /active|enabled|published|available|visible|on_sale|is_open/,
      /в продаже|доступн|активн|опубликован/i,
    )
  )
    return true;
  if (
    fieldIs(
      c,
      /closed|archived|offline|deleted|blocked|hidden|canceled|cancelled/,
      /выходной|архив|без сети|скрыт/i,
    )
  )
    return c.i % 5 === 4;
  return undefined;
}

/** Plausible value for a pii=none field; null → leave the optional column empty; undefined → neutral fallback. */
export function realisticValue(c: RealCtx): unknown {
  switch (c.field.type) {
    case "string":
    case "text":
      return stringValue(c);
    case "money":
      return moneyValue(c);
    case "int":
      return intValue(c);
    case "decimal":
      return decimalValue(c);
    case "bool":
      return boolValue(c);
    default:
      return undefined;
  }
}
