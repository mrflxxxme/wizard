// V4-06 quality probe fixtures: the two other businesses of the V4 acceptance (tools/eval/acceptance/briefs) — the
// coffee house «Зерно и пар» (menu, takeaway pre-order) and the beauty salon «Лаванда» (services with durations,
// booking to a master) — compiled in backend mode like the clinic of v3-compose-fixtures.ts, with a brief whose first
// scenario is the one the home page serves. Facts only from the acceptance briefs (D49): no invented numbers.
import { type BriefScenario, type SystemBrief, type SystemPlan, systemBriefSchema } from "@wizard/appspec";
import { compilePlan } from "@wizard/modules";
import { type ArchetypeId, designSystemV3 } from "@wizard/ui-kit/v3/design";
import type { V3BuildContext } from "../src/builder/v3/contract.js";
import { DEFAULT_REGISTRY } from "../src/planner/index.js";
import { BRIEF as CLINIC_BRIEF, composeContext } from "./v3-compose-fixtures.js";

export interface QualityCase {
  id: "clinic" | "coffee" | "salon";
  ctx: V3BuildContext;
  /** The scenario whose page is the home page. */
  scenario: BriefScenario;
}

const photo = (i: number, alt: string) => ({
  slot: i ? `top-${i + 1}` : "top",
  file: `1000000${i}-0000-4000-8000-00000000000${i}`,
  alt,
  provider: "pexels" as const,
  stockId: `20${i}`,
  author: "Автор",
  pageUrl: "https://www.pexels.com/photo/1",
  license: "Pexels License",
  licenseUrl: "https://www.pexels.com/license",
  width: 1600,
  height: 1067,
  pickedAt: "2026-10-08",
});

const design: SystemPlan["design"] = {
  direction: { mood: ["тепло"] },
  theme: "strict",
  accent: "#1F4FB8",
  fontPair: { heading: "Manrope", body: "Inter Tight" },
  photoStyle: "дневной свет",
};

interface CaseInput {
  systemId: string;
  appName: string;
  plan: SystemPlan;
  brief: SystemBrief;
  /** The business in the owner's words (spec.app.description: the «Описание» of the page facts). */
  description: string;
  photos: string[];
  operator: { name: string; contact: string; address: string };
  archetype: ArchetypeId;
  brandColor: string;
}

function caseContext(o: CaseInput): V3BuildContext {
  const plan = { ...o.plan, design: { ...o.plan.design, photos: o.photos.map((alt, i) => photo(i, alt)) } };
  const r = compilePlan(plan, DEFAULT_REGISTRY, { appName: o.appName, front: "backend" });
  if (!r.ok || !r.publicFront) throw new Error(JSON.stringify(r.ok ? "no public front" : r.errors));
  return {
    systemId: o.systemId,
    brief: o.brief,
    briefVersion: 1,
    plan: r.plan,
    spec: {
      ...r.spec,
      app: { ...r.spec.app, description: o.description },
      compliance: {
        ...r.spec.compliance,
        operatorName: o.operator.name,
        operatorContact: o.operator.contact,
        operatorAddress: o.operator.address,
      },
    },
    publicFront: r.publicFront,
    design: designSystemV3({ archetype: o.archetype, brandColor: o.brandColor, seed: 7, niche: plan.niche }),
    files: new Map(Object.entries(r.files)),
    route: async () => {
      throw new Error("model is not connected in this test");
    },
    budgetRub: 100,
  };
}

const COFFEE_BRIEF = systemBriefSchema.parse({
  goals: [
    {
      id: "menu",
      text: "Гости видят меню с ценами и что за зерно сейчас в работе",
      success: "Меню открыто на сайте",
    },
    {
      id: "preorder",
      text: "Гости заранее заказывают кофе навынос и забирают без очереди",
      success: "Предзаказ виден бариста",
    },
  ],
  audience: "Гости кофейни на Большой Покровской и те, кто берёт кофе навынос",
  scenarios: [
    {
      id: "preorder",
      actor: "visitor",
      when: "гость хочет заранее заказать кофе навынос",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: [
        "показывает меню с ценами и фото",
        "принимает предзаказ навынос к определённому времени",
        "показывает часы работы и как нас найти",
      ],
      goalId: "preorder",
      moduleHint: "leads",
    },
    {
      id: "menu",
      actor: "visitor",
      when: "гость смотрит меню",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["показывает меню: кофе, альтернатива, десерты, завтраки"],
      goalId: "menu",
      moduleHint: "catalog",
    },
  ],
});

