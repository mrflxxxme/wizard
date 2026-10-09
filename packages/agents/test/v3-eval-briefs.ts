// V3-18: system briefs of the four eval briefs of checkpoint 1 (tools/eval/briefs/v3-*.json) as the interview would
// leave them — goals, «Когда…, система…» scenarios with the module hints the grill gives, roles, data and the design
// direction (so the design stage needs no model). Written by hand from the eval texts: the 0 ₽ rung of the v3 build
// (the skeleton of createPageComposer, no model) runs the goal scenarios goalScenariosFor picks for each of them in a
// browser (apps/platform-api/test/v3-goals.browser.test.ts) and checks the composer's rules on them (agents tests).
import type { BriefScenario, SystemBriefInput } from "@wizard/appspec";

type ScenarioInput = Omit<BriefScenario, "then" | "priority"> & { priority?: BriefScenario["priority"] };

function scenario(s: ScenarioInput, steps: string[]): NonNullable<SystemBriefInput["scenarios"]>[number] {
  // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
  return { ...s, then: steps };
}

/** v3-01: an interior studio — a multi-page site with services, portfolio, blog and the lead «Обсудить проект». */
export const INTERIOR_STUDIO: SystemBriefInput = {
  goals: [
    {
      id: "g_leads",
      text: "Посетители оставляют заявку «Обсудить проект» с любой страницы сайта",
      success: "Заявка приходит на почту и в список заявок",
    },
    {
      id: "g_content",
      text: "Администратор сам публикует статьи и проекты без программиста",
      success: "Новая статья видна на сайте сразу после публикации",
    },
  ],
  audience: "Владельцы квартир и домов в Екатеринбурге, которые планируют ремонт",
  scenarios: [
    scenario(
      {
        id: "s_lead",
        actor: "visitor",
        when: "посетитель нажимает «Обсудить проект»",
        goalId: "g_leads",
        moduleHint: "leads",
      },
      ["показывает форму: имя, телефон, площадь объекта и бюджет", "сохраняет заявку с согласием"],
    ),
    scenario(
      {
        id: "s_home",
        actor: "visitor",
        when: "посетитель открывает главную страницу",
        moduleHint: "landing",
      },
      ["показывает лучшие работы студии и кнопку «Обсудить проект»"],
    ),
    scenario(
      { id: "s_services", actor: "visitor", when: "посетитель смотрит услуги студии", moduleHint: "catalog" },
      ["показывает услуги: дизайн квартиры, дизайн дома, авторский надзор, комплектация"],
    ),
    scenario(
      {
        id: "s_blog",
        actor: "visitor",
        when: "посетитель читает блог о ремонте",
        goalId: "g_content",
        moduleHint: "content",
      },
      ["показывает статьи про ремонт и планировки"],
    ),
    scenario(
      {
        id: "s_owner_lead",
        actor: "owner",
        when: "приходит новая заявка",
        goalId: "g_leads",
        moduleHint: "leads",
      },
      ["присылает письмо администратору", "показывает заявку в списке заявок"],
    ),
  ],
  roles: [{ id: "admin", name: "Администратор", can: ["публикует статьи и проекты", "видит заявки"] }],
  data: [
    {
      entity: "Заявка",
      fields: [
        { name: "Имя", pii: true },
        { name: "Телефон", pii: true },
        { name: "Площадь объекта" },
        { name: "Бюджет" },
      ],
      retention: "1 год",
    },
  ],
  design: { archetype: "editorial", references: [] },
};

