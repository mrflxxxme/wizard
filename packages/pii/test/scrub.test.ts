import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { detect, isPlaceholder, KIND_INFO, PLACEHOLDER_RE, scrub, scrubJson, scrubMessages } from "../src/index.js";
import { CORPUS_PATH, type CorpusLine } from "./gen-corpus.js";

const BRIEF =
  "Меня зовут Иванов Иван Иванович, тел. +7 (916) 123-45-67, почта ivan.petrov@mail.ru. " +
  "Паспорт 45 06 123456, СНИЛС 112-233-445 95, ИНН 500100732259, карта 4111 1111 1111 1111. " +
  "Адрес: г. Москва, ул. Ленина, д. 5, кв. 12. Дата рождения: 12.03.1985. Счёт 40817810099910004312.";
const VALUES = [
  "Иванов Иван Иванович",
  "+7 (916) 123-45-67",
  "ivan.petrov@mail.ru",
  "45 06 123456",
  "112-233-445 95",
  "500100732259",
  "4111 1111 1111 1111",
  "ул. Ленина, д. 5, кв. 12",
  "12.03.1985",
  "40817810099910004312",
];

describe("scrub()", () => {
  test("replaces every kind with a one-way placeholder", () => {
    const r = scrub(BRIEF);
    expect(r.text).toBe(
      "Меня зовут [ФИО_1], тел. [ТЕЛЕФОН_1], почта [EMAIL_1]. " +
        "Паспорт [ПАСПОРТ_1], СНИЛС [СНИЛС_1], ИНН [ИНН_1], карта [КАРТА_1]. " +
        "Адрес: [АДРЕС_1]. Дата рождения: [ДАТА_РОЖДЕНИЯ_1]. Счёт [СЧЁТ_1].",
    );
    expect(r.counts).toEqual({
      person_name: 1,
      phone_ru: 1,
      email: 1,
      passport_ru: 1,
      snils: 1,
      inn_person: 1,
      card: 1,
      address: 1,
      birthdate: 1,
      account_ru: 1,
    });
    expect(r.maxCategory).toBe("basic");
    expect(r.strongIds).toBe(true);
  });

  test("returns no mapping and no original values (M0-05)", () => {
    const r = scrub(BRIEF);
    expect(Object.keys(r).sort()).toEqual(["counts", "maxCategory", "strongIds", "text"]);
    const serialized = JSON.stringify(r);
    for (const v of VALUES) expect(serialized).not.toContain(v);
    for (const v of Object.values(r.counts)) expect(typeof v).toBe("number");
  });

  test("placeholder format ^\\[[А-ЯЁ_]+_\\d+\\]$ (EMAIL is the Latin exception)", () => {
    const placeholders = scrub(BRIEF).text.match(PLACEHOLDER_RE) ?? [];
    expect(placeholders.length).toBe(10);
    for (const p of placeholders) {
      expect(isPlaceholder(p)).toBe(true);
      if (p.startsWith("[EMAIL")) expect(p).toMatch(/^\[EMAIL_\d+\]$/);
      else expect(p).toMatch(/^\[[А-ЯЁ_]+_\d+\]$/u);
    }
    for (const info of Object.values(KIND_INFO)) {
      if (info.placeholder) expect(isPlaceholder(`[${info.placeholder}_1]`)).toBe(true);
    }
  });

  test("numbering: same value → same n, different values → different n, per call", () => {
    const r = scrub("Звонить 8 916 123-45-67 или +79161234567, резерв +7 903 000-00-01. Маша и Даша, снова Маша.");
    expect(r.text).toBe("Звонить [ТЕЛЕФОН_1] или [ТЕЛЕФОН_1], резерв [ТЕЛЕФОН_2]. [ФИО_1] и [ФИО_2], снова [ФИО_1].");
    expect(r.counts).toEqual({ phone_ru: 3, person_name: 3 });
    // A fresh call starts numbering again: nothing is remembered between calls.
    expect(scrub("+7 903 000-00-01").text).toBe("[ТЕЛЕФОН_1]");
  });

  test("special categories are counted, not replaced; maxCategory reflects them", () => {
    const r = scrub("Пациент Иванов Иван, диагноз: диабет");
    expect(r.text).toBe("Пациент [ФИО_1], диагноз: диабет");
    expect(r.counts).toEqual({ person_name: 1, special_context: 1 });
    expect(r.maxCategory).toBe("special");
    expect(r.strongIds).toBe(false);
    expect(scrub("Иван Петров сдал отпечатки пальцев").maxCategory).toBe("biometric");
  });

  test("text without PII is returned unchanged", () => {
    const text = "Нужна CRM: заявки, статусы, отчёт по менеджерам. ИНН организации 7707083893.";
    expect(scrub(text)).toEqual({ text, counts: {}, maxCategory: "none", strongIds: false });
  });

  test("scrubbed text has no detectable PII left; placeholders are stable under re-scrub", () => {
    const once = scrub(BRIEF).text;
    expect(detect(once)).toEqual([]);
    expect(scrub(once).text).toBe(once);
  });

  test("corpus: after scrub no basic-category findings remain", () => {
    const lines = readFileSync(CORPUS_PATH, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as CorpusLine);
    const leaks = lines
      .map((l) => ({ id: l.id, left: detect(scrub(l.text).text).filter((f) => f.category === "basic") }))
      .filter((x) => x.left.length > 0);
    expect(leaks).toEqual([]);
  });
});

describe("scrubJson() / scrubMessages()", () => {
  test("walks nested values and keys with one numbering", () => {
    const r = scrubJson({
      client: { name: "Иванов Иван", phones: ["+7 916 123-45-67", "8 (916) 123-45-67"] },
      note: "звонил Иванов Иван",
      count: 3,
      ok: true,
      nothing: null,
      phoneAsNumber: 79161234567,
    });
    expect(r.value).toEqual({
      client: { name: "[ФИО_1]", phones: ["[ТЕЛЕФОН_1]", "[ТЕЛЕФОН_1]"] },
      note: "звонил [ФИО_1]",
      count: 3,
      ok: true,
      nothing: null,
      phoneAsNumber: "[ТЕЛЕФОН_1]",
    });
    expect(r.counts).toEqual({ person_name: 2, phone_ru: 3 });
    expect(Object.keys(r).sort()).toEqual(["counts", "maxCategory", "strongIds", "value"]);
  });

  test("chat messages: roles and ids untouched, numbering shared across messages", () => {
    const messages = [
      { role: "system", content: "Ты — строитель систем." },
      { role: "user", content: "Меня зовут Анна Смирнова, мой телефон +7 916 123-45-67" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "add_field", arguments: '{"label":"Анна Смирнова"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "Анна Смирнова: ok" }] },
    ];
    const r = scrubMessages(messages);
    expect(r.messages[0]).toEqual(messages[0]);
    expect(r.messages[1]).toEqual({ role: "user", content: "Меня зовут [ФИО_1], мой телефон [ТЕЛЕФОН_1]" });
    expect(r.messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "add_field", arguments: '{"label":"[ФИО_1]"}' } }],
    });
    expect(r.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "[ФИО_1]: ok" }] });
    expect(r.counts).toEqual({ person_name: 3, phone_ru: 1 });
    expect(messages[1]?.content).toContain("Анна Смирнова"); // input is not mutated
  });
});
