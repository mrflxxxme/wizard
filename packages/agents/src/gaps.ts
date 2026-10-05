// Honest capability gaps (product.yaml#decisions D34_capability_gaps, D66_universal_build, D73_development_requests):
// an agent says what the platform cannot do yet, offers the closest replacement and «Написать команде», and records
// the request through the host (recordDevelopmentRequest — platform-api writes it to «Запросы на развитие»).
import { scrub } from "@wizard/pii";
import { z } from "zod";
import { defineTool, type Tool } from "./core/tool.js";

export const DEVELOPMENT_REQUEST_CATEGORIES = [
  "payments",
  "subscriptions",
  "integration",
  "messaging",
  "design",
  "domain",
  "media",
  "data",
  "mobile",
  "ai",
  "other",
] as const;
/** Category of a development request (D73). */
export type DevelopmentRequestCategory = (typeof DEVELOPMENT_REQUEST_CATEGORIES)[number];

/** What the host stores: the quote is already scrubbed of personal data. */
export interface DevelopmentRequestInput {
  category: DevelopmentRequestCategory;
  quote: string;
  offered: string | null;
}

/** Optional host method (orchestrator deps and BuildHost): records a development request; absent → nothing is stored. */
export type RecordDevelopmentRequest = (input: DevelopmentRequestInput) => Promise<void>;

/** What the platform cannot do at release and the closest replacement (prompt section «Пока не умеем»). */
export const PLATFORM_LIMITS: readonly {
  category: DevelopmentRequestCategory;
  what: string;
  offer: string;
}[] = [
  {
    category: "payments",
    what: "приём оплаты на сайте и в системе (карты, СБП, криптовалюта)",
    offer: "заявка или запись с суммой; оплата по счёту или ссылке вне системы",
  },
  {
    category: "subscriptions",
    what: "подписки и платный доступ (курс, клуб, закрытый раздел)",
    offer: "доступ по приглашению владельца после оплаты вне системы",
  },
  { category: "messaging", what: "SMS", offer: "письма на почту и уведомления в Telegram" },
  {
    category: "messaging",
    what: "маркетинговые рассылки",
    offer: "служебные письма (подтверждение, напоминание, отмена) и выгрузка контактов в таблицу",
  },
  { category: "domain", what: "свой домен", offer: "адрес вида имя.sandpile.ru" },
  {
    category: "media",
    what: "видео, карты, Яндекс Метрика и чужие скрипты на страницах",
    offer: "картинки, адрес и ссылки текстом",
  },
  {
    category: "mobile",
    what: "приложения в App Store и Google Play",
    offer: "веб-приложение, которое ставится на телефон с сайта",
  },
  {
    category: "ai",
    what: "ИИ-ассистент и чат-бот на сайте",
    offer: "форма заявки и раздел «Вопросы и ответы»",
  },
  {
    category: "data",
    what: "сведения о здоровье, диагнозы, вероисповедание, национальность и другие особые данные о людях",
    offer: "запись без медицинских сведений: имя, телефон, услуга, время",
  },
  {
    category: "integration",
    what: "готовые подключения к amoCRM, Битрикс24, 1С и другим сервисам",
    offer: "входящие вебхуки, исходящие запросы к их API и импорт таблиц",
  },
  {
    category: "design",
    what: "своя вёрстка и CSS, перетаскивание блоков",
    offer: "готовые блоки страниц и 4 темы с вашим цветом и шрифтом",
  },
  { category: "other", what: "второй язык сайта", offer: "сайт на русском" },
];

/** What the platform can do at release (prompt section «Платформа»). */
export const PLATFORM_CAN: readonly string[] = [
  "сайт с заявками: блоки лендинга (первый экран, преимущества, шаги, вопросы, форма заявки, подвал) и картинки, которые загружает владелец",
  "4 темы с фирменным цветом и шрифтами с кириллицей",
  "запись на услуги со слотами, подтверждением, напоминанием посетителю по почте за 24 часа и ссылкой отмены",
  "CRM и внутренние инструменты: клиенты, сделки, задачи, статусы, доски, отчёты, выгрузка в таблицу",
  "роли и права: кто что видит и меняет; вход по коду на почту или через Telegram",
  "уведомления владельцу и сотрудникам письмом и в Telegram",
  "автоматизации по событиям и расписанию; серверная логика на функциях",
  "исходящие HTTP-запросы функций на хосты, объявленные в системе, и входящие вебхуки",
  "импорт таблиц, QR-коды, загрузка файлов",
];

