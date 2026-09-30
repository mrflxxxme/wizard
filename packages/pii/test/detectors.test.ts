import { describe, expect, test } from "vitest";
import { detect, normalizePhoneRu } from "../src/index.js";
import { found, kindsOf } from "./helpers.js";

describe("phone_ru", () => {
  const formats = [
    "+7 (916) 123-45-67",
    "+79161234567",
    "+7 916 123-45-67",
    "+7-916-123-45-67",
    "+7 916 123 45 67",
    "8 916 123 45 67",
    "8(916)1234567",
    "8 (916) 123-45-67",
    "8-916-123-45-67",
    "89161234567",
    "79161234567",
  ];
  test.each(formats)("%s → +79161234567", (p) => {
    expect(found(`Телефон: ${p}.`)).toEqual([["phone_ru", p]]);
    expect(normalizePhoneRu(p)).toBe("+79161234567");
  });
  test("landlines and 4-digit area codes", () => {
    expect(found("+7 (495) 123-45-67")).toEqual([["phone_ru", "+7 (495) 123-45-67"]]);
    expect(found("8 (4722) 12-34-56")).toEqual([["phone_ru", "8 (4722) 12-34-56"]]);
    expect(normalizePhoneRu("8 (4722) 12-34-56")).toBe("+74722123456");
  });
  test("10 digits starting with 9 only with context", () => {
    expect(found("моб. 916 123-45-67")).toEqual([["phone_ru", "916 123-45-67"]]);
    expect(found("WhatsApp (916) 123-45-67")).toEqual([["phone_ru", "(916) 123-45-67"]]);
    expect(found("Партия 916 123-45-67 отгружена")).toEqual([]);
  });
  test("not inside a longer number, not prices, not counters", () => {
    expect(kindsOf("89161234567890")).toEqual([]);
    expect(kindsOf("Заказ №89161234567 оплачен")).toEqual([]);
    expect(kindsOf("Цена 8 950 000 000 руб.")).toEqual([]);
    expect(kindsOf("Цена 79 900 000 000 руб.")).toEqual([]);
    expect(kindsOf("8 123 456 78 90")).toEqual([]); // no Russian area code starts with 1
    expect(kindsOf("+7 916 123 45 678")).toEqual([]);
    expect(normalizePhoneRu("12345")).toBeNull();
  });
});

describe("email", () => {
  test("plain, Cyrillic domain, uppercase", () => {
    expect(found("пишите ivan.petrov@mail.ru.")).toEqual([["email", "ivan.petrov@mail.ru"]]);
    expect(found("почта: иван@почта.рф")).toEqual([["email", "иван@почта.рф"]]);
    expect(found("ANNA.SMIRNOVA@YANDEX.RU")).toEqual([["email", "ANNA.SMIRNOVA@YANDEX.RU"]]);
    expect(found("a+tag@sub.example.co.uk")).toEqual([["email", "a+tag@sub.example.co.uk"]]);
  });
  test("obfuscations", () => {
    for (const s of [
      "ivan собака mail.ru",
      "ivan at mail dot ru",
      "ivan(at)mail.ru",
      "ivan [at] mail [dot] ru",
    ]) {
      expect(found(`Контакт: ${s}`)).toEqual([["email", s]]);
    }
  });
  test("not assets, scoped packages or handles", () => {
    expect(kindsOf('<img src="icon@2x.png">')).toEqual([]);
    expect(kindsOf('import x from "@wizard/pii"')).toEqual([]);
    expect(kindsOf("user@localhost")).toEqual([]);
  });
});

