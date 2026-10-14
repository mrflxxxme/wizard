// The system's words in a visitor's text (rehearsal №6: «Запишитесь на слот.» on the first screen of the skeleton): a
// plan text in the jargon is not shown, the next source of the place is taken; «лидер», «бронзовый» stay.
import { describe, expect, test } from "vitest";
import { JARGON_RE, type SiteFacts, textOf } from "../src/builder/v3/compose/facts.js";

const facts = (subtitle: string) => ({ texts: new Map([["hero", { subtitle }]]) }) as unknown as SiteFacts;

describe("V4-06: the visitor's language, not the system's", () => {
  test("слот, лид, бронь in a plan text: left out", () => {
    expect(textOf(facts("Запишитесь на слот."), "hero", "subtitle")).toBeUndefined();
    expect(textOf(facts("Свободные слоты на неделю"), "hero", "subtitle")).toBeUndefined();
    expect(textOf(facts("Бронь столика за минуту"), "hero", "subtitle")).toBeUndefined();
    expect(textOf(facts("Каждый лид — в CRM"), "hero", "subtitle")).toBeUndefined();
  });

  test("words that only begin the same stay", () => {
    expect(textOf(facts("Выберите свободное время — запишем к врачу"), "hero", "subtitle")).toBe(
      "Выберите свободное время — запишем к врачу",
    );
    for (const ok of ["Лидер района по отзывам", "Бронзовый загар за сеанс", "Забронируйте столик"])
      expect(JARGON_RE.test(ok), ok).toBe(false);
  });
});
