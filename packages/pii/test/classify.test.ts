import { describe, expect, test } from "vitest";
import { classifyFieldName, detectSpecialTerms } from "../src/index.js";

describe("classifyFieldName (G2-PII-02/03)", () => {
  const basic: Array<[string, string | undefined, string]> = [
    ["fio", "ФИО", "fio"],
    ["fullName", undefined, "fio"],
    ["last_name", "Фамилия", "fio"],
    ["first_name", undefined, "fio"],
    ["patronymic", "Отчество", "fio"],
    ["client", "Имя клиента", "fio"],
    ["phone", "Телефон", "phone"],
    ["mobilePhone", undefined, "phone"],
    ["contact", "Моб. номер", "phone"],
    ["whatsapp", undefined, "phone"],
    ["email", "E-mail", "email"],
    ["contact_email", "Электронная почта", "email"],
    ["mail", "Адрес электронной почты", "email"],
    ["address", "Адрес доставки", "address"],
    ["street", undefined, "address"],
    ["birthDate", "Дата рождения", "birthdate"],
    ["dob", undefined, "birthdate"],
    ["bday", "День рождения", "birthdate"],
    ["passport", "Паспорт", "passport"],
    ["passportNumber", undefined, "passport"],
    ["snils", "СНИЛС", "snils"],
    ["inn", "ИНН", "inn"],
    ["tg", "Telegram", "other"],
    ["contact", "Контакт для связи", "other"],
    ["cardNumber", "Номер карты", "card"],
  ];
  test.each(basic)("%s / %s → basic %s", (name, label, piiKind) => {
    expect(classifyFieldName(name, label)).toEqual({ pii: "basic", piiKind });
  });

  const special: Array<[string, string | undefined, "special" | "biometric"]> = [
    ["diagnosis", "Диагноз", "special"],
    ["health", "Состояние здоровья", "special"],
    ["allergies", "Аллергии", "special"],
    ["religion", "Вероисповедание", "special"],
    ["criminal_record", "Судимость", "special"],
    ["ethnicity", "Национальность", "special"],
    ["disability", "Инвалидность", "special"],
    ["fingerprint", "Отпечаток пальца", "biometric"],
    ["faceId", "Биометрия", "biometric"],
  ];
  test.each(special)("%s / %s → %s", (name, label, pii) => {
    expect(classifyFieldName(name, label)).toEqual({ pii, piiKind: "other" });
  });

  const none: Array<[string, string | undefined]> = [
    ["name", "Название"],
    ["title", "Заголовок"],
    ["fileName", "Имя файла"],
    ["projectName", "Имя проекта"],
    ["price", "Цена"],
    ["headphones", "Наушники"],
    ["website", "Адрес сайта"],
    ["ip_address", "IP-адрес"],
    ["company_inn", "ИНН организации"],
    ["status", "Статус заявки"],
    ["schedule", "Расписание"],
    ["policy", "Политика конфиденциальности"],
    ["eventDate", "Дата мероприятия"],
  ];
  test.each(none)("%s / %s → null", (name, label) => {
    expect(classifyFieldName(name, label)).toBeNull();
  });

  test("declared type email/phone", () => {
    expect(classifyFieldName("contact", "Связь", "email")).toEqual({ pii: "basic", piiKind: "email" });
    expect(classifyFieldName("x", undefined, "phone")).toEqual({ pii: "basic", piiKind: "phone" });
  });

  test("special wins over basic", () => {
    expect(classifyFieldName("patient", "ФИО и диагноз")).toEqual({ pii: "special", piiKind: "other" });
  });
});

describe("detectSpecialTerms", () => {
  test("keywords alone, no subject needed", () => {
    expect(detectSpecialTerms("Анализы крови")).toBe("special");
    expect(detectSpecialTerms("Политические взгляды")).toBe("special");
    expect(detectSpecialTerms("Скан лица для прохода")).toBe("biometric");
    expect(detectSpecialTerms("распознавание лиц")).toBe("biometric");
    expect(detectSpecialTerms("Пожелания по питанию")).toBe(null);
    expect(detectSpecialTerms("Расписание занятий")).toBe(null);
  });
});
