// B2-16: «Сотрудники и роли», «Кабинет посетителя», «Напоминания и уведомления». Acceptance: the visitor logs in by
// code and sees only his rows, a staff member sees only his sections (G1 row isolation and permission probes); the
// reminder N hours before the visit goes by e-mail and to Telegram without personal data at the right time (G1
// scenario with advanceTime). The booking is the B2-14 stand-in with the contract notify relies on.
import type { AppSpec, SystemPlan } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type CompileSuccess, compilePlan, NOTIFY_BOOKING, SCENARIO_LEAD } from "../src/index.js";
import { bookingStandIn, testRegistry } from "./fixtures.js";
import { blockers, type G1Runtime, startG1Runtime, statusOf } from "./g1-runtime.js";

const registry = testRegistry([{ manifest: bookingStandIn }]);

const design: SystemPlan["design"] = {
  direction: { mood: ["спокойствие"] },
  theme: "calm",
  accent: "#2A7F9E",
  fontPair: { heading: "Manrope", body: "Inter Tight" },
  photoStyle: "светлые фото",
};

function plan(goals: SystemPlan["goals"], modules: SystemPlan["modules"]): SystemPlan {
  return { version: 1, niche: "студия красоты", goals, modules, design, outOfScope: [], custom: [] };
}

/** Two staff roles with different sections, notifications by e-mail and Telegram to the owner and the staff. */
const teamPlan = () =>
  plan(
    [
      { id: "team_work", statement: "Администратор ведёт заявки, мастер — запись" },
      { id: "reduce_no_shows", statement: "Клиенты не забывают про визит" },
    ],
    [
      { id: "leads" },
      { id: "booking" },
      {
        id: "notify",
        params: {
          channels: ["email", "telegram"],
          notify_staff: true,
          reminder_hours: 24,
          second_reminder_hours: 2,
        },
      },
      {
        id: "staff",
        params: { roles: ["Администратор", "Мастер"], sections_1: ["leads"], sections_2: ["booking"] },
      },
    ],
  );

/** The visitor cabinet with «Мои записи» and «Мои заявки»; the lead form has no e-mail, the cabinet adds it. */
const visitorPlan = () =>
  plan(
    [{ id: "self_service", statement: "Клиент сам видит свои записи и заявки" }],
    [
      { id: "leads", params: { form_fields: ["name", "comment"], contact: "phone" } },
      { id: "booking" },
      { id: "notify" },
      { id: "visitor_cabinet", params: { show_leads: true } },
    ],
  );

