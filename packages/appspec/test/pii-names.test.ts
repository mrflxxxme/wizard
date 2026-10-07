// B2-46: the G2-PII-02 criterion shared with module extra fields (abuse.yaml#patterns.pii_field_names).
import { describe, expect, test } from "vitest";
import { type Field, isPiiSubject, normalizeText, piiKindFor, piiNameReason } from "../src/index.js";

const f = (label: string, type: Field["type"] = "string", name = "x"): Field => ({ name, label, type });

describe("piiNameReason / piiKindFor", () => {
  test.each([
    ["Электронная почта", "string", true, "pii_field_names.weak", "email"],
    ["Электронная почта", "string", false, null, undefined],
    ["Мессенджер (Telegram/WhatsApp)", "string", true, "pii_field_names.weak", "other"],
    ["Телефон", "string", false, "pii_field_names.strong", "phone"],
    ["Почта", "email", false, "тип email", "email"],
    ["Паспорт", "string", false, "pii_field_names.strong", undefined],
    ["Дата рождения", "date", false, "pii_field_names.strong", "birthdate"],
    ["Адрес доставки", "string", true, "pii_field_names.weak", "address"],
    ["Адрес площадки", "string", true, null, undefined],
    ["Комментарий", "text", true, null, undefined],
  ] as const)("«%s» (%s, subject %s) → %s / %s", (label, type, subject, why, kind) => {
    const field = f(label, type);
    const r = piiNameReason(field, subject);
    expect(r?.why ?? null).toBe(why);
    if (r) expect(piiKindFor(field, r)).toBe(kind);
  });

  test("identifier words count as well as the label; homoglyphs are folded", () => {
    expect(piiNameReason(f("Связь", "string", "clientEmail"), false)?.why).toBe("pii_field_names.strong");
    expect(normalizeText("Тeлeфон")).toBe("телефон");
  });

  test("subject entity: a pii field, a ref to users or a strong name", () => {
    expect(isPiiSubject({ fields: [f("Комментарий")] })).toBe(false);
    expect(isPiiSubject({ fields: [f("Фото", "file")] })).toBe(true);
    expect(isPiiSubject({ fields: [f("ФИО")] })).toBe(true);
    expect(isPiiSubject({ fields: [{ ...f("Кто"), type: "ref", ref: { entity: "users" } }] })).toBe(true);
  });
});
