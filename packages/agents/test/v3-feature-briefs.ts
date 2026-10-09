// V3-18: briefs of v3 features the four eval briefs (v3-eval-briefs.ts) do not reach — the client cabinet with the
// visitor's requests («Мои заявки», GS-visitor_cabinet-2) and booking by a package («Абонементы», GS-packages-2/3). As
// the interview would leave them; the 0 ₽ rung builds them without a model and checks their goal scenarios in a
// browser (apps/platform-api/test/v3-goals.browser.test.ts), the agents tests check the composition.
import type { BriefScenario, SystemBriefInput } from "@wizard/appspec";

type ScenarioInput = Omit<BriefScenario, "then" | "priority"> & { priority?: BriefScenario["priority"] };

function scenario(s: ScenarioInput, steps: string[]): NonNullable<SystemBriefInput["scenarios"]>[number] {
  // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
  return { ...s, then: steps };
}

/** A window cleaning service: requests from the site, the client follows his requests in the cabinet. */
export const CLEANING_CABINET: SystemBriefInput = {
  goals: [
    {
      id: "g_leads",
      text: "Клиенты оставляют заявку на мойку окон и сами видят, что с ней",
      success: "Клиент видит статус своей заявки в личном кабинете",
    },
  ],
  audience: "Жители частных домов в Перми",
  scenarios: [
    scenario(
      {
        id: "s_lead",
        actor: "visitor",
        when: "посетитель оставляет заявку на мойку окон",
        goalId: "g_leads",
        moduleHint: "leads",
      },
      ["сохраняет заявку с согласием", "показывает «Заявка отправлена»"],
    ),
    scenario(
      {
        id: "s_cabinet",
        actor: "client",
        when: "клиент входит в личный кабинет по коду",
        goalId: "g_leads",
        moduleHint: "visitor_cabinet",
      },
      ["показывает только его заявки со статусом"],
    ),
  ],
  roles: [{ id: "manager", name: "Менеджер", can: ["видит заявки", "меняет статус заявки"] }],
  data: [
    {
      entity: "Заявка",
      fields: [
        { name: "Имя", pii: true },
        { name: "Телефон", pii: true },
        { name: "Почта", pii: true },
      ],
      retention: "1 год",
    },
  ],
  design: { archetype: "swiss", references: [] },
};

/** A yoga studio: the client books a class and a visit is written off his package. */
export const YOGA_PACKAGES: SystemBriefInput = {
  goals: [
    {
      id: "g_book",
      text: "Клиенты записываются на занятия по абонементу",
      success: "Визит списывается с абонемента при записи",
    },
  ],
  audience: "Жители Самары, которые занимаются йогой",
  scenarios: [
    scenario(
      {
        id: "s_book",
        actor: "visitor",
        when: "посетитель выбирает занятие и свободное время",
        goalId: "g_book",
        moduleHint: "booking",
      },
      ["создаёт запись", "показывает подтверждение"],
    ),
    scenario(
      {
        id: "s_package",
        actor: "client",
        when: "клиент записывается на занятие по абонементу",
        goalId: "g_book",
        moduleHint: "packages",
      },
      ["списывает визит с абонемента", "не записывает без действующего абонемента"],
    ),
  ],
  roles: [{ id: "admin", name: "Администратор", can: ["продаёт абонементы", "видит записи"] }],
  data: [
    {
      entity: "Запись",
      fields: [
        { name: "Имя", pii: true },
        { name: "Телефон", pii: true },
      ],
      retention: "1 год",
    },
  ],
  design: { archetype: "calm_medical", references: [] },
};

/** The feature briefs by id. */
export const FEATURE_BRIEFS: Readonly<Record<string, SystemBriefInput>> = {
  "v3-x-cleaning-cabinet": CLEANING_CABINET,
  "v3-x-yoga-packages": YOGA_PACKAGES,
};
