// Module «Абонементы и пакеты» (specs/modules/modules.yaml#catalog packages, origin: new, B2-18): tariffs
// (`package_plan`), packages sold to clients (`client_package`: visits, a term or visits on a term, the remaining
// visits, the end date, freezing) and their usage (`package_usage`: a visit written off or given back). With «Запись
// по слотам» a booking takes a visit off a valid package of the same contacts, a visitor without one cannot book (the
// booking page asks packageCheck before sending; a booking sent around it is cancelled at once), a cancelled booking
// gives the visit back. The expiry reminder is a message of «Напоминания и уведомления»; the client's packages are in
// his card («Клиенты с историей») and in «Мои абонементы» of «Кабинет посетителя». With the parameter materials the
// module also keeps members' materials (video lessons, files) that open only with a valid package (page /materials).
import type { ModuleManifest } from "@wizard/appspec";
import type { ModuleDefinition } from "../types.js";
import { compilePackages, packagesWarnings } from "./compile.js";
import {
  APPLY_USAGE_FILE,
  applyUsageSource,
  MY_MATERIALS_FILE,
  myMaterialsSource,
  PACKAGE_CHECK_FILE,
  PACKAGE_SOLD_FILE,
  packageCheckSource,
  packageSoldSource,
  RETURN_VISIT_FILE,
  returnVisitSource,
  UNFREEZE_FILE,
  unfreezeSource,
  WRITE_OFF_FILE,
  writeOffSource,
} from "./functions.js";
import { materialsPage } from "./materials.js";

const BOOKED = { param: "write_off_on_booking", module: "booking" } as const;

