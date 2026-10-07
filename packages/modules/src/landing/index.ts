// Module «Секции лендинга» (specs/modules/modules.yaml#catalog landing): the public page «/» from the plan's landing
// sections — the section library of B2-35 (20 types, 3–5 layouts each, ui-kit blocks). No data of its own; sections
// with data bind to the entities of their modules (lead form → leads, services and prices → catalog or packages).
import type { ModuleFragments, ModuleManifest } from "@wizard/appspec";
import { PACKAGE_NAMES } from "../packages/compile.js";
import type { ModuleContext, ModuleDefinition } from "../types.js";
import { LANDING_MATRIX } from "./matrix.js";
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
  hook: true,
  fragments: {},
  screens: [
    {
      id: "home",
      audience: "public",
      route: "/",
      title: "Главная",
      roles: ["$public", "$owner", "$staff", "$visitor"],
      components: [
        "Header",
        "Hero",
        "Features",
        "Steps",
        "Faq",
        "Cta",
        "LeadForm",
        "Footer",
        "Pricing",
        "Booking",
        "Gallery",
        "Team",
        "Testimonials",
        "Stats",
        "About",
        "Contacts",
        "Hours",
        "Logos",
        "TextBlock",
      ],
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
      ...LANDING_MATRIX,
    ],
    gates: ["G0", "G1"],
  },
};

/**
 * compile.ts: the pricing section of a plan without the catalog shows the tariffs of «Абонементы и пакеты» — visitors
 * read them (names and prices only are on the page anyway).
 */
export function landingCompile(ctx: ModuleContext): ModuleFragments {
  const pricing = (ctx.plan.landing?.sections ?? []).some((s) => s.type === "pricing");
  if (!pricing || ctx.present.has("catalog") || !ctx.present.has("packages")) return {};
  return { permissions: [{ value: { role: "$public", entity: PACKAGE_NAMES.plan, ops: ["read"] } }] };
}

export const landingModule: ModuleDefinition = {
  manifest: landingManifest,
  compile: landingCompile,
  screens: { home: landingPage },
  warnings: (ctx) =>
    (ctx.plan.landing?.sections ?? []).some((s) => s.content.image !== undefined)
      ? ["Фото в секциях пока не выводятся: их подберёт сток (B2-38), сейчас секции без фото"]
      : [],
};
