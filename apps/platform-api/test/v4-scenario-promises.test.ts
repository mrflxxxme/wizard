// V4-21: a brief scenario is checked against what its «видит …» steps promise. The rehearsal's s1 (клиника: «видит
// услуги с ценами «от», врачей с фото и опытом, отзывы, контакты, адрес») passed on a site without doctors, reviews or
// contacts; now each promise needs a section of its type (by the site model) and, with the browser, what that section
// shows (names that are not stand-ins, a price, a loaded photo, a phone or an address). Steps that act, not show, promise
// nothing; a scenario without promises is checked as before.
import { describe, expect, test } from "vitest";
import { checkScenario, scenarioPromiseCheck } from "../src/builds-v3/host.js";
import { checkPromises, keeps, type SectionView, scenarioPromises } from "../src/builds-v3/promises.js";
import type { BuildHost } from "../src/runs/types.js";

const S1 = {
  then: [
    "Посетитель видит услуги с ценами «от», врачей с фото и опытом, отзывы, контакты, адрес",
    "Записывается на приём к врачу",
  ],
};

/** ui/site.json of a site with the given sections on the home page (and a contacts page when asked). */
function site(home: string[], extra: Record<string, string[]> = {}): Map<string, string> {
  const page = (route: string, types: string[]) => ({
    route,
    sections: types.map((type, i) => ({ id: `${type}-${i}`, type, pattern: `${type}-cards`, props: {} })),
  });
  const pages = [page("/", home), ...Object.entries(extra).map(([r, t]) => page(r, t))];
  return new Map([["ui/site.json", JSON.stringify({ version: 1, pages })]]);
}

const view = (id: string, v: Partial<SectionView>): SectionView => ({
  id,
  text: "",
  names: [],
  texts: [],
  images: 0,
  ...v,
});

