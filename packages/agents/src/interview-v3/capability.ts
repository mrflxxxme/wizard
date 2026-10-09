// «Карта возможностей» (D77 (12); grill-8 № 12): every requirement of the brief — each scenario, integration and extra
// requirement — gets a level by code, never by the model: «на проверенных модулях» (a ready catalog module closes it),
// «своим кодом, с пометкой» (custom code of the build) or «пока не умею — в запросы на развитие» (D73). The share of
// «не умею» is counted per month for /admin and must go down.
import type { BriefCapability, SystemBrief } from "@wizard/appspec";
import type { ModuleRegistry } from "@wizard/modules";
import type { DevelopmentRequestCategory } from "../gaps.js";
import { availableModules, DEFAULT_REGISTRY } from "../planner/catalog.js";
import { clip } from "../planner/tolerant.js";
import type { ExtraRequirement } from "./schemas.js";

export type CapabilityLevel = BriefCapability["level"];

/** Russian labels of the levels as the owner sees them. */
export const CAPABILITY_LABELS: Readonly<Record<CapabilityLevel, string>> = {
  modules: "на проверенных модулях",
  custom: "своим кодом, с пометкой",
  not_yet: "пока не умею — в запросы на развитие",
};

/** Lower case, ё → е: the form every rule matches against. */
export const normText = (s: string): string => s.toLowerCase().replace(/ё/g, "е");

