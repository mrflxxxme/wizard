// Hints «что улучшить» of the goal panel (B2-27): deterministic rules over the metrics of the plan's modules, no models.
// Here a rule is chosen for the plan (its module is there, the fix is not on yet, the metric is visible to the owner);
// the page checks its condition on the month's metrics (lib/goalPanel.ts pickHints) and shows at most three. Each hint
// leads to an action: a section of the owner's cabinet, or the plan on the platform («Изменить в Born to Build»).
import { can } from "../screens/cabinet.js";
import type { GenContext } from "../types.js";
import type { HintRule } from "./lib/goalPanel.js";
import { PANEL_ROLE } from "./panel.js";

/** The platform: the owner changes the plan of the system there (a new tab; the owner signs in to Born to Build). */
export const PLATFORM_URL = "https://borntobuild.ru/";
/** At most this many hints on the panel. */
export const MAX_HINTS = 3;

/** Bounds of the rules: shares in percent, a drop as a share of the period before with its minimum. */
export const HINT_BOUNDS = {
  cancelShare: 15,
  noShowShare: 10,
  leadsHandled: 70,
  repeatShare: 20,
  scheduleLoad: 40,
  overdueShare: 20,
  dealsWon: 20,
  drop: 0.3,
  dropMin: 5,
} as const;

const platform = { label: "Изменить в Born to Build", href: PLATFORM_URL, external: true };

type Candidate = Omit<HintRule, "unit" | "goal"> & { applies: boolean };

