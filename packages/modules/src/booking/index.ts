// Module «Запись по слотам» (specs/modules/modules.yaml#catalog booking, origin: the D75 booking template): bookings
// of a service (catalog, with duration) on free time of a resource (doctor, chair, master — `specialist`), working
// days and hours, a break, a slot step and seats per time. The visitor books on /booking (also /booking?service=<id>
// from the showcase) without a login and without a server function (D75: the unique index (resource, starts_at, seat)
// answers CONFLICT to the second visitor). Messages are notify's; the e-mail carries the runtime's one-time links
// (D69, bookingLinks): cancel releases the seat at once, reschedule moves the booking. With «Клиенты с историей» the
// booking finds or creates its client; with «Кабинет посетителя» the visitor reads and cancels his own bookings.
// Canonical names: entity `booking` (starts_at, ends_at, status new | confirmed | done | no_show | cancelled, email,
// seat, client), `specialist`.
import type { ModuleFragments, ModuleManifest } from "@wizard/appspec";
import type { ModuleDefinition } from "../types.js";
import { compileBooking } from "./compile.js";
import {
  BUSY_SLOTS_FILE,
  busySlotsSource,
  CLIENT_FROM_BOOKING,
  CLIENT_FROM_BOOKING_FILE,
  SCHEDULE_LOAD_FILE,
  scheduleLoadSource,
} from "./functions.js";
import { bookingPage } from "./page.js";
import { scheduleWarnings } from "./schedule.js";

const WEEKDAYS = [
  { value: "mon", label: "Пн" },
  { value: "tue", label: "Вт" },
  { value: "wed", label: "Ср" },
  { value: "thu", label: "Чт" },
  { value: "fri", label: "Пт" },
  { value: "sat", label: "Сб" },
  { value: "sun", label: "Вс" },
];

const fragments: ModuleFragments = {
  permissions: [
    { value: { role: "$owner", entity: "booking", ops: ["read", "create", "update", "delete"] } },
    { value: { role: "$staff", entity: "booking", ops: ["read", "create", "update"] } },
    // The staff of the booking section book on a service: they read the catalog even without its section.
    { value: { role: "$staff", entity: "service", ops: ["read"] } },
    { when: { param: "with_specialists" }, value: { role: "$public", entity: "specialist", ops: ["read"] } },
    {
      when: { param: "with_specialists" },
      value: { role: "$owner", entity: "specialist", ops: ["read", "create", "update", "delete"] },
    },
    { when: { param: "with_specialists" }, value: { role: "$staff", entity: "specialist", ops: ["read"] } },
  ],
  acceptance: [
    {
      value: {
        text: "Посетитель без входа записывается на свободное время",
        check: { type: "permission", role: "$public", entity: "booking", op: "create", expect: "allow" },
      },
    },
    {
      value: {
        text: "Посетитель без входа не читает чужие записи (имена и контакты)",
        check: { type: "permission", role: "$public", entity: "booking", op: "read", expect: "deny" },
      },
    },
    {
      value: {
        text: "Владелец видит расписание и меняет статус записи",
        check: { type: "permission", role: "$owner", entity: "booking", op: "update", expect: "allow" },
      },
    },
  ],
};