/** A rule of word stems: each part matches at the start of a word (Cyrillic-aware). */
function stems(...parts: string[]): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join("|")})`, "u");
}

interface NotYetRule {
  re: RegExp;
  category: DevelopmentRequestCategory;
  /** The closest replacement the build makes instead (D73). */
  substitute: string;
  /**
   * V3-23: the module that closes this need in a shop's context (SHOP_CONTEXT): with it available the rule does not
   * apply there — «Интернет-магазин» takes the cart, the payment and receipts, СДЭК and the courier, the stock.
   */
  module?: "shop";
}

/** Words of a shop's requirement (goods, a cart, an order, delivery, the stock): the shop module closes its needs. */
const SHOP_CONTEXT = stems(
  "корзин",
  "товар",
  "магазин",
  "покупател",
  "заказ",
  "доставк",
  "сдэк",
  "cdek",
  "курьер",
  "самовывоз",
  "остатк",
  "склад",
  "чек(?:и|ов|а|ом)?(?![\\p{L}])",
  "54-фз",
  "юkassa",
  "юкасс",
  "yookassa",
);

/** What the platform cannot do yet (D73, gaps.ts PLATFORM_LIMITS); the shop's needs — with «Интернет-магазин» (V3-23). */
const NOT_YET: readonly NotYetRule[] = [
  {
    re: stems(
      "корзин",
      "онлайн[- ]?оплат",
      "оплат\\S*(?:\\s+\\S+)?\\s+(?:онлайн|на сайте|картой|по карте|через сайт)",
      "оплач\\S*(?:\\s+\\S+)?\\s+(?:онлайн|на сайте|картой|по карте|через сайт)",
      "юkassa",
      "юкасс",
      "ykassa",
      "yookassa",
      "эквайринг",
      "сбп(?![\\p{L}])",
      "оформ\\S*\\s+заказ",
    ),
    category: "payments",
    substitute: "заказ или заявка с суммой; оплата по счёту или ссылке вне системы",
    module: "shop",
  },
  {
    re: stems("чек(?:и|ов|а|ом)?(?![\\p{L}])", "54-фз", "онлайн-касс", "фискальн"),
    category: "payments",
    substitute: "чеки выдаёт ваша касса вне системы",
    module: "shop",
  },
  {
    // Only СДЭК, the shop's courier and self-pickup are built in: other delivery services stay a development request.
    re: stems("boxberry", "почт\\S*\\s+росси", "dpd(?![\\p{L}])", "пэк(?![\\p{L}])", "деловы\\S*\\s+лини"),
    category: "integration",
    substitute: "доставка СДЭК, курьер магазина или самовывоз",
  },
  {
    re: stems("доставк", "сдэк", "cdek", "курьер"),
    category: "integration",
    substitute: "самовывоз или доставка по договорённости: адрес и способ — в заказе",
    module: "shop",
  },
  {
    re: stems("остатк", "складск", "на склад"),
    category: "other",
    substitute: "наличие отмечает владелец в каталоге",
    module: "shop",
  },
  {
    re: stems("мойсклад", "мой склад"),
    category: "integration",
    substitute: "входящие вебхуки, исходящие запросы к их API и импорт таблиц",
  },
  {
    re: stems(
      "amocrm",
      "амо\\s?срм",
      "амо\\s?crm",
      "битрикс",
      "bitrix",
      "1с(?![\\p{L}\\p{N}])",
      "1c(?![\\p{L}\\p{N}])",
      "маркетплейс",
      "ozon",
      "озон(?![\\p{L}])",
      "wildberries",
      "вайлдберриз",
      "яндекс\\s?маркет",
    ),
    category: "integration",
    substitute: "входящие вебхуки, исходящие запросы к их API и импорт таблиц",
  },
  {
    re: stems("мобильн\\S*\\s+приложени", "app store", "google play"),
    category: "mobile",
    substitute: "веб-приложение, которое ставится на телефон с сайта",
  },
  {
    re: stems("чат-?бот", "ии-ассистент", "ai-ассистент", "нейросет"),
    category: "ai",
    substitute: "форма заявки и раздел «Вопросы и ответы»",
  },
  {
    re: stems("смс", "sms", "рассылк"),
    category: "messaging",
    substitute: "письма на почту и уведомления в Telegram",
  },
  {
    re: stems("платн\\S*\\s+доступ", "закрыт\\S*\\s+раздел", "платн\\S*\\s+курс"),
    category: "subscriptions",
    substitute: "доступ по приглашению владельца после оплаты вне системы",
  },
  {
    re: stems("диагноз", "анамнез", "жалоб", "медицинск\\S*\\s+карт", "вероисповед", "национальност"),
    category: "data",
    substitute: "запись без медицинских сведений: имя, телефон, услуга, время",
  },
  {
    re: stems("английск\\S*\\s+верси", "второй язык", "мультиязычн", "на английском"),
    category: "other",
    substitute: "сайт на русском",
  },
  {
    re: stems("свой домен", "собственн\\S*\\s+домен"),
    category: "domain",
    substitute: "адрес системы на домене платформы",
  },
];

/** Things the build writes as its own code (no module yet, but within custom limits): marked in the brief. */
const CUSTOM = stems(
  "блог",
  "стать(?:и|ю|я|ей|ями)(?![\\p{L}])",
  "новост",
  "калькулятор",
  "квиз",
  "опрос",
  "конструктор",
);

/** Word stems of the ready catalog modules; the first module that matches closes the requirement. */
const MODULE_RULES: readonly { module: string; re: RegExp }[] = [
  {
    // V3-23 «Интернет-магазин»: before «Каталог и прайс» — goods with a cart are the shop's showcase.
    module: "shop",
    re: stems(
      "корзин",
      "интернет-магазин",
      "онлайн-магазин",
      "покупател",
      "оформ\\S*\\s+заказ",
      "онлайн[- ]?оплат",
      "оплат\\S*(?:\\s+\\S+)?\\s+(?:онлайн|на сайте|картой|по карте|через сайт)",
      "оплач\\S*(?:\\s+\\S+)?\\s+(?:онлайн|на сайте|картой|по карте|через сайт)",
      "юkassa",
      "юкасс",
      "yookassa",
      "чек(?:и|ов|а|ом)?(?![\\p{L}])",
      "54-фз",
      "доставк",
      "сдэк",
      "cdek",
      "курьер",
      "самовывоз",
      "остатк",
      "складск",
      "на склад",
    ),
  },
  {
    module: "leads",
    re: stems(
      "заявк",
      "обращени",
      "перезвон",
      "обратн\\S*\\s+звон",
      "обратн\\S*\\s+связ",
      "оставить контакт",
    ),
  },
  {
    module: "booking",
    re: stems(
      "запис(?:ыва|ать|аться|ался|алась|ь|и|ей|ям)",
      "онлайн-запис",
      "бронир",
      "бронь",
      "слот",
      "расписани",
      "свободн\\S*\\s+врем",
    ),
  },
  {
    module: "visitor_cabinet",
    re: stems(
      "личн\\S*\\s+кабинет",
      "кабинет\\S*\\s+клиент",
      "свои записи",
      "свои заявки",
      "перенести запись",
    ),
  },
  {
    module: "client_card",
    re: stems(
      "клиентск\\S*\\s+баз",
      "баз\\S*\\s+клиент",
      "истори\\S*\\s+(?:клиент|обращени|визит|покуп)",
      "карточк\\S*\\s+клиент",
      "crm",
      "срм",
    ),
  },
  { module: "deals", re: stems("сделк", "воронк", "смет", "коммерческ\\S*\\s+предложени") },
  {
    module: "packages",
    re: stems("абонемент", "пакет\\S*\\s+(?:визит|заняти|услуг)", "подписк"),
  },
  {
    module: "resources",
    re: stems("выдач", "выда(?:ет|ть|ем)", "прокат", "аренд", "инвентар", "оборудовани", "инструмент"),
  },
  {
    module: "catalog",
    re: stems(
      "прайс",
      "цен(?:ы|а|у|ой|ам|ами|ах)?(?![\\p{L}])",
      "стоимост",
      "каталог",
      "меню",
      "ассортимент",
      "витрин",
      "товар",
    ),
  },
  { module: "reports", re: stems("отчет", "статистик", "аналитик", "выручк", "в цифрах", "сводк") },
  {
    module: "notify",
    re: stems(
      "уведом",
      "напомин",
      "оповещ",
      "telegram",
      "телеграм",
      "письм",
      "на почту",
      "сообща\\S*\\s+(?:владельц|администратор|менеджер|мастер|сотрудник)",
    ),
  },
  {
    module: "staff",
    re: stems(
      "пригла\\S*\\s+сотрудник",
      "доступ\\S*\\s+(?:к|только к)\\s+(?:нужн\\S*\\s+)?раздел",
      "прав(?:а|ами)\\s+доступ",
      "роли\\s+сотрудник",
      "видит только сво",
    ),
  },
  {
    module: "landing",
    re: stems(
      "сайт",
      "страниц",
      "лендинг",
      "о (?:нас|компании|клинике|студии|салоне|себе)",
      "контакт",
      "главн",
      "портфолио",
      "галере",
      "отзыв",
      "рассказ",
    ),
  },
];

/** One requirement of the brief the capability map rates. */
export interface Requirement {
  text: string;
  moduleHint?: string;
  source: "scenario" | "integration" | "extra";
}

export interface CapabilityVerdict {
  level: CapabilityLevel;
  /** modules: the catalog module that closes it. */
  module?: string;
  /** not_yet: the development request category (D73) and the replacement. */
  category?: DevelopmentRequestCategory;
  substitute?: string;
}

/** The rule whose stem appears first in the text (ties — the list order); undefined when none matches. */
function earliest<T extends { re: RegExp }>(rules: readonly T[], t: string): T | undefined {
  let best: { rule: T; at: number } | undefined;
  for (const rule of rules) {
    const at = t.search(rule.re);
    if (at >= 0 && (!best || at < best.at)) best = { rule, at };
  }
  return best?.rule;
}

/**
 * The level of one requirement: not yet → own code by kind → module hint → module stems → own code. Among the
 * not-yet and module rules the stem met first in the text wins («Когда менеджер открывает карточку клиента…»).
 */
export function requirementLevel(
  req: Pick<Requirement, "text" | "moduleHint">,
  registry: ModuleRegistry = DEFAULT_REGISTRY,
): CapabilityVerdict {
  const t = normText(req.text);
  const ok = availableModules(registry);
  // A shop's requirement (goods, a cart, an order, delivery…) with «Интернет-магазин» available: its rules close it.
  const shop = ok.has("shop") && (req.moduleHint === "shop" || SHOP_CONTEXT.test(t));
  const no = earliest(
    NOT_YET.filter((r) => !(shop && r.module === "shop")),
    t,
  );
  if (no) return { level: "not_yet", category: no.category, substitute: no.substitute };
  if (CUSTOM.test(t)) return { level: "custom" };
  if (req.moduleHint && ok.has(req.moduleHint)) return { level: "modules", module: req.moduleHint };
  const hit = earliest(
    MODULE_RULES.filter((r) => ok.has(r.module)),
    t,
  );
  return hit ? { level: "modules", module: hit.module } : { level: "custom" };
}

/** «Когда …, система …» of a scenario as one requirement line (≤ 400). */
export function scenarioLine(s: SystemBrief["scenarios"][number]): string {
  const when = s.when.replace(/^когда\s+/i, "").replace(/[.\s]+$/, "");
  const then = s.then.map((x) => x.replace(/^система\s+/i, "").replace(/[.\s]+$/, "")).join(", ");
  return clip(`Когда ${when}, система ${then}`, 400);
}

/** Requirements of a brief: its scenarios, its integrations and the extra requirements of the interview. */
export function briefRequirements(
  brief: SystemBrief,
  extras: readonly ExtraRequirement[] = [],
): Requirement[] {
  const out: Requirement[] = [];
  const seen = new Set<string>();
  const push = (r: Requirement) => {
    const key = normText(r.text);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };
  for (const s of brief.scenarios)
    push({
      text: scenarioLine(s),
      source: "scenario",
      ...(s.moduleHint ? { moduleHint: s.moduleHint } : {}),
    });
  for (const i of brief.integrations)
    push({
      text: clip(`Интеграция${i.direction === "in" ? " (входящая)" : ""}: ${i.name}`, 400),
      source: "integration",
    });
  for (const e of extras)
    push({ text: clip(e.text, 400), source: "extra", ...(e.moduleHint ? { moduleHint: e.moduleHint } : {}) });
  return out;
}

export interface CapabilityMap {
  capability: BriefCapability[];
  /** Each requirement with its verdict (module, development request category, replacement). */
  verdicts: (Requirement & CapabilityVerdict)[];
}

/** The capability map of a brief (C1 capability[]), by code; at most the brief limit of rows. */
export function capabilityMap(
  brief: SystemBrief,
  extras: readonly ExtraRequirement[] = [],
  registry: ModuleRegistry = DEFAULT_REGISTRY,
  max = 100,
): CapabilityMap {
  const verdicts = briefRequirements(brief, extras)
    .slice(0, max)
    .map((r) => ({ ...r, ...requirementLevel(r, registry) }));
  return { capability: verdicts.map((v) => ({ requirement: v.text, level: v.level })), verdicts };
}

/** Counts of a capability map by level. */
export function capabilityCounts(capability: readonly BriefCapability[]): Record<CapabilityLevel, number> & {
  total: number;
} {
  const out = { modules: 0, custom: 0, not_yet: 0, total: capability.length };
  for (const c of capability) out[c.level] += 1;
  return out;
}

/** Modules whose entities are not business records (landing keeps only the site photos). */
const NO_BUSINESS_DATA: ReadonlySet<string> = new Set(["landing"]);

/** Catalog modules of the verdicts that keep business records (provides entities): the brief then needs its data. */
export function dataModules(
  verdicts: readonly CapabilityVerdict[],
  registry: ModuleRegistry = DEFAULT_REGISTRY,
): string[] {
  const byId = new Map(registry.modules.map((d) => [d.manifest.id, d.manifest]));
  const out: string[] = [];
  for (const v of verdicts) {
    if (v.level !== "modules" || !v.module || out.includes(v.module) || NO_BUSINESS_DATA.has(v.module))
      continue;
    if ((byId.get(v.module)?.provides?.entities?.length ?? 0) > 0) out.push(v.module);
  }
  return out;
}

/** One month of the «не умею» share (/admin, D77 (12)). */
export interface CapabilityMonth {
  /** YYYY-MM (UTC). */
  month: string;
  /** Briefs counted (the latest version of each system in that month). */
  briefs: number;
  requirements: number;
  notYet: number;
  /** notYet / requirements, 3 decimals; 0 for a month without requirements. */
  share: number;
}

/** The monthly share of «пока не умею» over brief capability maps, months ascending. */
export function notYetShareByMonth(
  rows: readonly { createdAt: string | Date; capability: readonly BriefCapability[] }[],
): CapabilityMonth[] {
  const months = new Map<string, CapabilityMonth>();
  for (const r of rows) {
    const month = new Date(r.createdAt).toISOString().slice(0, 7);
    const m = months.get(month) ?? { month, briefs: 0, requirements: 0, notYet: 0, share: 0 };
    m.briefs += 1;
    m.requirements += r.capability.length;
    m.notYet += r.capability.filter((c) => c.level === "not_yet").length;
    m.share = m.requirements ? Math.round((m.notYet / m.requirements) * 1000) / 1000 : 0;
    months.set(month, m);
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
}