/** The rules that fit the plan, in the order of the plan's goals (then the rest), each with its metric's unit. */
export function hintRules(ctx: GenContext): HintRule[] {
  const { present, allParams, spec } = ctx;
  const p = (module: string, name: string): unknown => allParams[module]?.[name];
  const ownerReads = (entity: string) => can(spec, PANEL_ROLE, entity, "read");
  const section = (entity: string, label: string) => ({
    label,
    href: `/cabinet#${entity}`,
    external: false,
  });
  // A reminder before the visit reaches the visitor: notify with letters to visitors and a reminder time.
  const reminderOn =
    present.has("notify") &&
    p("notify", "visitor_emails") !== false &&
    Number(p("notify", "reminder_hours")) > 0;
  const B = HINT_BOUNDS;

  const candidates: Candidate[] = [
    {
      id: "booking_reminder_cancel",
      metric: "cancel_share",
      when: { op: "gte", value: B.cancelShare },
      title: "Много отмен записи",
      text: "Отменяется {value} записей. Включите письмо-напоминание посетителю за сутки до визита — о записи будут забывать реже.",
      action: platform,
      fix: "reminder",
      applies: present.has("booking") && !reminderOn,
    },
    {
      id: "booking_reminder_no_show",
      metric: "no_show_share",
      when: { op: "gte", value: B.noShowShare },
      title: "Много неявок",
      text: "Не приходят {value} записавшихся. Включите письмо-напоминание посетителю за сутки до визита.",
      action: platform,
      fix: "reminder",
      applies: present.has("booking") && !reminderOn,
    },
    {
      id: "booking_second_reminder",
      metric: "no_show_share",
      when: { op: "gte", value: B.noShowShare },
      title: "Неявки остаются и с напоминанием",
      text: "Не приходят {value} записавшихся. Добавьте второе напоминание — за 2–3 часа до визита.",
      action: platform,
      fix: "second_reminder",
      applies: present.has("booking") && reminderOn && !(Number(p("notify", "second_reminder_hours")) > 0),
    },
    {
      id: "booking_reschedule",
      metric: "cancel_share",
      when: { op: "gte", value: B.cancelShare },
      title: "Отмены вместо переносов",
      text: "Отменяется {value} записей. Разрешите перенос по ссылке из письма — часть отмен станет переносами.",
      action: platform,
      fix: "reschedule",
      applies: present.has("booking") && p("booking", "reschedule_by_link") === false,
    },
    {
      id: "leads_owner",
      metric: "leads_handled",
      when: { op: "lte", value: B.leadsHandled },
      title: "Заявки остаются без ответа",
      text: present.has("staff")
        ? "В работу взято {value} заявок. Назначьте ответственного за новые заявки и отмечайте статус: «В работе» или «Закрыта»."
        : "В работу взято {value} заявок. Назначьте ответственного: добавьте сотрудника, который будет разбирать новые заявки.",
      action: present.has("staff") ? section("lead", "Открыть заявки") : platform,
      fix: "leads_owner",
      applies: present.has("leads") && ownerReads("lead"),
    },
    {
      // «Заявки» requires notify: the owner already hears of new leads; Telegram is faster than e-mail.
      id: "leads_telegram",
      metric: "leads_handled",
      when: { op: "lte", value: B.leadsHandled },
      title: "Ответ на заявку можно ускорить",
      text: "В работу взято {value} заявок. Включите уведомления о новых заявках в Telegram — увидите их сразу.",
      action: platform,
      fix: "leads_telegram",
      applies:
        present.has("leads") &&
        present.has("notify") &&
        !(
          Array.isArray(p("notify", "channels")) &&
          (p("notify", "channels") as unknown[]).includes("telegram")
        ),
    },
    {
      id: "leads_drop",
      metric: "leads_count",
      when: { op: "drop", share: B.drop, min: B.dropMin },
      title: "Заявок стало меньше",
      text: "Заявок {value}, месяцем раньше было {previous}. Обновите первый экран сайта: понятный заголовок и кнопка заявки на виду.",
      action: platform,
      fix: "leads_drop",
      applies: present.has("leads"),
    },
    {
      id: "bookings_drop",
      metric: "bookings_count",
      when: { op: "drop", share: B.drop, min: B.dropMin },
      title: "Записей стало меньше",
      text: "Записей {value}, месяцем раньше было {previous}. Поставьте кнопку записи на первый экран сайта.",
      action: platform,
      fix: "bookings_drop",
      applies: present.has("booking"),
    },
    {
      id: "schedule_load",
      metric: "schedule_load",
      when: { op: "lte", value: B.scheduleLoad },
      title: "В расписании много свободного времени",
      text: "Расписание занято на {value}. Расскажите о свободных окнах на сайте: кнопка записи на первом экране и короткая акция.",
      action: platform,
      fix: "schedule_load",
      applies: present.has("booking"),
    },
    ...(["returning_clients", "repeat_lead_clients", "deals_repeat_clients"] as const).map(
      (metric): Candidate => ({
        id: `packages_offer_${metric}`,
        metric,
        when: { op: "lte", value: B.repeatShare },
        title: "Мало повторных клиентов",
        text: "Возвращаются {value} клиентов. Предложите абонемент или пакет визитов — добавьте модуль «Абонементы и пакеты».",
        action: platform,
        fix: "packages",
        applies: !present.has("packages"),
      }),
    ),
    {
      id: "packages_expiry",
      metric: "packages_renewed",
      when: { op: "lte", value: B.repeatShare },
      title: "Абонементы редко продлевают",
      text: "Продлили абонемент {value} клиентов. Включите напоминание об окончании абонемента за несколько дней.",
      action: platform,
      fix: "packages_expiry",
      applies: present.has("packages") && !(Number(p("packages", "expiry_reminder_days")) > 0),
    },
    {
      id: "overdue_reminder",
      metric: "overdue_share",
      when: { op: "gte", value: B.overdueShare },
      title: "Возвращают с опозданием",
      text: "Не вернули вовремя {value} выдач. Включите напоминание о сроке возврата и о просрочке.",
      action: platform,
      fix: "overdue",
      applies: present.has("resources") && p("resources", "overdue_reminder") === false,
    },
    {
      id: "overdue_contact",
      metric: "overdue_share",
      when: { op: "gte", value: B.overdueShare },
      title: "Возвращают с опозданием",
      text: "Не вернули вовремя {value} выдач. Откройте просроченные выдачи и свяжитесь с теми, кто не вернул.",
      action: section("resource_issue", "Открыть выдачи"),
      fix: "overdue",
      applies:
        present.has("resources") &&
        p("resources", "overdue_reminder") !== false &&
        ownerReads("resource_issue"),
    },
    {
      id: "deals_won",
      metric: "deals_won_share",
      when: { op: "lte", value: B.dealsWon },
      title: "Мало сделок доходят до успеха",
      text: "Из закрытых сделок успешны {value}. Посмотрите в воронке, на каком этапе они останавливаются.",
      action: section("deal", "Открыть сделки"),
      fix: "deals_won",
      applies: present.has("deals") && ownerReads("deal"),
    },
  ];

  const metrics = new Map(ctx.metrics.map((m) => [m.id, m]));
  const goalOrder = ctx.plan.goals.map((g) => g.id as string);
  const rank = (goal: string) => {
    const at = goalOrder.indexOf(goal);
    return at === -1 ? goalOrder.length : at;
  };
  return candidates
    .flatMap(({ applies, ...rule }, at) => {
      const m = metrics.get(rule.metric);
      if (!applies || !m) return [];
      // A data metric of an entity the owner cannot read is not computed for the panel.
      if (m.compute.kind !== "function" && !ownerReads(m.compute.entity)) return [];
      return [{ rule: { ...rule, goal: m.goal as string, unit: m.unit }, at }];
    })
    .sort((a, b) => rank(a.rule.goal) - rank(b.rule.goal) || a.at - b.at)
    .map((x) => x.rule);
}