const COFFEE_PLAN: SystemPlan = {
  version: 1,
  niche: "кофейня",
  goals: [
    { id: "show_offer", statement: "Гости видят меню с ценами" },
    { id: "leads", statement: "Гости заказывают кофе навынос к своему времени" },
  ],
  modules: [
    { id: "landing" },
    { id: "catalog", goals: ["show_offer"] },
    {
      id: "leads",
      params: { form_fields: ["name", "phone", "comment"], contact: "phone" },
      goals: ["leads"],
    },
    { id: "notify", params: { channels: ["email"] } },
  ],
  landing: {
    sections: [
      { type: "header", variant: "bar", content: { cta: "Заказать навынос" } },
      {
        type: "hero",
        variant: "split",
        content: {
          title: "Кофе своей обжарки на Большой Покровской",
          subtitle: "Закажите заранее — заберёте без очереди",
          cta: "Заказать навынос",
        },
      },
      { type: "footer", variant: "simple", content: { text: "Кофейня «Зерно и пар»" } },
    ],
  },
  design,
  outOfScope: [{ request: "Оплата на сайте", replacement: "Оплата на месте", category: "payments" }],
  custom: [],
};

const SALON_BRIEF = systemBriefSchema.parse({
  goals: [
    {
      id: "booking",
      text: "Клиентки сами записываются к мастеру на свободное окно",
      success: "Запись видна мастеру",
    },
    { id: "offer", text: "Клиентки видят услуги с ценами и длительностью", success: "Прайс открыт на сайте" },
  ],
  audience: "Клиентки салона в Екатеринбурге",
  scenarios: [
    {
      id: "visit",
      actor: "visitor",
      when: "клиентка впервые заходит на сайт салона",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: [
        "показывает услуги с ценами и длительностью",
        "даёт выбрать мастера или услугу и свободное окно",
        "показывает контакты",
      ],
      goalId: "booking",
    },
    {
      id: "remind",
      actor: "visitor",
      when: "до визита остался день",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["присылает напоминание"],
      goalId: "booking",
      moduleHint: "notify",
    },
  ],
});

const SALON_PLAN: SystemPlan = {
  version: 1,
  niche: "салон красоты",
  goals: [
    { id: "fill_schedule", statement: "Клиентки записываются к мастеру онлайн" },
    { id: "show_offer", statement: "Клиентки видят услуги и цены" },
  ],
  modules: [
    { id: "landing" },
    { id: "catalog", params: { with_duration: true }, goals: ["show_offer"] },
    {
      id: "booking",
      params: { with_specialists: true, specialist_label: "Мастер" },
      goals: ["fill_schedule"],
    },
    { id: "notify", params: { channels: ["email"] } },
  ],
  landing: {
    sections: [
      { type: "header", variant: "bar", content: { cta: "Записаться" } },
      {
        type: "hero",
        variant: "split",
        content: {
          title: "Стрижки, маникюр, брови и ресницы в Екатеринбурге",
          subtitle: "Выберите мастера и свободное окно",
          cta: "Записаться",
        },
      },
      { type: "footer", variant: "simple", content: { text: "Салон красоты «Лаванда»" } },
    ],
  },
  design,
  outOfScope: [{ request: "Онлайн-оплата", replacement: "Оплата в салоне", category: "payments" }],
  custom: [],
};

/** The three businesses of the V4 acceptance for the page quality probe: clinic, coffee house, beauty salon. */
export function qualityCases(o: { contact?: string } = {}): QualityCase[] {
  return [
    { id: "clinic", ctx: composeContext(o), scenario: CLINIC_BRIEF.scenarios[0] as BriefScenario },
    {
      id: "coffee",
      ctx: caseContext({
        systemId: "sys-zerno",
        appName: "Зерно и пар",
        plan: COFFEE_PLAN,
        brief: COFFEE_BRIEF,
        description:
          "Небольшая кофейня со своей обжаркой: альтернатива, десерты от местной кондитерской, завтраки до 12. По пятницам каппинги и вечера с музыкантами.",
        photos: [
          "Бариста наливает кофе у стойки",
          "Чашка капучино на деревянном столе",
          "Зал кофейни у окна",
        ],
        operator: {
          name: "Кофейня «Зерно и пар»",
          contact: o.contact ?? "+7 831 200-10-20",
          address: "Нижний Новгород, Большая Покровская",
        },
        archetype: "warm_craft",
        brandColor: "#8a4b2a",
      }),
      scenario: COFFEE_BRIEF.scenarios[0] as BriefScenario,
    },
    {
      id: "salon",
      ctx: caseContext({
        systemId: "sys-lavanda",
        appName: "Лаванда",
        plan: SALON_PLAN,
        brief: SALON_BRIEF,
        description:
          "Салон красоты: стрижки и окрашивание, маникюр и педикюр, брови и ресницы. Шесть мастеров, у каждого свой график и свои услуги.",
        photos: [
          "Мастер делает укладку клиентке",
          "Маникюр крупным планом",
          "Светлый зал салона с зеркалами",
        ],
        operator: {
          name: "Салон красоты «Лаванда»",
          contact: o.contact ?? "+7 343 200-30-40",
          address: "Екатеринбург",
        },
        archetype: "soft_organic",
        brandColor: "#7a5c9e",
      }),
      scenario: SALON_BRIEF.scenarios[0] as BriefScenario,
    },
  ];
}
