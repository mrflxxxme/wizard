// Module «Секции лендинга» (specs/modules/modules.yaml#catalog landing): the public page «/» from the plan's landing
// sections — the section library of B2-35 (20 types, 3–5 layouts each, ui-kit blocks). No data of its own; sections
// with data bind to the entities of their modules (lead form → leads, services and prices → catalog or packages).
// Photos (B2-38, param `photos`): stock photos the builder picked for the plan (copies in the platform photo library),
// the owner's own photo of any slot (site_photo, «Фото сайта» in the cabinet) and the «Источники фото» page.
import type { ModuleFragments, ModuleManifest } from "@wizard/appspec";
import { PACKAGE_NAMES } from "../packages/compile.js";
import type { ModuleContext, ModuleDefinition } from "../types.js";
import { LANDING_MATRIX, LANDING_PHOTO_ROW } from "./matrix.js";
import { landingPage } from "./page.js";
import {
  PHOTO_CABINET_ROUTE,
  PHOTO_CREDITS_ROUTE,
  PHOTO_HELPER,
  photoCabinetPage,
  photoCreditsPage,
  SITE_PHOTO,
  sitePhotosFile,
} from "./photos.js";

const photosOn = { param: "photos" } as const;

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
    { name: "photos", label: "Фото в секциях (со стока или свои)", type: "bool", default: true },
  ],
  provides: { entities: [SITE_PHOTO.entity], routes: ["/", PHOTO_CREDITS_ROUTE, PHOTO_CABINET_ROUTE] },
  hook: true,
  fragments: {
    entities: [
      {
        when: photosOn,
        value: {
          name: SITE_PHOTO.entity,
          label: "Фото сайта",
          fields: [
            {
              name: SITE_PHOTO.slot,
              label: "Место на странице",
              type: "string",
              required: true,
              maxLength: 60,
            },
            { name: SITE_PHOTO.image, label: "Фото", type: "image" },
            { name: SITE_PHOTO.alt, label: "Описание фото", type: "string", maxLength: 160 },
          ],
          indexes: [{ fields: [SITE_PHOTO.slot], unique: true }],
        },
      },
    ],
    permissions: [
      { when: photosOn, value: { role: "$public", entity: SITE_PHOTO.entity, ops: ["read"] } },
      {
        when: photosOn,
        value: { role: "$owner", entity: SITE_PHOTO.entity, ops: ["read", "create", "update", "delete"] },
      },
    ],
  },
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
    {
      id: "credits",
      audience: "public",
      route: PHOTO_CREDITS_ROUTE,
      title: "Источники фото",
      roles: ["$public", "$owner", "$staff", "$visitor"],
      components: ["LandingSection"],
      when: photosOn,
    },
    {
      id: "photos",
      audience: "cabinet",
      route: PHOTO_CABINET_ROUTE,
      title: "Фото сайта",
      roles: ["$owner"],
      components: ["CabinetLayout", "Image", "ImageField"],
      when: photosOn,
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
    {
      id: "GS-landing-2",
      goal: "attract",
      title: "Владелец заменяет фото сайта своим в один клик",
      when: photosOn,
      steps: [
        {
          actor: "owner",
          text: "Открывает «Фото сайта» в кабинете и выбирает своё фото для первого места страницы",
        },
        { actor: "visitor", text: "Открывает главную страницу" },
      ],
      expect: [{ kind: "page_text", text: "На этом месте главной показано фото владельца" }],
    },
  ],
  tests: {
    matrix: [
      { name: "по умолчанию", params: {} },
      { name: "без закреплённой шапки и меню", params: { sticky_header: false, anchor_nav: false } },
      { name: "без фото в секциях", params: { photos: false } },
      LANDING_PHOTO_ROW,
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
  screens: { home: landingPage, credits: photoCreditsPage, photos: photoCabinetPage },
  files: { [PHOTO_HELPER.file]: sitePhotosFile },
};