/** v3-02: a dental clinic — online booking to doctors, a patient's cabinet, the clinic site. */
export const DENTAL_BOOKING: SystemBriefInput = {
  goals: [
    {
      id: "g_book",
      text: "Пациенты записываются к врачам онлайн на свободное время",
      success: "Администратор сразу узнаёт о новой записи",
    },
  ],
  audience: "Пациенты клиники в Казани, записываются с телефона",
  scenarios: [
    scenario(
      {
        id: "s_book",
        actor: "visitor",
        when: "пациент выбирает услугу и свободное время",
        goalId: "g_book",
        moduleHint: "booking",
      },
      ["создаёт запись", "показывает подтверждение", "присылает письмо администратору"],
    ),
    scenario(
      { id: "s_prices", actor: "visitor", when: "пациент смотрит услуги и цены", moduleHint: "catalog" },
      ["показывает услуги с ценами «от»"],
    ),
    scenario(
      {
        id: "s_cabinet",
        actor: "client",
        when: "пациент входит в личный кабинет",
        goalId: "g_book",
        moduleHint: "visitor_cabinet",
      },
      ["показывает только его записи"],
    ),
  ],
  roles: [
    { id: "admin", name: "Администратор", can: ["видит все записи", "записывает пациента по звонку"] },
    { id: "doctor", name: "Врач", can: ["видит только своё расписание"] },
  ],
  data: [
    {
      entity: "Запись",
      fields: [
        { name: "Имя", pii: true },
        { name: "Телефон", pii: true },
      ],
      retention: "3 года",
    },
  ],
  design: { archetype: "calm_medical", references: [] },
};

/** v3-03: a cleaning company — a CRM of deals and crews; the site is a page of services with a lead form. */
export const CLEANING_CRM: SystemBriefInput = {
  goals: [
    {
      id: "g_leads",
      text: "Заявки с сайта попадают менеджерам и не теряются",
      success: "Каждая заявка становится сделкой",
    },
  ],
  audience: "Частные клиенты и офисы Новосибирска",
  scenarios: [
    scenario(
      {
        id: "s_site_lead",
        actor: "visitor",
        when: "посетитель оставляет заявку на уборку на сайте",
        goalId: "g_leads",
        moduleHint: "leads",
      },
      ["сохраняет заявку", "показывает «Заявка отправлена»"],
    ),
    scenario(
      { id: "s_services", actor: "visitor", when: "посетитель смотрит услуги и цены", moduleHint: "catalog" },
      ["показывает виды уборки с примерной ценой"],
    ),
  ],
  roles: [
    { id: "manager", name: "Менеджер", can: ["видит свои сделки"] },
    { id: "head", name: "Руководитель", can: ["видит все сделки и отчёты"] },
  ],
  data: [
    {
      entity: "Заявка",
      fields: [
        { name: "Имя", pii: true },
        { name: "Телефон", pii: true },
      ],
      retention: "1 год",
    },
  ],
  design: { archetype: "swiss", references: [] },
};

/** v3-04: small tours in Karelia — a tour catalog, a travel blog and a lead for a departure. */
export const KARELIA_TOURS: SystemBriefInput = {
  goals: [
    {
      id: "g_leads",
      text: "Посетитель выбирает тур и оставляет заявку на заезд",
      success: "Заявка приходит менеджеру на почту",
    },
  ],
  audience: "Путешественники, которые ищут небольшие группы по Карелии",
  scenarios: [
    scenario(
      { id: "s_tours", actor: "visitor", when: "посетитель смотрит каталог туров", moduleHint: "catalog" },
      ["показывает туры с ценой и длительностью"],
    ),
    scenario(
      {
        id: "s_lead",
        actor: "visitor",
        when: "посетитель выбирает тур и оставляет заявку на заезд",
        goalId: "g_leads",
        moduleHint: "leads",
      },
      ["сохраняет заявку: имя, телефон, сколько человек", "присылает письмо менеджеру"],
    ),
    scenario(
      { id: "s_blog", actor: "visitor", when: "посетитель читает отчёты из поездок", moduleHint: "content" },
      ["показывает статьи блога"],
    ),
  ],
  roles: [{ id: "manager", name: "Менеджер", can: ["меняет туры, даты и статьи", "видит заявки"] }],
  data: [
    {
      entity: "Заявка",
      fields: [{ name: "Имя", pii: true }, { name: "Телефон", pii: true }, { name: "Сколько человек" }],
      retention: "1 год",
    },
  ],
  design: { archetype: "bold_poster", references: [] },
};

/** The four eval briefs of checkpoint 1 by their eval ids. */
export const EVAL_BRIEFS: Readonly<Record<string, SystemBriefInput>> = {
  "v3-01-interior-studio": INTERIOR_STUDIO,
  "v3-02-dental-booking": DENTAL_BOOKING,
  "v3-03-cleaning-crm": CLEANING_CRM,
  "v3-04-karelia-tours": KARELIA_TOURS,
};