function compiled(p: SystemPlan): CompileSuccess {
  const r = compilePlan(p, registry, { appName: "Студия" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}

const perm = (spec: AppSpec, role: string, entity: string) =>
  spec.permissions.find((p) => p.role === role && p.entity === entity);
const acId = (spec: AppSpec, prefix: string) =>
  spec.acceptance?.find((a) => a.text.startsWith(prefix))?.id ?? `нет AC «${prefix}»`;

describe("staff: roles with sections", () => {
  const r = compiled(teamPlan());

  test("roles staff and staff_2 from the plan's list, login by code, closed sign-up", () => {
    expect(r.spec.roles.map((x) => [x.name, x.label])).toEqual([
      ["guest", "Посетитель"],
      ["owner", "Владелец"],
      ["staff", "Администратор"],
      ["staff_2", "Мастер"],
    ]);
    const staff = r.spec.roles.find((x) => x.name === "staff");
    expect(staff).toEqual({
      name: "staff",
      label: "Администратор",
      access: "login",
      loginMethods: ["email_otp"],
    });
  });

  test("$staff of a section module expands only to the roles with that section", () => {
    expect(perm(r.spec, "staff", "lead")?.ops).toEqual(["read", "update"]);
    expect(perm(r.spec, "staff_2", "lead")).toBeUndefined();
    expect(perm(r.spec, "staff_2", "booking")?.ops).toEqual(["read", "update"]);
    expect(perm(r.spec, "staff", "booking")).toBeUndefined();
    const pages = Object.fromEntries((r.spec.pages ?? []).map((p) => [p.route, p.roles]));
    expect(pages["/cabinet-staff"]).toEqual(["staff"]);
    expect(pages["/cabinet-staff-2"]).toEqual(["staff_2"]);
    expect(pages["/cabinet/staff"]).toEqual(["owner"]);
    expect(r.files["ui/pages/CabinetStaff.tsx"]).toContain('entity={"lead"}');
    expect(r.files["ui/pages/CabinetStaff.tsx"]).not.toContain('entity={"booking"}');
    expect(r.files["ui/pages/CabinetStaff2.tsx"]).toContain('entity={"booking"}');
    expect(r.files["ui/pages/CabinetStaff2.tsx"]).not.toContain('entity={"lead"}');
  });

  test("permission checks for G1: each role sees its section and not the other one", () => {
    const checks = (r.spec.acceptance ?? [])
      .filter((a) => a.check.type === "permission" && a.check.role?.startsWith("staff"))
      .map((a) => [a.check.role, a.check.entity, a.check.expect]);
    expect(checks).toEqual([
      ["staff", "lead", "allow"],
      ["staff", "booking", "deny"],
      ["staff_2", "lead", "deny"],
      ["staff_2", "booking", "allow"],
    ]);
  });

  test("the owner's page lists the roles, their sections and the invitation", () => {
    const page = r.files["ui/pages/StaffStaff.tsx"] ?? "";
    expect(page).toContain('{"title":"Администратор","text":"Видит: Заявки. Вход: код на почту."}');
    expect(page).toContain('{"title":"Мастер","text":"Видит: Запись. Вход: код на почту."}');
    expect(page).toContain('href="/_wizard/team"');
  });

  test("login through Telegram keeps the code on e-mail; the notification bot does not log in", () => {
    const p = teamPlan();
    const staff = p.modules.find((m) => m.id === "staff");
    if (staff?.params) staff.params.login = "telegram";
    const t = compiled(p);
    expect(t.spec.roles.find((x) => x.name === "staff")?.loginMethods).toEqual(["telegram", "email_otp"]);
    expect(t.spec.integrations?.find((i) => i.name === "tg")?.config).toEqual({ loginEnabled: false });
    expect(t.warnings).toContain(
      "Вход сотрудников через Telegram заработает после подключения своего бота; до этого сотрудники входят по коду на почту",
    );
  });
});

describe("notify: workflows by the capability formats", () => {
  const r = compiled(teamPlan());
  const wf = (name: string) => r.spec.workflows?.find((w) => w.name === name);

  test("a new lead: the owner and the staff with the section, e-mail and Telegram, a link to their cabinet", () => {
    expect(
      wf("lead_notify")?.steps.map((s) => [s.params?.integration, s.params?.to, s.params?.link]),
    ).toEqual([
      ["mail", "$owner", "/cabinet"],
      ["tg", "$owner", "/cabinet"],
      ["mail", "$role:staff", "/cabinet-staff"],
      ["tg", "$role:staff", "/cabinet-staff"],
    ]);
  });

  test("booking: confirmation to the visitor with consent and a cancel link, reminders 24 h and 2 h", () => {
    const visitor = wf("booking_notify")?.steps.find((s) => s.params?.to === "$record.email");
    expect(visitor?.params).toEqual({
      integration: "mail",
      to: "$record.email",
      consentField: NOTIFY_BOOKING.consent,
      template: "visitor_booked",
      cancel: { set: { status: "cancelled" } },
    });
    expect(wf("booking_reminder")?.trigger).toEqual({
      type: "schedule",
      entity: "booking",
      relative: { field: "starts_at", offsetMinutes: -1440 },
    });
    expect(wf("booking_reminder")?.steps.map((s) => [s.params?.integration, s.params?.to])).toEqual([
      ["mail", "$record.email"],
      ["tg", "$owner"],
      ["tg", "$role:staff_2"],
    ]);
    expect(wf("booking_reminder_2")?.trigger.relative).toEqual({ field: "starts_at", offsetMinutes: -120 });
    expect(wf("booking_reminder_2")?.steps.map((s) => s.params?.integration)).toEqual(["mail"]);
    const booking = r.spec.entities.find((e) => e.name === "booking");
    expect(booking?.fields.find((f) => f.name === NOTIFY_BOOKING.consent)).toEqual({
      name: "consent_messages",
      label: "Согласен получать письма о записи",
      type: "bool",
      default: false,
    });
  });

  test("Telegram texts carry no fields with personal data; e-mail subjects neither", () => {
    const tg = (r.spec.workflows ?? []).flatMap((w) =>
      w.steps.filter((s) => s.params?.integration === "tg").map((s) => String(s.params?.text)),
    );
    expect(tg.length).toBeGreaterThan(0);
    for (const t of tg)
      expect(t.match(/\{\{(\w+)\}\}/g) ?? []).toSatisfy((ph: string[]) =>
        ph.every((x) => x === "{{link}}" || x === "{{starts_at}}"),
      );
    const templates = r.spec.integrations?.find((i) => i.name === "mail")?.config?.templates as Record<
      string,
      { subject: string }
    >;
    for (const t of Object.values(templates)) expect(t.subject).not.toContain("{{");
  });

  test("the owner's page «Уведомления» lists what goes to whom", () => {
    const page = r.files["ui/pages/NotifySettings.tsx"] ?? "";
    expect(page).toContain("О новой заявке");
    expect(page).toContain("владельцу, сотрудникам роли «Администратор» — письмом и в Telegram");
    expect(page).toContain("Напоминание за 24 ч");
    expect((r.spec.pages ?? []).find((p) => p.route === "/cabinet/notifications")?.roles).toEqual(["owner"]);
  });
});

describe("visitor cabinet", () => {
  const r = compiled(visitorPlan());

  test("the visitor role: code on e-mail, open sign-up", () => {
    expect(r.spec.roles.find((x) => x.name === "visitor")).toEqual({
      name: "visitor",
      label: "Клиент",
      access: "login",
      loginMethods: ["email_otp"],
      selfSignup: true,
    });
  });

  test("own rows by the login contact: the lead gets the e-mail field, rowFilter by $user.email", () => {
    const lead = r.spec.entities.find((e) => e.name === "lead");
    expect(lead?.fields.map((f) => f.name)).toEqual(["name", "phone", "comment", "email", "status"]);
    expect(perm(r.spec, "visitor", "lead")).toEqual({
      role: "visitor",
      entity: "lead",
      ops: ["read"],
      rowFilter: { email: "$user.email" },
    });
    expect(perm(r.spec, "visitor", "booking")?.rowFilter).toEqual({ email: "$user.email" });
  });

  test("/me: «Мои записи» and «Мои заявки», cancelling only one's own booking", () => {
    expect((r.spec.pages ?? []).find((p) => p.route === "/me")).toEqual({
      route: "/me",
      title: "Личный кабинет",
      file: "ui/pages/VisitorCabinetMe.tsx",
      roles: ["visitor"],
      nav: true,
    });
    const me = r.files["ui/pages/VisitorCabinetMe.tsx"] ?? "";
    expect(me).toContain('label: "Мои записи"');
    expect(me).toContain('label: "Мои заявки"');
    expect(me).toContain('patch: { status: "cancelled" }');
    expect(me.match(/kind: "update"/g)).toHaveLength(1);
  });

  test("login by phone filters by $user.phone", () => {
    const p = visitorPlan();
    const vc = p.modules.find((m) => m.id === "visitor_cabinet");
    if (vc) vc.params = { login: "phone_otp", show_leads: true, show_bookings: false };
    p.modules = p.modules.filter((m) => m.id !== "booking");
    const t = compiled(p);
    expect(perm(t.spec, "visitor", "lead")?.rowFilter).toEqual({ phone: "$user.phone" });
    expect(t.spec.entities.find((e) => e.name === "lead")?.fields.map((f) => f.name)).toEqual([
      "name",
      "phone",
      "comment",
      "status",
    ]);
  });
});

describe("G1 without models", () => {
  let g: G1Runtime;
  beforeAll(async () => {
    g = await startG1Runtime("b216");
  });
  afterAll(async () => {
    await g?.close();
  });

  test("staff sections, the lead notification without personal data in Telegram, the reminder in time", async () => {
    const r = compiled(teamPlan());
    const { g0, g1 } = await g.gates(r.spec, r.files);
    expect(blockers(g0), "G0").toEqual([]);
    expect(blockers(g1), "G1").toEqual([]);
    // A staff member does not see another role's section (permission probes of the acceptance).
    expect(statusOf(g1, `SC-${acId(r.spec, "Роль «Мастер» не видит раздел «Заявки»")}`)).toBe("pass");
    expect(statusOf(g1, `SC-${acId(r.spec, "Роль «Администратор» не видит раздел «Запись»")}`)).toBe("pass");
    expect(statusOf(g1, `SC-${acId(r.spec, "Роль «Мастер» видит раздел «Запись»")}`)).toBe("pass");
    // The owner learns about a lead; the reminder 24 h before goes not earlier and not later (advanceTime).
    expect(statusOf(g1, `SC-${acId(r.spec, "Владелец узнаёт о новой заявке")}`)).toBe("pass");
    expect(statusOf(g1, `SC-${acId(r.spec, "Напоминание за 24 ч уходит в нужное время")}`)).toBe("pass");
    // Telegram messages rendered by the runtime carry neither the visitor's name nor the phone.
    const tg = g.rt.outbox().filter((m) => m.integration === "tg");
    expect(tg.length).toBeGreaterThan(0);
    const texts = JSON.stringify(tg.map((m) => m.payload));
    for (const v of [SCENARIO_LEAD.name, SCENARIO_LEAD.phone, "Анна", "visitor.test@example.ru"])
      expect(texts).not.toContain(v);
    expect(texts).toContain("Напоминание: запись на");
  }, 180_000);

  test("the visitor sees only his own leads and bookings (G1 row isolation)", async () => {
    const r = compiled(visitorPlan());
    const { g0, g1 } = await g.gates(r.spec, r.files);
    expect(blockers(g0), "G0").toEqual([]);
    expect(blockers(g1), "G1").toEqual([]);
    expect(statusOf(g1, "PC-visitor-lead-row")).toBe("pass");
    expect(statusOf(g1, "PC-visitor-booking-row")).toBe("pass");
    expect(statusOf(g1, "G1-RENDER-01")).toBe("pass");
  }, 180_000);

  test("confirmation by staff: «received», then «confirmed» mail; the reminder still in time; no cancel link", async () => {
    const p = teamPlan();
    const booking = p.modules.find((m) => m.id === "booking");
    if (booking) booking.params = { confirm: "manual", cancel_by_link: false };
    const r = compiled(p);
    const wf = (name: string) => r.spec.workflows?.find((w) => w.name === name);
    expect(wf("booking_confirmed")?.trigger).toEqual({
      type: "on_status",
      entity: "booking",
      field: "status",
      equals: "confirmed",
    });
    const visitor = wf("booking_notify")?.steps.find((s) => s.params?.to === "$record.email");
    expect(visitor?.params?.template).toBe("visitor_received");
    expect(visitor?.params?.cancel).toBeUndefined();
    const templates = JSON.stringify(r.spec.integrations?.find((i) => i.name === "mail")?.config);
    expect(templates).not.toContain("cancel_link");
    const { g0, g1 } = await g.gates(r.spec, r.files);
    expect(blockers(g0), "G0").toEqual([]);
    expect(blockers(g1), "G1").toEqual([]);
    expect(statusOf(g1, `SC-${acId(r.spec, "Напоминание за 24 ч уходит в нужное время")}`)).toBe("pass");
  }, 180_000);
});
