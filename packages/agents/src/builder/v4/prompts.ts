// Prompts of the roles (V5-03). The text of the bans repeats grill-11 (8); the code checks them again (antislop.ts).
import type { SystemBrief } from "@wizard/appspec";
import type { LlmMessage } from "@wizard/llm";
import { type BlockSpec, DIRECTIONS, type DirectionId, type SlotSpec } from "@wizard/ui-kit/v4/blocks";
import type { Copy, Positioning } from "./types.js";

export const TOOLS = {
  positioning: "submit_positioning",
  copy: "submit_copy",
  edited: "submit_edited_copy",
  blocks: "submit_blocks",
  signature: "submit_signature_section",
  judge: "submit_signature_choice",
} as const;

const BANS = [
  "Запрещено навсегда:",
  "- шаблонный первый экран: плашка-надзаголовок, заголовок, абзац и две кнопки по центру; иконка в цветном квадрате; три карточки преимуществ в ряд;",
  "- ИИ-текст: тройки прилагательных, «не X, а Y», «не просто», «мы заботимся», тире-вставки « — », слова «уникальный», «качественный», «индивидуальный подход», «команда профессионалов»;",
  "- обещания без цифр: срок, цена, объём, год, рейтинг называются числом.",
].join("\n");

export interface RolesInput {
  name: string;
  /** The owner's own words about the business. */
  request?: string;
  brief: Pick<SystemBrief, "goals" | "audience" | "qa" | "assumptions" | "scenarios">;
  /** Photos the page may use: index → alt (the director picks by index). */
  photos: readonly { src: string; alt: string; credit: string }[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The business as the roles see it: facts only, no interview chatter. */
export function businessDigest(i: RolesInput): string {
  const qa = i.brief.qa.slice(0, 16).map((x) => `- ${clip(x.q, 120)} → ${clip(x.a, 200)}`);
  return [
    `Название: ${i.name}.`,
    i.request ? `Слова владельца: ${clip(i.request, 900)}` : "",
    i.brief.audience ? `Аудитория: ${clip(i.brief.audience, 300)}` : "",
    i.brief.goals.length ? `Цели: ${i.brief.goals.map((g) => clip(g.text, 140)).join("; ")}` : "",
    i.brief.scenarios.length
      ? `Что делает посетитель: ${i.brief.scenarios
          .slice(0, 6)
          .map((s) => clip(s.when, 100))
          .join("; ")}`
      : "",
    qa.length ? `Ответы владельца:\n${qa.join("\n")}` : "",
    i.brief.assumptions.length
      ? `Допущения (не факты): ${i.brief.assumptions.map((a) => clip(a.text, 100)).join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const directionsDigest = (): string =>
  (Object.values(DIRECTIONS) as (typeof DIRECTIONS)[DirectionId][])
    .map((d) => `- ${d.id} («${d.title}»): ниши — ${d.niches.join(", ")}. ${clip(d.grammar, 260)}`)
    .join("\n");

export function strategistMessages(i: RolesInput): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "Ты — стратег сайта малого бизнеса в России. Из данных владельца делаешь позиционирование: кто они, для кого, чем отличаются, чем это доказать.",
        "УТП и доказательства — только то, что есть во входе или прямо следует из него; число не выдумывай. Нет числа — формулируй факт без него, но не обещание.",
        "Тон — рабочие слова и то, чего текст не делает.",
        "Карта сайта — 5–9 разделов одной страницы, по порядку сверху вниз: первым шапка (header), вторым первый экран (hero), последним подвал (footer). id — латиницей.",
        `Направление дизайна выбери одно:\n${directionsDigest()}`,
        BANS,
        `Ответ — только вызов ${TOOLS.positioning}.`,
      ].join("\n\n"),
    },
    { role: "user", content: businessDigest(i) },
  ];
}

export function copywriterMessages(i: RolesInput, p: Positioning): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "Ты — копирайтер. Пишешь все тексты страницы по карте сайта до вёрстки: по разделу — заголовок, короткий текст, пункты, призыв.",
        "Заголовок — мысль и факт, а не название раздела. Конкретика: цены, сроки, адреса, годы, имена, часы — из входа. Чего нет во входе, не придумывай; если без этого нельзя, впиши в assumptions.",
        "Короткие предложения, живая речь, обращение на «вы» без заискивания. Длина: заголовок до 60 знаков, пункт до 80.",
        BANS,
        `Разделы строго по id карты сайта, в её порядке. Ответ — только вызов ${TOOLS.copy}.`,
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [businessDigest(i), "", "Позиционирование:", JSON.stringify(p)].join("\n"),
    },
  ];
}

export function editorMessages(p: Positioning, c: Copy, hits: string): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "Ты — строгий редактор. Читаешь тексты сайта глазами покупателя и вычищаешь «ИИ-голос»: воду, штампы, обещания без цифр, ровный канцелярский тон.",
        "Правь только текст: смысл, факты, id разделов, порядок и число пунктов не меняй. Добавляй конкретику из позиционирования (цифры, имена, сроки), но не выдумывай новое.",
        "В changes кратко (по строке) перечисли, что и почему исправил.",
        BANS,
        `Ответ — только вызов ${TOOLS.edited} с полным исправленным copy.`,
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        `Тон: ${p.tone}`,
        `Доказательства: ${p.proof.join("; ")}`,
        hits ? `Код уже нашёл:\n${hits}` : "Код штампов не нашёл — проверь тон и конкретику сам.",
        "",
        "Тексты:",
        JSON.stringify(c),
      ].join("\n"),
    },
  ];
}

/** Compact line for a slot: «title: текст ≤28», «items: список 2–5 {…}». */
function slotLine(name: string, s: SlotSpec): string {
  switch (s.kind) {
    case "text":
      return `${name}: текст ≤${s.max}${s.optional ? " (необяз.)" : ""} — ${s.hint}`;
    case "number":
      return `${name}: число — ${s.hint}`;
    case "href":
      return `${name}: ссылка #якорь|tel:+7…|https:// — ${s.hint}`;
    case "photo":
      return `${name}: фото {src,alt,credit} из списка фото — ${s.hint}`;
    case "icon":
      return `${name}: имя иконки Lucide — ${s.hint}`;
    case "mark":
      return `${name}: необяз., не заполняй`;
    case "list":
      return `${name}: список ${s.min}–${s.max} из {${Object.entries(s.item)
        .map(([k, v]) => slotLine(k, v))
        .join("; ")}}`;
    case "group":
      return `${name}: группа {${Object.entries(s.slots)
        .map(([k, v]) => slotLine(k, v))
        .join("; ")}}`;
  }
}

export function blockDigest(b: BlockSpec): string {
  return [
    `### ${b.id} (${b.section}${b.signature ? ", несёт фирменный момент направления" : ""}) — ${b.use}`,
    `варианты: ${b.variants.map((v) => v.id).join(", ")}`,
    ...Object.entries(b.slots).map(([k, v]) => `  ${slotLine(k, v)}`),
  ].join("\n");
}

export function directorMessages(
  i: RolesInput,
  p: Positioning,
  c: Copy,
  catalog: readonly BlockSpec[],
): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "Ты — режиссёр страницы. Собираешь сайт из блоков каталога направления: берёшь 6–9 блоков, по одному на раздел карты сайта, и наполняешь слоты текстами копирайтера.",
        "Порядок: первым блок-шапка, вторым первый экран, последним подвал. Блок бери только из каталога и только своего направления; нужного блока нет — раздел пропусти.",
        "Слоты заполняй из copy слово в слово, сокращая под лимит знаков, но не теряя числа. Контакты, адреса и телефоны — только из входа; нет во входе — слот возьми из допущений или оставь на необязательном.",
        "Фото в слоты — объектом из списка фото (src, alt, credit как в списке), по смыслу.",
        "Лимиты слотов жёсткие, считай знаки: пиши на 15 % короче лимита, чтобы не упереться; текст длиннее лимита код вернёт на правку.",
        "Телефона нет во входе, а слот обязательный — поставь заглушку +7 000 000-00-00 и tel:+70000000000, владелец заменит; выдуманные адреса и цифры не нужны.",
        BANS,
        `Ответ — только вызов ${TOOLS.blocks}.`,
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        businessDigest(i),
        "",
        `Направление: ${p.direction}. Карта сайта: ${p.sitemap.map((s) => `${s.id} — ${s.purpose}`).join("; ")}`,
        "",
        "Тексты:",
        JSON.stringify(c),
        "",
        "Фото (индекс: описание → src):",
        ...i.photos.map((ph, n) => `${n}: ${ph.alt} → ${ph.src} (${ph.credit})`),
        "",
        "Каталог блоков направления:",
        ...catalog.map(blockDigest),
      ].join("\n"),
    },
  ];
}

