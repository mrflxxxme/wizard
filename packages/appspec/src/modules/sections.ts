// Landing section catalog of beta v2 (specs/modules/modules.yaml#sections): section types, layout variants and content
// keys a SystemPlan may use. Draft: B2-35 builds the components and may extend variants; `ready` lists the variants that
// already exist in ui-kit blocks (packages/ui-kit/src/components/blocks/types.ts).

export interface SectionTypeSpec {
  /** Section type id used in SystemPlan.landing.sections[].type. */
  type: string;
  label: string;
  /** Layout variant ids (3–5 per type). */
  variants: readonly string[];
  /** Variants already implemented by ui-kit blocks (the rest come with B2-35). */
  ready: readonly string[];
  /** Content keys the plan must fill. */
  required: readonly string[];
  /** Content keys the plan may fill. */
  optional: readonly string[];
  /** The section needs at least one of these modules in the plan. */
  requiresModule?: readonly string[];
  /** At most one such section on the page. */
  unique?: boolean;
  /** Fixed position on the page. */
  position?: "first" | "last";
}

export const SECTION_CATALOG: readonly SectionTypeSpec[] = [
  {
    type: "header",
    label: "Шапка",
    variants: ["bar", "centered", "transparent"],
    ready: ["bar", "centered"],
    required: [],
    optional: ["cta"],
    unique: true,
    position: "first",
  },
  {
    type: "hero",
    label: "Первый экран",
    variants: ["split", "centered", "cover", "minimal", "collage"],
    ready: ["split", "centered", "cover"],
    required: ["title", "cta"],
    optional: ["eyebrow", "subtitle", "image"],
    unique: true,
  },
  {
    type: "features",
    label: "Преимущества",
    variants: ["grid", "cards", "alternating", "icons"],
    ready: ["grid", "cards", "alternating"],
    required: ["title", "items"],
    optional: ["intro"],
  },
  {
    type: "steps",
    label: "Как это работает",
    variants: ["numbered", "timeline", "cards"],
    ready: ["numbered", "timeline"],
    required: ["title", "items"],
    optional: ["intro"],
  },
  {
    type: "services",
    label: "Услуги из каталога",
    variants: ["list", "cards", "table", "tabs"],
    ready: [],
    required: ["title"],
    optional: ["intro"],
    requiresModule: ["catalog"],
  },
  {
    type: "pricing",
    label: "Цены и пакеты",
    variants: ["cards", "table", "compact"],
    ready: [],
    required: ["title"],
    optional: ["intro", "note"],
    requiresModule: ["catalog", "packages"],
  },
  {
    type: "booking",
    label: "Запись на время",
    variants: ["card", "split", "inline"],
    ready: [],
    required: ["title"],
    optional: ["intro"],
    requiresModule: ["booking"],
    unique: true,
  },
  {
    type: "lead_form",
    label: "Форма заявки",
    variants: ["card", "split", "inline"],
    ready: ["card", "split", "inline"],
    required: ["title"],
    optional: ["intro", "submit_label"],
    requiresModule: ["leads"],
  },
  {
    type: "gallery",
    label: "Галерея",
    variants: ["grid", "masonry", "carousel"],
    ready: [],
    required: [],
    optional: ["title", "items"],
  },
  {
    type: "team",
    label: "Команда",
    variants: ["cards", "row", "list"],
    ready: [],
    required: ["title", "items"],
    optional: ["intro"],
  },
  {
    type: "testimonials",
    label: "Отзывы",
    variants: ["cards", "quote", "carousel"],
    ready: [],
    required: ["items"],
    optional: ["title"],
  },
  {
    type: "stats",
    label: "Цифры",
    variants: ["row", "cards", "band"],
    ready: [],
    required: ["items"],
    optional: ["title"],
  },
  {
    type: "about",
    label: "О нас",
    variants: ["split", "centered", "story"],
    ready: [],
    required: ["title", "text"],
    optional: ["image"],
  },
  {
    type: "faq",
    label: "Вопросы и ответы",
    variants: ["accordion", "columns", "split"],
    ready: ["accordion", "columns"],
    required: ["title", "items"],
    optional: [],
  },
  {
    type: "cta",
    label: "Призыв к действию",
    variants: ["band", "card", "split"],
    ready: ["band", "card"],
    required: ["title", "cta"],
    optional: ["text"],
  },
  {
    type: "contacts",
    label: "Контакты",
    variants: ["card", "split", "columns"],
    ready: [],
    required: ["title"],
    optional: ["address", "phone", "email", "hours", "messengers"],
    unique: true,
  },
  {
    type: "hours",
    label: "Часы работы",
    variants: ["table", "cards", "inline"],
    ready: [],
    required: ["items"],
    optional: ["title"],
  },
  {
    type: "logos",
    label: "Партнёры и клиенты",
    variants: ["row", "grid", "marquee"],
    ready: [],
    required: ["items"],
    optional: ["title"],
  },
  {
    type: "text",
    label: "Текстовый блок",
    variants: ["plain", "two_columns", "quote"],
    ready: [],
    required: ["text"],
    optional: ["title"],
  },
  {
    type: "footer",
    label: "Подвал",
    variants: ["simple", "columns", "minimal"],
    ready: ["simple", "columns"],
    required: [],
    optional: ["text"],
    unique: true,
    position: "last",
  },
];