/** Arguments of report_capability_gap (the model fills them; quote is scrubbed before recording). */
export const capabilityGapSchema = z.object({
  category: z.enum(DEVELOPMENT_REQUEST_CATEGORIES),
  quote: z.string().trim().min(1).max(300),
  missing: z.string().trim().min(1).max(200),
  offered: z.string().trim().min(1).max(200).nullable(),
});
export type CapabilityGap = z.infer<typeof capabilityGapSchema>;

export const SUPPORT_BUTTON = "Написать команде";

/** Owner-facing honest answer: what we cannot do yet, the replacement, and the team button. */
export function gapMessage(gaps: readonly CapabilityGap[]): string {
  if (gaps.length === 0) return "";
  const lines = gaps.map(
    (g) => `Пока не умеем: ${g.missing}.${g.offered ? ` Можно сделать так: ${g.offered}.` : ""}`,
  );
  return [...lines, `Остальное соберём. Если это важно, нажмите «${SUPPORT_BUTTON}»: мы учтём запрос.`].join(
    "\n",
  );
}

/** Card «outOfScope» line for a gap (≤ 300 characters). */
export function gapOutOfScope(g: CapabilityGap): string {
  const line = `Пока не войдёт: ${g.missing}.${g.offered ? ` Вместо этого: ${g.offered}.` : ""}`;
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

const gapKey = (g: Pick<CapabilityGap, "category" | "quote">) =>
  `${g.category}\n${g.quote.trim().toLowerCase()}`;

export interface GapToolOptions {
  record?: RecordDevelopmentRequest | undefined;
  /** Called once per new gap (deduplicated by category + quote). */
  onGap?: (gap: CapabilityGap) => void | Promise<void>;
  /** Already reported gaps (persisted between turns) — repeats are not recorded again. */
  known?: readonly CapabilityGap[];
}

/**
 * report_capability_gap: scrubs personal data from the quote and the offer, records the request through the host
 * (best effort: a failing or absent host method does not break the answer) and tells the model how to answer.
 */
export function reportCapabilityGapTool(opts: GapToolOptions = {}): Tool<typeof capabilityGapSchema> {
  const seen = new Set((opts.known ?? []).map(gapKey));
  return defineTool({
    name: "report_capability_gap",
    description:
      "Report a request the platform cannot do yet: category, the client's words, what is missing, the closest replacement.",
    input: capabilityGapSchema,
    run: async (g) => {
      const gap: CapabilityGap = {
        category: g.category,
        quote: scrub(g.quote).text,
        missing: g.missing,
        offered: g.offered === null ? null : scrub(g.offered).text,
      };
      const key = gapKey(gap);
      let recorded = false;
      if (!seen.has(key)) {
        seen.add(key);
        await opts.onGap?.(gap);
        if (opts.record) {
          try {
            await opts.record({ category: gap.category, quote: gap.quote, offered: gap.offered });
            recorded = true;
          } catch {
            recorded = false;
          }
        }
      }
      return {
        ok: true,
        recorded,
        reply: `Скажи владельцу честно, что этого пока нет, предложи замену и кнопку «${SUPPORT_BUTTON}». Остальное собирай дальше.`,
      };
    },
  });
}

/** Prompt section: what to answer honestly and when to call report_capability_gap. */
export function gapsPromptSection(mode: "interview" | "build"): string {
  const how =
    mode === "interview"
      ? "вызови report_capability_gap (категория, слова клиента, чего нет, ближайшая замена) в том же ответе, что и основной инструмент, и разбирай то, что платформа умеет; в карточке это попадает в outOfScope."
      : "вызови report_capability_gap (категория, слова клиента, чего нет, ближайшая замена), сделай замену, если она есть в карточке, и собирай остальное.";
  return [
    ...PLATFORM_LIMITS.map((l) => `- ${l.what} (${l.category}) → ${l.offer}`),
    `Если запрос выходит за эти рамки или за возможности платформы, не отказывай целиком и ничего не обещай: ${how}`,
  ].join("\n");
}
