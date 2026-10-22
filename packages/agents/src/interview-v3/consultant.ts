// V5-04 (D80 (7), grill-10 Р6–Р7): the consultant layer of the interview — 3 blocks (business, style, system),
// 16 steps, a hypothesis and ready buttons in every question, «Сделай сам» on any step, 2–3 competitors from a search
// in Russia (a port: the key lives in Actions, the code has a fixture mode). The answers go into the brief's journal
// (brief.qa), which the strategist of the role pipeline reads (V5-03: businessDigest), and into style tokens.
import type { BriefQa, SystemBrief } from "@wizard/appspec";
import {
  mergeStyleTokens,
  type ReferenceRead,
  type StyleTokens,
  VIBES,
} from "../builder/v3/directions/vibes.js";

export const CONSULT_BLOCKS = ["business", "style", "system"] as const;
export type ConsultBlock = (typeof CONSULT_BLOCKS)[number];

export const SELF_DO_LABEL = "Сделай сам";
export const SELF_DO_ID = "self";

export interface ConsultOption {
  id: string;
  label: string;
  /** The text that goes into the brief when the button is pressed. */
  value: string;
}

export interface ConsultQuestion {
  id: string;
  step: number;
  total: number;
  block: ConsultBlock;
  text: string;
  /** The agent's guess in the owner's words: «Похоже, у вас…». */
  hypothesis: string;
  options: ConsultOption[];
  /** The option «Сделай сам» takes. */
  defaultId: string;
}

export interface ConsultContext {
  name: string;
  niche: string;
  city?: string;
  /** Competitors found by the search (2–3); empty when the search found none. */
  competitors?: readonly Competitor[];
}

export interface Competitor {
  title: string;
  url: string;
  note: string;
}

interface StepDef {
  id: string;
  block: ConsultBlock;
  text: string;
  hypothesis: (c: ConsultContext) => string;
  options: (c: ConsultContext) => ConsultOption[];
  defaultId: string;
}

const o = (id: string, label: string, value = label): ConsultOption => ({ id, label, value });

