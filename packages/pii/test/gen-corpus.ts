// Synthetic PII corpus for packages/pii (specs/security/data-boundary.yaml#detectors.quality, backlog M0-05).
// Deterministic (seeded PRNG); independent of src/ on purpose — checksums are re-implemented here.
// Every value is synthetic: random digits with valid checksums, names from a small common-name list.
//
// Run: node packages/pii/test/gen-corpus.ts   → writes packages/pii/test/corpus.ru.jsonl

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface CorpusSpan {
  kind: string;
  start: number;
  end: number;
}
export interface CorpusLine {
  id: string;
  /** positive — contains PII; trap — must produce no findings; hard — known-difficult cases (both kinds), scored only. */
  group: "positive" | "trap" | "hard";
  text: string;
  spans: CorpusSpan[];
}

type Part = string | [kind: string, value: string];
type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ vocabulary

const MALE = "Иван Сергей Алексей Дмитрий Андрей Михаил Николай Павел Артём Максим Егор Кирилл Олег Игорь Юрий Виктор Тимур Глеб Фёдор Станислав".split(" ");
const FEMALE = "Анна Мария Елена Ольга Татьяна Наталья Екатерина Ирина Светлана Юлия Дарья Ксения Полина Алина Марина Людмила Галина Виктория Софья Валентина".split(" ");
const DIMINUTIVE = "Саша Маша Даша Паша Катя Таня Оля Лёша Дима Женя Настя Серёжа Коля Юля Миша".split(" ");
const AMBIGUOUS_F = "Вера Надежда Любовь".split(" ");
const AMBIGUOUS_M = "Роман Лев".split(" ");
const SURNAME_M = "Иванов Смирнов Кузнецов Попов Васильев Петров Соколов Михайлов Новиков Фёдоров Морозов Волков Лебедев Козлов Орлов Никитин Захаров Зайцев Соловьёв Сорокин Ильин Медведев Жуков Белов Крылов Голубев Шевчук Бондаренко Ким Черных Тихомиров Покровский Вишневский Гончаренко Ткачук".split(" ");
const PATRONYMIC_BASE = "Иван Сергей Алексей Андрей Николай Александр Михаил Владимир Петр Юрий".split(" ");

function femSurname(s: string): string {
  if (/(ов|ев|ёв|ин|ын)$/.test(s)) return `${s}а`;
  if (/ский$/.test(s)) return s.replace(/ий$/, "ая");
  return s; // indeclinable (Шевчук, Бондаренко, Ким, Черных)
}
function patronymic(base: string, female: boolean): string {
  const stem = base === "Петр" ? "Петр" : base;
  if (/[йь]$/.test(stem)) {
    const s = stem.slice(0, -1);
    return female ? `${s}евна` : `${s}евич`;
  }
  return female ? `${stem}овна` : `${stem}ович`;
}