export const packagesManifest: ModuleManifest = {
  id: "packages",
  version: 1,
  name: "Абонементы и пакеты",
  summary: "Продажа пакетов визитов или периодов, списание визита, остаток и напоминание об окончании",
  status: "ready",
  order: 60,
  origin: { kind: "new" },
  goals: ["retention"],
  params: [
    {
      name: "package_label",
      label: "Как называть пакет",
      type: "string",
      maxLength: 40,
      default: "Абонемент",
    },
    {
      name: "kind",
      label: "Что продаём",
      type: "enum",
      options: [
        { value: "visits", label: "Число визитов" },
        { value: "period", label: "Срок" },
        { value: "both", label: "Визиты на срок" },
      ],
      default: "both",
    },
    { name: "validity_days", label: "Срок действия, дней", type: "int", min: 7, max: 365, default: 30 },
    { name: "write_off_on_booking", label: "Списывать визит при записи", type: "bool", default: true },
    { name: "freeze", label: "Заморозка", type: "bool", default: false },
    {
      name: "expiry_reminder_days",
      label: "Напомнить об окончании за, дней",
      type: "int",
      min: 0,
      max: 14,
      default: 3,
    },
    {
      name: "materials",
      label: "Материалы только для клиентов с абонементом",
      type: "bool",
      default: false,
      description: "Видеоуроки, файлы и ссылки, которые открываются клиенту с действующим абонементом",
    },
    {
      name: "material_label",
      label: "Как называть материал",
      type: "string",
      maxLength: 40,
      default: "Материал",
    },
  ],
  requires: [
    { module: "client_card", reason: "абонемент принадлежит клиенту" },
    { module: "booking", reason: "визит списывается по записи", when: { param: "write_off_on_booking" } },
    {
      module: "notify",
      reason: "напоминание об окончании абонемента",
      when: { param: "expiry_reminder_days" },
    },
  ],
  links: [
    {
      module: "visitor_cabinet",
      effect: "клиент видит свои абонементы и открывает материалы после входа по коду",
    },
    { module: "staff", effect: "сотрудники с разделом «Абонементы» продают абонементы и отмечают визиты" },
  ],
  provides: {
    entities: ["client_package", "package_plan", "package_usage", "package_material"],
    routes: ["/materials"],
  },
  hook: true,
  fragments: {},
  functions: [
    {
      name: "packageSold",
      kind: "mutation",
      file: PACKAGE_SOLD_FILE,
      roles: ["$owner"],
      purpose: "проданный абонемент получает срок, визиты и цену тарифа и контакты клиента",
    },
    {
      name: "applyUsage",
      kind: "mutation",
      file: APPLY_USAGE_FILE,
      roles: ["$owner"],
      purpose: "визит, списанный или возвращённый вручную, один раз меняет остаток",
    },
    {
      name: "writeOffVisit",
      kind: "mutation",
      file: WRITE_OFF_FILE,
      roles: ["$owner", "$staff"],
      when: BOOKED,
      purpose: "списание визита с остатком и защитой от двойного списания",
    },
    {
      name: "returnVisit",
      kind: "mutation",
      file: RETURN_VISIT_FILE,
      roles: ["$owner"],
      when: BOOKED,
      purpose: "отменённая запись возвращает визит на абонемент",
    },
    {
      name: "packageCheck",
      kind: "mutation",
      file: PACKAGE_CHECK_FILE,
      public: true,
      roles: ["$public", "$owner", "$staff"],
      when: BOOKED,
      purpose:
        "страница записи узнаёт, есть ли действующий абонемент на эти контакты в день визита (да или нет)",
      systemDbReason:
        "Посетитель без входа не читает абонементы: функция ищет абонемент по телефону и почте и отвечает только «есть» или «нет», без имён, сроков и остатка",
    },
    {
      name: "unfreezePackage",
      kind: "mutation",
      file: UNFREEZE_FILE,
      roles: ["$owner"],
      when: { param: "freeze" },
      purpose: "дни заморозки переносят дату окончания абонемента",
    },
    {
      name: "myMaterials",
      kind: "query",
      file: MY_MATERIALS_FILE,
      public: true,
      roles: ["$owner", "$staff", "$visitor"],
      when: { param: "materials" },
      purpose: "материалы для клиента с действующим абонементом; команде — все материалы",
      systemDbReason:
        "Клиент не читает материалы напрямую: функция отдаёт их только при действующем абонементе клиента, материалы не содержат персональных данных",
    },
  ],
  screens: [
    {
      id: "packages",
      audience: "cabinet",
      route: "/cabinet",
      title: "Абонементы",
      roles: ["$owner", "$staff"],
      components: ["CabinetLayout", "DataTable", "RecordCard", "RecordForm"],
    },
    {
      id: "materials",
      audience: "visitor",
      route: "/materials",
      title: "Материалы",
      roles: ["$owner", "$staff", "$visitor"],
      components: ["EmptyState", "Loading"],
      when: { param: "materials" },
      nav: true,
    },
  ],
  metrics: [
    {
      id: "packages_sold",
      label: "Продано абонементов",
      goal: "retention",
      unit: "count",
      better: "up",
      compute: { kind: "count", entity: "client_package", dateField: "created_at" },
    },
    {
      id: "packages_renewed",
      label: "Продлили абонемент",
      goal: "retention",
      unit: "percent",
      better: "up",
      compute: { kind: "repeat_share", entity: "client_package", by: "client", dateField: "created_at" },
      description: "Доля клиентов, купивших за период больше одного абонемента",
    },
    {
      id: "package_visits",
      label: "Визитов по абонементам",
      goal: "retention",
      unit: "count",
      better: "up",
      compute: { kind: "count", entity: "package_usage", dateField: "used_at", where: { kind: "write_off" } },
    },
  ],
  goalScenarios: [
    {
      id: "GS-packages-1",
      goal: "retention",
      title: "Владелец продаёт абонемент — он сразу действует с остатком и сроком",
      steps: [
        { actor: "owner", text: "Заводит тариф и продаёт абонемент клиенту" },
        { actor: "owner", text: "Открывает раздел абонементов в кабинете" },
      ],
      expect: [
        { kind: "status", text: "Абонемент в статусе «Действует»" },
        { kind: "record", text: "Остаток визитов и дата окончания заполнены по тарифу" },
      ],
    },
    {
      id: "GS-packages-2",
      goal: "retention",
      title: "Запись по абонементу списывает визит",
      withModules: ["booking", "catalog", "notify"],
      when: { param: "write_off_on_booking" },
      steps: [
        { actor: "owner", text: "Продаёт клиенту абонемент на 4 визита" },
        { actor: "visitor", text: "Записывается на странице записи с тем же телефоном и почтой" },
        { actor: "owner", text: "Открывает абонемент клиента" },
      ],
      expect: [
        { kind: "page_text", text: "Посетитель видит «Вы записаны»" },
        { kind: "record", text: "Визит списан: остаток 3 визита, запись отмечена «Списан с абонемента»" },
      ],
    },
    {
      id: "GS-packages-3",
      goal: "retention",
      title: "С закончившимся абонементом записаться нельзя",
      withModules: ["booking", "catalog", "notify"],
      when: { param: "write_off_on_booking" },
      steps: [
        { actor: "owner", text: "У клиента абонемент закончился" },
        { actor: "visitor", text: "Пытается записаться с телефоном и почтой этого клиента" },
      ],
      expect: [
        { kind: "denied", text: "Посетитель видит, что действующего абонемента нет, и не записывается" },
        { kind: "record", text: "Записи на это время нет, остаток абонемента не изменился" },
      ],
    },
    {
      id: "GS-packages-4",
      goal: "retention",
      title: "Клиент получает напоминание об окончании абонемента",
      withModules: ["notify"],
      when: { param: "expiry_reminder_days" },
      steps: [
        { actor: "owner", text: "Продаёт абонемент клиенту, который согласился на письма" },
        { actor: "system", text: "Время сдвигается к дате напоминания (или остаётся последний визит)" },
      ],
      expect: [{ kind: "outbox_email", text: "Клиенту ушло письмо об окончании абонемента" }],
    },
    {
      id: "GS-packages-5",
      goal: "retention",
      title: "Материалы открываются только клиенту с действующим абонементом",
      withModules: ["visitor_cabinet"],
      when: { param: "materials" },
      steps: [
        { actor: "visitor", text: "Открывает страницу материалов без входа" },
        { actor: "client", text: "Входит в кабинет без абонемента и открывает материалы" },
        { actor: "owner", text: "Продаёт клиенту абонемент" },
        { actor: "client", text: "Снова открывает материалы" },
      ],
      expect: [
        { kind: "denied", text: "Без входа и без абонемента материалов не видно" },
        { kind: "page_text", text: "С действующим абонементом клиент видит материал и ссылку на него" },
      ],
    },
  ],
  tests: {
    matrix: [
      {
        name: "визиты на срок, списание по записи",
        params: {},
        withModules: ["client_card", "booking", "catalog", "notify"],
      },
      {
        name: "только срок, без записи, заморозка",
        params: { kind: "period", write_off_on_booking: false, freeze: true, validity_days: 90 },
        withModules: ["client_card", "notify"],
      },
      {
        name: "только визиты, без напоминаний",
        params: {
          kind: "visits",
          write_off_on_booking: false,
          expiry_reminder_days: 0,
          package_label: "Пакет",
        },
        withModules: ["client_card"],
      },
      {
        name: "подписка с видеоуроками и кабинетом ученика",
        params: {
          kind: "period",
          write_off_on_booking: false,
          materials: true,
          material_label: "Видеоурок",
          package_label: "Подписка",
        },
        withModules: ["client_card", "notify", "visitor_cabinet", "booking", "catalog"],
      },
      {
        name: "визиты по записи, кабинет посетителя и сотрудники",
        params: { kind: "visits", expiry_reminder_days: 1 },
        withModules: ["client_card", "booking", "catalog", "notify", "visitor_cabinet", "staff"],
      },
    ],
    gates: ["G0", "G1"],
  },
};

export const packagesModule: ModuleDefinition = {
  manifest: packagesManifest,
  compile: compilePackages,
  screens: { materials: materialsPage },
  files: {
    [PACKAGE_SOLD_FILE]: packageSoldSource,
    [APPLY_USAGE_FILE]: applyUsageSource,
    [WRITE_OFF_FILE]: writeOffSource,
    [RETURN_VISIT_FILE]: returnVisitSource,
    [PACKAGE_CHECK_FILE]: packageCheckSource,
    [UNFREEZE_FILE]: unfreezeSource,
    [MY_MATERIALS_FILE]: myMaterialsSource,
  },
  warnings: packagesWarnings,
};