const STEPS: readonly StepDef[] = [
  {
    id: "what",
    block: "business",
    text: "Чем вы занимаетесь и для кого?",
    defaultId: "yes",
    hypothesis: (c) => `Похоже, ${c.name} — ${c.niche}${c.city ? ` в городе ${c.city}` : ""}.`,
    options: (c) => [
      o("yes", "Да, верно", `${c.niche}${c.city ? `, ${c.city}` : ""}`),
      o("other", "Не совсем", "уточнит владелец"),
    ],
  },
  {
    id: "audience",
    block: "business",
    text: "Кто ваш основной клиент?",
    defaultId: "private",
    hypothesis: () => "Чаще всего это частные клиенты рядом, которые выбирают по отзывам и цене.",
    options: () => [
      o("private", "Частные клиенты", "частные клиенты, выбирают по отзывам и цене"),
      o("business", "Компании", "компании и ИП, выбирают по надёжности и срокам"),
    ],
  },
  {
    id: "usp",
    block: "business",
    text: "Чем вы лучше соседей по рынку (УТП)?",
    defaultId: "experience",
    hypothesis: () => "Сильнее всего работает один проверяемый факт: срок, опыт или гарантия.",
    options: () => [
      o("experience", "Опыт и репутация", "опыт и репутация: годы работы и отзывы"),
      o("speed", "Скорость", "быстрый срок и фиксированная цена"),
      o("guarantee", "Гарантия", "гарантия результата в договоре"),
    ],
  },
  {
    id: "competitors",
    block: "business",
    text: "Кто ваши главные конкуренты?",
    defaultId: "found",
    hypothesis: (c) =>
      c.competitors?.length
        ? `Нашёл в поиске: ${c.competitors.map((x) => x.title).join(", ")}. Отстроимся от них.`
        : "Поиск ничего не дал — отстроимся от типичных игроков ниши.",
    options: (c) => [
      o(
        "found",
        c.competitors?.length ? "Да, это они" : "Типичные игроки ниши",
        c.competitors?.length
          ? c.competitors.map((x) => `${x.title} (${x.url})`).join("; ")
          : "типичные игроки ниши",
      ),
      o("own", "Назову сам", "назовёт владелец"),
    ],
  },
  {
    id: "numbers",
    block: "business",
    text: "Какие цифры о вас можно показать?",
    defaultId: "years",
    hypothesis: () => "Покупателя убеждают годы работы, число клиентов и срок выполнения.",
    options: () => [
      o("years", "Годы и клиенты", "годы работы и число клиентов"),
      o("prices", "Цены и сроки", "цены «от» и сроки"),
      o("none", "Пока нет", "цифр нет, показываем факты без чисел"),
    ],
  },
  {
    id: "objections",
    block: "business",
    text: "Что чаще всего останавливает клиента?",
    defaultId: "price",
    hypothesis: () => "Обычно боятся переплатить и не получить обещанное.",
    options: () => [
      o("price", "Цена", "сомнение в цене"),
      o("trust", "Доверие", "сомнение, что сделают как обещано"),
      o("time", "Сроки", "боязнь задержек"),
    ],
  },
  {
    id: "tone",
    block: "business",
    text: "Каким голосом вам говорить с клиентом?",
    defaultId: "friendly",
    hypothesis: () => "Для малого бизнеса лучше всего звучит спокойный тон на «вы» без канцелярита.",
    options: () => [
      o("friendly", "Тёплый и простой", "тёплый, простой, на «вы»"),
      o("expert", "Экспертный", "сдержанный, экспертный, с фактами"),
      o("bold", "Дерзкий", "энергичный, короткие фразы"),
    ],
  },
  {
    id: "vibe",
    block: "style",
    text: "Какой вайб ближе? Выберите 1–2 по превью.",
    defaultId: "workshop",
    hypothesis: (c) => `Для «${c.niche}» чаще подходит «Мастерская» или «Чистая медицина», но решать вам.`,
    options: () => VIBES.map((v) => o(v.id, v.label, `${v.label}: ${v.hint}`)),
  },
  {
    id: "reference",
    block: "style",
    text: "Есть сайт или скриншот, на который хочется быть похожим?",
    defaultId: "none",
    hypothesis: () => "Без референса возьму стиль из выбранного вайба.",
    options: () => [
      o("none", "Нет референса", "без референса"),
      o("send", "Пришлю скриншот или ссылку", "референс будет приложен"),
    ],
  },
  {
    id: "brand",
    block: "style",
    text: "Есть ли фирменный цвет или логотип?",
    defaultId: "none",
    hypothesis: () => "Фирменный цвет главнее вайба и референса — он станет акцентом.",
    options: () => [
      o("none", "Нет, подберите", "цвет подбирает агент"),
      o("have", "Есть", "цвет бренда задан владельцем"),
    ],
  },
  {
    id: "data",
    block: "system",
    text: "Какие данные нужно хранить?",
    defaultId: "leads",
    hypothesis: () => "Для сайта обычно хватает заявок с именем и телефоном.",
    options: () => [
      o("leads", "Заявки", "заявки: имя и телефон"),
      o("catalog", "Каталог и заказы", "каталог товаров или услуг и заказы"),
    ],
  },
  {
    id: "roles",
    block: "system",
    text: "Кто будет работать с заявками?",
    defaultId: "owner",
    hypothesis: () => "Скорее всего, только вы как владелец.",
    options: () => [
      o("owner", "Только я", "один владелец"),
      o("team", "Я и сотрудники", "владелец и сотрудники"),
    ],
  },
  {
    id: "integrations",
    block: "system",
    text: "Куда отправлять уведомления о заявках?",
    defaultId: "telegram",
    hypothesis: () => "Удобнее всего Telegram: заявку видно сразу.",
    options: () => [
      o("telegram", "Telegram", "уведомления в Telegram"),
      o("email", "Почта", "уведомления на почту"),
    ],
  },
  {
    id: "content",
    block: "system",
    text: "Откуда взять фото и тексты?",
    defaultId: "stock",
    hypothesis: () => "Если своих фото нет, подберу из бесплатных банков с указанием автора.",
    options: () => [
      o("stock", "Подберите сами", "стоковые фото, тексты пишет агент"),
      o("own", "Свои фото", "владелец загрузит фото"),
    ],
  },
  {
    id: "payments",
    block: "system",
    text: "Нужна ли онлайн-оплата?",
    defaultId: "no",
    hypothesis: () => "На старте достаточно заявки, оплату добавим позже.",
    options: () => [o("no", "Пока не нужна", "оплата вне сайта"), o("yes", "Нужна", "онлайн-оплата")],
  },
  {
    id: "launch",
    block: "system",
    text: "Когда запускаетесь?",
    defaultId: "week",
    hypothesis: () => "Первый вариант готов за один заход, правки — по ходу.",
    options: () => [
      o("week", "В ближайшие дни", "запуск в течение недели"),
      o("later", "Позже", "запуск без срока"),
    ],
  },
];

/** Number of consultant steps (12–18 by D80 (7)). */
export const CONSULT_STEP_COUNT = STEPS.length;

/** The question of step `index` (0-based), or null after the last one. */
export function consultQuestion(index: number, ctx: ConsultContext): ConsultQuestion | null {
  const s = STEPS[index];
  if (!s) return null;
  const options = s.options(ctx);
  if (options.length < 2) throw new Error(`consult step ${s.id}: fewer than two buttons`);
  return {
    id: s.id,
    step: index + 1,
    total: STEPS.length,
    block: s.block,
    text: s.text,
    hypothesis: s.hypothesis(ctx),
    options,
    defaultId: s.defaultId,
  };
}