const LATIN_NAMES = [
  "Ivan Petrov",
  "Maria Ivanova",
  "Sergey Smirnov",
  "Anna Kuznetsova",
  "Dmitry Popov",
  "Olga Sokolova",
  "Alexey Volkov",
  "Elena Morozova",
  "Natalia Orlova",
  "Mikhail Zaitsev",
];
const DATIVE_NAMES = [
  "Ивану Петрову",
  "Анне Смирновой",
  "Сергею Кузнецову",
  "Марии Соколовой",
  "Дмитрию Новикову",
  "Ольге Морозовой",
  "Павлу Орлову",
  "Елене Волковой",
];
const GENITIVE_NAMES = ["Ивана Петрова", "Анны Смирновой", "Сергея Кузнецова", "Марии Соколовой", "Андрея Лебедева", "Ирины Козловой"];
const CITIES = "Москва Санкт-Петербург Казань Екатеринбург Новосибирск Самара Краснодар Тверь Владимир Воронеж".split(" ");
const CITY_PREP = "Москве Казани Самаре Твери Воронеже Сочи Перми Калуге Туле Екатеринбурге".split(" ");
const STREETS = "Ленина Тверская Садовая Победы Гагарина Советская Пушкина Лесная Молодёжная Центральная Чкалова Мира Строителей".split(" ");
const STREET_TYPES = ["ул.", "улица", "пр-т", "проспект", "пер.", "переулок", "наб.", "б-р", "бульвар", "ш."];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const TRANSLIT: Record<string, string> = {
  Иван: "ivan",
  Сергей: "sergey",
  Алексей: "alexey",
  Анна: "anna",
  Мария: "maria",
  Ольга: "olga",
  Елена: "elena",
  Дмитрий: "dmitry",
  Павел: "pavel",
  Ирина: "irina",
};
const LAST_TRANSLIT = ["petrov", "ivanova", "smirnov", "kuznetsova", "popov", "sokolova", "volkov", "orlova"];
const DOMAINS = ["mail.ru", "yandex.ru", "gmail.com", "bk.ru", "inbox.ru", "list.ru", "rambler.ru", "ya.ru", "studio-art.ru"];

// ------------------------------------------------------------------ checksums (independent of src/)

function luhnCheckDigit(body: string): number {
  let sum = 0;
  for (let i = body.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) {
    let v = Number(body[i]);
    if (dbl) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  }
  return (10 - (sum % 10)) % 10;
}
function luhnOk(num: string): boolean {
  return luhnCheckDigit(num.slice(0, -1)) === Number(num.slice(-1));
}
function snilsCheck(body: string): string {
  let s = 0;
  for (let i = 0; i < 9; i++) s += Number(body[i]) * (9 - i);
  const c = s < 100 ? s : s === 100 || s === 101 ? 0 : s % 101 === 100 ? 0 : s % 101;
  return String(c).padStart(2, "0");
}
function innDigit(d: string, w: number[]): number {
  return (w.reduce((acc, wi, i) => acc + wi * Number(d[i]), 0) % 11) % 10;
}
const W10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const W11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const W12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
function inn10Ok(d: string): boolean {
  return d.length === 10 && innDigit(d, W10) === Number(d[9]);
}
function inn12Ok(d: string): boolean {
  return d.length === 12 && innDigit(d, W11) === Number(d[10]) && innDigit(d, W12) === Number(d[11]);
}

// ------------------------------------------------------------------ generator