describe("card", () => {
  test("spaced, dashed, contiguous; 13–19 digits", () => {
    expect(found("карта 4111 1111 1111 1111")).toEqual([["card", "4111 1111 1111 1111"]]);
    expect(found("карта 2200-0000-0000-0004")).toEqual([["card", "2200-0000-0000-0004"]]);
    expect(found("5555555555554444")).toEqual([["card", "5555555555554444"]]);
    expect(found("4222222222222")).toEqual([["card", "4222222222222"]]);
    expect(found("4000 0000 0000 0000 006")).toEqual([["card", "4000 0000 0000 0000 006"]]);
  });
  test("trailing numbers do not hide the card", () => {
    expect(found("4111 1111 1111 1111 12 25")).toEqual([["card", "4111 1111 1111 1111"]]);
  });
  test("Luhn-invalid, wrong IIN, groups of 3 are not cards", () => {
    expect(kindsOf("трек 4111 1111 1111 1112")).toEqual([]);
    expect(kindsOf("378282246310005")).toEqual([]);
    expect(kindsOf("Итого: 4 111 111 111 111 111 руб.")).toEqual([]);
  });
});

describe("passport_ru", () => {
  test("formats that are detected without context", () => {
    expect(found("45 06 123456")).toEqual([["passport_ru", "45 06 123456"]]);
    expect(found("4506 123456")).toEqual([["passport_ru", "4506 123456"]]);
    expect(found("серия 4506 № 123456")).toEqual([["passport_ru", "4506 № 123456"]]);
    expect(found("серия 45 06 номер 123456")).toEqual([["passport_ru", "45 06 номер 123456"]]);
  });
  test("10 contiguous digits only with context and when not a valid INN-10", () => {
    expect(found("паспорт 4506123456")).toEqual([["passport_ru", "4506123456"]]);
    expect(kindsOf("код 4506123456")).toEqual([]);
    expect(found("паспорт 7707083893", { includeNonPii: true })).toEqual([["inn_org", "7707083893"]]);
  });
  test("order-like numbers and implausible series are skipped", () => {
    expect(kindsOf("Счёт № 2024 000123 на оплату")).toEqual([]);
    expect(kindsOf("Лот 1234 567890")).toEqual([]);
    expect(kindsOf("00 12 345678")).toEqual([]);
    expect(kindsOf("1250 345678")).toEqual([]); // 50: blank year that does not exist
  });
});

describe("snils", () => {
  test("formatted with valid checksum", () => {
    expect(found("112-233-445 95")).toEqual([["snils", "112-233-445 95"]]);
    expect(found("112-233-445-95")).toEqual([["snils", "112-233-445-95"]]);
    expect(found("112 233 445 95")).toEqual([["snils", "112 233 445 95"]]);
  });
  test("one changed digit is not SNILS", () => {
    expect(kindsOf("112-233-445 96")).toEqual([]);
    expect(kindsOf("112-233-455 95")).toEqual([]);
  });
  test("11 contiguous digits only with context", () => {
    expect(found("СНИЛС 11223344595")).toEqual([["snils", "11223344595"]]);
    expect(kindsOf("номер 11223344595")).toEqual([]);
  });
});

describe("inn", () => {
  test("person INN is PII, org INN is not", () => {
    expect(found("ИНН 500100732259")).toEqual([["inn_person", "500100732259"]]);
    expect(detect("ИНН 500100732259")[0]?.confidence).toBe("high");
    expect(detect("500100732259")[0]?.confidence).toBe("medium");
    expect(kindsOf("ИНН 7707083893")).toEqual([]);
    const org = detect("ИНН 7707083893", { includeNonPii: true });
    expect(org.map((f) => [f.kind, f.category, f.piiKind])).toEqual([["inn_org", "none", "inn"]]);
  });
  test("invalid checksum / counters are not INN", () => {
    expect(kindsOf("Номер отправления 500100732258")).toEqual([]);
    expect(kindsOf("500100732259123")).toEqual([]);
  });
});

describe("account_ru", () => {
  test("personal accounts 40817/40820/423", () => {
    expect(found("счёт 40817810099910004312")).toEqual([["account_ru", "40817810099910004312"]]);
    expect(found("40820810000000000001")).toEqual([["account_ru", "40820810000000000001"]]);
    expect(found("42301810000000000001")).toEqual([["account_ru", "42301810000000000001"]]);
  });
  test("company settlement and correspondent accounts are not personal", () => {
    expect(kindsOf("р/с 40702810000000000001, к/с 30101810400000000225")).toEqual([]);
  });
});

