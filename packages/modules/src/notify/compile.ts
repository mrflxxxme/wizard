// compile.ts of «Напоминания и уведомления» (manifest.hook): the email and Telegram integrations and the notify
// workflows for the plan's modules, in the formats of capabilities/notify.md and runtime/examples/booking-notify.json:
// owner ($owner) and staff ($role:<staff role> in scope of the module, notify_staff) by the chosen channels, Telegram
// without personal data (D71), service mail to a visitor only with the record's consent field (D69), reminders by a
// schedule.relative trigger on the visit time. The G1 checks are scenarios with runWorkflows and advanceTime.
import type { Field, ModuleFragments, Workflow } from "@wizard/appspec";
import { leadFormFields } from "../leads/compile.js";
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
    const cancelLink = b.cancel_by_link !== false;
    const cancelLine = cancelLink ? "\nНе сможете прийти — отмените запись по ссылке: {{cancel_link}}" : "";
    const visitor = p.visitor_emails === true;
    const cancel = cancelLink
      ? { cancel: { set: { [NOTIFY_BOOKING.status]: NOTIFY_BOOKING.cancelled } } }
      : {};
    const toVisitor = (template: string, ifStatus?: string): Step => ({
      type: "notify",
      params: {
        integration: MAIL,
        to: `$record.${NOTIFY_BOOKING.email}`,
        consentField: NOTIFY_BOOKING.consent,
        template,
        ...cancel,
        ...(ifStatus ? { if: { [NOTIFY_BOOKING.status]: [ifStatus] } } : {}),
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

  return { templates, telegram, workflows, items, acceptance };
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
  // Messages of the update itself: the confirmation e-mail of manual confirmation.
  const before = visitor && manual ? 1 : 0;
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
