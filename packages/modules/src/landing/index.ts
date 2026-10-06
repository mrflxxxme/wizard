// Module «Секции лендинга» (specs/modules/modules.yaml#catalog landing): the public page «/» from the plan's landing
// sections. No data of its own; the lead form section binds to the leads module's entity.
import type { ModuleManifest } from "@wizard/appspec";
import type { ModuleDefinition } from "../types.js";
import { landingPage } from "./page.js";

export const landingManifest: ModuleManifest = {
  id: "landing",
  version: 1,
  name: "Секции лендинга",
  summary: "Публичная страница из библиотеки секций с вариантами раскладки под дизайн-направление ниши",
  status: "ready",
  order: 10,
  origin: {
    kind: "v1_code",
    ref: "ui-kit/src/components/blocks/*, landingPage в builder/template.ts (D75 site)",
  },
  goals: ["attract"],
  params: [
    { name: "sticky_header", label: "Закреплённая шапка", type: "bool", default: true },
    { name: "anchor_nav", label: "Меню по секциям страницы", type: "bool", default: true },
  ],
  provides: { routes: ["/"] },
  fragments: {},
  screens: [
    {
      id: "home",
      audience: "public",
      route: "/",
      title: "Главная",
      roles: ["$public", "$owner", "$staff", "$visitor"],
      components: ["Header", "Hero", "Features", "Steps", "Faq", "Cta", "LeadForm", "Footer"],
      nav: true,
    },
  ],
  metrics: [],
  goalScenarios: [
    {
      id: "GS-landing-1",
      goal: "attract",
      title: "Посетитель с телефона понимает предложение и находит главное действие",
      steps: [
        { actor: "visitor", text: "Открывает главную страницу на экране 390 px" },
        { actor: "visitor", text: "Нажимает главную кнопку первого экрана" },
      ],
      expect: [
        { kind: "page_text", text: "Заголовок первого экрана из плана виден без прокрутки" },
        { kind: "page_text", text: "Кнопка ведёт к форме заявки или записи на этой же странице" },
      ],
    },
  ],
  tests: {
    matrix: [
      { name: "по умолчанию", params: {} },
      { name: "без закреплённой шапки и меню", params: { sticky_header: false, anchor_nav: false } },
    ],
    gates: ["G0", "G1"],
  },
};

export const landingModule: ModuleDefinition = {
  manifest: landingManifest,
  screens: { home: landingPage },
  warnings: (ctx) =>
    (ctx.plan.landing?.sections ?? []).some((s) => s.content.image !== undefined)
      ? ["Фото в секциях пока не выводятся: их подберёт сток (B2-38), сейчас секции без фото"]
      : [],
};