describe("birthdate", () => {
  test("dates in birth context", () => {
    expect(found("Дата рождения: 12.03.1985")).toEqual([["birthdate", "12.03.1985"]]);
    expect(found("родилась 5 мая 1990 г. в Туле")).toEqual([["birthdate", "5 мая 1990 г."]]);
    expect(found("д.р. 1990-05-05")).toEqual([["birthdate", "1990-05-05"]]);
    expect(found("12/03/1985 г.р.")).toEqual([["birthdate", "12/03/1985"]]);
    expect(found("ДР 01.01.2001")).toEqual([["birthdate", "01.01.2001"]]);
  });
  test("event dates, invalid and future dates are not birthdates", () => {
    expect(kindsOf("Мероприятие 12.03.2025 в 18:00")).toEqual([]);
    expect(kindsOf("Родительское собрание 12.03.2025")).toEqual([]);
    expect(kindsOf("дата рождения 31.02.1990")).toEqual([]);
    expect(kindsOf("день рождения компании 15.11.2099")).toEqual([]);
    expect(kindsOf("родился 12.13.1990")).toEqual([]);
  });
});

describe("address", () => {
  test("two or more markers with values", () => {
    expect(found("Адрес: г. Москва, ул. Ленина, д. 5, кв. 12")).toEqual([
      ["address", "г. Москва, ул. Ленина, д. 5, кв. 12"],
    ]);
    expect(found("101000, г. Москва, пр-т Мира, д. 1, корп. 2")).toEqual([
      ["address", "101000, г. Москва, пр-т Мира, д. 1, корп. 2"],
    ]);
    expect(found("улица Садовая, дом 3")).toEqual([["address", "улица Садовая, дом 3"]]);
    expect(found("Санкт-Петербург, наб. Фонтанки, д. 20, оф. 5")).toEqual([
      ["address", "наб. Фонтанки, д. 20, оф. 5"],
    ]);
  });
  test("a single city or street is not an address", () => {
    expect(kindsOf("Форум в Казани")).toEqual([]);
    expect(kindsOf("Встреча в г. Казань")).toEqual([]);
    expect(kindsOf("ул. Ленина")).toEqual([]);
    expect(kindsOf("Проспект Мира и улица Ленина — центральные улицы")).toEqual([]);
    expect(kindsOf("В 2020 г. Москва приняла форум, д. нет")).toEqual([]);
  });
});

