// Fork taxonomy (typed mirror of specs/agents/orchestrator.yaml#fork_taxonomy; drift test in test/taxonomy.test.ts)
// and deterministic fork selection S3_select_forks.
import type { Analysis } from "./schemas.js";

export type ForkGroup = "horizontal" | "b2b_events" | "made_to_order_goods";
export type Plan = "free" | "start" | "business";

export interface ForkContext {
  plan: Plan;
}

export interface ForkDef {
  id: string;
  group: ForkGroup;
  impact: number;
  q: string;
  options: readonly string[];
  /** Recommendation rule as written in the spec (goes to the prompt). */
  rec: string;
  applies: (a: Analysis) => boolean;
  /** Code recommendation, used for forks decided without asking. */
  recommend: (a: Analysis, answers: ReadonlyMap<string, string>) => string;
  /** Asked only when this fork is already decided by the brief (else decided by recommendation afterwards). */
  dependsOn?: { forkId: string; when: (optionId: string) => boolean };
}

/** Lower-cased text of Analysis signals (goals, constraints, entities, roles) — never the evidence quotes. */
export function signalText(a: Analysis): string {
  return [
    ...a.goals,
    ...a.constraints,
    ...a.entities.flatMap((e) => [e.name, e.label, ...e.keyFields]),
    ...a.roles.flatMap((r) => [r.name, r.label]),
  ]
    .join(" \n")
    .toLowerCase();
}

const has = (a: Analysis, re: RegExp) => re.test(signalText(a));
const staff = (a: Analysis) => a.roles.filter((r) => r.isStaff);
const external = (a: Analysis) => a.roles.filter((r) => !r.isStaff);
const sk = (a: Analysis, s: Analysis["skeleton"][number]) => a.skeleton.includes(s);
const mentionsTelegram = (a: Analysis) => a.integrations.includes("telegram") || has(a, /telegram|телеграм/);
const maxNumber = (a: Analysis) =>
  Math.max(
    0,
    ...[...a.goals, ...a.constraints].flatMap((s) =>
      [...s.matchAll(/\d[\d\s]*/g)].map((m) => Number(m[0].replace(/\s/g, ""))),
    ),
  );

const RE = {
  payment: /оплат|цен[аы]|стоимост|платеж|платёж|предоплат|money|price/,
  performers: /исполнител|мастер|курьер|назначат/,
  booking: /запис[ьи] на|слот|бронир|приём у|прием у/,
  inventory: /остат|склад|запас/,
  reports: /отч[её]т|дашборд|статистик|аналитик/,
  import: /таблиц|excel|эксел|csv|импорт|существующ\S* баз/,
  online: /онлайн-мероприят|вебинар|онлайн-конференц/,
  program: /секци|спикер|доклад|расписан|программ/,
  speakers: /спикер|доклад/,
  stay: /выезд|прожив|расселен|отел|гостиниц/,
  zones: /vip|лаунж|зон[аыу]/,
  groups: /команд|делегац|юрлиц|юридическ/,
  b2b: /опт|b2b|юрлиц|юридическ|дилер/,
  toDate: /к дате|срок|изготов|предзаказ/,
  delivery: /доставк/,
  check: /провер|модерац|одобр|подтвержд/,
};

type Raw = Omit<ForkDef, "group">;
const H = (d: Raw): ForkDef => ({ ...d, group: "horizontal" });
const EV = (d: Raw): ForkDef => ({ ...d, group: "b2b_events" });
const GD = (d: Raw): ForkDef => ({ ...d, group: "made_to_order_goods" });

