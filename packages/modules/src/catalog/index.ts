// Module «Каталог и прайс» (specs/modules/modules.yaml#catalog catalog, origin: the D75 site template's showcase): items
// (services or goods) with prices, optional duration, categories and photos. The owner edits them in the cabinet, the
// visitor sees the visible ones on the page /services and in the landing section «Услуги из каталога». Canonical
// names: entities `service` and `service_category`, fields name, price, duration_min, category, active, description,
// photo, sort_order — leads (with_service) and booking (expectParams with_duration) refer to them.
import type { ModuleFragments, ModuleManifest } from "@wizard/appspec";
import type { ModuleContext, ModuleDefinition } from "../types.js";
import { compileCatalog, SHOWCASE } from "./compile.js";
import { catalogShowcasePage, showcaseTarget } from "./page.js";

const fragments: ModuleFragments = {
  permissions: [
    {
      value: { role: "$public", entity: "service", ops: ["read"], rowFilter: { active: true } },
    },
    {
      when: { param: "show_prices", equals: false },
      value: { role: "$public", entity: "service", ops: ["read"], hiddenFields: ["price"] },
    },
    { value: { role: "$owner", entity: "service", ops: ["read", "create", "update", "delete"] } },
    { value: { role: "$staff", entity: "service", ops: ["read"] } },
    {
      when: { param: "with_categories" },
      value: { role: "$public", entity: "service_category", ops: ["read"] },
    },
    {
      when: { param: "with_categories" },
      value: { role: "$owner", entity: "service_category", ops: ["read", "create", "update", "delete"] },
    },
    {
      when: { param: "with_categories" },
      value: { role: "$staff", entity: "service_category", ops: ["read"] },
    },
  ],
  acceptance: [
    {
      value: {
        text: "Посетитель без входа видит позиции каталога",
        check: { type: "permission", role: "$public", entity: "service", op: "read", expect: "allow" },
      },
    },
    {
      value: {
        text: "Посетитель без входа не меняет каталог",
        check: { type: "permission", role: "$public", entity: "service", op: "update", expect: "deny" },
      },
    },
    {
      value: {
        text: "Владелец добавляет позиции в каталог",
        check: { type: "permission", role: "$owner", entity: "service", op: "create", expect: "allow" },
      },
    },
  ],
};