describe("person_name", () => {
  test("full names in any order, case forms, all caps", () => {
    expect(found("Иванов Иван Иванович пришёл")).toEqual([["person_name", "Иванов Иван Иванович"]]);
    expect(found("Мария Петровна Соколова")).toEqual([["person_name", "Мария Петровна Соколова"]]);
    expect(found("Передайте Ивану Петрову")).toEqual([["person_name", "Ивану Петрову"]]);
    expect(found("со слов Анны Смирновой")).toEqual([["person_name", "Анны Смирновой"]]);
    expect(found("ПЕТРОВ СЕРГЕЙ")).toEqual([["person_name", "ПЕТРОВ СЕРГЕЙ"]]);
    expect(found("Павел Дуров")).toEqual([["person_name", "Павел Дуров"]]);
  });
  test("standalone first names and diminutives (medium confidence)", () => {
    expect(found("Маша придёт в 5")).toEqual([["person_name", "Маша"]]);
    expect(detect("Маша придёт в 5")[0]?.confidence).toBe("medium");
    expect(found("спросить у Лёши")).toEqual([["person_name", "Лёши"]]);
  });
  test("initials", () => {
    expect(found("Петров И. И.")).toEqual([["person_name", "Петров И. И."]]);
    expect(found("Петров И.И.")).toEqual([["person_name", "Петров И.И."]]);
    expect(found("А. С. Пушкин")).toEqual([["person_name", "А. С. Пушкин"]]);
    expect(found("отв. И.И. Шевчук")).toEqual([["person_name", "И.И. Шевчук"]]);
    expect(kindsOf("В. Новгород и С. Петербург")).toEqual([]);
  });
  test("Latin transliteration (person_name_latin) needs a surname, patronymic or initial", () => {
    expect(found("Hi, I'm Ivan Petrov")).toEqual([["person_name_latin", "Ivan Petrov"]]);
    expect(found("Contact: Petrov Ivan")).toEqual([["person_name_latin", "Petrov Ivan"]]);
    expect(found("IVAN PETROV")).toEqual([["person_name_latin", "IVAN PETROV"]]);
    expect(found("Yevgeniya Sergeevna")).toEqual([["person_name_latin", "Yevgeniya Sergeevna"]]);
    expect(found("Aleksandr Kuznetsov")).toEqual([["person_name_latin", "Aleksandr Kuznetsov"]]);
    expect(found("I. Ivanov")).toEqual([["person_name_latin", "I. Ivanov"]]);
    expect(found("Smirnova A.")).toEqual([["person_name_latin", "Smirnova A."]]);
    expect(kindsOf("Anna said hello")).toEqual([]);
    expect(detect("Ivan Petrov")[0]?.piiKind).toBe("fio");
  });
  test("ambiguous word-names need a surname or patronymic", () => {
    expect(kindsOf("Вера в успех помогает")).toEqual([]);
    expect(kindsOf("Роман «Война и мир»")).toEqual([]);
    expect(kindsOf("Любовь к музыке")).toEqual([]);
    expect(kindsOf("Слава России")).toEqual([]);
    expect(found("Вера Николаевна")).toEqual([["person_name", "Вера Николаевна"]]);
    expect(found("Любовь Орлова")).toEqual([["person_name", "Любовь Орлова"]]);
    expect(found("Роман Сергеевич")).toEqual([["person_name", "Роман Сергеевич"]]);
  });
  test("streets, cities and venues named after people", () => {
    expect(kindsOf("на улице Карла Маркса")).toEqual([]);
    expect(kindsOf("Встреча во Владимире")).toEqual([]);
    expect(kindsOf("Магазин «Людмила» открыт")).toEqual([]);
    expect(kindsOf("проспект Мира")).toEqual([]);
  });
  test("ФИО label", () => {
    expect(found("ФИО: Кузнецов")).toEqual([["person_name", "Кузнецов"]]);
    expect(kindsOf("ФИО Телефон Email")).toEqual([]);
  });
  test("placeholders are not names", () => {
    expect(kindsOf("[ФИО_1] и [ТЕЛЕФОН_2], [EMAIL_3], [АДРЕС_1]")).toEqual([]);
  });
});