export function generateCorpus(seed = 20260930): CorpusLine[] {
  const rng = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;
  const digits = (n: number) => Array.from({ length: n }, () => String(int(0, 9))).join("");
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");

  // ---- personal values
  const fullName = (): string => {
    const female = rng() < 0.5;
    const first = pick(female ? FEMALE : MALE);
    const sur = female ? femSurname(pick(SURNAME_M)) : pick(SURNAME_M);
    const pat = patronymic(pick(PATRONYMIC_BASE), female);
    switch (int(0, 5)) {
      case 0:
        return `${sur} ${first} ${pat}`;
      case 1:
        return `${first} ${pat} ${sur}`;
      case 2:
        return `${first} ${sur}`;
      case 3:
        return `${sur} ${first}`;
      case 4:
        return `${first} ${pat}`;
      default:
        return `${sur.toUpperCase()} ${first.toUpperCase()} ${pat.toUpperCase()}`;
    }
  };
  const ambiguousFull = (): string => {
    const female = rng() < 0.6;
    const first = pick(female ? AMBIGUOUS_F : AMBIGUOUS_M);
    return rng() < 0.5
      ? `${first} ${patronymic(pick(PATRONYMIC_BASE), female)}`
      : `${first} ${female ? femSurname(pick(SURNAME_M)) : pick(SURNAME_M)}`;
  };
  const initialsName = (): string => {
    const female = rng() < 0.5;
    const sur = female ? femSurname(pick(SURNAME_M)) : pick(SURNAME_M);
    const i = pick([...MALE, ...FEMALE])[0];
    const o = pick(PATRONYMIC_BASE)[0];
    return pick([`${sur} ${i}. ${o}.`, `${i}. ${o}. ${sur}`, `${sur} ${i}.${o}.`, `${i}.${o}. ${sur}`, `${sur} ${i}.`]);
  };
  const firstOnly = (): string => pick([...MALE, ...FEMALE, ...DIMINUTIVE]);

  const phone = (): string => {
    const mobile = `9${digits(2)}`;
    const code = rng() < 0.8 ? mobile : pick(["495", "499", "812", "343", "383", "863"]);
    const a = digits(3);
    const b = digits(2);
    const c = digits(2);
    const fmts = [
      `+7 (${code}) ${a}-${b}-${c}`,
      `+7${code}${a}${b}${c}`,
      `8 ${code} ${a} ${b} ${c}`,
      `8(${code})${a}${b}${c}`,
      `8-${code}-${a}-${b}-${c}`,
      `+7 ${code} ${a}-${b}-${c}`,
      `8${code}${a}${b}${c}`,
      `+7-${code}-${a}-${b}-${c}`,
      `8 (${code}) ${a}-${b}-${c}`,
      `+7 ${code} ${a} ${b} ${c}`,
    ];
    if (code.startsWith("9")) fmts.push(`7${code}${a}${b}${c}`);
    if (rng() < 0.08) return `8 (${pick(["4722", "3452", "8452"])}) ${digits(2)}-${digits(2)}-${digits(2)}`;
    return pick(fmts);
  };
  const phone10 = (): string => {
    const code = `9${digits(2)}`;
    return pick([`${code} ${digits(3)}-${digits(2)}-${digits(2)}`, `(${code}) ${digits(3)}-${digits(2)}-${digits(2)}`, `${code}${digits(7)}`]);
  };
  const email = (): string => {
    const first = pick(Object.values(TRANSLIT));
    const last = pick(LAST_TRANSLIT);
    const local = pick([`${first}.${last}`, `${first}${int(70, 99)}`, `${first}_${last}`, `${first[0]}.${last}`, `${last}.${first}${int(1, 9)}`]);
    if (rng() < 0.08) return `${pick(["иван", "мария", "олег"])}@${pick(["почта.рф", "мойдом.рф"])}`;
    return `${local}@${pick(DOMAINS)}`;
  };
  const emailObfuscated = (): string => {
    const first = pick(Object.values(TRANSLIT));
    const d = pick(["mail", "yandex", "gmail", "bk", "inbox"]);
    const tld = d === "gmail" ? "com" : "ru";
    return pick([`${first} собака ${d}.${tld}`, `${first} at ${d} dot ${tld}`, `${first}(at)${d}.${tld}`, `${first} [at] ${d} [dot] ${tld}`]);
  };
  const card = (): string => {
    const prefix = pick(["2200", "2201", "2202", "2204", "4", "4", "51", "53", "55", "2221", "2500", "2720", "62", "35"]);
    const len = prefix === "4" ? pick([16, 16, 13, 19]) : prefix === "62" || prefix.startsWith("220") ? pick([16, 16, 19]) : 16;
    const body = prefix + digits(len - prefix.length - 1);
    const num = body + luhnCheckDigit(body);
    const groups = num.match(/.{1,4}/g) ?? [num];
    return pick([groups.join(" "), groups.join(" "), groups.join("-"), num]);
  };
  const passportParts = (): [string, string, string] => {
    const region = pad(int(1, 99));
    const year = pad(pick([int(97, 99), int(0, 25)]));
    return [region, year, digits(6)];
  };
  const snils = (formatted = true): string => {
    let body = digits(9);
    while (Number(body) <= 1001998) body = digits(9);
    const c = snilsCheck(body);
    return formatted
      ? pick([`${body.slice(0, 3)}-${body.slice(3, 6)}-${body.slice(6)} ${c}`, `${body.slice(0, 3)}-${body.slice(3, 6)}-${body.slice(6)}-${c}`, `${body.slice(0, 3)} ${body.slice(3, 6)} ${body.slice(6)} ${c}`])
      : body + c;
  };
  const innPerson = (): string => {
    const b = pad(int(1, 99)) + digits(8);
    const d11 = innDigit(b, W11);
    const d12 = innDigit(b + d11, W12);
    return `${b}${d11}${d12}`;
  };
  const innOrg = (): string => {
    const b = pad(int(1, 99)) + digits(7);
    return b + innDigit(b, W10);
  };
  const account = (): string => `${pick(["40817810", "40820810", "42301810", "42305810"])}${digits(12)}`;
  const birthdate = (): string => {
    const y = int(1950, 2008);
    const m = int(1, 12);
    const d = int(1, 28);
    return pick([`${pad(d)}.${pad(m)}.${y}`, `${d} ${MONTHS[m - 1]} ${y} г.`, `${y}-${pad(m)}-${pad(d)}`, `${pad(d)}/${pad(m)}/${y}`, `${d} ${MONTHS[m - 1]} ${y}`]);
  };
  const address = (): string => {
    const st = `${pick(STREET_TYPES)} ${pick(STREETS)}`;
    const n = int(1, 150);
    const k = int(1, 5);
    const m = int(1, 300);
    const city = pick(CITIES);
    return pick([
      `г. ${city}, ${st}, д. ${n}, кв. ${m}`,
      `${int(101, 699)}${digits(3)}, г. ${city}, ${st}, д. ${n}, корп. ${k}, кв. ${m}`,
      `${city}, ${st}, д. ${n}`,
      `${st}, дом ${n}, квартира ${m}`,
      `г. ${city}, ${st}, д. ${n}, стр. ${k}, оф. ${m}`,
      `${st}, д. ${n}/${k}, кв. ${m}`,
      `город ${city}, ${st}, д. ${n}`,
    ]);
  };
  const special = (): string =>
    pick(["диагноз", "инвалидность", "беременность", "судимость", "вероисповедание", "ВИЧ", "национальность", "онкологии", "аллергия", "заболевание"]);
  const biometric = (): string => pick(["отпечатки пальцев", "биометрию", "скан лица", "образец голоса"]);

  // ---- non-personal values for traps
  const eventDate = (): string => pick([`${pad(int(1, 28))}.${pad(int(1, 12))}.${int(2023, 2026)}`, `${int(1, 28)} ${pick(MONTHS)} ${int(2024, 2026)} года`, `${int(2024, 2026)}-${pad(int(1, 12))}-${pad(int(1, 28))}`]);
  const price = (): string => pick([`${int(1, 9)} ${digits(3)} ${digits(3)}`, `${int(1, 999)} ${digits(3)},${digits(2)}`, `${int(100, 99999)}`, `${int(1, 9)} ${digits(3)} ${digits(3)} ${digits(3)}`]);
  const invalid = (len: number, bad: (d: string) => boolean): string => {
    let d = `${int(1, 9)}${digits(len - 1)}`;
    while (bad(d)) d = `${int(1, 9)}${digits(len - 1)}`;
    return d;
  };
  const counter12 = () => invalid(12, inn12Ok);
  const track16 = () => (invalid(16, luhnOk).match(/.{4}/g) ?? []).join(" ");

  // ---- templates
  const P = (kind: string, value: string): Part => [kind, value];
  const positives: Array<() => Part[]> = [
    () => ["Меня зовут ", P("person_name", firstOnly()), ", мой телефон ", P("phone_ru", phone()), "."],
    () => ["Для связи: ", P("phone_ru", phone()), ", почта ", P("email", email())],
    () => ["Клиент ", P("person_name", fullName()), " оставил заявку, email: ", P("email", email())],
    () => {
      const [r, y, n] = passportParts();
      return ["Паспорт ", P("passport_ru", pick([`${r} ${y} ${n}`, `${r}${y} ${n}`, `${r}${y} № ${n}`])), " выдан ОУФМС России по г. Москве"];
    },
    () => {
      const [r, y, n] = passportParts();
      return ["серия ", P("passport_ru", `${r} ${y} № ${n}`), ", выдан ", eventDate()];
    },
    () => {
      let v = passportParts().join("");
      while (inn10Ok(v)) v = passportParts().join("");
      return ["Номер паспорта: ", P("passport_ru", v)];
    },
    () => ["СНИЛС сотрудника: ", P("snils", snils())],
    () => ["СНИЛС ", P("snils", snils(false)), ", приложите копию"],
    () => ["ИНН ", P("inn_person", innPerson()), " (физлицо, самозанятый)"],
    () => ["Самозанятый ", P("person_name", fullName()), ", ИНН ", P("inn_person", innPerson())],
    () => ["Оплата картой ", P("card", card()), ", держатель ", P("person_name", pick(LATIN_NAMES).toUpperCase())],
    () => ["Карта для возврата: ", P("card", card())],
    () => ["Адрес доставки: ", P("address", address()), "."],
    () => ["Живу по адресу ", P("address", address()), ", домофон не работает"],
    () => ["Дата рождения: ", P("birthdate", birthdate())],
    () => [pick(["Родился ", "Родилась ", "родился "]), P("birthdate", birthdate()), " в ", pick(CITY_PREP)],
    () => [P("person_name", fullName()), ", ", P("birthdate", birthdate()), " г.р."],
    () => ["Счёт для перевода зарплаты: ", P("account_ru", account())],
    () => ["Ответственный — ", P("person_name", initialsName()), ", тел. ", P("phone_ru", phone())],
    () => ["Передайте ", P("person_name", pick(DATIVE_NAMES)), ", что встреча переносится"],
    () => ["Со слов ", P("person_name", pick(GENITIVE_NAMES)), ", заказ не пришёл"],
    () => ["Пациент ", P("person_name", fullName()), ", ", P("special_context", special()), " уточнить у врача"],
    () => [P("person_name", fullName()), " сообщила, что у неё ", P("special_context", special())],
    () => ["Участники: ", P("person_name", fullName()), ", ", P("person_name", fullName()), " и ", P("person_name", firstOnly()), "."],
    () => ["Пишите в WhatsApp ", P("phone_ru", phone10())],
    () => ["моб. ", P("phone_ru", phone10()), ", звонить после 18:00"],
    () => ["Контакты: ", P("email", emailObfuscated())],
    () => ["ФИО: ", P("person_name", fullName()), "; дата рождения ", P("birthdate", birthdate()), "; адрес: ", P("address", address())],
    () => ["Hi, I'm ", P("person_name", pick(LATIN_NAMES)), ", reach me at ", P("email", email())],
    () => ["Сотрудник ", P("person_name", fullName()), " сдал ", P("biometric_context", biometric()), " для прохода в офис"],
    () => {
      const [r, y, n] = passportParts();
      return ["Заявка от ", P("person_name", firstOnly()), " (", P("phone_ru", phone()), "), паспорт серия ", P("passport_ru", `${r}${y} № ${n}`)];
    },
    () => [P("person_name", fullName()), ";", P("phone_ru", phone()), ";", P("email", email()), ";", P("address", address())],
    () => ["Мама — ", P("person_name", pick(DIMINUTIVE)), ", папа — ", P("person_name", pick(MALE)), "."],
    () => ["Карта ", P("card", card()), ", ИНН ", P("inn_person", innPerson()), ", СНИЛС ", P("snils", snils())],
    () => ["Руководитель: ", P("person_name", ambiguousFull()), ", тел. ", P("phone_ru", phone())],
    () => ["Встретить ", P("person_name", ambiguousFull()), " на вокзале"],
    () => [P("person_name", initialsName()), " просит перезвонить на ", P("phone_ru", phone())],
    () => ["Получатель: ", P("person_name", fullName()), ", ", P("address", address())],
    () => ["Бронь на имя ", P("person_name", fullName()), ", заказ №", String(int(1000, 99999)), ", оплата ", price(), " руб."],
    () => ["Мой номер ", P("phone_ru", phone()), ", а почта ", P("email", email()), ". ", P("person_name", firstOnly())],
  ];

  const traps: Array<() => Part[]> = [
    () => [`Заказ №${pick(["8", "7"])}${digits(10)} от ${eventDate()} оплачен`],
    () => [`Цена: ${price()} руб.`],
    () => [`Итого ${price()} ₽ за ${int(2, 40)} шт.`],
    () => [`Мероприятие пройдёт ${eventDate()} в 18:00 в ${pick(CITY_PREP)}`],
    () => [`ИНН организации ${innOrg()}, КПП ${digits(9)}, ОГРН 1${digits(12)}`],
    () => [`ООО «Ромашка», ИНН ${innOrg()}`],
    () => [`Номер отправления ${counter12()}`],
    () => [`Трек-номер ${track16()}`],
    () => [`.btn { color: #${digits(6)}; width: ${int(100, 1920)}px; margin: 0 ${int(1, 16)}px; }`],
    () => [`const total = items.reduce((a, b) => a + b.price, 0); // ${int(10, 9999)}`],
    () => ['import { detect } from "@wizard/pii";'],
    () => [`<img src="icon@2x.png" alt="logo" width="${int(16, 256)}">`],
    () => [`Форум в ${pick(CITY_PREP)} соберёт ${int(100, 5000)} участников`],
    () => ["Встреча во Владимире, затем поезд в Москву"],
    () => [pick(["Роман «Война и мир» лежит на столе", "Вера в успех помогает", "Любовь к музыке у нас с детства", "Надежда умирает последней", "Лев — царь зверей", "Роза пахнет", "Мир, труд, май"])],
    () => [`Версия ${int(1, 9)}.${int(0, 20)}.${int(0, 99)}, сборка ${digits(6)}`],
    () => [`IP-адрес сервера 192.168.${int(0, 255)}.${int(1, 254)}`],
    () => [`UUID ${digits(8)}-${digits(4)}-4${digits(3)}-a${digits(3)}-${digits(12)}`],
    () => ["Время работы: с 9:00 до 18:00, пн–пт"],
    () => [`Р/с 40702810${digits(12)}, БИК 04452${digits(4)}, к/с 30101810${digits(12)}`],
    () => [`Счёт-фактура № ${int(1, 99999)} от ${eventDate()}`],
    () => [`Unix time ${int(1600000000, 1790000000)}`],
    () => ["Проспект Мира и улица Ленина — центральные улицы города"],
    () => [`В ${int(2000, 2025)} г. Москва приняла форум`],
    () => [`Код подтверждения: ${digits(6)}. Артикул ${int(1, 9)}${digits(9)}`],
    () => [`Скидка ${int(5, 50)}% до ${eventDate()}`],
    () => ["Спросить у участников про аллергии и пожелания по питанию"],
    () => ["Поле «Диагноз» в форму не добавлять"],
    () => ["Телефон горячей линии указан на сайте"],
    () => [`Москва — Санкт-Петербург, ${int(600, 750)} км, поезд № ${int(1, 999)}`],
    () => [`Население ${pick(["Казани", "Самары", "Твери"])} — ${int(1, 2)} ${digits(3)} ${digits(3)} человек`],
    () => [`Счёт № ${int(2020, 2026)} ${digits(6)} на оплату`],
    () => [`Температура 36.${int(0, 9)}, давление ${int(100, 140)}/${int(60, 90)}`],
    () => [`Табличка: ${pick(CITIES)}, Красная площадь`],
    () => ["Нужна форма: ФИО, телефон, email, согласие на обработку"],
    () => [`Лот ${digits(4)} ${digits(6)}, партия ${int(1, 99)}`],
    () => [`Итоги ${int(2020, 2025)} года: выручка ${price()} руб., рост ${int(1, 99)}%`],
    () => [`Список задач на ${eventDate()}: созвон, ревью, релиз ${int(1, 9)}.${int(0, 9)}`],
    () => ["Сделать так, чтобы администратор видел все заявки, а менеджер — только свои"],
    () => [`Кабинет ${int(100, 999)}, этаж ${int(1, 20)}, корпус Б`],
  ];

  // Known-difficult cases, fixed (not random): scored in the metrics, but not required to be perfect.
  const hard: Part[][] = [
    ["Позвоните ", P("person_name", "Петрову"), " до обеда"],
    [P("person_name", "иван петров"), ", ", P("phone_ru", "8 916 555-12-34")],
    ["Доставка: ", P("address", "Москва, Тверская 12-5")],
    [P("person_name", "Марина"), ", привет! Скинь адрес"],
    ["Контакт: ", P("person_name", "Petrov Ivan"), ", ", P("email", "ANNA.SMIRNOVA@YANDEX.RU")],
    ["Заказчица ", P("person_name", "Любовь Иванова"), ", WhatsApp ", P("phone_ru", "+7 916 123 45 67")],
    ["Рождён ", P("birthdate", "3.4.1990"), " в Туле"],
    [P("person_name", "Павел Дуров"), " основал Telegram"],
    ["Счёт ", P("account_ru", "40817810099910004312"), " закрыт"],
    ["Марина в Сочи открылась после ремонта"],
    ["Технический паспорт объекта 4506 123456"],
    ["Магазин «Людмила» работает до 22:00"],
    ["День рождения компании отмечаем 15.11.2099"],
    ["Родительское собрание 12.03.2025 в 18:00"],
    ["Роза ветров на карте и Слава России!"],
    ["Серия 4506, но номер не помню"],
    ["Итого: 4 276 380 012 345 678 руб."],
    ["Лена, Обь и Енисей — крупные реки"],
    ["Иду в кафе «Вера» с ", P("person_name", "Надеждой Рыбаковой")],
    ["Тел. доб. 1234, факс не работает"],
  ];

  const build = (parts: Part[]): { text: string; spans: CorpusSpan[] } => {
    let text = "";
    const spans: CorpusSpan[] = [];
    for (const p of parts) {
      if (typeof p === "string") text += p;
      else {
        spans.push({ kind: p[0], start: text.length, end: text.length + p[1].length });
        text += p[1];
      }
    }
    return { text, spans };
  };

  const out: CorpusLine[] = [];
  for (let i = 0; i < 280; i++) {
    const t = positives[i % positives.length] as () => Part[];
    out.push({ id: `p${String(i + 1).padStart(3, "0")}`, group: "positive", ...build(t()) });
  }
  for (let i = 0; i < 140; i++) {
    const t = traps[i % traps.length] as () => Part[];
    out.push({ id: `t${String(i + 1).padStart(3, "0")}`, group: "trap", ...build(t()) });
  }
  hard.forEach((parts, i) => {
    out.push({ id: `h${String(i + 1).padStart(3, "0")}`, group: "hard", ...build(parts) });
  });
  return out;
}

export function corpusJsonl(lines: CorpusLine[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

export const CORPUS_PATH = join(dirname(fileURLToPath(import.meta.url)), "corpus.ru.jsonl");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = generateCorpus();
  writeFileSync(CORPUS_PATH, corpusJsonl(lines));
  console.log(`corpus.ru.jsonl: ${lines.length} lines (${lines.filter((l) => l.group === "trap").length} traps)`);
}