describe("V4-21 scenario promises", () => {
  test("s1 of the rehearsal: every promise of its «видит» step, the acting step promises nothing", () => {
    expect(scenarioPromises(S1).map((p) => p.kind)).toEqual([
      "services",
      "prices",
      "staff",
      "staff_photo",
      "staff_experience",
      "reviews",
      "contacts",
    ]);
    expect(scenarioPromises({ then: ["Оставляет заявку на услугу", "Записывается к врачу"] })).toEqual([]);
    // Photos and experience promise people only with people in the step.
    expect(scenarioPromises({ then: ["Видит фото интерьера и опыт клиники"] })).toEqual([]);
    expect(scenarioPromises({ then: ["Смотрит расписание занятий"] }).map((p) => p.kind)).toEqual([
      "schedule",
    ]);
  });

  test("by the site model: no section of doctors, reviews or contacts — each said in words", () => {
    const r = checkPromises(S1, site(["header", "hero", "services", "cta", "footer"]), null);
    expect(r.browser).toBe(false);
    expect(r.problems).toHaveLength(5);
    expect(r.problems.join("\n")).toContain("на сайте нет специалистов");
    expect(r.problems.join("\n")).toContain("на сайте нет отзывов");
    expect(r.problems.join("\n")).toContain("на сайте нет контактов");
    expect(r.problems[0]).toMatch(/^Обещано в сценарии «Посетитель видит услуги/);
  });

  test("every section in place (contacts on their own page): kept by the site model", () => {
    const files = site(["header", "hero", "services", "team", "testimonials", "footer"], {
      "/contacts": ["contacts"],
    });
    expect(checkPromises(S1, files, null).problems).toEqual([]);
  });

  test("in the browser: stand-in names, no price, no photo, no phone — not kept, in words", () => {
    const files = site(["header", "services", "team", "testimonials", "contacts", "footer"]);
    const views = new Map([
      [
        "/",
        [
          view("services-1", {
            text: "Услуги Услуга 1 Услуга 2 Услуга 3",
            names: ["Услуга 1", "Услуга 2", "Услуга 3"],
          }),
          view("team-2", { text: "Врачи Иван Иванов", names: ["Иван Иванов"] }),
          view("testimonials-3", { text: "Отзывы", texts: [] }),
          view("contacts-4", { text: "Контакты Пишите нам" }),
          view("footer", { text: "© Улыбка" }),
        ],
      ],
    ]);
    const r = checkPromises(S1, files, views);
    expect(r.browser).toBe(true);
    expect(r.problems).toEqual([
      expect.stringContaining("в списке услуг только заглушки вместо названий"),
      expect.stringContaining("цены не показаны"),
      expect.stringContaining("в секции специалистов нет настоящих имён"),
      expect.stringContaining("фото специалистов не загрузились"),
      expect.stringContaining("у специалистов не указан опыт"),
      expect.stringContaining("в секции отзывов нет текстов отзывов"),
      expect.stringContaining("в контактах нет телефона или адреса"),
    ]);
  });

  test("in the browser: a site that shows it all keeps every promise; the footer's phone is a contact", () => {
    const files = site(["header", "services", "team", "testimonials", "footer"]);
    const views = new Map([
      [
        "/",
        [
          view("services-1", { text: "Лечение кариеса от 3 500 ₽", names: ["Лечение кариеса", "Чистка"] }),
          view("team-2", {
            text: "Анна Смирнова, стоматолог-терапевт, стаж 12 лет",
            names: ["Анна Смирнова"],
            images: 1,
          }),
          view("testimonials-3", { texts: ["Лечила зуб у Анны — без боли и быстро, всем советую клинику."] }),
          view("footer", { text: "+7 (843) 210-45-67, Казань" }),
        ],
      ],
    ]);
    expect(checkPromises(S1, files, views, { phones: ["+7 843 210-45-67"], emails: [] }).problems).toEqual(
      [],
    );
    // A phone the owner never gave keeps no contacts promise.
    const other = checkPromises(S1, files, views, { phones: ["+7 900 111-22-33"], emails: [] });
    expect(other.problems).toEqual([expect.stringContaining("в контактах нет телефона или адреса")]);
  });

  test("a signature section (free code) may keep any promise: by the site model it stands, the browser judges it", () => {
    const files = site(["header", "hero", "signature", "footer"]);
    const doctors = { then: ["Посетитель видит врачей"] };
    expect(checkPromises(doctors, files, null).problems).toEqual([]);
    const shown = (v: Partial<SectionView>) => new Map([["/", [view("signature-2", v)]]]);
    expect(
      checkPromises(doctors, files, shown({ text: "Наши врачи", names: ["Анна Смирнова"] })).problems,
    ).toEqual([]);
    expect(checkPromises(doctors, files, shown({ text: "Красивая анимация" })).problems).toEqual([
      expect.stringContaining("в секции специалистов нет настоящих имён"),
    ]);
  });

  test("keeps: a price «от», an address, the hours", () => {
    expect(keeps("prices", view("x", { text: "Чистка — от 2000" }))).toBe(true);
    expect(keeps("contacts", view("x", { text: "Казань, ул. Баумана, 12" }))).toBe(true);
    expect(keeps("schedule", view("x", { text: "Пн–Пт 9:00–20:00" }))).toBe(true);
    expect(keeps("schedule", view("x", { text: "Звоните нам" }))).toBe(false);
  });
});

/** A build host whose gates pass and whose draft holds `files`. */
function host(files: Map<string, string>): BuildHost {
  const passed = { level: "G1", passed: true, checks: [] };
  return {
    runGates: async () => passed,
    store: {
      listFiles: async () => [...files.keys()],
      readFile: async (p: string) => files.get(p) ?? null,
      getSpec: async () => ({ spec: {} }),
    },
  } as unknown as BuildHost;
}

describe("V4-21 checkScenario with promises", () => {
  const input = (then: string[]) => ({
    scenario: { id: "s1", title: "Видит клинику", given: "Пациент", when: "открывает сайт", then } as never,
    goalScenarios: [],
    routes: ["/"],
    revision: 3,
  });
  const contacts = async () => ({ phones: [], emails: [] });

  test("gates pass, promises not kept: the scenario fails with the reasons", async () => {
    const h = host(site(["header", "hero", "services", "footer"]));
    const r = await checkScenario(
      h,
      null,
      false,
      input(S1.then),
      scenarioPromiseCheck(h, null, { contacts }),
    );
    expect(r.ok).toBe(false);
    expect(r.unavailable).toBeUndefined();
    expect(r.problems.some((p) => p.includes("на сайте нет отзывов"))).toBe(true);
  });

  test("no promises, or all kept: as before", async () => {
    const h = host(site(["header", "hero", "services", "team", "testimonials", "contacts", "footer"]));
    const check = scenarioPromiseCheck(h, null, { contacts });
    expect(await checkScenario(h, null, false, input(["Оставляет заявку"]), check)).toEqual({
      ok: true,
      problems: [],
      browser: false,
    });
    expect((await checkScenario(h, null, false, input(S1.then), check)).ok).toBe(true);
  });
});