export const FORKS: readonly ForkDef[] = [
  H({
    id: "F-ACCESS",
    impact: 3,
    q: "Как клиенты попадают в систему?",
    options: ["public_form", "login_required", "staff_only"],
    rec: "public_form, если нужна только подача заявки; иначе login_required",
    applies: (a) => external(a).length > 0,
    recommend: (a) =>
      external(a).every((r) => r.access === "public") && sk(a, "application")
        ? "public_form"
        : "login_required",
  }),
  H({
    id: "F-LOGIN",
    impact: 2,
    q: "Как входить?",
    options: ["email", "telegram", "email_or_telegram", "phone", "phone_or_email"],
    rec: "email; email_or_telegram, если Telegram упомянут",
    applies: (a) => a.roles.some((r) => r.access === "login"),
    recommend: (a) => (mentionsTelegram(a) ? "email_or_telegram" : "email"),
  }),
  H({
    id: "F-STAFF",
    impact: 3,
    q: "Кто из сотрудников работает в системе?",
    options: ["single_admin", "admin_manager", "admin_manager_moderator"],
    rec: "минимальный набор, покрывающий действия из брифа",
    applies: (a) => staff(a).length >= 2,
    recommend: (a) =>
      staff(a).length >= 3
        ? "admin_manager_moderator"
        : staff(a).length === 2
          ? "admin_manager"
          : "single_admin",
  }),
  H({
    id: "F-VISIBILITY",
    impact: 3,
    q: "Кто из сотрудников видит какие записи?",
    options: ["all_see_all", "assigned_only", "by_department"],
    rec: "all_see_all при ≤5 сотрудниках",
    applies: (a) => staff(a).length >= 2,
    recommend: () => "all_see_all",
    dependsOn: { forkId: "F-STAFF", when: (o) => o !== "single_admin" },
  }),
  H({
    id: "F-APPROVAL",
    impact: 3,
    q: "Заявки подтверждаются?",
    options: ["auto", "manual", "rule_based"],
    rec: "auto, если нет упоминания проверки",
    // Events: confirmation is covered by F-EV-TICKETS (payment/quota) and F-EV-SPEAKERS (moderation).
    applies: (a) => sk(a, "application") && a.segment !== "events",
    recommend: (a) => (has(a, RE.check) ? "manual" : "auto"),
  }),
  H({
    id: "F-STATUSES",
    impact: 2,
    q: "Какой путь проходит заявка?",
    options: ["simple_3", "pipeline_board", "custom"],
    rec: "simple_3 (новая → в работе → готово)",
    applies: (a) => sk(a, "process"),
    recommend: () => "simple_3",
  }),
  H({
    id: "F-PAYMENT",
    impact: 3,
    q: "Как принимать оплату?",
    options: ["none", "yookassa_full", "yookassa_prepay", "invoice_manual"],
    rec: "yookassa_full; invoice_manual добавляется вариантом при B2B",
    applies: (a) => sk(a, "payment") || a.integrations.includes("yookassa") || has(a, RE.payment),
    recommend: () => "yookassa_full",
  }),
  H({
    id: "F-NOTIFY",
    impact: 2,
    q: "Как сообщать об изменениях?",
    options: ["email", "telegram", "email_and_telegram", "none"],
    rec: "email",
    applies: (a) => sk(a, "process"),
    recommend: () => "email",
  }),
  H({
    id: "F-ASSIGN",
    impact: 2,
    q: "Как назначать исполнителя?",
    options: ["manual", "round_robin", "self_pick"],
    rec: "manual",
    applies: (a) => has(a, RE.performers),
    recommend: () => "manual",
  }),
  H({
    id: "F-BOOKING",
    impact: 3,
    q: "Как устроено время записи?",
    options: ["fixed_slots", "specialist_schedule", "requests_only"],
    rec: "fixed_slots",
    applies: (a) => has(a, RE.booking),
    recommend: () => "fixed_slots",
  }),
  H({
    id: "F-INVENTORY",
    impact: 3,
    q: "Нужно ли учитывать остатки?",
    options: ["no", "simple_stock", "reserve_on_order"],
    rec: "reserve_on_order, если есть оплата",
    applies: (a) => has(a, RE.inventory),
    recommend: (a, ans) =>
      (ans.get("F-PAYMENT") ?? (sk(a, "payment") ? "yookassa_full" : "none")) !== "none"
        ? "reserve_on_order"
        : "simple_stock",
  }),
  H({
    id: "F-REPORTS",
    impact: 1,
    q: "Какие отчёты нужны?",
    options: ["lists_export", "summary_dashboard", "both"],
    rec: "both",
    applies: (a) => has(a, RE.reports),
    recommend: () => "both",
  }),
  H({
    id: "F-IMPORT",
    impact: 2,
    q: "С чего начинаем данные?",
    options: ["empty", "import_table"],
    rec: "empty; import_table — M1",
    applies: (a) => has(a, RE.import),
    recommend: () => "empty",
  }),
  H({
    id: "F-RETENTION",
    impact: 2,
    q: "Сколько хранить данные людей?",
    options: ["d30_after_event", "y1", "y3"],
    rec: "по defaults",
    applies: (a) => a.entities.some((e) => e.containsPii),
    recommend: (a) => (a.segment === "events" ? "d30_after_event" : sk(a, "payment") ? "y3" : "y1"),
  }),
  EV({
    id: "F-EV-TICKETS",
    impact: 3,
    q: "Какие бывают билеты/участия?",
    options: ["single_free", "types_with_quotas", "types_quotas_price_tiers"],
    rec: "types_with_quotas, если упомянуты типы",
    applies: (a) => a.segment === "events",
    recommend: (a) => (has(a, /тип\S* билет|ticket_type/) ? "types_with_quotas" : "single_free"),
  }),
  EV({
    id: "F-EV-CHECKIN",
    impact: 2,
    q: "Как проверять вход?",
    options: ["list_only", "qr_online", "qr_offline_scanner"],
    rec: "qr_offline_scanner при >300 участниках",
    applies: (a) => a.segment === "events" && !has(a, RE.online),
    recommend: (a) =>
      maxNumber(a) > 300 ? "qr_offline_scanner" : a.integrations.includes("qr") ? "qr_online" : "list_only",
  }),
  EV({
    id: "F-EV-PROGRAM",
    impact: 2,
    q: "Нужна ли программа?",
    options: ["none", "schedule_only", "schedule_with_signup"],
    rec: "schedule_only",
    applies: (a) => a.segment === "events" && has(a, RE.program),
    recommend: () => "schedule_only",
  }),
  EV({
    id: "F-EV-SPEAKERS",
    impact: 2,
    q: "Как отбирать доклады?",
    options: ["manual_list", "call_for_papers_moderation"],
    rec: "call_for_papers_moderation, если упомянута подача",
    applies: (a) => a.segment === "events" && has(a, RE.speakers),
    recommend: (a) => (has(a, /заявк|пода/) ? "call_for_papers_moderation" : "manual_list"),
  }),
  EV({
    id: "F-EV-STAY",
    impact: 2,
    q: "Нужно ли расселение?",
    options: ["none", "room_assignment", "room_requests"],
    rec: "room_assignment",
    applies: (a) => a.segment === "events" && has(a, RE.stay),
    recommend: () => "room_assignment",
  }),
  EV({
    id: "F-EV-ZONES",
    impact: 2,
    q: "Есть ли зоны с ограниченным доступом?",
    options: ["none", "zones_by_ticket_type"],
    rec: "zones_by_ticket_type",
    applies: (a) => a.segment === "events" && has(a, RE.zones),
    recommend: () => "zones_by_ticket_type",
  }),
  EV({
    id: "F-EV-GROUPS",
    impact: 2,
    q: "Регистрируются поодиночке или группами?",
    options: ["individual", "group_by_contact", "company_quota"],
    rec: "individual",
    applies: (a) => a.segment === "events" && has(a, RE.groups),
    recommend: () => "individual",
  }),
  GD({
    id: "F-GD-CATALOG",
    impact: 3,
    q: "Как устроен товар?",
    options: ["fixed_items", "items_with_options", "calculator_formula"],
    rec: "items_with_options",
    applies: (a) => a.segment === "made_to_order",
    recommend: () => "items_with_options",
  }),
  GD({
    id: "F-GD-PRICING",
    impact: 3,
    q: "Цены одинаковые для всех?",
    options: ["single_price", "per_client_pricelist", "volume_discounts"],
    rec: "per_client_pricelist, если упомянуты юрлица",
    applies: (a) => a.segment === "made_to_order" && has(a, RE.b2b),
    recommend: (a) => (has(a, /юрлиц|юридическ/) ? "per_client_pricelist" : "single_price"),
  }),
  GD({
    id: "F-GD-CAPACITY",
    impact: 3,
    q: "Как ограничивать заказы по срокам?",
    options: ["no_limit", "daily_capacity", "preorder_batches"],
    rec: "daily_capacity",
    applies: (a) => a.segment === "made_to_order" && has(a, RE.toDate),
    recommend: () => "daily_capacity",
  }),
  GD({
    id: "F-GD-DELIVERY",
    impact: 2,
    q: "Как клиент получает заказ?",
    options: ["pickup", "delivery", "both"],
    rec: "pickup, если не упомянута доставка",
    applies: (a) => a.segment === "made_to_order" && sk(a, "fulfillment"),
    recommend: (a) => (has(a, RE.delivery) ? "delivery" : "pickup"),
  }),
  GD({
    id: "F-GD-PREPAY",
    impact: 2,
    q: "Сколько оплачивать заранее?",
    options: ["full", "fixed_percent", "on_pickup"],
    rec: "fixed_percent (50%)",
    applies: (a) => a.segment === "made_to_order",
    recommend: () => "fixed_percent",
    dependsOn: { forkId: "F-PAYMENT", when: (o) => o !== "none" },
  }),
];

