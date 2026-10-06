// Module «Напоминания и уведомления» (specs/modules/modules.yaml#catalog notify): the email and Telegram connectors and
// the notify workflows of the plan's modules (compile.ts), the consent field of service mail on the booking (link), the
// owner's page «Уведомления» listing what goes to whom and how. Recipients and formats — capabilities/notify.md.
import type { ModuleManifest } from "@wizard/appspec";
import { jsxEl } from "../screens/jsx.js";
import type { ModuleDefinition, ScreenContext } from "../types.js";
import { BOOKING_CONSENT_FIELD, compileNotify, NOTIFY_BOOKING, notifyPlan } from "./compile.js";

export const notifyManifest: ModuleManifest = {
  id: "notify",
  version: 1,
  name: "Напоминания и уведомления",
  summary: "Письма и сообщения в Telegram владельцу и сотрудникам, подтверждения и напоминания посетителям",
  status: "ready",
  order: 5,
  origin: {
    kind: "v1_code",
    ref: "коннекторы email и telegram, шаг notify, capabilities/notify.md, runtime/examples/booking-notify.json",
  },
  goals: ["stay_informed", "reduce_no_shows"],
  params: [
    {
      name: "channels",
      label: "Каналы для владельца и сотрудников",
      type: "enum_list",
      options: [
        { value: "email", label: "Почта" },
        { value: "telegram", label: "Telegram" },
      ],
      minItems: 1,
      default: ["email"],
    },
    { name: "notify_staff", label: "Уведомлять сотрудников", type: "bool", default: false },
    { name: "visitor_emails", label: "Письма посетителям (с согласия)", type: "bool", default: true },
    {
      name: "reminder_hours",
      label: "Напоминание посетителю за, часов",
      type: "int",
      min: 0,
      max: 72,
      default: 24,
    },
    {
      name: "second_reminder_hours",
      label: "Второе напоминание за, часов",
      type: "int",
      min: 0,
      max: 12,
      default: 0,
    },
  ],
  links: [
    {
      module: "booking",
      effect: "подтверждение, напоминания перед визитом, уведомление о новой записи и отмене",
      fragments: {
        fields: [
          {
            when: { param: "visitor_emails" },
            entity: NOTIFY_BOOKING.entity,
            value: { ...BOOKING_CONSENT_FIELD },
          },
        ],
      },
    },
    { module: "leads", effect: "уведомление владельца о новой заявке" },
    { module: "deals", effect: "напоминание ответственному о задаче по сделке" },
    { module: "packages", effect: "напоминание об окончании абонемента" },
    { module: "resources", effect: "напоминание о возврате и просрочке" },
  ],
  provides: { routes: ["/cabinet/notifications"] },
  hook: true,
  fragments: {},
  screens: [
    {
      id: "settings",
      audience: "cabinet",
      route: "/cabinet/notifications",
      title: "Уведомления",
      roles: ["$owner"],
      components: ["CabinetLayout", "Features"],
      nav: true,
    },
  ],
  metrics: [],
  goalScenarios: [
    {
      id: "GS-notify-1",
      goal: "reduce_no_shows",
      title: "За сутки до визита посетителю уходит напоминание",
      withModules: ["booking"],
      when: { param: "reminder_hours" },
      steps: [
        { actor: "visitor", text: "Записывается на завтра с согласием на письма" },
        { actor: "system", text: "Время сдвигается до момента напоминания" },
      ],
      expect: [
        {
          kind: "outbox_email",
          text: "Посетителю ушло письмо-напоминание с датой, временем и ссылкой отмены",
        },
      ],
    },
    {
      id: "GS-notify-2",
      goal: "stay_informed",
      title: "Сообщение владельцу в Telegram без персональных данных",
      withModules: ["leads"],
      when: { param: "channels", includes: "telegram" },
      steps: [{ actor: "visitor", text: "Отправляет заявку с именем и телефоном" }],
      expect: [
        { kind: "outbox_telegram", text: "Владельцу ушло сообщение со ссылкой, без имени и телефона" },
      ],
    },
    {
      id: "GS-notify-3",
      goal: "stay_informed",
      title: "Владелец видит, какие уведомления настроены",
      steps: [{ actor: "owner", text: "Открывает раздел «Уведомления» в кабинете" }],
      expect: [{ kind: "page_text", text: "Список уведомлений: о чём, кому и каким каналом" }],
    },
  ],
  tests: {
    matrix: [
      { name: "письмо владельцу о заявке", params: {}, withModules: ["leads", "landing"] },
      {
        name: "почта и Telegram, сотрудникам тоже",
        params: { channels: ["email", "telegram"], notify_staff: true },
        withModules: ["leads", "landing", "staff"],
      },
      {
        name: "только Telegram, без писем посетителям",
        params: { channels: ["telegram"], visitor_emails: false, reminder_hours: 0 },
        withModules: ["leads"],
      },
      {
        name: "запись: подтверждение, напоминание, отмена и перенос по ссылке",
        params: {},
        withModules: ["booking", "catalog"],
      },
      {
        name: "запись: почта и Telegram, второе напоминание",
        params: { channels: ["email", "telegram"], second_reminder_hours: 2 },
        withModules: ["booking", "catalog"],
      },
    ],
    gates: ["G0", "G1"],
  },
};

/** «Уведомления» of the owner: what is sent, to whom and by which channel (from the same plan as the workflows). */
export function notifyScreen(ctx: ScreenContext): string {
  const plan = notifyPlan(ctx);
  const items = plan.items.length
    ? plan.items
    : [{ title: "Пока нечего отправлять", text: "Уведомления появятся вместе с заявками или записью." }];
  const intro = plan.telegram
    ? "Сообщения в Telegram не содержат имён и телефонов: только ссылку на запись в кабинете."
    : "Письма уходят с адреса платформы; посетителям — только если они согласились на письма.";
  return [
    "// Generated by the module «Напоминания и уведомления» (B2-16): the configured notifications.",
    'import { CabinetLayout, Features } from "@wizard/ui-kit";',
    "",
    "export default function Notifications() {",
    "  return (",
    `    <CabinetLayout title="Уведомления" defaultSection="list" sections={[{ id: "list", label: "Что и кому", content: (`,
    `      ${jsxEl("Features", [
      ["title", "Настроенные уведомления"],
      ["intro", intro],
      ["items", items],
      ["variant", "grid", "lit"],
      ["columns", 2],
    ])}`,
    "    ) }]} />",
    "  );",
    "}",
    "",
  ].join("\n");
}

export const notifyModule: ModuleDefinition = {
  manifest: notifyManifest,
  compile: compileNotify,
  screens: { settings: notifyScreen },
};
