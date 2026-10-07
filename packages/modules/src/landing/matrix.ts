// CI matrix of the section library (B2-35): every layout variant of every section type compiles and passes G0 and G1.
// Row k puts all 20 section types on one page with the k-th variant of each (types with fewer variants wrap around),
// with the modules the data sections need and a theme of its own. Texts are neutral examples («Пример: …»).
import { type PlanSection, SECTION_CATALOG, THEME_PRESETS } from "@wizard/appspec";

/** Example content per section type: required keys and the optional ones a block shows. */
const CONTENT: Readonly<Record<string, PlanSection["content"]>> = {
  header: { cta: "Записаться" },
  hero: {
    title: "Пример: заголовок первого экрана",
    cta: "Оставить заявку",
    subtitle: "Пример подзаголовка",
  },
  features: { title: "Пример: почему мы", items: ["Пример преимущества", "Ещё пример"] },
  steps: { title: "Пример: как записаться", items: ["Пример: заявка", "Пример: визит"] },
  services: { title: "Пример: услуги и цены" },
  pricing: { title: "Пример: цены", note: "Пример: цены из кабинета владельца" },
  booking: { title: "Пример: запись онлайн" },
  lead_form: { title: "Оставьте заявку" },
  gallery: { title: "Пример: наши работы", items: [{ caption: "Пример: работа" }] },
  team: { title: "Пример: команда", items: [{ name: "Пример: мастер", role: "Пример: стрижки" }] },
  testimonials: { items: [{ text: "Пример отзыва из брифа", author: "Пример: клиент" }] },
  stats: { items: ["Пример: 10 лет — опыт", { value: "Пример: 500", label: "клиентов" }] },
  about: { title: "Пример: о нас", text: "Пример текста о бизнесе.\n\nПример второго абзаца." },
  faq: { title: "Пример: вопросы", items: [{ question: "Пример вопроса?", answer: "Пример ответа." }] },
  cta: { title: "Пример: остались вопросы?", cta: "Написать" },
  contacts: { title: "Пример: контакты", address: "Пример: адрес из брифа", phone: "+7 000 000-00-00" },
  hours: { items: ["Пн–Пт: 10:00–20:00", { day: "Сб", time: "11:00–18:00" }] },
  logos: { items: ["Пример: партнёр"] },
  text: { text: "Пример текста владельца." },
  footer: {},
};

/** The k-th variant of every section type, in catalog order (header first, footer last). */
export function librarySections(k: number): PlanSection[] {
  return SECTION_CATALOG.map((t) => ({
    type: t.type,
    variant: t.variants[k % t.variants.length] as string,
    content: { ...(CONTENT[t.type] ?? {}) },
  }));
}

const ROWS = Math.max(...SECTION_CATALOG.map((t) => t.variants.length));
/** Themes of the rows: the presets added by themes v2 first (the default rows use the first preset). */
const THEMES = [...THEME_PRESETS.slice(4), ...THEME_PRESETS.slice(0, 4)];

export const LANDING_MATRIX = Array.from({ length: ROWS }, (_, k) => ({
  name: `библиотека секций, вариант ${k + 1}`,
  params: {},
  withModules: ["leads", "notify", "catalog", "booking"],
  sections: librarySections(k),
  theme: THEMES[k % THEMES.length] as string,
}));
