// B2-20 test fixtures: the dental brief, its goals analysis and plan as a scripted model would answer them.
import type { SystemPlan } from "@wizard/appspec";
import { CATALOG, type ModuleRegistry } from "@wizard/modules";
import type { GoalsAnalysis } from "../src/planner/index.js";

/** The registry the planner tests compile with: the real catalog (@wizard/modules CATALOG). */
export function plannerRegistry(): ModuleRegistry {
  return CATALOG;
}

export const DENTAL_BRIEF =
  "Стоматологическая клиника в Казани. Хотим, чтобы пациенты оставляли заявки на сайте и мы их не теряли, " +
  "а администратор сразу узнавал о новой заявке. Хорошо бы ещё онлайн-запись к врачу и оплату лечения на сайте.";

export function dentalAnalysis(over: Partial<GoalsAnalysis> = {}): GoalsAnalysis {
  return {
    niche: "стоматологическая клиника",
    goals: [
      { id: "leads", statement: "Пациенты оставляют заявки на сайте, и мы их не теряем" },
      { id: "attract", statement: "Посетитель сразу понимает, чем клиника лучше" },
    ],
    roles: ["Администратор"],
    resources: ["услуги", "врачи"],
    modules: [
      { id: "landing", why: "страница клиники" },
      { id: "leads", why: "заявки с сайта" },
      { id: "notify", why: "администратор узнаёт о заявке" },
      { id: "booking", why: "онлайн-запись к врачу" },
    ],
    outOfScope: [{ request: "оплата лечения на сайте", category: "payments" }],
    questions: [
      {
        id: "q1",
        topic: "params",
        module: "leads",
        param: "contact",
        text: "Какой контакт пациента обязателен в заявке?",
        whyItMatters: "Администратор сможет перезвонить или написать",
        options: [
          { id: "phone", label: "Телефон", recommended: true },
          { id: "email", label: "Почта", recommended: false },
        ],
        allowCustom: true,
      },
      {
        id: "q2",
        topic: "goals",
        text: "Что важнее всего в первый месяц?",
        whyItMatters: "От этого зависит, что будет на первом экране",
        options: [
          { id: "leads", label: "Больше заявок", recommended: true },
          { id: "attract", label: "Рассказать о клинике", recommended: false },
        ],
        allowCustom: false,
      },
    ],
    ...over,
  };
}

/** Dental plan: landing (ready section variants), leads with the phone required, notify; booking and payments out. */
export function dentalPlan(): SystemPlan {
  return {
    version: 1,
    niche: "стоматологическая клиника",
    goals: [
      { id: "leads", statement: "Пациенты оставляют заявки на сайте, и мы их не теряем" },
      { id: "attract", statement: "Посетитель сразу понимает, чем клиника лучше" },
    ],
    modules: [
      { id: "landing", goals: ["attract"] },
      { id: "leads", params: { contact: "phone" }, goals: ["leads"] },
      { id: "notify", params: { channels: ["email"] } },
    ],
    landing: {
      sections: [
        { type: "header", variant: "bar", content: { cta: "Оставить заявку" } },
        {
          type: "hero",
          variant: "split",
          content: {
            title: "Лечим зубы без боли",
            subtitle: "Перезвоним за 15 минут",
            cta: "Оставить заявку",
          },
        },
        {
          type: "features",
          variant: "cards",
          content: { title: "Почему мы", items: ["Современное оборудование", "Лечение под анестезией"] },
        },
        {
          type: "lead_form",
          variant: "card",
          content: { title: "Оставьте заявку", submit_label: "Отправить" },
        },
        { type: "footer", variant: "simple", content: { text: "Пример: стоматологическая клиника" } },
      ],
    },
    design: {
      direction: { mood: ["спокойствие", "доверие"], rhythm: "airy" },
      theme: "calm",
      accent: "#2A7F9E",
      fontPair: { heading: "Manrope", body: "Inter Tight" },
      photoStyle: "светлые кабинеты, дневной свет",
    },
    outOfScope: [
      {
        request: "Онлайн-запись к врачу",
        replacement: "Заявка на приём через форму, администратор перезванивает",
        category: "other",
        module: "leads",
      },
      { request: "Оплата лечения на сайте", replacement: "Пока нет: оплата в клинике", category: "payments" },
    ],
    custom: [],
  };
}