export const FORK_IDS = [
  "F-ACCESS",
  "F-LOGIN",
  "F-STAFF",
  "F-VISIBILITY",
  "F-APPROVAL",
  "F-STATUSES",
  "F-PAYMENT",
  "F-NOTIFY",
  "F-ASSIGN",
  "F-BOOKING",
  "F-INVENTORY",
  "F-REPORTS",
  "F-IMPORT",
  "F-RETENTION",
  "F-EV-TICKETS",
  "F-EV-CHECKIN",
  "F-EV-PROGRAM",
  "F-EV-SPEAKERS",
  "F-EV-STAY",
  "F-EV-ZONES",
  "F-EV-GROUPS",
  "F-GD-CATALOG",
  "F-GD-PRICING",
  "F-GD-CAPACITY",
  "F-GD-DELIVERY",
  "F-GD-PREPAY",
] as const;
export type ForkId = (typeof FORK_IDS)[number];

const BY_ID = new Map(FORKS.map((f) => [f.id, f]));
export function getFork(id: string): ForkDef | undefined {
  return BY_ID.get(id);
}

/** Options available to the model: F-LOGIN phone variants are removed on the free plan (F4, plan_rule). */
export function forkOptions(id: string, ctx: ForkContext): string[] {
  const f = BY_ID.get(id);
  if (!f) return [];
  if (id === "F-LOGIN" && ctx.plan === "free") return f.options.filter((o) => !o.startsWith("phone"));
  return [...f.options];
}

