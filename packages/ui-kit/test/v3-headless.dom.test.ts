// @vitest-environment happy-dom
// V3-10 (specs/agents/builder-v3.md §3 C4): the headless hooks of @wizard/ui-kit/v3/headless — no markup, the logic of
// LeadForm, the booking page and the catalog: data and permissions of the role, the personal data consent (G2-PII-04:
// no write without it, then {consent: true}), states. Over the memory DataSource with the runtime's permission
// semantics, and once over @wizard/sdk against a fake runtime (the default DataSource of the system template).
import type { AppSpec } from "@wizard/appspec";
import { SdkClient, SdkProvider } from "@wizard/sdk";
import * as subpath from "@wizard/ui-kit/v3/headless";
import { act, createElement as h, type ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { toRoleSpec, WzProvider } from "../src/index.js";
import { createMemoryDataSource, type MemoryDataSource, wzError } from "../src/testing/index.js";
import {
  type BusyTime,
  dayKey,
  freeSlots,
  type ScheduleSpec,
  useBooking,
  useCatalog,
  useContent,
  useLeadForm,
  workdays,
  zonedAt,
} from "../src/v3/headless/index.js";
import { type Rendered, render } from "./helpers/dom.js";

const STATUS = [
  { value: "new", label: "Новая" },
  { value: "done", label: "Готово" },
];

const app: AppSpec = {
  specVersion: "1",
  app: { name: "Студия", locale: "ru" },
  entities: [
    {
      name: "lead",
      label: "Заявка",
      fields: [
        { name: "name", label: "Имя", type: "string", required: true, pii: "basic", piiKind: "fio" },
        { name: "phone", label: "Телефон", type: "phone", required: true, pii: "basic", piiKind: "phone" },
        { name: "comment", label: "Комментарий", type: "text" },
        { name: "status", label: "Статус", type: "enum", required: true, default: "new", enum: STATUS },
      ],
      retention: { deleteAfterDays: 365 },
    },
    {
      name: "service_category",
      label: "Раздел",
      fields: [{ name: "name", label: "Название", type: "string" }],
    },
    {
      name: "service",
      label: "Услуга",
      fields: [
        { name: "name", label: "Название", type: "string", required: true },
        { name: "price", label: "Цена", type: "money" },
        { name: "duration_min", label: "Длительность", type: "int" },
        { name: "active", label: "Показывать", type: "bool", required: true, default: true },
        { name: "sort_order", label: "Порядок", type: "int" },
        { name: "category", label: "Раздел", type: "ref", ref: { entity: "service_category" } },
      ],
    },
    {
      name: "booking",
      label: "Запись",
      fields: [
        { name: "starts_at", label: "Начало", type: "datetime", required: true },
        { name: "ends_at", label: "Конец", type: "datetime", required: true },
        { name: "service", label: "Услуга", type: "ref", ref: { entity: "service" }, required: true },
        { name: "seat", label: "Место", type: "int" },
        { name: "status", label: "Статус", type: "enum", required: true, default: "new", enum: STATUS },
        { name: "name", label: "Имя", type: "string", required: true, pii: "basic", piiKind: "fio" },
        { name: "phone", label: "Телефон", type: "phone", required: true, pii: "basic", piiKind: "phone" },
        { name: "photo", label: "Фото", type: "image" },
        {
          name: "consent_messages",
          label: "Согласен получать служебные сообщения",
          type: "bool",
          default: false,
        },
      ],
      retention: { deleteAfterDays: 365 },
    },
  ],
  roles: [
    { name: "guest", label: "Посетитель", access: "public" },
    { name: "owner", label: "Владелец", access: "login", loginMethods: ["email_otp"], isAdmin: true },
    { name: "viewer", label: "Наблюдатель", access: "login", loginMethods: ["email_otp"] },
  ],
  permissions: [
    { role: "guest", entity: "lead", ops: ["create"], readonlyFields: ["status"] },
    { role: "owner", entity: "lead", ops: ["read", "update", "delete"] },
    { role: "guest", entity: "service", ops: ["read"], rowFilter: { active: true } },
    { role: "owner", entity: "service", ops: ["read", "create", "update", "delete"] },
    { role: "guest", entity: "service_category", ops: ["read"] },
    { role: "guest", entity: "booking", ops: ["create"], readonlyFields: ["status"] },
    { role: "owner", entity: "booking", ops: ["read", "create", "update", "delete"] },
    { role: "viewer", entity: "booking", ops: ["read"] },
  ],
  compliance: { consentTemplateId: "default", policyPage: "/privacy" },
};

const SERVICES = [
  {
    id: "s_cut",
    name: "Стрижка",
    price: 1500,
    duration_min: 90,
    active: true,
    sort_order: 2,
    category: "c_hair",
  },
  { id: "s_color", name: "Окрашивание", price: 4000, active: true, sort_order: 1, category: "c_hair" },
  { id: "s_nails", name: "Маникюр", price: 1200, active: true, sort_order: 3, category: "c_nails" },
  { id: "s_old", name: "Старая услуга", active: false, sort_order: 0 },
];

/** Monday 12.10.2026, 06:00 UTC: the working day 09:00–18:00 (UTC) is ahead. */
const NOW = Date.parse("2026-10-12T06:00:00Z");
const SCHEDULE: ScheduleSpec = {
  tz: "UTC",
  days: [1, 2, 3, 4, 5],
  start: 540,
  end: 1080,
  step: 60,
  breakStart: null,
  breakEnd: null,
  capacity: 1,
  leadMinutes: 0,
};
const BUSY: BusyTime[] = [
  { starts_at: "2026-10-12T10:00:00.000Z", ends_at: "2026-10-12T11:00:00.000Z", seat: 1 },
];

function memory(o: { userId?: string; packageOk?: boolean } = {}): MemoryDataSource {
  return createMemoryDataSource(
    app,
    {
      service: SERVICES,
      service_category: [
        { id: "c_hair", name: "Волосы" },
        { id: "c_nails", name: "Ногти" },
      ],
    },
    {
      users: [
        { id: "u_owner", role: "owner", displayName: "Владелец", isAdmin: true },
        { id: "u_viewer", role: "viewer", displayName: "Наблюдатель", isAdmin: false },
      ],
      ...(o.userId ? { userId: o.userId } : {}),
      functions: {
        busySlots: (args) => (args === "skip" ? [] : BUSY),
        packageCheck: () => ({ ok: o.packageOk ?? true }),
      },
    },
  );
}

/** Renders a hook inside WzProvider and returns its latest value. */
async function mountHook<T>(hook: () => T, ds: MemoryDataSource, role: string | null = null) {
  let current: T | undefined;
  function Probe(): ReactNode {
    current = hook();
    return null;
  }
  const rendered = await render(h(Probe), { app, role, ds });
  return { get: () => current as T, rendered };
}

const run = (fn: () => unknown) => act(async () => void (await fn()));

let r: Rendered | undefined;
afterEach(() => {
  r?.unmount();
  r = undefined;
});

describe("useLeadForm", () => {
  test("no create without consent; then create with {consent: true}; «sent» and again()", async () => {
    const ds = memory();
    const m = await mountHook(() => useLeadForm("lead"), ds);
    r = m.rendered;
    expect(m.get().allowed).toBe(true);
    expect(m.get().form.fields.map((f) => f.name)).toEqual(["name", "phone", "comment"]);
    expect(m.get().form.consent).toMatchObject({ required: true, checked: false, policyPage: "/privacy" });

    await run(() => m.get().form.submit());
    expect(m.get().form.errors).toMatchObject({ name: "Заполните поле", phone: "Заполните поле" });
    await run(() => {
      m.get().form.setValue("name", "Анна");
      m.get().form.setValue("phone", "+79990001122");
    });
    await run(() => m.get().form.submit());
    expect(m.get().form.consent.error).toBe("Нужно согласие на обработку персональных данных");
    expect(ds.calls.filter((c) => c.op === "create")).toEqual([]);

    await run(() => m.get().form.consent.set(true));
    expect(m.get().form.consent.error).toBeUndefined();
    await run(() => m.get().form.submit());
    expect(ds.calls.filter((c) => c.op === "create").map((c) => c.args)).toEqual([
      [{ name: "Анна", phone: "+79990001122" }, { consent: true }],
    ]);
    expect(m.get().sent).toMatchObject({ name: "Анна", status: "new" });
    expect(m.get().form.values).toEqual({ name: null, phone: null, comment: null });
    expect(m.get().form.consent.checked).toBe(false);

    await run(() => m.get().again());
    expect(m.get().sent).toBeNull();
    expect(m.get().round).toBe(1);
  });

  test("a role that may not create sees the form unavailable; server field errors land on the fields", async () => {
    const viewer = await mountHook(() => useLeadForm("lead"), memory({ userId: "u_viewer" }), "viewer");
    expect(viewer.get().allowed).toBe(false);
    viewer.rendered.unmount();

    const ds = memory();
    const m = await mountHook(() => useLeadForm("lead", { fields: ["name", "phone"] }), ds);
    r = m.rendered;
    await run(() => {
      m.get().form.setValue("name", "Анна");
      m.get().form.setValue("phone", "+79990001122");
      m.get().form.consent.set(true);
    });
    ds.failNext(
      "create",
      wzError("VALIDATION_FAILED", {
        fields: [{ field: "phone", code: "TAKEN", message: "Этот номер уже есть" }],
      }),
    );
    await run(() => m.get().form.submit());
    expect(m.get().form.errors).toEqual({ phone: "Этот номер уже есть" });
    expect(m.get().form.formError).toBeUndefined();
    expect(m.get().sent).toBeNull();
  });

  test("over @wizard/sdk: the write goes to /api/data with _consent", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const client = new SdkClient({
      realtime: false,
      consent: { policyVersion: "1", textHash: "h" },
      fetch: async (input: string, init?: RequestInit) => {
        const url = new URL(input, "http://studio--draft.localhost");
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
        return new Response(JSON.stringify({ item: { id: "lead_1", ...(body ?? {}) } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    let model: ReturnType<typeof useLeadForm> | undefined;
    function Probe(): ReactNode {
      model = useLeadForm("lead");
      return null;
    }
    r = await render(
      h(SdkProvider, { client }, h(WzProvider, { spec: toRoleSpec(app, null), applyTheme: false }, h(Probe))),
    );
    await run(() => {
      model?.form.setValue("name", "Анна");
      model?.form.setValue("phone", "+79990001122");
      model?.form.consent.set(true);
    });
    await run(() => model?.form.submit());
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/api/data/lead");
    expect(post?.body).toMatchObject({
      name: "Анна",
      phone: "+79990001122",
      _consent: { policyVersion: "1", textHash: "h" },
    });
    expect(model?.sent).toMatchObject({ id: "lead_1" });
  });
});

describe("useCatalog and useContent", () => {
  test("visible items in the owner's order; sections; «Показать ещё»; read permission", async () => {
    const m = await mountHook(() => useCatalog(), memory());
    r = m.rendered;
    expect(m.get().canRead).toBe(true);
    expect(m.get().items.map((x) => x.id)).toEqual(["s_color", "s_cut", "s_nails"]);
    expect(m.get()).toMatchObject({ total: 3, pageSize: 24, hasMore: false, category: null });
    await run(() => m.get().setCategory("c_nails"));
    expect(m.get().items.map((x) => x.id)).toEqual(["s_nails"]);
    await run(() => m.get().setCategory(null));
    expect(m.get().items).toHaveLength(3);

    const viewer = await mountHook(() => useCatalog(), memory({ userId: "u_viewer" }), "viewer");
    expect(viewer.get().canRead).toBe(false);
    expect(viewer.get().error?.code).toBe("FORBIDDEN");
    viewer.rendered.unmount();
  });

  test("a long list grows by a page up to 96 rows", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      name: `Услуга ${i}`,
      active: true,
      sort_order: i,
    }));
    const ds = createMemoryDataSource(app, { service: many });
    const m = await mountHook(() => useCatalog("service", { pageSize: 12 }), ds);
    r = m.rendered;
    expect(m.get()).toMatchObject({ pageSize: 12, total: 30, hasMore: true });
    expect(m.get().items).toHaveLength(12);
    await run(() => m.get().more());
    await run(() => m.get().more());
    expect(m.get()).toMatchObject({ pageSize: 36, hasMore: false });
    expect(m.get().items).toHaveLength(30);
  });

  test("useContent lists what the role reads", async () => {
    const m = await mountHook(
      () => useContent("service_category", { sort: { field: "name", dir: "asc" } }),
      memory(),
    );
    r = m.rendered;
    expect(m.get().items.map((x) => x.name)).toEqual(["Волосы", "Ногти"]);
    expect(m.get().canRead).toBe(true);
  });
});

describe("useBooking", () => {
  const booking = (ds: MemoryDataSource, extra: Partial<Parameters<typeof useBooking>[0]> = {}) =>
    mountHook(
      () => useBooking({ schedule: SCHEDULE, durationField: "duration_min", now: () => NOW, ...extra }),
      ds,
    );

  test("service → day → free time from busySlots → contacts with consent → booking", async () => {
    const ds = memory();
    const m = await booking(ds);
    r = m.rendered;
    expect(m.get().allowed).toBe(true);
    expect(m.get().services.items.map((x) => x.name)).toEqual(["Маникюр", "Окрашивание", "Стрижка"]);
    expect(m.get().days.slice(0, 6)).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-19",
    ]);
    expect(m.get().ready).toBe(false);
    expect(m.get().slots).toEqual([]);

    // One-step service: 09:00…17:00 without the busy 10:00.
    await run(() => m.get().selectService("s_color"));
    expect(m.get().ready).toBe(true);
    expect(m.get().slots.map((x) => x.start.slice(11, 16))).toEqual([
      "09:00",
      "11:00",
      "12:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
      "17:00",
    ]);
    // 90 minutes: no 09:00 (overlaps 10:00), no 17:00 (past the end of the day).
    await run(() => m.get().selectService("s_cut"));
    expect(m.get().slots.map((x) => x.start.slice(11, 16))).toEqual([
      "11:00",
      "12:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
    ]);

    expect(m.get().form.fields.map((f) => f.name)).toEqual(["name", "phone", "consent_messages"]);
    const slot = m.get().slots[0];
    await run(() => m.get().selectSlot(slot ?? null));
    await run(() => {
      m.get().form.setValue("name", "Анна");
      m.get().form.setValue("phone", "+79990001122");
    });
    await run(() => m.get().form.submit());
    expect(m.get().form.consent.error).toBe("Нужно согласие на обработку персональных данных");
    expect(ds.calls.filter((c) => c.op === "create")).toEqual([]);

    await run(() => m.get().form.consent.set(true));
    await run(() => m.get().form.submit());
    expect(ds.calls.filter((c) => c.op === "create").map((c) => c.args)).toEqual([
      [
        {
          service: "s_cut",
          starts_at: "2026-10-12T11:00:00.000Z",
          ends_at: "2026-10-12T12:30:00.000Z",
          name: "Анна",
          phone: "+79990001122",
          consent_messages: false,
        },
        { consent: true },
      ],
    ]);
    expect(m.get().booked).toEqual(slot);
    await run(() => m.get().again());
    expect(m.get()).toMatchObject({ booked: null, slot: null });
  });

  test("a time taken meanwhile: the choice is cleared with a notice, no form error", async () => {
    const ds = memory();
    const m = await booking(ds);
    r = m.rendered;
    await run(() => m.get().selectService("s_color"));
    await run(() => m.get().selectSlot(m.get().slots[0] ?? null));
    await run(() => {
      m.get().form.setValue("name", "Анна");
      m.get().form.setValue("phone", "+79990001122");
      m.get().form.consent.set(true);
    });
    ds.failNext("create", wzError("CONFLICT"));
    await run(() => m.get().form.submit());
    expect(m.get().slot).toBeNull();
    expect(m.get().notice).toBe("Это время только что заняли — выберите другое");
    expect(m.get().form.formError).toBeUndefined();
    expect(m.get().booked).toBeNull();
    // Without a chosen time nothing is written.
    await run(() => m.get().form.submit());
    expect(ds.calls.filter((c) => c.op === "create")).toHaveLength(1);
  });

  test("with packages: no valid package — no booking, a Russian reason", async () => {
    const ds = memory({ packageOk: false });
    const m = await booking(ds, { packageCheckFn: "packageCheck" });
    r = m.rendered;
    await run(() => m.get().selectService("s_color"));
    await run(() => m.get().selectSlot(m.get().slots[0] ?? null));
    await run(() => {
      m.get().form.setValue("name", "Анна");
      m.get().form.setValue("phone", "+79990001122");
      m.get().form.consent.set(true);
    });
    await run(() => m.get().form.submit());
    expect(ds.calls.find((c) => c.op === "call")?.args[0]).toEqual({
      phone: "+79990001122",
      starts_at: "2026-10-12T09:00:00.000Z",
    });
    expect(ds.calls.filter((c) => c.op === "create")).toEqual([]);
    expect(m.get().form.formError).toMatch(/нет действующего абонемента/);
  });
});

