// compile.ts of «Напоминания и уведомления» (manifest.hook): the email and Telegram integrations and the notify
// workflows for the plan's modules, in the formats of capabilities/notify.md and runtime/examples/booking-notify.json:
// owner ($owner) and staff ($role:<staff role> in scope of the module, notify_staff) by the chosen channels, Telegram
// without personal data (D71), service mail to a visitor only with the record's consent field (D69), reminders by a
// schedule.relative trigger on the visit time. The G1 checks are scenarios with runWorkflows and advanceTime.
// B2-18: the end of a package (packages) and the due and overdue messages of issues (resources). V3-18: the shop's new
// order (to the team; to the buyer with the order's link, only with his consent like the booking), its payment and a
// payment that needs the owner's check.
import type { AppSpec, Field, ModuleFragments, Workflow } from "@wizard/appspec";
import { ACTIVE_STATUSES, bookingLinks } from "../booking/compile.js";
import { leadFormFields } from "../leads/compile.js";
import { PACKAGE_NAMES, packageKind } from "../packages/compile.js";
import { RESOURCE_NAMES } from "../resources/compile.js";
import { cabinetRoute } from "../screens/cabinet.js";
import { staffRoles, staffRolesFor } from "../staff/compile.js";
import type { ModuleContext } from "../types.js";

/**
 * What notify expects of the booking entity (module «Запись по слотам», B2-14): `starts_at` (datetime), the visitor's
 * `email` (type email) and `status` with `confirmed` and `cancelled`. notify adds the consent field itself (link).
 */
export const NOTIFY_BOOKING = {
  entity: "booking",
  startsAt: "starts_at",
  email: "email",
  status: "status",
  confirmed: "confirmed",
  cancelled: "cancelled",
  consent: "consent_messages",
} as const;

/** The consent field notify adds to the booking (unchecked checkbox of the booking form). */
export const BOOKING_CONSENT_FIELD: Field = {
  name: NOTIFY_BOOKING.consent,
  label: "Согласен получать письма о записи",
  type: "bool",
  default: false,
};

/**
 * What notify expects of «Интернет-магазин» (V3-23): the order `shop_order` with its number, sum, lines summary, the
 * buyer's contacts, the e-mail «Почта (для чека)», the buyer's secret `token` (the order's page link) and the status
 * `paid`; the payment journal `shop_payment` with `needs_review`. notify adds the consent field itself (link).
 */
export const NOTIFY_SHOP = {
  order: "shop_order",
  payment: "shop_payment",
  email: "email",
  status: "status",
  paid: "paid",
  review: "needs_review",
  consent: "consent_messages",
  /** The order's page of its buyer: the secret in ?t= opens it on any device (useOrder/orderToken). */
  orderLink: "/order/$record.id?t=$record.token",
} as const;

/** The consent field notify adds to the shop's order (the unchecked box of the checkout). */
export const SHOP_CONSENT_FIELD: Field = {
  name: NOTIFY_SHOP.consent,
  label: "Согласен получать письма о заказе",
  type: "bool",
  default: false,
};

/** Names of notify's integrations: e-mail and Telegram (other modules send through them, e.g. the reports digest). */
export const NOTIFY_MAIL = "mail";
export const NOTIFY_TG = "tg";
const MAIL = NOTIFY_MAIL;
const TG = NOTIFY_TG;

type Template = { subject: string; body: string };
type Step = Workflow["steps"][number];

/** One configured notification for the owner's page «Уведомления». */
export interface NotifyItem {
  title: string;
  text: string;
}