export const catalogManifest: ModuleManifest = {
  id: "catalog",
  version: 1,
  name: "Каталог и прайс",
  summary: "Услуги или товары с ценами, длительностью и фото; витрина на сайте и правка в кабинете",
  status: "ready",
  order: 20,
  origin: { kind: "d75_template", ref: "витрины DataTable шаблона site; ui-kit Catalog, ItemCard" },
  goals: ["show_offer"],
  params: [
    { name: "item_label", label: "Как называть позицию", type: "string", maxLength: 40, default: "Услуга" },
    { name: "show_prices", label: "Показывать цены", type: "bool", default: true },
    { name: "with_duration", label: "Длительность услуги", type: "bool", default: false },
    { name: "with_categories", label: "Разделы каталога", type: "bool", default: false },
    { name: "with_photos", label: "Фото позиций", type: "bool", default: true },
    { name: "extra_fields", label: "Дополнительные поля позиции", type: "fields", maxItems: 6 },
    {
      name: "showcase_title",
      label: "Заголовок витрины",
      type: "string",
      maxLength: 60,
      default: "Услуги и цены",
    },
  ],
  provides: { entities: ["service", "service_category"], routes: [SHOWCASE.route] },
  hook: true,
  fragments,
  screens: [
    {
      id: "services",
      audience: "public",
      route: SHOWCASE.route,
      title: "Каталог и цены",
      roles: ["$public", "$owner", "$staff", "$visitor"],
      components: ["Catalog", "DataTable"],
      nav: true,
    },
    {
      id: "catalog",
      audience: "cabinet",
      route: "/cabinet",
      title: "Каталог",
      roles: ["$owner", "$staff"],
      components: ["CabinetLayout", "DataTable", "RecordCard", "RecordForm"],
    },
  ],
  metrics: [
    {
      id: "services_active",
      label: "Позиций на витрине",
      goal: "show_offer",
      unit: "count",
      better: "up",
      compute: { kind: "count", entity: "service", dateField: "created_at", where: { active: true } },
    },
  ],
  goalScenarios: [
    {
      id: "GS-catalog-1",
      goal: "show_offer",
      title: "Владелец добавляет услугу, посетитель видит её с ценой",
      when: { param: "show_prices" },
      steps: [
        { actor: "owner", text: "В кабинете создаёт позицию с названием и ценой" },
        { actor: "visitor", text: "Открывает раздел услуг на сайте" },
      ],
      expect: [{ kind: "page_text", text: "Позиция видна на витрине с ценой в рублях" }],
    },
    {
      id: "GS-catalog-2",
      goal: "show_offer",
      title: "Скрытая позиция не видна посетителю",
      steps: [
        { actor: "owner", text: "Снимает позицию с витрины" },
        { actor: "visitor", text: "Открывает раздел услуг" },
      ],
      expect: [{ kind: "page_text", text: "Скрытой позиции нет в списке" }],
    },
    {
      id: "GS-catalog-3",
      goal: "show_offer",
      title: "Посетитель видит длительность услуги",
      when: { param: "with_duration" },
      steps: [
        { actor: "owner", text: "Указывает у позиции длительность 60 минут" },
        { actor: "visitor", text: "Открывает раздел услуг" },
      ],
      expect: [{ kind: "page_text", text: "У позиции видно «60 мин»" }],
    },
    {
      id: "GS-catalog-4",
      goal: "show_offer",
      title: "Посетитель выбирает позицию и переходит к заявке или записи",
      withModules: ["landing", "leads"],
      steps: [{ actor: "visitor", text: "Открывает раздел услуг и нажимает «Выбрать» у позиции" }],
      expect: [{ kind: "page_text", text: "Видна форма заявки на главной или запись на выбранную позицию" }],
    },
  ],
  tests: {
    matrix: [
      { name: "по умолчанию, прайс-лист", params: {}, withModules: ["landing"] },
      {
        name: "разделы, длительность, без цен, карточки с заявкой",
        params: {
          item_label: "Процедура",
          with_categories: true,
          with_duration: true,
          show_prices: false,
          showcase_title: "Процедуры",
        },
        withModules: ["landing", "leads", "notify"],
      },
      {
        name: "товары без фото со своими полями, без лендинга",
        params: {
          item_label: "Товар",
          with_photos: false,
          showcase_title: "Товары и цены",
          extra_fields: [
            { name: "sku", label: "Артикул", type: "string" },
            { name: "in_stock", label: "В наличии", type: "bool" },
            {
              name: "size",
              label: "Размер",
              type: "enum",
              options: [
                { value: "s", label: "S" },
                { value: "m", label: "M" },
              ],
            },
            { name: "order_phone", label: "Телефон для заказа", type: "phone" },
          ],
        },
      },
      {
        name: "фото, длительность и цены, карточки с заявкой",
        params: { with_duration: true },
        withModules: ["landing", "leads", "notify"],
      },
      {
        name: "карточки без фото и разделов",
        params: { with_photos: false },
        withModules: ["landing", "leads", "notify"],
      },
    ],
    gates: ["G0", "G1"],
  },
};

const has = (ctx: ModuleContext, type: string) =>
  (ctx.plan.landing?.sections ?? []).some((s) => s.type === type);

export const catalogModule: ModuleDefinition = {
  manifest: catalogManifest,
  compile: compileCatalog,
  screens: { services: catalogShowcasePage },
  warnings: (ctx) => [
    ...(showcaseTarget(ctx)
      ? []
      : [
          "На витрине нет кнопки «Выбрать»: в системе нет формы заявки на главной или записи — позиции показаны прайс-листом",
        ]),
    ...(ctx.present.has("landing") && !has(ctx, "services")
      ? [
          "Каталог — на отдельной странице «Каталог и цены»; чтобы показать его на главной, добавьте секцию «Услуги из каталога»",
        ]
      : []),
  ],
};