describe("@wizard/ui-kit/v3/headless", () => {
  test("the subpath of package.json exports the hooks", () => {
    expect(subpath.useLeadForm).toBe(useLeadForm);
    expect(subpath.useBooking).toBe(useBooking);
    expect(subpath.useCatalog).toBe(useCatalog);
    expect(subpath.useContent).toBe(useContent);
  });
});

describe("schedule of «Запись по слотам»", () => {
  test("time zone, working days, break and seats", () => {
    expect(new Date(zonedAt("Europe/Moscow", "2026-10-12", 540)).toISOString()).toBe(
      "2026-10-12T06:00:00.000Z",
    );
    expect(dayKey("Europe/Moscow", Date.parse("2026-10-11T21:30:00Z"))).toBe("2026-10-12");
    const s: ScheduleSpec = { ...SCHEDULE, breakStart: 780, breakEnd: 840, capacity: 2, days: [1, 6] };
    expect(workdays(s, "2026-10-12", 3)).toEqual(["2026-10-12", "2026-10-17", "2026-10-19"]);
    const free = freeSlots(s, "2026-10-12", null, BUSY, NOW);
    expect(free.find((x) => x.start.startsWith("2026-10-12T10:00"))?.seat).toBe(2);
    expect(free.some((x) => x.start.startsWith("2026-10-12T13:00"))).toBe(false);
    expect(freeSlots(s, "2026-10-13", null, [], NOW)).toEqual([]);
  });
});