/** impact per orchestrator.yaml S3 + 2 when the model listed the fork as unknown. */
export const MAX_QUESTIONS = 7;

export interface ForkSelection {
  /** Forks to ask, top-7 by score (ties by id). */
  asked: { forkId: string; score: number }[];
  /** Applicable forks decided without asking (brief, confident default, dependency, overflow). */
  decided: { forkId: string; optionId: string; source: "brief" | "default" }[];
}

function groupAllowed(f: ForkDef, a: Analysis): boolean {
  if (f.group === "horizontal") return true;
  if (f.group === "b2b_events") return a.segment === "events";
  return a.segment === "made_to_order";
}

/** S3_select_forks: deterministic, code only. */
export function selectForks(a: Analysis): ForkSelection {
  const resolved = new Map<string, string>(a.resolved.map((r) => [r.forkId, r.optionId]));
  const unknowns = new Set<string>(a.unknowns);
  const candidates: { forkId: string; score: number }[] = [];
  const decided: ForkSelection["decided"] = [];
  const pendingDefaults: ForkDef[] = [];
  for (const f of FORKS) {
    if (!groupAllowed(f, a) || !f.applies(a)) continue;
    const fromBrief = resolved.get(f.id);
    if (fromBrief !== undefined) {
      decided.push({ forkId: f.id, optionId: fromBrief, source: "brief" });
      continue;
    }
    const unknown = unknowns.has(f.id);
    // default_if_unasked: the model did not flag the fork as unclear → confidence high; ask only impact ≥ 3.
    if (!unknown && f.impact < 3) {
      pendingDefaults.push(f);
      continue;
    }
    if (f.dependsOn && !resolved.has(f.dependsOn.forkId)) {
      pendingDefaults.push(f);
      continue;
    }
    if (f.dependsOn && !f.dependsOn.when(resolved.get(f.dependsOn.forkId) as string)) continue;
    candidates.push({ forkId: f.id, score: f.impact + (unknown ? 2 : 0) });
  }
  candidates.sort((x, y) => y.score - x.score || (x.forkId < y.forkId ? -1 : x.forkId > y.forkId ? 1 : 0));
  const asked = candidates.slice(0, MAX_QUESTIONS);
  for (const c of candidates.slice(MAX_QUESTIONS)) pendingDefaults.push(BY_ID.get(c.forkId) as ForkDef);
  const known = new Map(resolved);
  for (const f of pendingDefaults) {
    decided.push({ forkId: f.id, optionId: f.recommend(a, known), source: "default" });
  }
  return { asked, decided };
}

/**
 * Forks decided by recommendation after the answers are known (defaults and dependent forks); dependent forks whose
 * condition is not met are dropped.
 */
export function finalDefaults(a: Analysis, sel: ForkSelection, answers: ReadonlyMap<string, string>) {
  const known = new Map([...a.resolved.map((r) => [r.forkId, r.optionId] as const), ...answers]);
  const out: { forkId: string; optionId: string }[] = [];
  for (const d of sel.decided) {
    if (d.source === "brief") continue;
    const f = BY_ID.get(d.forkId) as ForkDef;
    if (f.dependsOn) {
      const dep = known.get(f.dependsOn.forkId);
      if (dep !== undefined && !f.dependsOn.when(dep)) continue;
    }
    out.push({ forkId: f.id, optionId: f.recommend(a, known) });
  }
  return out;
}
