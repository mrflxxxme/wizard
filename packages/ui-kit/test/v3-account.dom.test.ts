// @vitest-environment happy-dom
// V3-18 (builder-v3.md §3 C3, C4): the v3 features the goal scenarios found missing, over the memory DataSource with
// the runtime's permission semantics — the owner's photos of «Фото сайта» (useSitePhotos: an uploaded place wins over
// the stock picture), the client cabinet (useMyRecords: only the visitor's own rows by the rowFilter of his login
// contact, as texts, «Отменить»; the account patterns: sign-in for a guest, rows and sections for the client), and the
// reschedule by the e-mail's link (useBooking with ?reschedule=: the service fixed, the chosen time to the runtime's
// confirmation; the booking patterns show «Перенос записи» and booking-move instead of the contacts).
import type { AppSpec } from "@wizard/appspec";
import { act, createElement as h, type ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { createMemoryDataSource, type MemoryDataSource } from "../src/testing/index.js";
import {
  bookingAddress,
  RESCHEDULE_PATH,
  type ScheduleSpec,
  useBooking,
  useClientSession,
  useMyRecords,
  useSitePhotos,
} from "../src/v3/headless/index.js";
import AccountList from "../src/v3/patterns/account/list.js";
import AccountTabs from "../src/v3/patterns/account/tabs.js";
import FormBookingCompact from "../src/v3/patterns/form/booking-compact.js";
import FormBookingGrid from "../src/v3/patterns/form/booking-grid.js";
import FormBookingSteps from "../src/v3/patterns/form/booking-steps.js";
import FormBookingStrip from "../src/v3/patterns/form/booking-strip.js";
import { click, type Rendered, render } from "./helpers/dom.js";

const STATUS = [
  { value: "new", label: "Новая" },
  { value: "confirmed", label: "Подтверждена" },
  { value: "cancelled", label: "Отменена" },
];

const app: AppSpec = {
  specVersion: "1",
  app: { name: "Студия", locale: "ru" },
  entities: [
    {
      name: "site_photo",
      label: "Фото сайта",
      fields: [
        { name: "slot", label: "Место", type: "string", required: true },
        { name: "image", label: "Фото", type: "image" },
        { name: "alt", label: "Подпись", type: "string" },
      ],
    },
    {
      name: "service",
      label: "Услуга",
      fields: [
        { name: "name", label: "Название", type: "string", required: true },
        { name: "duration_min", label: "Длительность", type: "int" },
        { name: "active", label: "Показывать", type: "bool", required: true, default: true },
      ],
    },
    {
      name: "booking",
      label: "Запись",
      fields: [
        { name: "starts_at", label: "Начало", type: "datetime", required: true },
        { name: "ends_at", label: "Конец", type: "datetime", required: true },
        { name: "service", label: "Услуга", type: "ref", ref: { entity: "service" }, required: true },
        { name: "status", label: "Статус", type: "enum", required: true, default: "new", enum: STATUS },
        { name: "name", label: "Имя", type: "string", required: true, pii: "basic", piiKind: "fio" },
        { name: "email", label: "Почта", type: "email", pii: "basic", piiKind: "email" },
        { name: "photo", label: "Фото", type: "image" },
      ],
      retention: { deleteAfterDays: 365 },
    },
    {
      name: "lead",
      label: "Заявка",
      fields: [
        { name: "name", label: "Имя", type: "string", required: true, pii: "basic", piiKind: "fio" },
        { name: "email", label: "Почта", type: "email", pii: "basic", piiKind: "email" },
        { name: "status", label: "Статус", type: "enum", required: true, default: "new", enum: STATUS },
      ],
      retention: { deleteAfterDays: 365 },
    },
  ],
  roles: [
    { name: "guest", label: "Посетитель", access: "public" },
    { name: "visitor", label: "Клиент", access: "login", loginMethods: ["email_otp"], selfSignup: true },
  ],
  permissions: [
    { role: "guest", entity: "site_photo", ops: ["read"] },
    { role: "guest", entity: "service", ops: ["read"], rowFilter: { active: true } },
    { role: "guest", entity: "booking", ops: ["create"], readonlyFields: ["status"] },
    { role: "visitor", entity: "service", ops: ["read"], rowFilter: { active: true } },
    {
      role: "visitor",
      entity: "booking",
      ops: ["read", "update"],
      rowFilter: { email: "$user.email" },
      readonlyFields: ["starts_at", "ends_at", "service", "name", "email"],
    },
    { role: "visitor", entity: "lead", ops: ["read"], rowFilter: { email: "$user.email" } },
  ],
  compliance: { consentTemplateId: "default", policyPage: "/privacy" },
};

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

const MINE = "anna@example.test";
const FIXTURES = {
  site_photo: [{ id: "p1", slot: "top", image: "file_top", alt: "Зал студии утром" }],
  service: [
    { id: "s_yoga", name: "Хатха-йога", duration_min: 60, active: true },
    { id: "s_stretch", name: "Растяжка", duration_min: 60, active: true },
  ],
  booking: [
    {
      id: "b_mine",
      starts_at: "2026-10-14T09:00:00.000Z",
      ends_at: "2026-10-14T10:00:00.000Z",
      service: "s_yoga",
      status: "confirmed",
      name: "Анна",
      email: MINE,
      created_at: "2026-10-01T09:00:00.000Z",
    },
    {
      id: "b_other",
      starts_at: "2026-10-15T09:00:00.000Z",
      ends_at: "2026-10-15T10:00:00.000Z",
      service: "s_stretch",
      status: "confirmed",
      name: "Борис",
      email: "boris@example.test",
      created_at: "2026-10-02T09:00:00.000Z",
    },
  ],
  lead: [
    { id: "l_mine", name: "Анна", email: MINE, status: "new", created_at: "2026-10-03T09:00:00.000Z" },
    { id: "l_other", name: "Борис", email: "boris@example.test", status: "new" },
  ],
};

function memory(userId?: string): MemoryDataSource {
  return createMemoryDataSource(app, structuredClone(FIXTURES), {
    users: [{ id: "u_anna", role: "visitor", displayName: "Анна", isAdmin: false, email: MINE }],
    ...(userId ? { userId } : {}),
    functions: { busySlots: () => [] },
  });
}

let r: Rendered | undefined;
afterEach(() => {
  r?.unmount();
  r = undefined;
  window.history.replaceState(null, "", "/");
});

const run = (fn: () => unknown) => act(async () => void (await fn()));

async function mountHook<T>(hook: () => T, ds: MemoryDataSource, role: string | null = null) {
  let current: T | undefined;
  function Probe(): ReactNode {
    current = hook();
    return null;
  }
  r = await render(h(Probe), { app, role, ds });
  await act(async () => {});
  return () => current as T;
}

describe("useSitePhotos: the owner's photo of a place wins over the stock picture", () => {
  test("one, list and items; a place without the owner's photo keeps the stock one (or nothing)", async () => {
    const ds = memory();
    const get = await mountHook(() => useSitePhotos(), ds);
    const own = { src: ds.files.imageSrc("file_top", 1600), alt: "Зал студии утром" };
    expect(own.src).toContain("file_top");
    expect(get().one("top", undefined)).toEqual(own);
    const stock = { src: "/_wizard/photos/a/1600", alt: "Коврики в зале" };
    expect(get().one("top", stock)).toEqual(own);
    expect(get().one("about", stock)).toBe(stock);
    expect(get().one("about", undefined)).toBeUndefined();
    const listed = get().list(["gallery", "top"], [stock, { ...stock, caption: "Зал" }]);
    expect(listed).toEqual([stock, { ...own, caption: "Зал" }]);
    expect(get().items([{ title: "Йога" }, { title: "Растяжка" }], ["top"])).toEqual([
      { title: "Йога", image: own },
      { title: "Растяжка" },
    ]);
  });
});

describe("useMyRecords: the client's own records", () => {
  test("only his rows by the rowFilter of his login contact, as texts; «Отменить» sets the cancelled status", async () => {
    const ds = memory("u_anna");
    const get = await mountHook(
      () =>
        useMyRecords("booking", {
          fields: ["starts_at", "service", "status", "name", "photo"],
          cancel: { field: "status", value: "cancelled" },
        }),
      ds,
      "visitor",
    );
    expect(get().canRead).toBe(true);
    expect(get().items.map((x) => x.id)).toEqual(["b_mine"]);
    const [row] = get().items;
    // Images never become text; a reference shows the caption of the referenced record.
    expect(row?.cells.map((c) => c.name)).toEqual(["starts_at", "service", "status", "name"]);
    expect(row?.cells.find((c) => c.name === "service")?.text).toBe("Хатха-йога");
    expect(row?.cells.find((c) => c.name === "starts_at")?.text).toMatch(/14\.10\.2026/);
    expect(row?.status).toBe("Подтверждена");
    expect(row?.canCancel).toBe(true);
    await run(() => get().cancel("b_mine"));
    expect(ds.rows("booking").find((b) => b.id === "b_mine")?.status).toBe("cancelled");
    expect(get().items[0]).toMatchObject({ status: "Отменена", canCancel: false });
    // Someone else's record is not the client's to cancel.
    await run(() => get().cancel("b_other"));
    expect(ds.rows("booking").find((b) => b.id === "b_other")?.status).toBe("confirmed");
  });

  test("a guest reads nothing: canRead false, the session says he is not signed in", async () => {
    const ds = memory();
    const get = await mountHook(() => ({ m: useMyRecords("booking"), s: useClientSession() }), ds);
    expect(get().m.canRead).toBe(false);
    expect(get().m.items).toEqual([]);
    expect(get().s).toMatchObject({ signedIn: false, name: null });
  });
});

const ACCOUNT = {
  title: "Личный кабинет",
  level: 1 as const,
  sections: [
    {
      id: "booking",
      entity: "booking",
      label: "Мои записи",
      fields: ["starts_at", "service", "status", "name"],
      cancel: { field: "status", value: "cancelled", label: "Отменить запись" },
      empty: "Записей пока нет",
    },
    { id: "lead", entity: "lead", label: "Мои заявки", fields: ["name", "status"], empty: "Заявок пока нет" },
  ],
  signIn: { label: "Войти по коду", href: "/login?role=visitor&next=%2Fme" },
  action: { label: "Записаться", href: "/booking" },
};

describe("the account patterns: the client cabinet /me on the design system", () => {
  test("a guest gets the sign-in by a code, no rows", async () => {
    for (const Pattern of [AccountTabs, AccountList]) {
      r = await render(h(Pattern, ACCOUNT), { app, role: null, ds: memory() });
      await act(async () => {});
      const link = r.q<HTMLAnchorElement>('a[href^="/login"]');
      expect(link.textContent).toBe("Войти по коду");
      expect(r.$$("wz-datatable-row")).toEqual([]);
      expect(r.q("h1").textContent).toBe("Личный кабинет");
      r.unmount();
      r = undefined;
    }
  });

  test("tabs: «Мои записи» first with the client's row, «Мои заявки» on its tab with the status", async () => {
    r = await render(h(AccountTabs, ACCOUNT), { app, role: "visitor", ds: memory("u_anna") });
    await act(async () => {});
    expect(r.$$("wz-datatable-row").map((x) => x.textContent)).toEqual([
      expect.stringContaining("Хатха-йога"),
    ]);
    expect(r.container.textContent).not.toContain("Борис");
    await click(r.$("wz-cabinet-tab-lead"));
    const rows = r.$$("wz-datatable-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Анна");
    expect(rows[0]?.textContent).toContain("Новая");
    expect(r.$("wz-cabinet-tab-lead").getAttribute("aria-selected")).toBe("true");
  });

  test("list: every section under its heading; «Отменить запись» asks, then cancels", async () => {
    const ds = memory("u_anna");
    r = await render(h(AccountList, ACCOUNT), { app, role: "visitor", ds });
    await act(async () => {});
    expect(r.$$("wz-datatable-row")).toHaveLength(2);
    const ask = [...r.container.querySelectorAll("button")].find((b) => b.textContent === "Отменить запись");
    await click(ask as HTMLButtonElement);
    expect(r.container.textContent).toContain("Отменить запись?");
    const yes = [...r.container.querySelectorAll("button")].find((b) => b.textContent === "Да, отменить");
    await click(yes as HTMLButtonElement);
    await act(async () => {});
    expect(ds.rows("booking").find((b) => b.id === "b_mine")?.status).toBe("cancelled");
    expect(r.container.textContent).toContain("Отменена");
  });
});

describe("the reschedule by the e-mail's link (?reschedule=, B2-14)", () => {
  test("bookingAddress and useBooking: the kept service is fixed, the chosen time goes to the runtime's link", async () => {
    expect(bookingAddress("?reschedule=tok.1&service=s_yoga")).toEqual({
      reschedule: "tok.1",
      service: "s_yoga",
      specialist: null,
    });
    const ds = memory();
    const now = Date.parse("2026-10-12T06:00:00Z");
    const get = await mountHook(
      () =>
        useBooking({
          schedule: SCHEDULE,
          durationField: "duration_min",
          now: () => now,
          service: "s_yoga",
          reschedule: "tok.1",
        }),
      ds,
    );
    expect(get().fixed).toBe(true);
    expect(get().reschedule).toMatchObject({ token: "tok.1", title: "Перенос записи" });
    await run(() => get().selectService("s_stretch"));
    expect(get().service?.id).toBe("s_yoga");
    await run(() => get().selectDay("2026-10-13"));
    const slot = get().slots[0];
    expect(slot).toBeDefined();
    if (!slot) return;
    const href = get().reschedule?.href(slot) ?? "";
    expect(href.startsWith(`${RESCHEDULE_PATH}tok.1?`)).toBe(true);
    expect(Object.fromEntries(new URL(href, "http://x").searchParams)).toEqual({
      starts_at: slot.start,
      ends_at: slot.end,
    });
  });

  test("every booking pattern: «Перенос записи», the service as text, booking-move with the link instead of the contacts", async () => {
    const binding = { schedule: SCHEDULE, serviceEntity: "service", durationField: "duration_min" };
    const props = {
      entity: "booking",
      booking: binding,
      title: "Запись на занятие",
      submit: "Записаться",
      sent: { title: "Вы записаны" },
    };
    for (const Pattern of [FormBookingCompact, FormBookingGrid, FormBookingSteps, FormBookingStrip]) {
      window.history.replaceState(null, "", "/booking?reschedule=tok.2&service=s_yoga");
      r = await render(h(Pattern, props), { app, role: null, ds: memory() });
      await act(async () => {});
      const name = Pattern.name;
      expect(r.$("booking-page").textContent, name).toContain("Перенос записи");
      expect(r.$("booking-service").textContent, name).toContain("Хатха-йога");
      expect(r.$("booking-service").querySelectorAll("select, input, button"), name).toHaveLength(0);
      // To the times (the stepper: «Далее»), a free time, then the move (the stepper: «Далее» once more).
      if (r.$$("booking-next").length) await click(r.$("booking-next"));
      const day = r.$("booking-day");
      const select = day.querySelector("select");
      if (select) {
        await act(async () => {
          select.value = select.options[3]?.value ?? select.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
      } else await click(day.querySelectorAll("button")[3] as HTMLButtonElement);
      await act(async () => {});
      await click(r.q('[data-testid="booking-slots"] button'));
      if (r.$$("booking-next").length) await click(r.$("booking-next"));
      const move = r.q<HTMLAnchorElement>('[data-testid="booking-move"] a');
      expect(move.textContent, name).toBe("Перенести на это время");
      expect(move.getAttribute("href"), name).toMatch(
        /^\/_wizard\/hooks\/message\/reschedule\/tok\.2\?starts_at=/,
      );
      expect(r.$$("booking-form"), name).toEqual([]);
      r.unmount();
      r = undefined;
    }
  });
});
