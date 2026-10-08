// V3-10 (C5): extension operations over a small hand-made spec — markExtraPii (the B2-46 rule shared with the module
// engine), the ПДн gate over module fields, self sign-up roles, triggers and Telegram texts. The operations on compiled
// module systems with the gates — packages/modules/test/extend.test.ts.
import { describe, expect, test } from "vitest";
import {
  type AppSpec,
  applyExtensions,
  type Entity,
  EXTENSION_FIELD_TYPES,
  extensionOpSchema,
  markExtraPii,
  validateSpec,
} from "../src/index.js";

const ALL = ["read", "create", "update", "delete"] as const;

function spec(): AppSpec {
  return {
    specVersion: "1",
    app: { name: "Проверка", locale: "ru" },
    entities: [
      {
        name: "lead",
        label: "Заявка",
        fields: [
          { name: "name", label: "Имя", type: "string", required: true, pii: "basic", piiKind: "fio" },
          { name: "phone", label: "Телефон", type: "phone", required: true, pii: "basic", piiKind: "phone" },
          {
            name: "status",
            label: "Статус",
            type: "enum",
            required: true,
            default: "new",
            enum: [
              { value: "new", label: "Новая" },
              { value: "done", label: "Готово" },
            ],
          },
          { name: "visit_at", label: "Когда прийти", type: "datetime" },
          { name: "venue", label: "Площадка", type: "ref", ref: { entity: "venue" } },
        ],
        retention: { deleteAfterDays: 365 },
      },
      {
        name: "venue",
        label: "Площадка",
        fields: [
          { name: "title", label: "Название", type: "string", required: true },
          { name: "contact", label: "Контакт для связи", type: "string" },
        ],
      },
    ],
    roles: [
      { name: "guest", label: "Посетитель", access: "public" },
      { name: "owner", label: "Владелец", access: "login", loginMethods: ["email_otp"], isAdmin: true },
      { name: "client", label: "Клиент", access: "login", loginMethods: ["email_otp"], selfSignup: true },
    ],
    permissions: [
      { role: "guest", entity: "lead", ops: ["create"], readonlyFields: ["status"] },
      { role: "owner", entity: "lead", ops: ["read", "update", "delete"] },
      { role: "client", entity: "lead", ops: ["read"], rowFilter: { phone: "$user.phone" } },
      { role: "owner", entity: "venue", ops: [...ALL] },
      { role: "client", entity: "venue", ops: ["read"] },
    ],
    integrations: [{ name: "tg", connector: "telegram" }],
    compliance: { consentTemplateId: "default", policyPage: "/privacy" },
  };
}

const reason = (s: AppSpec, op: unknown) => applyExtensions(s, [op]).rejected[0]?.reasonRu;

describe("markExtraPii (B2-46, shared by the engine and the extensions)", () => {
  test("ПДн-like extra fields are marked; weak names once the entity is a subject; a retention is added", () => {
    const e: Entity = {
      name: "deal",
      label: "Сделка",
      fields: [
        { name: "title", label: "Название", type: "string" },
        { name: "messenger", label: "Мессенджер (Telegram/WhatsApp)", type: "string" },
        { name: "phone", label: "Телефон", type: "phone" },
        { name: "comment", label: "Комментарий", type: "text" },
      ],
    };
    markExtraPii(e, new Set(["messenger", "phone", "comment"]));
    expect(e.fields.map((f) => [f.name, f.pii ?? "—", f.piiKind ?? "—"])).toEqual([
      ["title", "—", "—"],
      ["messenger", "basic", "other"],
      ["phone", "basic", "phone"],
      ["comment", "—", "—"],
    ]);
    expect(e.retention).toEqual({ deleteAfterDays: 3650, mode: "anonymize" });
  });

  test("fields outside the extras and an existing retention stay as they are", () => {
    const e: Entity = {
      name: "x",
      label: "Икс",
      retention: { deleteAfterDays: 30 },
      fields: [
        { name: "phone", label: "Телефон", type: "phone" },
        { name: "email", label: "Почта", type: "email" },
      ],
    };
    markExtraPii(e, new Set(["email"]));
    expect(e.fields[0]?.pii).toBeUndefined();
    expect(e.fields[1]).toMatchObject({ pii: "basic", piiKind: "email" });
    expect(e.retention).toEqual({ deleteAfterDays: 30 });
  });
});