describe("person_name: non-Slavic and English/European names (FU-1)", () => {
  test("dictionary names and surnames of RF peoples", () => {
    expect(found("Джахонгир Рахимов оплатил заказ")).toEqual([["person_name", "Джахонгир Рахимов"]]);
    expect(found("Рахимов Джахонгир Алишерович")).toEqual([["person_name", "Рахимов Джахонгир Алишерович"]]);
    expect(found("Передайте Джахонгиру Рахимову")).toEqual([["person_name", "Джахонгиру Рахимову"]]);
    for (const n of [
      "Айгуль Сатпаева",
      "Нодира Юлдашева",
      "Ашот Саргсян",
      "Гиви Беридзе",
      "Эльчин Мамедли",
      "Сардаана Аммосова",
      "Баир Цыденов",
      "Фаррух Рахимзода",
      "Олжас Сулейменов",
    ]) {
      expect(found(`Клиент ${n} оставил заявку`)).toEqual([["person_name", n]]);
    }
  });
  test("pair heuristic: dictionary side + unknown Title-case side", () => {
    expect(found("Водитель Нарек Турдыбек, пропуск")).toEqual([["person_name", "Нарек Турдыбек"]]);
    expect(found("Абдумалик Юлдашев на связи")).toEqual([["person_name", "Абдумалик Юлдашев"]]);
    expect(found("Speaker: Emily Pemberton")).toEqual([["person_name_latin", "Emily Pemberton"]]);
    expect(found("Smith Johnny")).toEqual([["person_name_latin", "Smith Johnny"]]);
  });
  test("common Latin full names", () => {
    expect(found("Contact John Smith today")).toEqual([["person_name_latin", "John Smith"]]);
    expect(found("JOHN SMITH")).toEqual([["person_name_latin", "JOHN SMITH"]]);
    expect(found("Thomas Mueller, Giulia Rossi, Pierre Dubois")).toEqual([
      ["person_name_latin", "Thomas Mueller"],
      ["person_name_latin", "Giulia Rossi"],
      ["person_name_latin", "Pierre Dubois"],
    ]);
    expect(found("J. Smith")).toEqual([["person_name_latin", "J. Smith"]]);
  });
  test.each([
    "Белый Дом",
    "Дед Мороз пришёл",
    "White House",
    "Black Friday",
    "Visual Studio Code",
    "Jordan River",
    "Лада Веста",
    "Роза Хутор",
    "Проспект Сахарова",
    "Площадь Королёва",
    "Agent Smith",
    "Morgan Stanley",
    "Wells Fargo",
    "Grace Period",
    "Smith Street",
    "Кафе Тимур Парк",
    "улица Мусы Джалиля",
    "Али Экспресс",
    "Мадина Маркет",
    "Уважаемые Коллеги",
    "Позвоните Петрову",
  ])("hard negative: %s", (text) => {
    expect(found(text).filter(([, s]) => s.includes(" "))).toEqual([]);
  });
});

describe("phone_intl", () => {
  test("+country code ≠ 7 with 8–15 digits", () => {
    expect(found("Минск: +375 29 123-45-67")).toEqual([["phone_intl", "+375 29 123-45-67"]]);
    expect(found("+998901234567")).toEqual([["phone_intl", "+998901234567"]]);
    expect(found("+380 (67) 1234567")).toEqual([["phone_intl", "+380 (67) 1234567"]]);
    expect(found("+44 20 7946 0958")).toEqual([["phone_intl", "+44 20 7946 0958"]]);
    expect(detect("+375 29 123-45-67")[0]?.piiKind).toBe("phone");
  });
  test("without + only CIS codes in phone context", () => {
    expect(found("тел. 375 29 123 45 67")).toEqual([["phone_intl", "375 29 123 45 67"]]);
    expect(kindsOf("Партия 375 29 123 45 67")).toEqual([]);
  });
  test("short numbers and money are not phones", () => {
    expect(kindsOf("+100500 к карме")).toEqual([]);
    expect(kindsOf("Рост выручки +12 345 678 руб.")).toEqual([]);
  });
});

describe("social_handle", () => {
  test("@handle and profile links", () => {
    expect(found("пишите в телеграм @ivan_petrov")).toEqual([["social_handle", "@ivan_petrov"]]);
    expect(found("t.me/ivan_petrov")).toEqual([["social_handle", "t.me/ivan_petrov"]]);
    expect(found("https://vk.com/id123456.")).toEqual([["social_handle", "https://vk.com/id123456"]]);
    expect(found("instagram.com/anna.smirnova")).toEqual([["social_handle", "instagram.com/anna.smirnova"]]);
  });
  test("not emails, npm scopes, decorators, CSS at-rules, short handles", () => {
    expect(found("ivan_petrov@mail.ru")).toEqual([["email", "ivan_petrov@mail.ru"]]);
    expect(kindsOf('import { x } from "@tanstack/react-query"')).toEqual([]);
    expect(kindsOf("@Component({ selector: 'app' })")).toEqual([]);
    expect(kindsOf("@media (max-width: 600px) {} @keyframes spin {}")).toEqual([]);
    expect(kindsOf("@ivan")).toEqual([]);
    expect(kindsOf("t.me/share")).toEqual([]);
  });
  test("the system's own service accounts are ignored", () => {
    const text = "Бот записи: t.me/salon_booking_bot, администратор @salon_admin_masha";
    expect(found(text).map(([k]) => k)).toEqual(["social_handle", "social_handle"]);
    expect(found(text, { ignoreHandles: ["salon_booking_bot"] })).toEqual([
      ["social_handle", "@salon_admin_masha"],
    ]);
  });
});

