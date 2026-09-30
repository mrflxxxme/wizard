// Plausible non-personal seed values (qa.yaml#seed.rules MAY-hint, done in code): titles, descriptions, prices and
// capacities by entity/field name, label and type. Only fields with pii=none reach this module; people-shaped values
// stay in the synthetic dictionary of seed.ts. Deterministic: every value comes from a faker instance seeded by
// (key, entity, field, row).
import { createHash } from "node:crypto";
import { base, Faker, ru } from "@faker-js/faker";
import type { AppSpec, Entity, Field } from "@wizard/appspec";

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
const GENERIC_TITLES = [
  "Основной",
  "Пробный",
  "Весенний",
  "Базовый",
  "Расширенный",
  "Летний",
  "Новый",
  "Особый",
];
const GENERIC_TEXT = [
  "Короткое описание: что входит и для кого подходит.",
  "Подробности и условия — в карточке записи.",
  "Популярный вариант среди клиентов.",
  "Доступно по предварительной договорённости.",
];
const NICE_PRICES = [1000, 1500, 2500, 3900, 4900, 7500, 12000];

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

function ticketKind(c: RealCtx): keyof typeof TICKET_TYPES {
  const v = enumAt(c.entity, c.i);
  if (v && v in TICKET_TYPES) return v as keyof typeof TICKET_TYPES;
  return (TICKET_ORDER[c.i % TICKET_ORDER.length] ?? "standard") as keyof typeof TICKET_TYPES;
}

function stringValue(c: RealCtx): string | undefined {
  const f = rng(c);
  const unique = c.field.unique === true;
  if (fieldIs(c, /promo|coupon|voucher/, /промокод|купон/i)) return `${rotate(PROMO_PREFIX, c)}${10 + c.n}`;
  if (fieldIs(c, /(provider|external|payment)_?(payment_)?id$/, /id платежа/i)) {
    f.seed(seedOf(c.key, "provider-id", c.n));
    return f.string.uuid();
  }
  if (unique) return undefined;
  if (fieldIs(c, /company|organization|org_name|employer/, /компани|организац/i)) return rotate(COMPANIES, c);
  if (fieldIs(c, /room|hall|venue|auditorium/, /^(зал|аудитория|помещение)/i)) return rotate(ROOMS, c);
  if (fieldIs(c, /gate|checkpoint|entrance/, /^(вход|точка прохода|кпп)/i)) return rotate(GATES, c);
  if (fieldIs(c, /device/, /устройств/i)) return `tsd-${String((c.i % 9) + 1).padStart(2, "0")}`;
  if (fieldIs(c, /inscription|greeting/, /надпись/i)) return rotate(INSCRIPTIONS, c);
  if (fieldIs(c, /topic|subject/, /^тема/i)) return rotate(TALKS, c);
  const nameLike = fieldIs(c, NAME_RE, NAME_LABEL);
  if (nameLike) {
    if (isTicketType(c)) return TICKET_TYPES[ticketKind(c)]?.name;
    if (isStream(c)) return rotate(STREAMS, c, "row").name;
    if (isTalk(c)) return rotate(TALKS, c);
    if (isCake(c)) return rotate(CAKES, c, "row").name;
    if (isProductOption(c)) {
      const opts = CAKE_OPTIONS[enumAt(c.entity, c.i) ?? ""];
      if (opts) return opts[Math.floor(c.i / 3) % opts.length]?.title;
    }
    return `${c.entity.label} «${f.helpers.arrayElement(GENERIC_TITLES)}»`;
  }
  if (c.field.type === "text" || fieldIs(c, DESC_RE, DESC_LABEL)) return textValue(c);
  return undefined;
}

function textValue(c: RealCtx): string {
  if (fieldIs(c, /abstract/, /описание доклада|тезисы/i)) return rotate(ABSTRACTS, c);
  if (fieldIs(c, /moderator|review|comment/, /комментарий модератора|рецензи/i) && isTalk(c))
    return rotate(MOD_COMMENTS, c);
  if (fieldIs(c, /note|comment|wish/, /комментарий|пожелани|примечани/i) && isOrder(c))
    return rotate(ORDER_NOTES, c);
  if (isTicketType(c)) return TICKET_TYPES[ticketKind(c)]?.about ?? "";
  if (isStream(c)) return rotate(STREAMS, c, "row").about;
  if (isCake(c)) return rotate(CAKES, c, "row").about;
  if (isTalk(c)) return rotate(ABSTRACTS, c);
  return rng(c).helpers.arrayElement(GENERIC_TEXT);
}

const clamp = (v: number, f: Field) => Math.min(Math.max(v, f.min ?? v), f.max ?? v);
const round100 = (v: number) => Math.round(v / 100) * 100;

function moneyValue(c: RealCtx): number | undefined {
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
  } else if (fieldIs(c, /amount|sum|total|price|cost/)) {
    v = BAKERY.test(c.hint) ? round100(rotate(CAKES, c).price / 2) : rotate([4900, 14900, 4900, 1900], c);
  }
  v ??= rotate(NICE_PRICES, c);
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
