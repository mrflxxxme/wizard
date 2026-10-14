// V4-21: a brief scenario is checked against what its «видит …» steps promise. The rehearsal's s1 (клиника: «видит
// услуги с ценами «от», врачей с фото и опытом, отзывы, контакты, адрес») passed on a site without doctors, reviews or
// contacts; now each promise needs a section of its type (by the site model) and, with the browser, what that section
// shows (names that are not stand-ins, a price, a loaded photo, a phone or an address). Steps that act, not show, promise
// nothing; a scenario without promises is checked as before.
import { describe, expect, test } from "vitest";
import { checkScenario, scenarioPromiseCheck } from "../src/builds-v3/host.js";
import { checkPromises, keeps, type SectionView, scenarioPromises } from "../src/builds-v3/promises.js";
import type { BuildHost } from "../src/runs/types.js";

/** A scenario's `then` steps. */
const steps = (...then: string[]): { then: string[] } => ({ then });

const S1 = steps(
  "Посетитель видит услуги с ценами «от», врачей с фото и опытом, отзывы, контакты, адрес",
  "Записывается на приём к врачу",
);

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
    expect(scenarioPromises(steps("Оставляет заявку на услугу", "Записывается к врачу"))).toEqual([]);
    // Photos and experience promise people only with people in the step.
    expect(scenarioPromises(steps("Видит фото интерьера и опыт клиники"))).toEqual([]);
    expect(scenarioPromises(steps("Смотрит расписание занятий")).map((p) => p.kind)).toEqual(["schedule"]);
  });

  test("by the site model: no section of doctors, reviews or contacts — each said in words", () => {
    const r = checkPromises(S1, site(["header", "hero", "services", "cta", "footer"]), null);
    expect(r.browser).toBe(false);
    expect(r.problems).toHaveLength(5);
    expect(r.problems.join("\n")).toContain(
      "на сайте нет специалистов — нужна секция специалистов с их именами",
    );
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

  test("a signature section (free code) keeps people, reviews and contacts only by a strong sign, never without the browser", () => {
    const files = site(["header", "hero", "signature", "footer"]);
    const doctors = steps("Посетитель видит врачей");
    expect(checkPromises(doctors, files, null).problems).toEqual([
      expect.stringContaining("на сайте нет специалистов"),
    ]);
    const shown = (v: Partial<SectionView>) => new Map([["/", [view("signature-2", v)]]]);
    expect(
      checkPromises(doctors, files, shown({ text: "Наши врачи", names: ["Анна Смирнова — терапевт"] }))
        .problems,
    ).toEqual([]);
    // Headings of steps are no people's names.
    expect(
      checkPromises(
        doctors,
        files,
        shown({ text: "Как записаться", names: ["Выберите услугу", "Выберите врача"] }),
      ).problems,
    ).toEqual([expect.stringContaining("в секции специалистов нет настоящих имён")]);
    // A review in free code is a quote, not any long paragraph.
    const reviews = steps("Посетитель видит отзывы");
    const para = "Запишитесь онлайн: выберите врача и время, подтверждение придёт на почту.";
    expect(checkPromises(reviews, files, shown({ text: para, texts: [para] })).problems).toHaveLength(1);
    expect(
      checkPromises(reviews, files, shown({ text: para, quotes: ["Лечили без боли, спасибо доктору Ким!"] }))
        .problems,
    ).toEqual([]);
  });

  test("s2 of rehearsal №4: a «how it works» section keeps none of the doctors, reviews, contacts; only facts are repaired", () => {
    const files = site(["header", "hero", "catalog", "signature", "footer"]);
    const s2 = steps(
      "Посетитель видит услуги с ценами «от», врачей с фото и опытом, отзывы, контакты и как доехать",
    );
    const how = view("signature-3", {
      text: "Как проходит запись. Выберите услугу. Выберите врача. Подтвердите время. Мы пришлём напоминание за день до приёма.",
      names: ["Выберите услугу", "Выберите врача", "Подтвердите время"],
      texts: ["Мы пришлём напоминание за день до приёма — перенести можно в личном кабинете."],
      images: 1,
    });
    const catalog = view("catalog", {
      text: "Терапия 60 мин Хирургия 90 мин",
      names: ["Терапия", "Хирургия"],
    });
    const footer = view("footer", { text: "Стоматологическая клиника в Казани" });
    const r = checkPromises(s2, files, new Map([["/", [catalog, how, footer]]]));
    const said = [
      "цены не показаны: нет суммы с «₽» или «от»",
      "в секции специалистов нет настоящих имён",
      "фото специалистов не загрузились",
      "у специалистов не указан опыт",
      "в секции отзывов нет текстов отзывов",
      "в контактах нет телефона или адреса",
    ];
    const kinds = (xs: string[]) => xs.map((x) => said.find((k) => x.includes(k)) ?? x);
    expect(kinds(r.problems)).toEqual([
      "цены не показаны: нет суммы с «₽» или «от»",
      "в секции специалистов нет настоящих имён",
      "фото специалистов не загрузились",
      "у специалистов не указан опыт",
      "в секции отзывов нет текстов отзывов",
      "в контактах нет телефона или адреса",
    ]);
    // The repair round is only for what the facts keep: contacts; doctors, reviews, prices go to the requests.
    expect(kinds(r.repairable)).toEqual(["в контактах нет телефона или адреса"]);
    // #207: the specialists the owner named are facts — their section goes to the repair round (not photos, experience).
    const named = checkPromises(s2, files, new Map([["/", [catalog, how, footer]]]), undefined, [
      "Анна Смирнова — терапевт",
    ]);
    expect(kinds(named.repairable)).toEqual([
      "в секции специалистов нет настоящих имён",
      "в контактах нет телефона или адреса",
    ]);
    // Without the browser the code section keeps none of them either.
    expect(checkPromises(s2, files, null).problems.length).toBeGreaterThanOrEqual(4);
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
    scenario: {
      id: "s1",
      title: "Видит клинику",
      given: "Пациент",
      when: "открывает сайт",
      ...steps(...then),
    } as never,
    goalScenarios: [],
    routes: ["/"],
    revision: 3,
  });
  const contacts = async () => ({ phones: [], emails: [] });

  test("gates pass, promises not kept: ok with the promises not kept (the layer stays)", async () => {
    const h = host(site(["header", "hero", "services", "footer"]));
    const r = await checkScenario(
      h,
      null,
      false,
      input(S1.then),
      scenarioPromiseCheck(h, null, { contacts }),
    );
    // The system works (gates passed): not a failure — the promises not kept, for one repair and the requests.
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.unkept?.some((p) => p.includes("на сайте нет отзывов"))).toBe(true);
  });

  test("#207: the staff the owner named reach the check — the missing specialists become repairable", async () => {
    const h = host(site(["header", "hero", "services", "footer"]));
    const doctors = steps("Посетитель видит врачей");
    const without = await scenarioPromiseCheck(h, null, { contacts })(input(doctors.then));
    expect(without.repairable).toEqual([]);
    const named = await scenarioPromiseCheck(h, null, {
      contacts,
      staff: async () => ["Анна Смирнова — терапевт"],
    })(input(doctors.then));
    expect(named.repairable).toEqual([expect.stringContaining("на сайте нет специалистов")]);
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