export function signatureMessages(
  p: Positioning,
  after: readonly { id: string; section: string }[],
  tokens: readonly string[],
  momentIdea: string,
): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "Ты — дизайнер-программист. Пишешь ОДНУ фирменную секцию сайта свободным React 19 + TSX + Tailwind: то, чего нет в каталоге блоков и что делает именно этот бизнес узнаваемым.",
        `Секция — файл с export default function без props. Импорты только из react, motion/react и @wizard/ui-kit. Цвета и шрифты — только токены Tailwind темы: ${tokens.join(", ")}; сырые цвета, hex и inline-стили цвета запрещены.`,
        "На 390 px и при prefers-reduced-motion показывай статичный кадр; тяжёлых эффектов не нужно, одна идея, один движущийся элемент.",
        "Тексты — по-русски, с цифрой или фактом из позиционирования; без штампов.",
        BANS,
        `Ответ — только вызов ${TOOLS.signature}. Поле after — точный id блока из списка, после которого встанет секция (например «nochnoy-produkt.status»).`,
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        `Позиционирование: ${JSON.stringify(p)}`,
        `Идея фирменного момента направления (отправная точка, не обязательство): ${momentIdea}`,
        `Блоки страницы (id, раздел): ${after.map((b) => `${b.id} (${b.section})`).join("; ")}`,
      ].join("\n"),
    },
  ];
}

export function judgeMessages(p: Positioning, a: string, b: string): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "Ты — судья двух вариантов фирменной секции одного сайта. Выбери тот, что сильнее по идее, узнаваемости для этого бизнеса, чистоте кода и отсутствию штампов.",
        `Ответ — только вызов ${TOOLS.judge}: pick A или B и причина одной фразой.`,
      ].join("\n"),
    },
    {
      role: "user",
      content: [`Бизнес: ${p.name}. ${p.essence}`, "", "Вариант A:", a, "", "Вариант B:", b].join("\n"),
    },
  ];
}
