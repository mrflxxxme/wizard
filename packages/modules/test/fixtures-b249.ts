// B2-49 fixture: the plan of the D76 control measurement brief mvp-07 «CRM агентства недвижимости» — landing, client
// cards, deals and the staff, nothing for the public to do; the landing's buttons lead nowhere without a target.
import type { PlanSection, SystemPlan } from "@wizard/appspec";
import { landingLeadsPlan, testRegistry } from "./fixtures.js";

const registry = testRegistry();

const goalOf = (id: string) =>
  registry.modules.find((d) => d.manifest.id === id)?.manifest.goals[0] as SystemPlan["goals"][number]["id"];

/** Sections of the realty CRM landing (the model's: «Оставить заявку» buttons without a lead form). */
export const CRM_SECTIONS: readonly PlanSection[] = [
  { type: "header", variant: "bar", content: { cta: "Оставить заявку" } },
  {
    type: "hero",
    variant: "split",
    content: {
      title: "Агентство недвижимости",
      subtitle: "Клиенты, объекты и сделки агентства в одном месте",
      cta: "Оставить заявку",
    },
  },
  {
    type: "features",
    variant: "cards",
    content: { title: "Что внутри", items: ["Карточки клиентов", "Воронка сделок", "Задачи менеджерам"] },
  },
  {
    type: "steps",
    variant: "numbered",
    content: { title: "Как мы работаем", items: ["Звонок", "Показ", "Сделка"] },
  },
  { type: "cta", variant: "card", content: { title: "Готовы начать?", cta: "Оставить заявку" } },
  { type: "footer", variant: "minimal", content: {} },
];

/** «CRM агентства недвижимости»: landing (with the anchor menu), client cards, deals, staff, plus `modules`. */
export function crmLandingPlan(modules: SystemPlan["modules"] = []): SystemPlan {
  return {
    ...landingLeadsPlan(),
    niche: "агентство недвижимости",
    goals: [{ id: goalOf("deals"), statement: "Сделки агентства не теряются между этапами" }],
    modules: [
      { id: "landing", params: { anchor_nav: true } },
      { id: "client_card" },
      { id: "deals" },
      { id: "staff" },
      ...modules,
    ],
    landing: { sections: structuredClone([...CRM_SECTIONS]) },
    outOfScope: [],
    custom: [],
  };
}