export interface NotifyPlan {
  templates: Record<string, Template>;
  telegram: boolean;
  workflows: Workflow[];
  items: NotifyItem[];
  acceptance: NonNullable<ModuleFragments["acceptance"]>;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** Synthetic values of the lead form in the G1 scenario (a name and a phone that Telegram must not carry). */
export const SCENARIO_LEAD: Readonly<Record<string, string>> = {
  name: "Анна Тестова",
  phone: "+79990001122",
  email: "anna.test@example.ru",
  comment: "Хочу записаться на консультацию",
  preferred_time: "Вечер",
};

/** Everything notify adds for the plan (deterministic: the order of modules and steps is fixed). */
export function notifyPlan(ctx: ModuleContext): NotifyPlan {
  const p = ctx.params;
  const channels = list(p.channels);
  const email = channels.includes("email");
  const telegram = channels.includes("telegram");
  const staffOn = p.notify_staff === true && ctx.present.has("staff");
  const staffParams = ctx.allParams.staff ?? {};
  const staffLabel = new Map(staffRoles(staffParams).map((r) => [r.name, r.label]));
  const templates: Record<string, Template> = {};
  const workflows: Workflow[] = [];
  const items: NotifyItem[] = [];
  const acceptance: NotifyPlan["acceptance"] = [];

  /**
   * Steps to the owner and the staff of `module` by the chosen channels (a step per recipient: its own link). The
   * e-mail template is registered only when e-mail is a channel.
   */
  const team = (
    module: string,
    msg: { template?: [string, Template]; text?: string },
    ifStatus?: string,
  ): Step[] => {
    const roles = staffOn ? staffRolesFor(staffParams, module) : [];
    const targets: { to: string; link: string }[] = [
      { to: "$owner", link: cabinetRoute("owner", true).route },
      ...roles.map((r) => ({ to: `$role:${r}`, link: cabinetRoute(r, false).route })),
    ];
    const cond = ifStatus ? { if: { [NOTIFY_BOOKING.status]: [ifStatus] } } : {};
    if (email && msg.template) templates[msg.template[0]] = msg.template[1];
    const steps: Step[] = [];
    for (const t of targets) {
      if (email && msg.template)
        steps.push({
          type: "notify",
          params: { integration: MAIL, to: t.to, template: msg.template[0], link: t.link, ...cond },
        });
      if (telegram && msg.text)
        steps.push({
          type: "notify",
          params: { integration: TG, to: t.to, text: msg.text, link: t.link, ...cond },
        });
    }
    return steps;
  };
  const whom = (module: string): string => {
    const roles = staffOn ? staffRolesFor(staffParams, module) : [];
    const people = ["владельцу", ...roles.map((r) => `сотрудникам роли «${staffLabel.get(r) ?? r}»`)];
    const how = [email ? "письмом" : "", telegram ? "в Telegram" : ""].filter(Boolean).join(" и ");
    return `${people.join(", ")} — ${how}`;
  };

  // Leads: the owner (and the staff with the section) learn about a new lead.
  if (ctx.present.has("leads")) {
    workflows.push({
      name: "lead_notify",
      label: "Уведомить о новой заявке",
      trigger: { type: "on_create", entity: "lead" },
      steps: team("leads", {
        template: [
          "new_lead",
          { subject: "Новая заявка", body: "Пришла новая заявка. Откройте её в кабинете: {{link}}" },
        ],
        text: "Новая заявка — откройте её по ссылке: {{link}}",
      }),
    });
    items.push({ title: "О новой заявке", text: `Сразу после заявки: ${whom("leads")}.` });
    const scenario = leadScenario(ctx, email, telegram);
    if (scenario) acceptance.push({ value: scenario });
  }

  // Booking: new booking and cancellation to the team, confirmation and reminders to the visitor (with consent).
  if (ctx.present.has("booking")) {
    const b = ctx.allParams.booking ?? {};
    const manual = b.confirm === "manual";
    // One-time links of the runtime (D69) by the booking's parameters: cancel (releases the time at once) and
    // reschedule, both closed cancel_until_hours before the visit; `cancelLine` — their text in the templates.
    const { cancel, reschedule, lines: cancelLine } = bookingLinks(b);
    const visitor = p.visitor_emails === true;
    const toVisitor = (template: string, ifStatus?: string | readonly string[]): Step => ({
      type: "notify",
      params: {
        integration: MAIL,
        to: `$record.${NOTIFY_BOOKING.email}`,
        consentField: NOTIFY_BOOKING.consent,
        template,
        ...(cancel ? { cancel } : {}),
        ...(reschedule ? { reschedule } : {}),
        ...(ifStatus
          ? { if: { [NOTIFY_BOOKING.status]: Array.isArray(ifStatus) ? [...ifStatus] : [ifStatus] } }
          : {}),
      },
    });
    const created: Step[] = team("booking", {
      template: [
        "new_booking",
        { subject: "Новая запись", body: "Новая запись на {{starts_at}}. Откройте расписание: {{link}}" },
      ],
      text: "Новая запись на {{starts_at}} — откройте расписание: {{link}}",
    });
    if (visitor) {
      if (manual) {
        templates.visitor_received = {
          subject: "Запись получена",
          body: `Мы получили вашу запись на {{starts_at}} и подтвердим её отдельным письмом.${cancelLine}`,
        };
        templates.visitor_confirmed = {
          subject: "Запись подтверждена",
          body: `Ваша запись на {{starts_at}} подтверждена.${cancelLine}`,
        };
      } else
        templates.visitor_booked = {
          subject: "Вы записаны",
          body: `Вы записаны на {{starts_at}}.${cancelLine}`,
        };
      created.push(toVisitor(manual ? "visitor_received" : "visitor_booked"));
    }
    workflows.push({
      name: "booking_notify",
      label: "Уведомить о новой записи",
      trigger: { type: "on_create", entity: NOTIFY_BOOKING.entity },
      steps: created,
    });
    items.push({
      title: "О новой записи",
      text: `Сразу после записи: ${whom("booking")}.${visitor ? " Посетителю — письмо с датой и временем, если он согласился на письма." : ""}`,
    });
    if (visitor && manual) {
      workflows.push({
        name: "booking_confirmed",
        label: "Письмо о подтверждении записи",
        trigger: {
          type: "on_status",
          entity: NOTIFY_BOOKING.entity,
          field: NOTIFY_BOOKING.status,
          equals: NOTIFY_BOOKING.confirmed,
        },
        steps: [toVisitor("visitor_confirmed")],
      });
      items.push({
        title: "О подтверждении записи",
        text: "Посетителю — письмо, когда сотрудник подтвердил запись.",
      });
    }
    workflows.push({
      name: "booking_cancelled",
      label: "Уведомить об отмене записи",
      trigger: {
        type: "on_status",
        entity: NOTIFY_BOOKING.entity,
        field: NOTIFY_BOOKING.status,
        equals: NOTIFY_BOOKING.cancelled,
      },
      steps: team("booking", {
        template: [
          "booking_cancelled",
          {
            subject: "Запись отменена",
            body: "Запись на {{starts_at}} отменена, время снова свободно. Расписание: {{link}}",
          },
        ],
        text: "Запись на {{starts_at}} отменена — расписание: {{link}}",
      }),
    });
    items.push({ title: "Об отмене записи", text: `Когда запись отменили: ${whom("booking")}.` });

    // A booking moved to another time (by the reschedule link or in the cabinet): the visitor gets the new time with
    // new links (the team sees the schedule; the reminder follows the new time by itself).
    if (visitor) {
      templates.visitor_moved = {
        subject: "Время записи изменено",
        body: `Ваша запись перенесена на {{starts_at}}.${cancelLine}`,
      };
      workflows.push({
        name: "booking_moved",
        label: "Письмо о переносе записи",
        trigger: { type: "on_update", entity: NOTIFY_BOOKING.entity, field: NOTIFY_BOOKING.startsAt },
        steps: [toVisitor("visitor_moved", ACTIVE_STATUSES)],
      });
      items.push({
        title: "О переносе записи",
        text: "Посетителю — письмо с новым временем и новыми ссылками, если он согласился на письма.",
      });
    }

    const reminders = [
      { name: "booking_reminder", hours: Number(p.reminder_hours ?? 0), team: true },
      { name: "booking_reminder_2", hours: Number(p.second_reminder_hours ?? 0), team: false },
    ];
    for (const r of reminders) {
      if (r.hours <= 0) continue;
      const steps: Step[] = [];
      if (visitor) {
        templates.visitor_reminder = {
          subject: "Напоминание о записи",
          body: `Напоминаем: вы записаны на {{starts_at}}.${cancelLine}`,
        };
        steps.push(toVisitor("visitor_reminder", NOTIFY_BOOKING.confirmed));
      }
      // The team gets the first reminder only in Telegram: e-mail already brought the booking itself.
      if (r.team)
        steps.push(
          ...team(
            "booking",
            { text: "Напоминание: запись на {{starts_at}} — расписание: {{link}}" },
            NOTIFY_BOOKING.confirmed,
          ),
        );
      if (!steps.length) continue;
      workflows.push({
        name: r.name,
        label: `Напоминание за ${r.hours} ч до визита`,
        trigger: {
          type: "schedule",
          entity: NOTIFY_BOOKING.entity,
          relative: { field: NOTIFY_BOOKING.startsAt, offsetMinutes: -r.hours * 60 },
        },
        steps,
      });
      items.push({
        title: `Напоминание за ${r.hours} ч`,
        text: [
          visitor
            ? "Посетителю — письмо с датой, временем и ссылкой отмены, если он согласился на письма."
            : "",
          r.team && telegram
            ? `${whom("booking").replace(/ — .*$/, "")} — в Telegram, без имён и телефонов.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
      if (r.team) acceptance.push({ value: reminderScenario(r.hours, visitor, telegram, manual, staffOn) });
    }
  }

  // Packages (B2-18): the end of a package — N days before its end date and, for visits, when one visit is left — to
  // the client (with consent) and the team in Telegram; the refusal letter of a booking cancelled without a package.
  if (ctx.present.has("packages")) {
    const pp = ctx.allParams.packages ?? {};
    const kind = packageKind(pp);
    const label = String(pp.package_label ?? "Абонемент");
    const days = Number(pp.expiry_reminder_days ?? 0);
    const visitor = p.visitor_emails === true;
    const toClient = (template: string, cond: Record<string, unknown[]>): Step => ({
      type: "notify",
      params: {
        integration: MAIL,
        to: "$record.email",
        consentField: "consent_messages",
        template,
        if: cond,
      },
    });
    if (days > 0) {
      const ends: {
        name: string;
        trigger: Workflow["trigger"];
        cond: Record<string, unknown[]>;
        what: string;
      }[] = [];
      if (kind.period)
        ends.push({
          name: "package_expiring",
          trigger: {
            type: "schedule",
            entity: PACKAGE_NAMES.item,
            relative: { field: "ends_at", offsetMinutes: -days * 1440 },
          },
          cond: { status: ["active"] },
          what: `за ${days} дн. до окончания`,
        });
      if (kind.visits)
        ends.push({
          name: "package_last_visit",
          trigger: { type: "on_update", entity: PACKAGE_NAMES.item, field: "visits_left" },
          cond: { status: ["active"], visits_left: [1] },
          what: "когда остаётся последний визит",
        });
      for (const e of ends) {
        const template = e.name === "package_expiring" ? "package_expiring" : "package_last_visit";
        if (visitor)
          templates[template] =
            e.name === "package_expiring"
              ? {
                  subject: `${label} скоро закончится`,
                  body: `Ваш ${label.toLowerCase()} действует до {{expires_on}}. Продлите его, чтобы не прерывать занятия.`,
                }
              : {
                  subject: `${label}: остался последний визит`,
                  body: `На вашем ${label.toLowerCase() === "абонемент" ? "абонементе" : `«${label.toLowerCase()}»`} остался последний визит. Продлите его заранее.`,
                };
        const steps: Step[] = [
          ...(visitor ? [toClient(template, e.cond)] : []),
          ...team("packages", { text: `${label} клиента заканчивается — откройте кабинет: {{link}}` }).map(
            (s): Step => ({ ...s, params: { ...s.params, if: e.cond } }),
          ),
        ];
        if (!steps.length) continue;
        workflows.push({
          name: e.name,
          label: `Напоминание: ${label.toLowerCase()} заканчивается`.slice(0, 80),
          trigger: e.trigger,
          steps,
        });
        items.push({
          title: `Об окончании: ${label.toLowerCase()}`,
          text: [
            visitor ? `Клиенту — письмо ${e.what}, если он согласился на письма.` : "",
            telegram ? `${whom("packages").replace(/ — .*$/, "")} — в Telegram, без имён и телефонов.` : "",
          ]
            .filter(Boolean)
            .join(" "),
        });
      }
    }
    if (pp.write_off_on_booking !== false && ctx.present.has("booking") && visitor) {
      templates.booking_no_package = {
        subject: "Запись не состоялась",
        body: `Мы не нашли действующий ${label.toLowerCase() === "абонемент" ? "абонемент" : `«${label.toLowerCase()}»`} на ваш телефон и почту, поэтому запись на {{starts_at}} не сохранена. Продлите его или свяжитесь с нами.`,
      };
      workflows.push({
        name: "booking_no_package",
        label: "Письмо: запись без действующего абонемента",
        trigger: {
          type: "on_status",
          entity: NOTIFY_BOOKING.entity,
          field: "package_status",
          equals: "no_package",
        },
        steps: [
          {
            type: "notify",
            params: {
              integration: MAIL,
              to: `$record.${NOTIFY_BOOKING.email}`,
              consentField: NOTIFY_BOOKING.consent,
              template: "booking_no_package",
              if: { [NOTIFY_BOOKING.status]: [NOTIFY_BOOKING.cancelled] },
            },
          },
        ],
      });
      items.push({
        title: "О записи без абонемента",
        text: "Посетителю, записавшемуся без действующего абонемента, — письмо, что запись не сохранена.",
      });
    }
  }

  // Resources (B2-18): a day before the due time — to the borrower; overdue — to the team and the borrower.
  if (ctx.present.has("resources") && ctx.allParams.resources?.overdue_reminder !== false) {
    const visitor = p.visitor_emails === true;
    const toBorrower = (template: string, status: string): Step => ({
      type: "notify",
      params: {
        integration: MAIL,
        to: "$record.email",
        consentField: "consent_messages",
        template,
        if: { status: [status] },
      },
    });
    if (visitor) {
      templates.resource_due = {
        subject: "Напоминание о возврате",
        body: "Напоминаем: срок возврата — {{due_at}}. Пожалуйста, верните взятое вовремя.",
      };
      templates.resource_overdue_borrower = {
        subject: "Срок возврата прошёл",
        body: "Срок возврата прошёл ({{due_at}}). Пожалуйста, верните взятое как можно скорее.",
      };
      workflows.push({
        name: "resource_due_reminder",
        label: "Напоминание о возврате за сутки",
        trigger: {
          type: "schedule",
          entity: RESOURCE_NAMES.issue,
          relative: { field: "due_at", offsetMinutes: -1440 },
        },
        steps: [toBorrower("resource_due", "issued")],
      });
      items.push({
        title: "Напоминание о возврате",
        text: "Получателю — письмо за сутки до срока возврата, если он согласился на письма.",
      });
    }
    workflows.push({
      name: "resource_overdue_notify",
      label: "Уведомить о просрочке возврата",
      trigger: { type: "on_status", entity: RESOURCE_NAMES.issue, field: "status", equals: "overdue" },
      steps: [
        ...team("resources", {
          template: [
            "resource_overdue",
            {
              subject: "Просрочен возврат",
              body: "Срок возврата прошёл ({{due_at}}), а выдача не закрыта. Откройте выдачи: {{link}}",
            },
          ],
          text: "Просрочен возврат — откройте выдачи: {{link}}",
        }),
        ...(visitor ? [toBorrower("resource_overdue_borrower", "overdue")] : []),
      ],
    });
    items.push({
      title: "О просрочке возврата",
      text: `Когда срок прошёл: ${whom("resources")}.${visitor ? " Получателю — письмо, если он согласился на письма." : ""}`,
    });
  }

  // Shop (V3-18): a new order and its payment — to the team and, with the buyer's consent, to the buyer (his order's
  // page by its secret); a payment the connector could not match — to the team (the order is neither paid nor
  // cancelled until the owner checks it).
  if (ctx.present.has("shop")) {
    const sp = ctx.allParams.shop ?? {};
    const online = sp.online_payment !== false;
    const visitor = p.visitor_emails === true;
    const toBuyer = (template: string): Step => ({
      type: "notify",
      params: {
        integration: MAIL,
        to: `$record.${NOTIFY_SHOP.email}`,
        consentField: NOTIFY_SHOP.consent,
        template,
        link: NOTIFY_SHOP.orderLink,
      },
    });
    const created: Step[] = team("shop", {
      template: [
        "shop_new_order",
        {
          subject: "Новый заказ №{{number}}",
          body: "Новый заказ №{{number}} на {{total}} ₽.\nСостав: {{items_summary}}\nПокупатель: {{name}}, {{phone}} {{email}}\nОткройте заказ в кабинете: {{link}}",
        },
      ],
      text: "Новый заказ №{{number}} на {{total}} ₽ — откройте кабинет: {{link}}",
    });
    if (visitor) {
      templates.shop_order_received = {
        subject: "Заказ №{{number}} оформлен",
        body: online
          ? "Ваш заказ №{{number}} на {{total}} ₽ оформлен.\nСостав: {{items_summary}}\nСтатус и оплата заказа — на его странице: {{link}}"
          : "Ваш заказ №{{number}} на {{total}} ₽ оформлен, магазин свяжется с вами.\nСостав: {{items_summary}}\nСтатус заказа — на его странице: {{link}}",
      };
      created.push(toBuyer("shop_order_received"));
    }
    workflows.push({
      name: "shop_order_notify",
      label: "Уведомить о новом заказе",
      trigger: { type: "on_create", entity: NOTIFY_SHOP.order },
      steps: created,
    });
    items.push({
      title: "О новом заказе",
      text: `Сразу после заказа: ${whom("shop")} — номер, состав, сумма и контакты покупателя.${visitor ? " Покупателю — письмо с номером, составом и ссылкой на заказ, если он согласился на письма." : ""}`,
    });
    if (online) {
      const paid: Step[] = team("shop", {
        template: [
          "shop_order_paid",
          {
            subject: "Заказ №{{number}} оплачен",
            body: "Заказ №{{number}} на {{total}} ₽ оплачен через ЮKassa. Соберите его: {{link}}",
          },
        ],
        text: "Заказ №{{number}} оплачен — откройте кабинет: {{link}}",
      });
      if (visitor) {
        templates.shop_order_paid_buyer = {
          subject: "Заказ №{{number}} оплачен",
          body: "Оплата заказа №{{number}} на {{total}} ₽ получена. Статус заказа — на его странице: {{link}}",
        };
        paid.push(toBuyer("shop_order_paid_buyer"));
      }
      workflows.push({
        name: "shop_paid_notify",
        label: "Уведомить об оплате заказа",
        trigger: {
          type: "on_status",
          entity: NOTIFY_SHOP.order,
          field: NOTIFY_SHOP.status,
          equals: NOTIFY_SHOP.paid,
        },
        steps: paid,
      });
      items.push({
        title: "Об оплате заказа",
        text: `Когда ЮKassa подтвердила оплату: ${whom("shop")}.${visitor ? " Покупателю — письмо «Оплачен», если он согласился на письма." : ""}`,
      });
      workflows.push({
        name: "shop_payment_review",
        label: "Оплата требует проверки",
        trigger: {
          type: "on_status",
          entity: NOTIFY_SHOP.payment,
          field: NOTIFY_SHOP.status,
          equals: NOTIFY_SHOP.review,
        },
        steps: team("shop", {
          template: [
            "shop_payment_review",
            {
              subject: "Оплата требует проверки",
              body: "Оплата заказа №{{shop_order.number}} на {{amount}} ₽ не совпала с заказом (сумма или состав изменились). Заказ не отмечен оплаченным и не отменяется, пока вы не проверите платёж в личном кабинете ЮKassa. Кабинет: {{link}}",
            },
          ],
          text: "Оплата заказа №{{shop_order.number}} требует проверки — откройте кабинет: {{link}}",
        }),
      });
      items.push({
        title: "Об оплате, которая требует проверки",
        text: `Когда платёж ЮKassa не совпал с заказом: ${whom("shop")}.`,
      });
    }
  }

  return { templates, telegram, workflows, items, acceptance };
}

const WEEKDAYS = [
  "по воскресеньям",
  "по понедельникам",
  "по вторникам",
  "по средам",
  "по четвергам",
  "по пятницам",
  "по субботам",
];

/** When a workflow fires, in the owner's words (a cron of «M H * * D» → «по понедельникам в 09:00»). */
function whenWords(w: Workflow, spec: AppSpec): string {
  const t = w.trigger;
  const entity = spec.entities.find((e) => e.name === t.entity);
  const section = entity ? ` в разделе «${entity.label}»` : "";
  if (t.type === "schedule" && t.cron) {
    const [m = "", h = "", dom, mon, dow = ""] = t.cron.trim().split(/\s+/);
    const at = /^\d+$/.test(m) && /^\d+$/.test(h) ? ` в ${h.padStart(2, "0")}:${m.padStart(2, "0")}` : "";
    if (at && dom === "*" && mon === "*" && dow === "*") return `Каждый день${at}`;
    const day = /^[0-7]$/.test(dow) ? WEEKDAYS[Number(dow) % 7] : undefined;
    if (at && dom === "*" && mon === "*" && day) return `${day.charAt(0).toUpperCase()}${day.slice(1)}${at}`;
    return "По расписанию";
  }
  if (t.type === "schedule") return `По сроку${section}`;
  if (t.type === "on_create") return `Новое${section}`;
  if (t.type === "on_status") {
    const field = entity?.fields.find((f) => f.name === t.field);
    const value = field?.enum?.find((x) => x.value === t.equals)?.label;
    return `Смена статуса${section}${value ? ` на «${value}»` : ""}`;
  }
  if (t.type === "on_update") return `Изменение${section}`;
  return "Автоматически";
}

/**
 * Recipient of a notify step in the owner's words (capabilities/notify.md): $owner — «владельцу», $role:<name> —
 * «сотрудникам роли «…»», $record.<field> — «клиенту» (with consent — «если он согласился на письма»).
 */
export function recipientWords(params: Readonly<Record<string, unknown>>, spec: AppSpec): string {
  const to = String(params.to ?? "");
  if (to === "$owner") return "владельцу";
  if (to.startsWith("$role:")) {
    const role = to.slice("$role:".length);
    return `сотрудникам роли «${spec.roles.find((r) => r.name === role)?.label ?? role}»`;
  }
  if (to.startsWith("$record."))
    return params.consentField ? "клиенту, если он согласился на письма" : "клиенту";
  return "получателю";
}

/**
 * Items of the page «Уведомления» for the notify steps of the plan's other workflows (not in `own`, the workflows of
 * notifyPlan), e.g. the weekly digest of «Отчёты»: when, to whom and by which channel — from the workflow itself, so
 * the page lists every notification the system sends (B2-47).
 */
export function otherNotifyItems(spec: AppSpec, own: ReadonlySet<string>): NotifyItem[] {
  const connector = new Map((spec.integrations ?? []).map((i) => [i.name, i.connector]));
  const items: NotifyItem[] = [];
  for (const w of spec.workflows ?? []) {
    if (own.has(w.name)) continue;
    const byWhom = new Map<string, Set<string>>();
    for (const s of w.steps) {
      if (s.type !== "notify") continue;
      const p = (s.params ?? {}) as Record<string, unknown>;
      const c = connector.get(String(p.integration));
      const how = c === "email" ? "письмом" : c === "telegram" ? "в Telegram" : "сообщением";
      const who = recipientWords(p, spec);
      byWhom.set(who, (byWhom.get(who) ?? new Set<string>()).add(how));
    }
    if (!byWhom.size) continue;
    const whom = [...byWhom].map(([who, how]) => `${who} — ${[...how].join(" и ")}`).join("; ");
    items.push({ title: (w.label ?? w.name).slice(0, 80), text: `${whenWords(w, spec)}: ${whom}.` });
  }
  return items;
}

/** «Owner learns about a new lead»: an anonymous visitor sends the form, the jobs run, the outbox has the messages. */
function leadScenario(ctx: ModuleContext, email: boolean, telegram: boolean): Record<string, unknown> | null {
  const leads = ctx.allParams.leads ?? {};
  const extra = (leads.extra_fields ?? []) as { required?: boolean }[];
  if (extra.some((x) => x.required)) return null;
  const names = leadFormFields(list(leads.form_fields), String(leads.contact ?? "any"));
  const data = Object.fromEntries(names.flatMap((n) => (SCENARIO_LEAD[n] ? [[n, SCENARIO_LEAD[n]]] : [])));
  const expects = [
    ...(email ? [{ expect: { outbox: { connector: "email" } } }] : []),
    ...(telegram ? [{ expect: { outbox: { connector: "telegram" } } }] : []),
  ];
  return {
    text: `Владелец узнаёт о новой заявке${telegram ? " (в Telegram — без имени и телефона)" : ""}`,
    check: {
      type: "scenario",
      actors: { visitor: { role: "guest" } },
      steps: [
        { as: "visitor" },
        { create: { entity: "lead", data }, consent: true },
        { runWorkflows: {} },
        ...expects,
      ],
    },
  };
}

/**
 * «The reminder goes at the right time»: the owner moves a seed booking to now + N h + 1 h with the visitor's
 * consent; 30 minutes later nothing new is sent, 31 minutes more — the reminder goes (e-mail to the visitor,
 * Telegram to the team).
 */
function reminderScenario(
  hours: number,
  visitor: boolean,
  telegram: boolean,
  manual: boolean,
  staffOn: boolean,
): Record<string, unknown> {
  // Messages of the update itself: the confirmation e-mail of manual confirmation and the letter about the new time.
  const before = visitor ? (manual ? 2 : 1) : 0;
  const emails = (count: number) => ({ expect: { outbox: { connector: "email", count } } });
  // Without a count — at least one message (the staff of the role may be several users of the seed).
  const tgCount = (count?: number) => ({
    expect: { outbox: { connector: "telegram", ...(count === undefined ? {} : { count }) } },
  });
  return {
    text: `Напоминание за ${hours} ч уходит в нужное время${telegram ? ": письмом посетителю и в Telegram без персональных данных" : ""}`,
    check: {
      type: "scenario",
      actors: { owner: { role: "owner" } },
      steps: [
        { as: "owner" },
        {
          update: {
            entity: NOTIFY_BOOKING.entity,
            id: `$seed.${NOTIFY_BOOKING.entity}[0].id`,
            data: {
              [NOTIFY_BOOKING.startsAt]: `$now+${hours * 60 + 60}m`,
              [NOTIFY_BOOKING.status]: NOTIFY_BOOKING.confirmed,
              [NOTIFY_BOOKING.email]: "visitor.test@example.ru",
              [NOTIFY_BOOKING.consent]: true,
            },
          },
        },
        { runWorkflows: {} },
        emails(before),
        ...(telegram ? [tgCount(0)] : []),
        { advanceTime: { minutes: 30 } },
        emails(before),
        ...(telegram ? [tgCount(0)] : []),
        { advanceTime: { minutes: 31 } },
        emails(before + (visitor ? 1 : 0)),
        ...(telegram ? [tgCount(staffOn ? undefined : 1)] : []),
      ],
    },
  };
}

export function compileNotify(ctx: ModuleContext): ModuleFragments {
  const plan = notifyPlan(ctx);
  const integrations: NonNullable<ModuleFragments["integrations"]> = [];
  if (Object.keys(plan.templates).length)
    integrations.push({
      value: { name: MAIL, connector: "email", config: { templates: plan.templates } },
    });
  if (plan.telegram) {
    // The shared platform bot only notifies; login through Telegram needs the client's own bot (telegram.yaml).
    const login = ctx.present.has("staff") && ctx.allParams.staff?.login === "telegram";
    integrations.push({
      value: { name: TG, connector: "telegram", config: login ? { loginEnabled: false } : {} },
    });
  }
  return {
    integrations,
    workflows: plan.workflows.filter((w) => w.steps.length).map((w) => ({ value: w })),
    acceptance: plan.acceptance,
  };
}
