// Test registry of the engine: the real catalog (notify, staff and visitor_cabinet with code since B2-16) plus fixture
// modules fx_* for the application order, links, conflicts and module bugs. «Запись по слотам» is the real module
// since B2-14 (its stand-in is gone).
import type { ModuleManifest, SystemPlan } from "@wizard/appspec";
import {
  MODULES,
  MODULES_WITH_CODE,
  type ModuleDefinition,
  type ModuleRegistry,
  matrixPlan,
} from "../src/index.js";

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

/** The real catalog plus fixtures; `extra` definitions replace catalog modules or fixtures with the same id. */
export function testRegistry(
  extra: ModuleDefinition[] = [],
  fixtures: ModuleManifest[] = FIXTURES,
): ModuleRegistry {
  const replaced = new Map(extra.map((d) => [d.manifest.id, d]));
  const base = MODULES.map((d) => replaced.get(d.manifest.id) ?? d);
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

/**
 * «Все модули» (B2-19): the dental clinic's landing with every module with code — catalog with durations, booking with
 * packages writing a visit off, clients, deals, staff, the visitor's cabinet, issue of resources, members' materials
 * and the goal panel. The CI row of the full plan (goals.browser.test.ts, gates.test.ts) and the time measure
 * (goals-time.browser.test.ts) compile it.
 */
export function allModulesPlan(): SystemPlan {
  const plan: SystemPlan = { ...landingLeadsPlan(), custom: [] };
  plan.goals = [
    ...plan.goals,
    { id: "retention", statement: "Пациенты возвращаются и продлевают абонементы" },
  ];
  const params: Record<string, Record<string, unknown>> = {
    catalog: { with_duration: true },
    packages: { materials: true },
  };
  const own = new Map(plan.modules.map((m) => [m.id, m]));
  plan.modules = MODULES_WITH_CODE.map((d) => {
    const id = d.manifest.id;
    const p = params[id];
    return own.get(id) ?? (p ? { id, params: p } : { id });
  });
  return plan;
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

/**
 * B2-47 (D76 control measurement, brief mvp-08 «Мастерская по ремонту техники»): plans of «Воронка сделок»,
 * «Напоминания и уведомления» and «Отчёты» under the parameters a model may choose — with and without the weekly digest
 * to the owner, Telegram only without letters to visitors, notifications to the staff too (deals with the person in
 * charge, leads). The owner's page «Уведомления» must list every notification of them (GS-notify-3).
 */
export function dealsNotifyReportsPlans(registry: ModuleRegistry): { name: string; plan: SystemPlan }[] {
  const variants: { name: string; params: Record<string, Record<string, unknown>>; extra?: string[] }[] = [
    { name: "сделки и отчёты без сводки", params: {} },
    { name: "сделки и отчёты, сводка письмом", params: { reports: { digest: "weekly" } } },
    {
      name: "только Telegram без писем посетителям, сводка письмом",
      params: {
        notify: { channels: ["telegram"], visitor_emails: false, reminder_hours: 0 },
        reports: { digest: "weekly" },
      },
    },
    {
      name: "заявки, ответственные и сотрудникам тоже, сводка письмом",
      params: {
        notify: { channels: ["email", "telegram"], notify_staff: true },
        deals: { assignees: true, stages: ["Принят", "Диагностика", "Ремонт", "Готов к выдаче"] },
        reports: { digest: "weekly", period: "week" },
      },
      extra: ["staff", "leads", "landing"],
    },
  ];
  return variants.map((v) => {
    const plan = matrixPlan(registry, "notify", {
      name: v.name,
      params: v.params.notify ?? {},
      withModules: ["deals", "reports", ...(v.extra ?? [])],
    });
    plan.niche = "мастерская по ремонту техники";
    plan.modules = plan.modules.map((m) => {
      const params = { ...(m.params ?? {}), ...(m.id === "notify" ? {} : (v.params[m.id] ?? {})) };
      return Object.keys(params).length ? { id: m.id, params } : { id: m.id };
    });
    return { name: v.name, plan };
  });
}
