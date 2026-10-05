// Synthetic AppSpecs of the release classes (site, booking, crm) on which the QA reference scenarios of
// specs/agents/qa.yaml#checks.reference_scenarios run (M2-39). Minimal: no pages and functions, CRUD + workflows only.
import type { AppSpec } from "@wizard/appspec";

const compliance = {
  consentText: "Я соглашаюсь на обработку имени и контактов для ответа на заявку.",
  policyPage: "/privacy",
  operatorName: "ИП Пример",
  operatorContact: "owner@example.test",
} as const;

const owner = {
  name: "owner",
  label: "Владелец",
  access: "login",
  isAdmin: true,
  loginMethods: ["email_otp"],
};
const status = (values: [string, string][], dflt: string) => ({
  type: "enum",
  required: true,
  default: dflt,
  enum: values.map(([value, label]) => ({ value, label })),
});

export const CLASS_SPECS: Record<"site" | "booking" | "crm", AppSpec> = {
  site: {
    specVersion: "1",
    app: { name: "Сайт с заявками", locale: "ru" },
    entities: [
      {
        name: "lead",
        label: "Заявка",
        fields: [
          {
            name: "name",
            label: "Имя",
            type: "string",
            required: true,
            maxLength: 200,
            pii: "basic",
            piiKind: "fio",
          },
          { name: "phone", label: "Телефон", type: "phone", required: true, pii: "basic", piiKind: "phone" },
          { name: "comment", label: "Комментарий", type: "text", maxLength: 2000 },
          {
            name: "status",
            label: "Статус",
            ...status(
              [
                ["new", "Новая"],
                ["in_work", "В работе"],
                ["done", "Готово"],
              ],
              "new",
            ),
          },
        ],
        retention: { deleteAfterDays: 365, mode: "delete" },
      },
    ],
    roles: [owner, { name: "visitor", label: "Посетитель", access: "public" }],
    permissions: [
      { role: "owner", entity: "lead", ops: ["read", "create", "update", "delete"] },
      { role: "visitor", entity: "lead", ops: ["create"] },
    ],
    compliance,
  },
  booking: {
    specVersion: "1",
    app: { name: "Запись на услуги", locale: "ru" },
    entities: [
      {
        name: "service",
        label: "Услуга",
        fields: [
          { name: "name", label: "Название", type: "string", required: true, maxLength: 200 },
          { name: "duration_min", label: "Длительность, мин", type: "int", required: true, min: 5, max: 600 },
        ],
      },
      {
        name: "booking",
        label: "Запись",
        fields: [
          { name: "service", label: "Услуга", type: "ref", required: true, ref: { entity: "service" } },
          { name: "starts_at", label: "Начало", type: "datetime", required: true, unique: true },
          { name: "client_user", label: "Клиент", type: "ref", required: true, ref: { entity: "users" } },
          {
            name: "status",
            label: "Статус",
            ...status(
              [
                ["confirmed", "Подтверждена"],
                ["cancelled", "Отменена"],
              ],
              "confirmed",
            ),
          },
        ],
        ownerField: "client_user",
      },
    ],
    roles: [
      owner,
      { name: "client", label: "Клиент", access: "login", loginMethods: ["email_otp"], selfSignup: true },
    ],
    permissions: [
      { role: "owner", entity: "service", ops: ["read", "create", "update", "delete"] },
      { role: "owner", entity: "booking", ops: ["read", "create", "update", "delete"] },
      { role: "client", entity: "service", ops: ["read"] },
      { role: "client", entity: "booking", ops: ["read", "create"], rowFilter: { client_user: "$user.id" } },
    ],
    workflows: [
      {
        name: "booking_reminder",
        label: "Напоминание за 24 часа",
        trigger: {
          type: "schedule",
          entity: "booking",
          relative: { field: "starts_at", offsetMinutes: -1440 },
        },
        steps: [
          {
            type: "notify",
            params: {
              integration: "email",
              to: "$record.client_user",
              text: "Напоминаем о записи {{starts_at}}.",
              if: { status: ["confirmed"] },
            },
          },
        ],
      },
    ],
    integrations: [{ name: "email", connector: "email" }],
    compliance,
  },
  crm: {
    specVersion: "1",
    app: { name: "Сделки", locale: "ru" },
    entities: [
      {
        name: "deal",
        label: "Сделка",
        fields: [
          { name: "title", label: "Название", type: "string", required: true, maxLength: 200 },
          { name: "amount", label: "Сумма", type: "money", min: 0 },
          {
            name: "stage",
            label: "Этап",
            ...status(
              [
                ["new", "Новая"],
                ["negotiation", "Переговоры"],
                ["won", "Успех"],
                ["lost", "Отказ"],
              ],
              "new",
            ),
          },
          { name: "manager", label: "Менеджер", type: "ref", required: true, ref: { entity: "users" } },
        ],
        indexes: [{ fields: ["stage"] }],
        ownerField: "manager",
      },
    ],
    roles: [owner, { name: "manager", label: "Менеджер", access: "login", loginMethods: ["email_otp"] }],
    permissions: [
      { role: "owner", entity: "deal", ops: ["read", "create", "update", "delete"] },
      {
        role: "manager",
        entity: "deal",
        ops: ["read", "create", "update"],
        rowFilter: { manager: "$user.id" },
      },
    ],
    compliance,
  },
} as unknown as Record<"site" | "booking" | "crm", AppSpec>;