describe("applyExtensions over a small spec", () => {
  test("the fixture is a valid spec; the schema knows five operations", () => {
    expect(validateSpec(spec()).ok).toBe(true);
    expect(extensionOpSchema.options.map((o) => o.shape.op.value)).toEqual([
      "add_field",
      "add_entity",
      "add_role",
      "add_function",
      "add_automation",
    ]);
    expect(EXTENSION_FIELD_TYPES).not.toContain("json");
  });

  test("a field that makes a module entity a subject turns its module field into ПДн — rejected", () => {
    const s = spec();
    expect(
      reason(s, {
        op: "add_field",
        entity: "venue",
        field: { name: "phone", label: "Телефон", type: "phone" },
      }),
    ).toMatch(/поле «Контакт для связи» тоже становится ПДн/);
    // An entity of the extension marks its own weak names instead.
    const r = applyExtensions(s, [
      {
        op: "add_entity",
        entity: {
          name: "branch",
          label: "Филиал",
          fields: [
            { name: "title", label: "Название", type: "string" },
            { name: "contact", label: "Контакт для связи", type: "string" },
          ],
        },
      },
      { op: "add_field", entity: "branch", field: { name: "phone", label: "Телефон", type: "phone" } },
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.spec.entities.find((e) => e.name === "branch")?.fields.map((f) => f.pii ?? "—")).toEqual([
      "—",
      "basic",
      "basic",
    ]);
  });

  test("a self sign-up role: only own rows on entities with ПДн", () => {
    const s = spec();
    // The client reads every venue: a ПДн field there would open it to all clients.
    expect(
      reason(s, {
        op: "add_field",
        entity: "venue",
        field: { name: "email", label: "Почта", type: "email" },
      }),
    ).toMatch(/открыты роли «Клиент» целиком|тоже становится ПДн/);
    expect(
      reason(s, {
        op: "add_entity",
        entity: {
          name: "ticket",
          label: "Обращение",
          fields: [{ name: "email", label: "Почта", type: "email" }],
        },
        grants: [{ role: "client", ops: ["read", "create"] }],
      }),
    ).toMatch(/чужие записи/);
    const ok = applyExtensions(s, [
      {
        op: "add_entity",
        entity: {
          name: "ticket",
          label: "Обращение",
          fields: [{ name: "email", label: "Почта", type: "email" }],
        },
        grants: [{ role: "client", ops: ["read", "create"], rowFilter: { email: "$user.email" } }],
      },
    ]);
    expect(ok.rejected).toEqual([]);
  });

  test("triggers: a schedule needs a date field; on_status needs a field and a value", () => {
    const s = spec();
    const step = [{ type: "wait", params: { minutes: 10 } }];
    expect(
      reason(s, {
        op: "add_automation",
        name: "remind",
        trigger: { type: "schedule", entity: "lead", relative: { field: "status", offsetMinutes: -60 } },
        steps: step,
      }),
    ).toMatch(/полем даты/);
    expect(
      applyExtensions(s, [
        {
          op: "add_automation",
          name: "remind",
          trigger: { type: "schedule", entity: "lead", relative: { field: "visit_at", offsetMinutes: -60 } },
          steps: step,
        },
      ]).rejected,
    ).toEqual([]);
    expect(
      reason(s, {
        op: "add_automation",
        name: "done",
        trigger: { type: "on_status", entity: "lead" },
        steps: step,
      }),
    ).toMatch(/поле и значение/);
  });

  test("Telegram: no ПДн through a link either ({{ref.field}})", () => {
    const s = spec();
    const tg = (text: string) => ({
      op: "add_automation",
      name: "tg_note",
      trigger: { type: "on_create", entity: "lead" },
      steps: [{ type: "notify", params: { integration: "tg", to: ["$owner"], text } }],
    });
    expect(reason(s, tg("Заявка: {{name}}"))).toMatch(/уберите \{\{name\}\}/);
    expect(reason(s, tg("Площадка {{venue.title}}: {{link}}"))).toBeUndefined();
    const withPii = applyExtensions(s, [
      {
        op: "add_field",
        entity: "venue",
        field: { name: "manager", label: "Управляющий", type: "string", pii: "basic" },
      },
    ]);
    // The venue becomes a subject and its «Контакт для связи» would need marking — rejected before Telegram matters.
    expect(withPii.rejected[0]?.reasonRu).toMatch(/Контакт для связи/);
  });

  test("an unknown operation gets a Russian reason; the input is never mutated", () => {
    const s = spec();
    const before = JSON.stringify(s);
    const r = applyExtensions(s, [{ op: "remove_entity", name: "venue" }, "x"]);
    expect(r.rejected.map((x) => x.index)).toEqual([0, 1]);
    expect(r.rejected[0]?.reasonRu).toMatch(
      /Неизвестный тип операции.*add_field.*менять и удалять части модулей нельзя/,
    );
    expect(JSON.stringify(s)).toBe(before);
    expect(r.spec).toEqual(s);
  });
});
