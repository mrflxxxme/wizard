// Test registry of the engine: the real catalog with a ready stand-in for «Напоминания и уведомления» (notify is
// B2-16; «Заявки» require it) and fixture modules fx_* for the application order, links, conflicts and module bugs.
import type { ModuleManifest, SystemPlan } from "@wizard/appspec";
import { MODULES, type ModuleDefinition, type ModuleRegistry } from "../src/index.js";

/** notify stand-in: e-mail (and Telegram) to the owner about a new lead through a link with fragments. */
export const notifyStub: ModuleManifest = {
  id: "notify",
  version: 1,
  name: "Уведомления (тестовая замена)",
  summary: "Письмо владельцу о новой заявке",
  status: "ready",
  order: 5,
  origin: { kind: "new" },
  goals: ["stay_informed"],
  params: [
    {
      name: "channels",
      label: "Каналы",
      type: "enum_list",
      options: [
        { value: "email", label: "Почта" },
        { value: "telegram", label: "Telegram" },
      ],
      minItems: 1,
      default: ["email"],
    },
  ],
  links: [
    {
      module: "leads",
      effect: "уведомление владельца о новой заявке",
      fragments: {
        integrations: [
          {
            value: {
              name: "mail",
              connector: "email",
              config: {
                templates: { new_lead: { subject: "Новая заявка", body: "Новая заявка. Открыть: {{link}}" } },
              },
            },
          },
          {
            when: { param: "channels", includes: "telegram" },
            value: { name: "tg", connector: "telegram", config: {} },
          },
        ],
        workflows: [
          {
            when: { param: "channels", includes: "email" },
            value: {
              name: "lead_notify",
              label: "Уведомить о новой заявке",
              trigger: { type: "on_create", entity: "lead" },
              steps: [
                { type: "notify", params: { integration: "mail", to: "$owner", template: "new_lead" } },
              ],
            },
          },
        ],
      },
    },
  ],
  fragments: {
    integrations: [
      {
        value: {
          name: "mail",
          connector: "email",
          config: { templates: { welcome: { subject: "Добро пожаловать", body: "Здравствуйте! {{link}}" } } },
        },
      },
    ],
  },
  screens: [
    {
      id: "settings",
      audience: "cabinet",
      route: "/cabinet",
      title: "Уведомления",
      roles: ["$owner"],
      components: ["CabinetLayout"],
    },
  ],
  metrics: [],
  goalScenarios: [
    {
      id: "GS-notify-1",
      goal: "stay_informed",
      title: "Владелец получает письмо о новой заявке",
      withModules: ["leads"],
      steps: [{ actor: "visitor", text: "Отправляет заявку" }],
      expect: [{ kind: "outbox_email", text: "Владельцу ушло письмо" }],
    },
  ],
  tests: { matrix: [{ name: "по умолчанию", params: {}, withModules: ["leads"] }], gates: ["G0"] },
};

type FxOver = Partial<ModuleManifest> & { id: string };

/** A ready fixture module with one entity <id>_item and a shared-cabinet screen. */
export function fx(over: FxOver): ModuleManifest {
  const item = `${over.id}_item`;
  return {
    version: 1,
    name: `Фикстура ${over.id}`,
    summary: "Тестовый модуль движка",
    status: "ready",
    order: 100,
    origin: { kind: "new" },
    goals: ["visibility"],
    params: [{ name: "label", label: "Подпись", type: "string", maxLength: 40, default: "Запись" }],
    provides: { entities: [item] },
    fragments: {
      entities: [
        {
          value: {
            name: item,
            label: "{{label}}",
            fields: [
              { name: "title", label: "Название", type: "string", required: true },
              {
                name: "status",
                label: "Статус",
                type: "enum",
                required: true,
                default: "open",
                enum: [
                  { value: "open", label: "Открыта" },
                  { value: "closed", label: "Закрыта" },
                ],
              },
            ],
          },
        },
      ],
      permissions: [
        { value: { role: "$owner", entity: item, ops: ["read", "create", "update", "delete"] } },
        { value: { role: "$staff", entity: item, ops: ["read"] } },
      ],
    },
    screens: [
      {
        id: "items",
        audience: "cabinet",
        route: "/cabinet",
        title: "Записи",
        roles: ["$owner", "$staff"],
        components: ["DataTable"],
      },
    ],
    metrics: [
      {
        id: `${over.id}_open`,
        label: "Открытых записей",
        goal: "visibility",
        unit: "count",
        better: "up",
        compute: { kind: "count", entity: item, dateField: "created_at", where: { status: "open" } },
      },
    ],
    goalScenarios: [
      {
        id: `GS-${over.id}-1`,
        goal: "visibility",
        title: "Владелец видит записи",
        steps: [{ actor: "owner", text: "Открывает кабинет" }],
        expect: [{ kind: "record", text: "Записи видны" }],
      },
    ],
    tests: { matrix: [{ name: "по умолчанию", params: {} }], gates: ["G0"] },
    ...over,
  };
}

