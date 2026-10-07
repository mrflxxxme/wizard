// Landing section catalog of beta v2 (specs/modules/modules.yaml#sections): section types, layout variants and content
// keys a SystemPlan may use. Since B2-35 every variant is a ui-kit block (packages/ui-kit/src/components/blocks) that the
// landing module renders, so `ready` lists them all; a variant added later starts outside `ready` until its component.

export interface SectionTypeSpec {
  /** Section type id used in SystemPlan.landing.sections[].type. */
  type: string;
  label: string;
  /** Layout variant ids (3–5 per type). */
  variants: readonly string[];
  /** Variants implemented by ui-kit blocks and rendered by the landing module (the planner sees only these). */
  ready: readonly string[];
  /** Content keys the plan must fill. */
  required: readonly string[];
  /** Content keys the plan may fill. */
  optional: readonly string[];
  /** The section needs at least one of these modules in the plan. */
  requiresModule?: readonly string[];
  /** Keys of an object in content.items (a plain string is the first key); the planner sees them. */
  itemKeys?: readonly string[];
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
    ready: ["bar", "centered", "transparent"],
    required: [],
    optional: ["cta"],
    unique: true,
    position: "first",
  },
  {
    type: "hero",
    label: "Первый экран",
    variants: ["split", "centered", "cover", "minimal", "collage"],
    ready: ["split", "centered", "cover", "minimal", "collage"],
    required: ["title", "cta"],
    optional: ["eyebrow", "subtitle", "image"],
    unique: true,
  },
  {
    type: "features",
    label: "Преимущества",
    variants: ["grid", "cards", "alternating", "icons"],
    ready: ["grid", "cards", "alternating", "icons"],
    itemKeys: ["title", "text"],
    required: ["title", "items"],
    optional: ["intro"],
  },
  {
    type: "steps",
    label: "Как это работает",
    variants: ["numbered", "timeline", "cards"],
    ready: ["numbered", "timeline", "cards"],
    itemKeys: ["title", "text"],
    required: ["title", "items"],
    optional: ["intro"],
  },
  {
    type: "services",
    label: "Услуги из каталога",
    variants: ["list", "cards", "table", "tabs"],
    // Rendered by the catalog module's showcase in a ui-kit LandingSection (packages/modules/src/catalog); tabs — by
    // catalog sections (with_categories), without them a list.
    ready: ["list", "cards", "table", "tabs"],
    required: ["title"],
    optional: ["intro"],
    requiresModule: ["catalog"],
  },
  {
    type: "pricing",
    label: "Цены и пакеты",
    variants: ["cards", "table", "compact"],
    ready: ["cards", "table", "compact"],
    required: ["title"],
    optional: ["intro", "note"],
    requiresModule: ["catalog", "packages"],
  },
  {
    type: "booking",
    label: "Запись на время",
    variants: ["card", "split", "inline"],
    ready: ["card", "split", "inline"],
    required: ["title"],
    optional: ["intro", "cta"],
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
    ready: ["grid", "masonry", "carousel"],
    itemKeys: ["caption"],
    required: [],
    optional: ["title", "intro", "items"],
  },
  {
    type: "team",
    label: "Команда",
    variants: ["cards", "row", "list"],
    ready: ["cards", "row", "list"],
    itemKeys: ["name", "role", "text"],
    required: ["title", "items"],
    optional: ["intro"],
  },
  {
    type: "testimonials",
    label: "Отзывы",
    variants: ["cards", "quote", "carousel"],
    ready: ["cards", "quote", "carousel"],
    itemKeys: ["text", "author", "source"],
    required: ["items"],
    optional: ["title"],
  },
  {
    type: "stats",
    label: "Цифры",
    variants: ["row", "cards", "band"],
    ready: ["row", "cards", "band"],
    itemKeys: ["value", "label"],
    required: ["items"],
    optional: ["title"],
  },
  {
    type: "about",
    label: "О нас",
    variants: ["split", "centered", "story"],
    ready: ["split", "centered", "story"],
    required: ["title", "text"],
    optional: ["image"],
  },
  {
    type: "faq",
    label: "Вопросы и ответы",
    variants: ["accordion", "columns", "split"],
    ready: ["accordion", "columns", "split"],
    itemKeys: ["question", "answer"],
    required: ["title", "items"],
    optional: ["intro"],
  },
  {
    type: "cta",
    label: "Призыв к действию",
    variants: ["band", "card", "split"],
    ready: ["band", "card", "split"],
    required: ["title", "cta"],
    optional: ["text"],
  },
  {
    type: "contacts",
    label: "Контакты",
    variants: ["card", "split", "columns"],
    ready: ["card", "split", "columns"],
    required: ["title"],
    optional: ["address", "phone", "email", "hours", "messengers"],
    unique: true,
  },
  {
    type: "hours",
    label: "Часы работы",
    variants: ["table", "cards", "inline"],
    ready: ["table", "cards", "inline"],
    itemKeys: ["day", "time"],
    required: ["items"],
    optional: ["title"],
  },
  {
    type: "logos",
    label: "Партнёры и клиенты",
    variants: ["row", "grid", "marquee"],
    ready: ["row", "grid", "marquee"],
    itemKeys: ["name"],
    required: ["items"],
    optional: ["title"],
  },
  {
    type: "text",
    label: "Текстовый блок",
    variants: ["plain", "two_columns", "quote"],
    ready: ["plain", "two_columns", "quote"],
    required: ["text"],
    optional: ["title"],
  },
  {
    type: "footer",
    label: "Подвал",
    variants: ["simple", "columns", "minimal"],
    ready: ["simple", "columns", "minimal"],
    required: [],
    optional: ["text"],
    unique: true,
    position: "last",
  },
];