export const bookingManifest: ModuleManifest = {
  id: "booking",
  version: 1,
  name: "Запись по слотам",
  summary:
    "Запись на свободное время с подтверждением, отменой и переносом по ссылке; расписание у персонала",
  status: "ready",
  order: 40,
  origin: {
    kind: "d75_template",
    ref: "шаблон booking (уникальный индекс времени, LeadForm), capabilities/booking.md",
  },
  goals: ["fill_schedule", "reduce_no_shows"],
  params: [
    { name: "slot_minutes", label: "Шаг расписания, минут", type: "int", min: 15, max: 240, default: 60 },
    {
      name: "workdays",
      label: "Рабочие дни",
      type: "enum_list",
      options: WEEKDAYS,
      minItems: 1,
      default: ["mon", "tue", "wed", "thu", "fri"],
    },
    { name: "day_start", label: "Начало дня", type: "time", default: "09:00" },
    { name: "day_end", label: "Конец дня", type: "time", default: "18:00" },
    { name: "break_start", label: "Начало перерыва", type: "time" },
    { name: "break_end", label: "Конец перерыва", type: "time" },
    { name: "with_specialists", label: "Несколько специалистов", type: "bool", default: false },
    {
      name: "specialist_label",
      label: "Как называть специалиста",
      type: "string",
      maxLength: 40,
      default: "Специалист",
    },
    { name: "capacity", label: "Мест на одно время", type: "int", min: 1, max: 50, default: 1 },
    {
      name: "confirm",
      label: "Подтверждение записи",
      type: "enum",
      options: [
        { value: "auto", label: "Сразу" },
        { value: "manual", label: "Сотрудником" },
      ],
      default: "auto",
    },
    { name: "cancel_by_link", label: "Отмена по ссылке из письма", type: "bool", default: true },
    { name: "reschedule_by_link", label: "Перенос по ссылке из письма", type: "bool", default: true },
    {
      name: "cancel_until_hours",
      label: "Отмена не позже чем за, часов",
      type: "int",
      min: 0,
      max: 72,
      default: 2,
    },
    { name: "extra_fields", label: "Дополнительные поля записи", type: "fields", maxItems: 4 },
    {
      name: "retention_days",
      label: "Срок хранения записей, дней",
      type: "int",
      min: 30,
      max: 1095,
      default: 365,
    },
  ],
  requires: [
    {
      module: "catalog",
      reason: "запись идёт на услугу с длительностью",
      expectParams: { with_duration: true },
    },
    {
      module: "notify",
      reason: "посетитель получает подтверждение и ссылку отмены, владелец — уведомление",
    },
  ],
  links: [
    {
      module: "client_card",
      effect: "запись ссылается на клиента (поле client); визиты видны в истории клиента",
    },
    { module: "staff", effect: "специалисты — сотрудники со входом; каждый видит своё расписание" },
    {
      module: "visitor_cabinet",
      effect: "посетитель видит, отменяет и переносит свои записи в кабинете",
    },
  ],
  provides: { entities: ["booking", "specialist"], routes: ["/booking"] },
  hook: true,
  fragments,
  functions: [
    {
      name: "busySlots",
      kind: "query",
      file: BUSY_SLOTS_FILE,
      public: true,
      roles: ["$public", "$owner", "$staff", "$visitor"],
      purpose: "занятое время дня для страницы записи: начало, конец и место, без имён и контактов",
      systemDbReason:
        "Страница записи показывает свободное время: функция отдаёт только начало, конец и место занятых записей, без имён и контактов",
    },
    {
      name: "scheduleLoad",
      kind: "query",
      file: SCHEDULE_LOAD_FILE,
      public: true,
      roles: ["$owner", "$staff"],
      purpose:
        "занятость расписания за неделю или месяц и период до него для панели цели (метрика schedule_load)",
    },
    {
      name: "clientFromBooking",
      kind: "mutation",
      file: CLIENT_FROM_BOOKING_FILE,
      roles: ["$owner"],
      when: { module: "client_card" },
      purpose: "новая запись находит клиента по телефону или почте или создаёт его",
    },
  ],
  screens: [
    {
      id: "booking",
      audience: "public",
      route: "/booking",
      title: "Запись",
      roles: ["$public", "$owner", "$staff", "$visitor"],
      components: ["Button", "ConsentCheckbox", "EmptyState", "Field", "Loading"],
      nav: true,
    },
    {
      id: "schedule",
      audience: "cabinet",
      route: "/cabinet",
      title: "Записи",
      roles: ["$owner", "$staff"],
      components: ["CabinetLayout", "DataTable", "RecordCard", "RecordForm"],
    },
  ],
  metrics: [
    {
      id: "bookings_count",
      label: "Записей",
      goal: "fill_schedule",
      unit: "count",
      better: "up",
      compute: {
        kind: "count",
        entity: "booking",
        dateField: "starts_at",
        where: { status: ["confirmed", "done"] },
      },
    },
    {
      id: "schedule_load",
      label: "Занятость расписания",
      goal: "fill_schedule",
      unit: "percent",
      better: "up",
      compute: { kind: "function", name: "scheduleLoad" },
      description: "Доля занятого времени от рабочего времени всех специалистов и мест за период",
    },
    {
      id: "no_show_share",
      label: "Доля неявок",
      goal: "reduce_no_shows",
      unit: "percent",
      better: "down",
      compute: {
        kind: "ratio",
        entity: "booking",
        dateField: "starts_at",
        numerator: { status: "no_show" },
        denominator: { status: ["done", "no_show"] },
      },
    },
    {
      id: "cancel_share",
      label: "Доля отмен",
      goal: "reduce_no_shows",
      unit: "percent",
      better: "down",
      compute: {
        kind: "ratio",
        entity: "booking",
        dateField: "starts_at",
        numerator: { status: "cancelled" },
      },
    },
  ],
  goalScenarios: [
    {
      id: "GS-booking-1",
      goal: "fill_schedule",
      title: "Посетитель записался на свободное время, владелец получил уведомление",
      withModules: ["notify"],
      steps: [
        { actor: "visitor", text: "Открывает страницу записи, выбирает услугу, день и свободное время" },
        {
          actor: "visitor",
          text: "Вводит имя, телефон и почту, соглашается на письма и обработку данных, записывается",
        },
        { actor: "owner", text: "Открывает записи в кабинете" },
      ],
      expect: [
        { kind: "page_text", text: "Посетитель видит «Вы записаны» с датой и временем" },
        { kind: "record", text: "Запись в кабинете владельца со статусом «Подтверждена»" },
        {
          kind: "outbox_email",
          text: "Посетителю ушло подтверждение со ссылками отмены и переноса, владельцу — письмо о новой записи",
        },
      ],
    },
    {
      id: "GS-booking-2",
      goal: "fill_schedule",
      title: "Второй посетитель на то же время получает отказ",
      steps: [
        { actor: "visitor", text: "Первый посетитель записывается на время" },
        {
          actor: "visitor",
          text: "Второй посетитель, открывший страницу раньше, отправляет запись на то же время",
        },
      ],
      expect: [
        { kind: "page_text", text: "Второй видит «Это время только что заняли — выберите другое»" },
        { kind: "record", text: "На это время одна запись" },
        { kind: "page_text", text: "Занятое время больше не предлагается" },
      ],
    },
    {
      id: "GS-booking-3",
      goal: "reduce_no_shows",
      title: "Отмена по ссылке из письма освобождает время",
      when: { param: "cancel_by_link" },
      withModules: ["notify"],
      steps: [
        { actor: "visitor", text: "Открывает ссылку отмены из письма и подтверждает отмену" },
        { actor: "visitor", text: "Снова открывает страницу записи на тот же день" },
      ],
      expect: [
        { kind: "status", text: "Запись в статусе «Отменена»" },
        { kind: "page_text", text: "Освободившееся время снова доступно" },
        { kind: "outbox_email", text: "Владельцу ушло письмо об отмене" },
        { kind: "metric", text: "Доля отмен выросла" },
      ],
    },
    {
      id: "GS-booking-4",
      goal: "reduce_no_shows",
      title: "Перенос по ссылке из письма на другое свободное время",
      when: { param: "reschedule_by_link" },
      withModules: ["notify"],
      steps: [
        { actor: "visitor", text: "Открывает ссылку переноса из письма" },
        { actor: "visitor", text: "Выбирает другой день и время и подтверждает перенос" },
        { actor: "visitor", text: "Открывает ту же ссылку ещё раз" },
      ],
      expect: [
        { kind: "page_text", text: "Посетитель видит «Запись перенесена»" },
        { kind: "record", text: "Запись на новом времени, старое время снова свободно" },
        { kind: "outbox_email", text: "Посетителю ушло письмо «Время записи изменено» с новыми ссылками" },
        { kind: "denied", text: "Повторно ссылка не работает: «Ссылка недействительна»" },
      ],
    },
  ],
  tests: {
    matrix: [
      { name: "одно место, без специалистов", params: {}, withModules: ["catalog", "notify"] },
      {
        name: "врачи, шаг 30 минут, перерыв и суббота, свои поля",
        params: {
          with_specialists: true,
          specialist_label: "Врач",
          slot_minutes: 30,
          workdays: ["mon", "tue", "wed", "thu", "fri", "sat"],
          day_start: "08:00",
          day_end: "20:00",
          break_start: "13:00",
          break_end: "14:00",
          extra_fields: [
            { name: "first_visit", label: "Первый визит", type: "bool" },
            {
              name: "visit_reason",
              label: "Причина визита",
              type: "enum",
              options: [
                { value: "pain", label: "Боль" },
                { value: "checkup", label: "Осмотр" },
              ],
            },
          ],
        },
        withModules: ["catalog", "notify"],
      },
      {
        name: "группа до 8 мест, шаг 90 минут",
        params: { capacity: 8, slot_minutes: 90, cancel_until_hours: 24 },
        withModules: ["catalog", "notify"],
      },
      {
        name: "подтверждение сотрудником, без ссылок",
        params: {
          confirm: "manual",
          cancel_by_link: false,
          reschedule_by_link: false,
          cancel_until_hours: 0,
        },
        withModules: ["catalog", "notify"],
      },
      {
        name: "с клиентами и кабинетом посетителя",
        params: {},
        withModules: ["catalog", "notify", "client_card", "visitor_cabinet"],
      },
    ],
    gates: ["G0", "G1"],
  },
};

export const bookingModule: ModuleDefinition = {
  manifest: bookingManifest,
  compile: compileBooking,
  screens: { booking: bookingPage },
  files: {
    [BUSY_SLOTS_FILE]: busySlotsSource,
    [SCHEDULE_LOAD_FILE]: scheduleLoadSource,
    [CLIENT_FROM_BOOKING_FILE]: CLIENT_FROM_BOOKING,
  },
  warnings: (ctx) => scheduleWarnings(ctx.params),
};