/** fx_alpha (order 1) requires fx_beta (order 50); fx_beta links fx_gamma with a field; fx_gamma conflicts fx_delta. */
export const FIXTURES: ModuleManifest[] = [
  fx({ id: "fx_alpha", order: 1, requires: [{ module: "fx_beta", reason: "альфе нужна бета" }] }),
  fx({
    id: "fx_beta",
    order: 50,
    params: [
      { name: "label", label: "Подпись", type: "string", maxLength: 40, default: "Бета" },
      { name: "extra", label: "Свои поля", type: "fields", maxItems: 3 },
    ],
    links: [
      {
        module: "fx_gamma",
        effect: "у беты появляется заметка гаммы",
        fragments: {
          fields: [
            { entity: "fx_beta_item", value: { name: "gamma_note", label: "Заметка гаммы", type: "string" } },
          ],
        },
      },
    ],
  }),
  fx({
    id: "fx_gamma",
    order: 20,
    conflicts: [{ module: "fx_delta", reason: "гамма и дельта ведут одно и то же" }],
  }),
  fx({ id: "fx_delta", order: 30 }),
];

/** The real catalog with notify replaced by the stand-in, plus fixtures (and `extra` definitions). */
export function testRegistry(
  extra: ModuleDefinition[] = [],
  fixtures: ModuleManifest[] = FIXTURES,
): ModuleRegistry {
  const replaced = new Map(extra.map((d) => [d.manifest.id, d]));
  const base = MODULES.map((d) =>
    d.manifest.id === "notify" ? { manifest: notifyStub } : (replaced.get(d.manifest.id) ?? d),
  );
  const fx = fixtures.map((m) => replaced.get(m.id) ?? { manifest: m });
  const known = new Set([...base, ...fx].map((d) => d.manifest.id));
  return { modules: [...base, ...fx, ...extra.filter((d) => !known.has(d.manifest.id))] };
}

const design: SystemPlan["design"] = {
  direction: { mood: ["спокойствие", "доверие"], rhythm: "airy" },
  theme: "calm",
  accent: "#2A7F9E",
  fontPair: { heading: "Manrope", body: "Inter Tight" },
  photoStyle: "светлые кабинеты, дневной свет",
};

/** «Лендинг + заявки» of a dental clinic: every ready section variant kind, the lead form, e-mail to the owner. */
export function landingLeadsPlan(): SystemPlan {
  return {
    version: 1,
    niche: "стоматологическая клиника",
    goals: [
      { id: "leads", statement: "Пациенты оставляют заявки на сайте, и мы их не теряем" },
      { id: "attract", statement: "Посетитель сразу понимает, чем мы лучше" },
    ],
    modules: [
      { id: "landing" },
      {
        id: "leads",
        params: {
          form_fields: ["name", "phone", "comment"],
          contact: "phone",
          extra_fields: [{ name: "visit_reason", label: "Причина визита", type: "string" }],
        },
      },
      { id: "notify", params: { channels: ["email", "telegram"] } },
    ],
    landing: {
      sections: [
        { type: "header", variant: "bar", content: { cta: "Записаться" } },
        {
          type: "hero",
          variant: "split",
          content: {
            eyebrow: "Казань",
            title: "Лечим зубы без боли и очередей",
            subtitle: "Оставьте заявку — перезвоним за 15 минут",
            cta: "Оставить заявку",
          },
        },
        {
          type: "features",
          variant: "cards",
          content: {
            title: "Почему мы",
            items: ["Современное оборудование", { title: "Анестезия", text: "Лечим без боли" }],
          },
        },
        {
          type: "steps",
          variant: "timeline",
          content: { title: "Как это работает", items: ["Заявка", "Звонок администратора", "Приём"] },
        },
        {
          type: "faq",
          variant: "columns",
          content: {
            title: "Вопросы",
            items: [{ question: "Больно ли?", answer: "Работаем с анестезией." }],
          },
        },
        { type: "cta", variant: "card", content: { title: "Есть вопросы?", cta: "Спросить" } },
        {
          type: "lead_form",
          variant: "split",
          content: {
            title: "Оставьте заявку",
            intro: "Перезвоним и подберём время",
            submit_label: "Отправить",
          },
        },
        { type: "footer", variant: "columns", content: { text: "Пример: ООО «Улыбка»" } },
      ],
    },
    design,
    outOfScope: [{ request: "Онлайн-оплата лечения", replacement: "Оплата в клинике", category: "payments" }],
    custom: [
      {
        id: "price_calc",
        title: "Калькулятор стоимости",
        kind: "screen",
        description: "Экран с выбором процедур и расчётом стоимости",
        budgetRub: 8,
        module: "leads",
      },
    ],
  };
}

/** A plan of fixture modules only (with the visibility goal). */
export function fxPlan(modules: SystemPlan["modules"]): SystemPlan {
  return {
    version: 1,
    niche: "тестовая система",
    goals: [{ id: "visibility", statement: "Видеть записи в цифрах" }],
    modules,
    design,
    outOfScope: [],
    custom: [],
  };
}