describe("ogrnip", () => {
  test("15 digits, first 3/4, checksum mod 13", () => {
    expect(found("ОГРНИП 304500116000157")).toEqual([["ogrnip", "304500116000157"]]);
    expect(kindsOf("ОГРНИП 304500116000158")).toEqual([]);
    expect(kindsOf("504500116000157")).toEqual([]);
    expect(kindsOf("ОГРН 1027700132195")).toEqual([]);
  });
});

describe("car_plate_ru", () => {
  test("Cyrillic and Latin look-alike letters, with or without spaces", () => {
    expect(found("Госномер А123ВС77")).toEqual([["car_plate_ru", "А123ВС77"]]);
    expect(found("машина А 123 ВС 777")).toEqual([["car_plate_ru", "А 123 ВС 777"]]);
    expect(found("пропуск на а123вс77")).toEqual([["car_plate_ru", "а123вс77"]]);
    expect(found("номер K123MH199")).toEqual([["car_plate_ru", "K123MH199"]]);
    expect(found("номер Е001КХ05")).toEqual([["car_plate_ru", "Е001КХ05"]]);
  });
  test("hex, identifiers, distances are not plates", () => {
    expect(kindsOf("color: #A123BC77")).toEqual([]);
    expect(kindsOf("id a123bc77")).toEqual([]);
    expect(kindsOf("Ехать в 100 км 20 минут")).toEqual([]);
    expect(kindsOf("А123ВС")).toEqual([]);
  });
});

describe("special / biometric context", () => {
  test("stem near a data subject", () => {
    expect(found("Иванов Иван, диагноз: диабет")).toEqual([
      ["person_name", "Иванов Иван"],
      ["special_context", "диагноз"],
    ]);
    expect(
      detect("Иванов Иван, судимость погашена").find((f) => f.kind === "special_context")?.category,
    ).toBe("special");
    expect(found("Сотрудник +7 916 123-45-67 сдал отпечатки пальцев")).toEqual([
      ["phone_ru", "+7 916 123-45-67"],
      ["biometric_context", "отпечатки пальцев"],
    ]);
  });
  test("no subject — no finding; patronymic -вич is not HIV", () => {
    expect(kindsOf("спросить про аллергии")).toEqual([]);
    expect(kindsOf("Поле «Диагноз» не добавлять")).toEqual([]);
    expect(kindsOf("Сергей Иванович")).toEqual(["person_name"]);
    expect(kindsOf("у Сергея ВИЧ")).toEqual(["person_name", "special_context"]);
  });
  test("outside the 100-character window", () => {
    const text = `Иван Петров. ${"x".repeat(120)} диагноз`;
    expect(kindsOf(text)).toEqual(["person_name"]);
  });
});

describe("detect()", () => {
  test("finding shape", () => {
    const [f] = detect("тел. +7 916 123-45-67");
    expect(f).toEqual({
      kind: "phone_ru",
      category: "basic",
      piiKind: "phone",
      start: 5,
      end: 21,
      confidence: "high",
    });
  });
  test("empty and non-PII input", () => {
    expect(detect("")).toEqual([]);
    expect(detect("Система записи клиентов: администратор видит все заявки.")).toEqual([]);
  });
  test("findings never overlap and are sorted", () => {
    const text =
      "Иванов Иван, +7 916 123-45-67, ivan@mail.ru, г. Москва, ул. Ленина, д. 5, паспорт 4506 123456";
    const fs = detect(text);
    for (let i = 1; i < fs.length; i++) expect(fs[i]?.start).toBeGreaterThanOrEqual(fs[i - 1]?.end ?? 0);
    expect(fs.map((f) => f.kind)).toEqual(["person_name", "phone_ru", "email", "address", "passport_ru"]);
  });
});
