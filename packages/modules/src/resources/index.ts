// Module «Учёт выдачи и ресурсов» (specs/modules/modules.yaml#catalog resources, origin: new, B2-18): items
// (`resource`: books, equipment, keys — in stock, issued or unavailable; with quantities — pieces in stock) and their
// issues (`resource_issue`: to whom, until when, returned; overdue at the due time; deposit). The owner or the staff
// of the section issue and take back in the cabinet; an item without quantities cannot be issued twice before it is
// returned (unique open issue). The reminder before the due date and the overdue notice are messages of «Напоминания
// и уведомления»; with «Клиенты с историей» an issue refers to the client and is in his history. With bulk_import the
// owner adds a list of items pasted from a spreadsheet.
import type { ModuleManifest } from "@wizard/appspec";
import type { ModuleDefinition } from "../types.js";
import { compileResources, resourcesWarnings } from "./compile.js";
import {
  ISSUE_RESOURCE_FILE,
  issueResourceSource,
  RETURN_RESOURCE_FILE,
  returnResourceSource,
} from "./functions.js";
import { importPage } from "./import.js";

export const resourcesManifest: ModuleManifest = {
  id: "resources",
  version: 1,
  name: "Учёт выдачи и ресурсов",
  summary: "Что выдано, кому и до какого числа; возврат, просрочки и напоминания",
  status: "ready",
  order: 70,
  origin: { kind: "new" },
  goals: ["resource_tracking"],
  params: [
    {
      name: "resource_label",
      label: "Как называть предмет",
      type: "string",
      maxLength: 40,
      default: "Инвентарь",
    },
    { name: "with_quantity", label: "Учёт количества", type: "bool", default: false },
    {
      name: "default_days",
      label: "Срок выдачи по умолчанию, дней",
      type: "int",
      min: 1,
      max: 90,
      default: 7,
    },
    { name: "overdue_reminder", label: "Напоминание о просрочке", type: "bool", default: true },
    { name: "deposit", label: "Залог", type: "bool", default: false },
    { name: "extra_fields", label: "Дополнительные поля предмета", type: "fields", maxItems: 6 },
    { name: "bulk_import", label: "Загрузка списка из таблицы", type: "bool", default: false },
  ],
  requires: [
    { module: "notify", reason: "напоминание о возврате и просрочке", when: { param: "overdue_reminder" } },
  ],
  links: [
    { module: "client_card", effect: "выдача ссылается на клиента, история выдач в карточке" },
    { module: "staff", effect: "сотрудники с разделом «Учёт выдачи» выдают и принимают предметы" },
  ],
  provides: { entities: ["resource", "resource_issue"], routes: ["/resources-import"] },
  hook: true,
  fragments: {},
  functions: [
    {
      name: "issueResource",
      kind: "mutation",
      file: ISSUE_RESOURCE_FILE,
      roles: ["$owner"],
      purpose: "выдача получает время выдачи, срок возврата и контакты клиента; предмет становится выданным",
    },
    {
      name: "returnResource",
      kind: "mutation",
      file: RETURN_RESOURCE_FILE,
      roles: ["$owner"],
      purpose: "возврат закрывает выдачу и возвращает предмет в наличие",
    },
  ],
  screens: [
    {
      id: "issues",
      audience: "cabinet",
      route: "/cabinet",
      title: "Учёт выдачи",
      roles: ["$owner", "$staff"],
      components: ["CabinetLayout", "DataTable", "RecordCard", "RecordForm"],
    },
    {
      id: "import",
      audience: "cabinet",
      route: "/resources-import",
      title: "Загрузка списка",
      roles: ["$owner"],
      components: ["Button", "EmptyState"],
      when: { param: "bulk_import" },
      nav: true,
    },
  ],
  metrics: [
    {
      id: "issued_count",
      label: "Выдач",
      goal: "resource_tracking",
      unit: "count",
      better: "up",
      compute: { kind: "count", entity: "resource_issue", dateField: "issued_at" },
    },
    {
      id: "overdue_share",
      label: "Доля просрочек",
      goal: "resource_tracking",
      unit: "percent",
      better: "down",
      compute: {
        kind: "ratio",
        entity: "resource_issue",
        dateField: "due_at",
        numerator: { was_overdue: true },
      },
      description: "Доля выдач со сроком возврата в периоде, которые вернули позже срока или ещё не вернули",
    },
  ],
  goalScenarios: [
    {
      id: "GS-resources-1",
      goal: "resource_tracking",
      title: "Сотрудник выдаёт предмет и принимает возврат",
      steps: [
        { actor: "owner", text: "Выдаёт предмет со сроком возврата" },
        { actor: "owner", text: "Отмечает возврат" },
      ],
      expect: [{ kind: "status", text: "Предмет снова «в наличии», выдача закрыта" }],
    },
    {
      id: "GS-resources-2",
      goal: "resource_tracking",
      title: "Просроченная выдача помечается и даёт напоминание",
      withModules: ["notify"],
      when: { param: "overdue_reminder" },
      steps: [
        { actor: "owner", text: "Выдаёт предмет на 1 день" },
        { actor: "system", text: "Время сдвигается на 2 дня" },
      ],
      expect: [
        { kind: "status", text: "Выдача в статусе «Просрочено»" },
        { kind: "outbox_email", text: "Владельцу ушло напоминание о просрочке" },
      ],
    },
    {
      id: "GS-resources-3",
      goal: "resource_tracking",
      title: "Получатель получает письмо за сутки до срока возврата",
      withModules: ["notify"],
      when: { param: "overdue_reminder" },
      steps: [
        { actor: "owner", text: "Выдаёт предмет на 3 дня с почтой получателя и его согласием на письма" },
        { actor: "system", text: "Время сдвигается к суткам до срока" },
      ],
      expect: [{ kind: "outbox_email", text: "Получателю ушло письмо с напоминанием вернуть предмет" }],
    },
    {
      id: "GS-resources-4",
      goal: "resource_tracking",
      title: "Пока предмет не вернули, второй раз его не выдать",
      when: { param: "with_quantity", equals: false },
      steps: [
        { actor: "owner", text: "Выдаёт предмет" },
        { actor: "owner", text: "Пытается выдать тот же предмет ещё раз" },
      ],
      expect: [
        { kind: "denied", text: "Вторая выдача не сохраняется, предмет числится у первого получателя" },
      ],
    },
  ],
  tests: {
    matrix: [
      { name: "по умолчанию: напоминания о просрочке", params: {}, withModules: ["notify"] },
      {
        name: "библиотека: книги с автором, клиенты, загрузка списка",
        params: {
          resource_label: "Книга",
          default_days: 14,
          bulk_import: true,
          extra_fields: [
            { name: "author", label: "Автор", type: "string" },
            { name: "year", label: "Год издания", type: "int" },
          ],
        },
        withModules: ["notify", "client_card"],
      },
      {
        name: "прокат: количество и залог, без напоминаний",
        params: {
          resource_label: "Снаряжение",
          with_quantity: true,
          deposit: true,
          overdue_reminder: false,
          default_days: 1,
        },
      },
      {
        name: "сотрудники выдают, выдачи клиентам",
        params: { default_days: 3 },
        withModules: ["notify", "staff", "client_card"],
      },
    ],
    gates: ["G0", "G1"],
  },
};

export const resourcesModule: ModuleDefinition = {
  manifest: resourcesManifest,
  compile: compileResources,
  screens: { import: importPage },
  files: {
    [ISSUE_RESOURCE_FILE]: issueResourceSource,
    [RETURN_RESOURCE_FILE]: returnResourceSource,
  },
  warnings: resourcesWarnings,
};
