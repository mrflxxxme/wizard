// CI matrix of the section library (B2-35): every layout variant of every section type compiles and passes G0 and G1.
// Row k puts all 20 section types on one page with the k-th variant of each (types with fewer variants wrap around),
// with the modules the data sections need and a theme of its own. Texts are neutral examples («Пример: …»).
import { type PlanPhoto, type PlanSection, SECTION_CATALOG, THEME_PRESETS } from "@wizard/appspec";

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

/** Odd rows set the bands of the design direction (B2-37) by hand: alternate band on every even section. */
const withBands = (sections: PlanSection[]): PlanSection[] =>
  sections.map((s, i) => ({ ...s, band: i % 2 === 0 ? "alt" : "base" }));

export const LANDING_MATRIX = Array.from({ length: ROWS }, (_, k) => ({
  name: `библиотека секций, вариант ${k + 1}`,
  params: {},
  withModules: ["leads", "notify", "catalog", "booking"],
  sections: k % 2 === 1 ? withBands(librarySections(k)) : librarySections(k),
  theme: THEMES[k % THEMES.length] as string,
}));

/** Sections of the photo row (B2-38): every section type with photo slots, a gallery tile left without a photo. */
export const PHOTO_ROW_SECTIONS: PlanSection[] = [
  { type: "header", variant: "bar", content: { cta: "Оставить заявку" } },
  { type: "hero", variant: "collage", content: { ...(CONTENT.hero ?? {}) } },
  {
    type: "features",
    variant: "alternating",
    content: { title: "Пример: почему мы", items: ["Пример преимущества", "Ещё пример", "Третий пример"] },
  },
  { type: "about", variant: "split", content: { ...(CONTENT.about ?? {}) } },
  {
    type: "gallery",
    variant: "grid",
    content: {
      title: "Пример: наши работы",
      items: [{ caption: "Пример: работа" }, "Вторая", "Третья", "Четвёртая"],
    },
  },
  { type: "lead_form", variant: "card", content: { title: "Оставьте заявку" } },
  { type: "footer", variant: "simple", content: {} },
];

/** Slots of PHOTO_ROW_SECTIONS that get a stock photo (gallery-4 keeps the theme graphic). */
export const PHOTO_ROW_SLOTS = [
  "top",
  "top-2",
  "top-3",
  "features",
  "features-2",
  "features-3",
  "about",
  "gallery",
  "gallery-2",
  "gallery-3",
] as const;

/** Example stock photos of the photo row: library ids from `files`, sources marked as examples. */
export function examplePhotos(files: (slot: string, i: number) => string): PlanPhoto[] {
  return PHOTO_ROW_SLOTS.map((slot, i) => {
    const pexels = i % 2 === 0;
    const id = String(1000 + i);
    return {
      slot,
      file: files(slot, i),
      alt: `Пример: фото для места «${slot}»`,
      provider: pexels ? "pexels" : "pixabay",
      stockId: id,
      author: `Пример: автор ${i + 1}`,
      authorUrl: pexels ? `https://www.pexels.com/@example-${i}` : `https://pixabay.com/users/example-${i}/`,
      pageUrl: pexels
        ? `https://www.pexels.com/photo/example-${id}/`
        : `https://pixabay.com/photos/example-${id}/`,
      license: pexels ? "Лицензия Pexels" : "Лицензия на контент Pixabay",
      licenseUrl: pexels ? "https://www.pexels.com/license/" : "https://pixabay.com/service/license-summary/",
      width: 960,
      height: 640,
      pickedAt: "2026-10-07",
    };
  });
}

/** Library id of the n-th example photo (UUID shape). */
export const exampleFile = (_slot: string, i: number): string =>
  `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;

/** CI row of the landing with stock photos in every type of photo slot (B2-38). */
export const LANDING_PHOTO_ROW = {
  name: "фото со стока в секциях",
  params: {},
  withModules: ["leads", "notify"],
  sections: PHOTO_ROW_SECTIONS,
  photos: examplePhotos(exampleFile),
};