export interface ConsultAnswer {
  questionId: string;
  /** Option ids pressed (the vibe step takes 1–2), `self` for «Сделай сам», or a free text in `text`. */
  choice: string[];
  text?: string;
}

/** «Сделай сам»: the answer that takes the step's default. */
export const selfDoAnswer = (q: ConsultQuestion): ConsultAnswer => ({
  questionId: q.id,
  choice: [SELF_DO_ID],
});

/** The journal line of an answer; `self` takes the default option, a free text is kept as written. */
export function answerToQa(q: ConsultQuestion, a: ConsultAnswer): BriefQa {
  const self = a.choice.includes(SELF_DO_ID);
  const ids = self ? [q.defaultId] : a.choice;
  const picked = ids.map((id) => q.options.find((x) => x.id === id)).filter((x): x is ConsultOption => !!x);
  const recommended = q.options.find((x) => x.id === q.defaultId)?.value ?? "";
  const text = a.text?.trim();
  return {
    q: q.text,
    a: text || picked.map((x) => x.value).join("; ") || recommended,
    recommended,
    chosen: self
      ? "delegated"
      : text
        ? "custom"
        : picked.some((x) => x.id === q.defaultId)
          ? "recommended"
          : "option",
  };
}

export interface ConsultResult {
  qa: BriefQa[];
  /** Tokens of the style step (vibes → reference → brand colour). */
  style: StyleTokens;
  /** Vibes the owner chose, ids. */
  vibes: string[];
}

/** Folds the answers (any subset: missing steps take their defaults) into journal lines and style tokens. */
export function foldConsult(
  ctx: ConsultContext,
  answers: readonly ConsultAnswer[],
  style: { reference?: ReferenceRead | null; brandColor?: string | null } = {},
): ConsultResult {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const qa: BriefQa[] = [];
  let vibes: string[] = [];
  for (let i = 0; i < STEPS.length; i++) {
    const q = consultQuestion(i, ctx) as ConsultQuestion;
    const a = byId.get(q.id) ?? selfDoAnswer(q);
    qa.push(answerToQa(q, a));
    if (q.id === "vibe") vibes = (a.choice.includes(SELF_DO_ID) ? [q.defaultId] : a.choice).slice(0, 2);
  }
  return {
    qa,
    vibes,
    style: mergeStyleTokens({ vibes, reference: style.reference, brandColor: style.brandColor }),
  };
}

/**
 * Puts the consultant's answers into the brief's journal so that the strategist reads them first: the strategist digest
 * takes the first 16 lines of brief.qa, so the style line and the consultant lines go to the front.
 */
export function applyConsultToBrief(brief: SystemBrief, result: ConsultResult): void {
  const key = new Set(result.qa.map((x) => x.q));
  const rest = brief.qa.filter((x) => !key.has(x.q));
  const styleLine: BriefQa = {
    q: "Стиль сайта",
    a: `вайбы: ${result.vibes.join(", ")}; шрифт: ${result.style.fontKind}; плотность: ${result.style.density}; акцент ${result.style.accent}`.slice(
      0,
      1500,
    ),
    recommended: "",
    chosen: "option",
  };
  brief.qa = [styleLine, ...result.qa, ...rest].slice(0, 60);
}

// ---- Competitors (search in Russia) ----

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}
/** Port of the search in Russia (Yandex Search API in Actions); tests and the fixture mode use `fixtureSearch`. */
export type CompetitorSearch = (query: string) => Promise<readonly SearchHit[]>;

/** Fixture mode: answers by query substring, no network. */
export const fixtureSearch =
  (table: Readonly<Record<string, readonly SearchHit[]>>): CompetitorSearch =>
  async (q) =>
    Object.entries(table).find(([k]) => q.includes(k))?.[1] ?? [];

const host = (u: string): string | null => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};
const AGGREGATORS =
  /(^|\.)(yandex|google|2gis|avito|vk|ok|youtube|wikipedia|hh|zoon|yell|otzovik|irecommend)\./;

/** 2–3 competitors: one site per host, no aggregators and not the client's own site. A failed search gives []. */
export async function findCompetitors(
  search: CompetitorSearch,
  ctx: Pick<ConsultContext, "niche" | "city">,
  ownSite?: string,
): Promise<Competitor[]> {
  let hits: readonly SearchHit[] = [];
  try {
    hits = await search(`${ctx.niche}${ctx.city ? ` ${ctx.city}` : ""}`.trim());
  } catch {
    return [];
  }
  const own = ownSite ? host(ownSite) : null;
  const seen = new Set<string>();
  const out: Competitor[] = [];
  for (const h of hits) {
    const hn = host(h.url);
    if (!hn || hn === own || AGGREGATORS.test(hn) || seen.has(hn)) continue;
    seen.add(hn);
    out.push({
      title: h.title.trim().slice(0, 80),
      url: `https://${hn}`,
      note: h.snippet.trim().slice(0, 160),
    });
    if (out.length === 3) break;
  }
  return out;
}
