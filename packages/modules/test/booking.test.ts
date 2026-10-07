// B2-14 «Запись по слотам»: the schedule helpers compiled into pages and functions, the compiled spec by parameters,
// and the goal scenarios in a real runtime without models or a browser (the browser run of the same scenarios is
// B2-24): a visitor books, a second one on the same time gets CONFLICT, the e-mail carries one-time cancel and
// reschedule links of the runtime, cancel frees the time at once, reschedule moves the booking once, a late link is
// closed, the goal-panel function counts the schedule load.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppSpec, dropSystemRoleDDL, quoteIdent, type SystemPlan } from "@wizard/appspec";
import { buildSystem, writeArtifact } from "@wizard/build";
import { testPlatform } from "@wizard/connectors/testing";
import {
  closeExecutors,
  complianceInfo,
  createRuntimeApp,
  MemoryRegistry,
  migrateSystem,
  type RegistryEntry,
  type RuntimeApp,
  SYSTEM_SUBJECT,
  schemaName,
} from "@wizard/runtime";
import postgres from "postgres";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type CompileSuccess,
  compilePlan,
  linkRules,
  matrixPlan,
  type ScheduleSpec,
  scheduleOf,
  scheduleSource,
  scheduleWarnings,
} from "../src/index.js";
import { testRegistry } from "./fixtures.js";
import { blockers, type G1Runtime, startG1Runtime, statusOf } from "./g1-runtime.js";

const registry = testRegistry();

interface Lib {
  SCHEDULE: ScheduleSpec;
  zonedAt(day: string, minutes: number): number;
  dayKey(t: number): string;
  addDays(day: string, n: number): string;
  weekdayOf(day: string): number;
  workdays(from: string, count: number): string[];
  daySlots(length: number): number[];
  slotsPerDay(): number;
  freeSlots(
    day: string,
    minutes: number | null,
    busy: { starts_at: string; ends_at: string | null; seat: number | null }[],
    now: number,
  ): { start: string; end: string; seat: number }[];
}

/** The generated helpers as they run in pages and functions (TypeScript → CommonJS, evaluated here). */
function lib(s: ScheduleSpec): Lib {
  const src = `${scheduleSource(s)}\nexport { SCHEDULE, zonedAt, dayKey, addDays, weekdayOf, workdays, daySlots, slotsPerDay, freeSlots };`;
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports: Record<string, unknown> = {};
  new Function("exports", out.outputText)(exports);
  return exports as unknown as Lib;
}

function compiled(plan: unknown): CompileSuccess {
  const r = compilePlan(plan, registry, { appName: "Улыбка" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}

const ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function bookingPlan(params: Record<string, unknown> = {}): SystemPlan {
  const plan = matrixPlan(registry, "booking", {
    name: "e2e",
    params: { workdays: ALL_DAYS, ...params },
    withModules: ["catalog", "notify"],
  });
  return { ...plan, niche: "стоматологическая клиника" };
}

describe("schedule helpers", () => {
  const base = scheduleOf({
    slot_minutes: 30,
    day_start: "09:00",
    day_end: "13:00",
    break_start: "11:00",
    break_end: "12:00",
    workdays: ["mon", "tue", "wed", "thu", "fri"],
  });
  const L = lib(base);

  test("wall-clock minutes in Europe/Moscow → UTC instants and back", () => {
    expect(new Date(L.zonedAt("2026-10-12", 9 * 60)).toISOString()).toBe("2026-10-12T06:00:00.000Z");
    expect(L.dayKey(Date.parse("2026-10-11T22:30:00Z"))).toBe("2026-10-12");
    expect(L.weekdayOf("2026-10-12")).toBe(1);
    expect(L.addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(L.workdays("2026-10-10", 3)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14"]);
  });

  test("slots skip the break and the end of the day; the length follows the service", () => {
    expect(L.daySlots(30).map((m) => `${m / 60}`)).toEqual(["9", "9.5", "10", "10.5", "12", "12.5"]);
    expect(L.daySlots(90)).toEqual([9 * 60, 9 * 60 + 30]);
    expect(L.slotsPerDay()).toBe(6);
    expect(L.freeSlots("2026-10-11", 30, [], 0)).toEqual([]); // Sunday
  });

  test("an overlapping booking holds the time; past slots are not offered", () => {
    const day = "2026-10-12";
    const at = (m: number) => new Date(L.zonedAt(day, m)).toISOString();
    const busy = [{ starts_at: at(9 * 60), ends_at: at(10 * 60), seat: 1 }];
    const free = L.freeSlots(day, 30, busy, 0).map((s) => s.start);
    expect(free).not.toContain(at(9 * 60));
    expect(free).not.toContain(at(9 * 60 + 30));
    expect(free).toContain(at(10 * 60));
    // A 60-minute service cannot start at 9:30 or 10:30 (overlaps the booking or the break).
    expect(L.freeSlots(day, 60, busy, 0).map((s) => s.start)).toEqual([at(10 * 60), at(12 * 60)]);
    expect(L.freeSlots(day, 30, [], L.zonedAt(day, 10 * 60)).map((s) => s.start)[0]).toBe(at(10 * 60 + 30));
    // A released seat (null) does not hold the time.
    expect(L.freeSlots(day, 30, [{ ...busy[0], seat: null } as never], 0)[0]?.start).toBe(at(9 * 60));
  });

  test("a group takes the first free seat until all are held", () => {
    const G = lib({ ...base, capacity: 2 });
    const day = "2026-10-12";
    const at = new Date(G.zonedAt(day, 9 * 60)).toISOString();
    const end = new Date(G.zonedAt(day, 9 * 60 + 30)).toISOString();
    expect(G.freeSlots(day, 30, [{ starts_at: at, ends_at: end, seat: 1 }], 0)[0]).toMatchObject({
      start: at,
      seat: 2,
    });
    const both = [1, 2].map((seat) => ({ starts_at: at, ends_at: end, seat }));
    expect(G.freeSlots(day, 30, both, 0)[0]?.start).not.toBe(at);
  });

  test("contradicting parameters are explained on the plan screen", () => {
    expect(scheduleWarnings({})).toEqual([]);
    expect(scheduleWarnings({ break_start: "13:00" })[0]).toMatch(/Перерыв задан не полностью/);
    expect(scheduleWarnings({ break_start: "14:00", break_end: "13:00" })[0]).toMatch(/внутри рабочего дня/);
    expect(scheduleWarnings({ day_start: "09:00", day_end: "09:30", slot_minutes: 60 })[0]).toMatch(
      /короче шага/,
    );
  });
});

describe("compiled spec by parameters", () => {
  const entity = (r: CompileSuccess, name: string) => r.spec.entities.find((e) => e.name === name);
  const perm = (r: CompileSuccess, role: string, e: string) =>
    r.spec.permissions.find((p) => p.role === role && p.entity === e);

  test("one place: unique (starts_at, seat), the visitor creates but does not read, seat read-only", () => {
    const r = compiled(bookingPlan());
    const b = entity(r, "booking");
    expect(b?.indexes).toContainEqual({ fields: ["starts_at", "seat"], unique: true });
    expect(b?.fields.find((f) => f.name === "status")?.default).toBe("confirmed");
    expect(b?.fields.find((f) => f.name === "email")?.required).toBe(true);
    expect(perm(r, "guest", "booking")).toEqual({
      role: "guest",
      entity: "booking",
      ops: ["create"],
      readonlyFields: ["status", "seat"],
    });
    expect(entity(r, "specialist")).toBeUndefined();
    expect(r.spec.functions?.map((f) => [f.name, f.roles, Boolean(f.systemDbReason)])).toEqual([
      ["busySlots", ["guest", "owner"], true],
      ["scheduleLoad", ["owner"], false],
    ]);
    expect(r.spec.pages?.map((p) => p.route)).toContain("/booking");
    expect(r.metrics.map((m) => m.id)).toEqual([
      "services_active",
      "bookings_count",
      "schedule_load",
      "no_show_share",
      "cancel_share",
    ]);
    expect(r.scenarios.map((s) => s.id)).toContain("GS-booking-4");
    // Messages are notify's (with the booking's links); the booking releases the time of a cancelled booking.
    const wf = r.spec.workflows?.map((w) => w.name);
    expect(wf).toEqual([
      "booking_notify",
      "booking_cancelled",
      "booking_moved",
      "booking_reminder",
      "booking_release",
    ]);
    expect(r.spec.workflows?.find((w) => w.name === "booking_release")).toMatchObject({
      trigger: { type: "on_status", entity: "booking", field: "status", equals: "cancelled" },
      steps: [{ type: "update", params: { set: { seat: null } } }],
    });
    // Cancel link: status → cancelled and the seat released at once; both links close 2 hours before the start.
    const confirm = r.spec.workflows?.[0]?.steps.find(
      (s) => (s.params as { to?: unknown }).to === "$record.email",
    );
    expect(confirm?.params).toMatchObject({
      template: "visitor_booked",
      cancel: { set: { status: "cancelled", seat: null }, until: { field: "starts_at", minutesBefore: 120 } },
      reschedule: { page: "/booking", fields: ["starts_at", "ends_at"], keep: ["service"] },
    });
    // The catalog's contract: the length from service.duration_min, the showcase opens /booking?service=<id>.
    const page = r.files["ui/pages/BookingBooking.tsx"] ?? "";
    expect(page).toContain("chosen.duration_min ?? null");
    expect(page).toContain('params.get("service")');
    expect(r.files["ui/pages/CatalogServices.tsx"]).toContain("/booking?service=");
    // The goal scenarios without a browser: a second visitor on the same time, the time released by a cancel.
    expect(r.spec.acceptance?.map((a) => a.text)).toEqual(
      expect.arrayContaining([
        "Второй посетитель на то же время получает отказ, на это время одна запись",
        "Отменённая запись сразу освобождает время для другого посетителя",
      ]),
    );
  });

  test("with client cards and the visitor cabinet: the client link and the visitor's own bookings", () => {
    const r = compiled(
      matrixPlan(registry, "booking", {
        name: "links",
        params: {},
        withModules: ["catalog", "notify", "client_card", "visitor_cabinet"],
      }),
    );
    const b = entity(r, "booking");
    expect(b?.fields.find((f) => f.name === "client")).toEqual({
      name: "client",
      label: "Клиент",
      type: "ref",
      ref: { entity: "client", onDelete: "set_null" },
    });
    expect(b?.indexes).toContainEqual({ fields: ["client"] });
    expect(perm(r, "guest", "booking")?.readonlyFields).toEqual(["status", "seat", "client"]);
    expect(perm(r, "visitor", "booking")).toMatchObject({
      ops: ["read", "update"],
      rowFilter: { email: "$user.email" },
    });
    expect(perm(r, "visitor", "booking")?.readonlyFields).not.toContain("status");
    expect(perm(r, "visitor", "booking")?.readonlyFields).toContain("starts_at");
    expect(r.spec.workflows?.find((w) => w.name === "client_from_booking")?.steps[0]?.params).toEqual({
      name: "clientFromBooking",
      args: { id: "$record.id", matchBy: "phone", create: true },
    });
    expect(r.spec.functions?.map((f) => f.name)).toContain("clientFromBooking");
    expect(r.files["functions/booking/clientFromBooking.ts"]).toContain("ctx.db.client.insert");
    expect(r.files["ui/pages/VisitorCabinetMe.tsx"]).toContain('label: "Мои записи"');
    expect(r.metrics.map((m) => m.id)).toContain("returning_clients");
    expect(r.spec.acceptance?.map((a) => a.text)).toContain(
      "Две записи с одним контактом дают одного клиента, и обе записи видны в его истории",
    );
  });

  test("resources, a group and manual confirmation change the index, rights, texts and workflows", () => {
    const r = compiled(
      bookingPlan({ with_specialists: true, specialist_label: "Врач", capacity: 4, confirm: "manual" }),
    );
    expect(entity(r, "booking")?.indexes).toContainEqual({
      fields: ["specialist", "starts_at", "seat"],
      unique: true,
    });
    expect(entity(r, "specialist")?.label).toBe("Врач");
    expect(perm(r, "guest", "booking")?.readonlyFields).toEqual(["status"]);
    expect(perm(r, "guest", "specialist")?.ops).toEqual(["read"]);
    expect(entity(r, "booking")?.fields.find((f) => f.name === "status")?.default).toBe("new");
    expect(r.spec.workflows?.map((w) => w.name)).toContain("booking_confirmed");
    expect(r.files["ui/pages/BookingBooking.tsx"]).toContain("Отправить заявку на запись");
    expect(r.files["functions/booking/busySlots.ts"]).toContain('specialist: v.id("specialist")');
  });

  test("without links: no link placeholders, no link params, e-mail optional", () => {
    const params = { cancel_by_link: false, reschedule_by_link: false };
    expect(linkRules(params).any).toBe(false);
    const r = compiled(bookingPlan(params));
    const text = JSON.stringify(r.spec);
    expect(text).not.toContain("cancel_link");
    expect(text).not.toContain("reschedule_link");
    expect(text).not.toContain('"reschedule"');
    expect(entity(r, "booking")?.fields.find((f) => f.name === "email")?.required).toBeUndefined();
  });

  test("deterministic output", () => {
    const a = compiled(bookingPlan({ with_specialists: true }));
    const b = compiled(structuredClone(bookingPlan({ with_specialists: true })));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

// ---------------------------------------------------------------- goal scenarios in a real runtime

const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
const OWNER = "owner@example.ru";
const SLUG = `zapis${randomBytes(3).toString("hex")}`;
const HOST = `${SLUG}--draft.localhost:4100`;

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
let schema: string;
let spec: AppSpec;
let L: Lib;
let serviceId: string;

function req(method: string, path: string, o: { body?: unknown; cookie?: string; form?: boolean } = {}) {
  const headers: Record<string, string> = { host: HOST };
  if (o.cookie) headers.cookie = o.cookie;
  if (method !== "GET" && !path.startsWith("/_wizard/hooks/")) {
    headers.origin = `http://${HOST}`;
    headers["x-wizard-request"] = "1";
  }
  let body: string | undefined;
  if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers["content-type"] = "application/json";
  }
  return rt.fetch(new Request(`http://127.0.0.1:4100${path}`, { method, headers, body, redirect: "manual" }));
}

const T = (t: string) => `${quoteIdent(schema)}.${quoteIdent(t)}`;
const row = async (id: string) =>
  (await db.unsafe(`select status, seat, starts_at, ends_at from ${T("booking")} where id = $1`, [id]))[0];

/** Slot of the day after tomorrow at `minutes` (Moscow) for one step (60 minutes). */
function slot(minutes: number, days = 2) {
  const day = L.addDays(L.dayKey(Date.now()), days);
  return {
    starts_at: new Date(L.zonedAt(day, minutes)).toISOString(),
    ends_at: new Date(L.zonedAt(day, minutes + 60)).toISOString(),
  };
}

async function book(email: string, at: { starts_at: string; ends_at: string }) {
  const c = complianceInfo(spec);
  return req("POST", "/api/data/booking", {
    body: {
      service: serviceId,
      ...at,
      name: "Анна Тестова",
      phone: "+79991234567",
      email,
      consent_messages: true,
      _consent: { policyVersion: c.policyVersion, textHash: c.consentTextHash },
    },
  });
}

async function bookedId(res: Response): Promise<string> {
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  const j = (await res.json()) as { id?: string; item?: { id: string } };
  return (j.item?.id ?? j.id) as string;
}

const mailsTo = (to: string) =>
  rt
    .outbox()
    .filter((m) => (m.payload as { to?: unknown }).to === to)
    .map((m) => String((m.payload as { text?: unknown }).text ?? ""));
const linkOf = (text: string, action: string) =>
  new RegExp(`(/_wizard/hooks/message/${action}/[A-Za-z0-9_-]+)`).exec(text)?.[1] as string;

beforeAll(async () => {
  const r = compiled(bookingPlan());
  spec = r.spec;
  L = lib(scheduleOf({ workdays: ALL_DAYS }));
  db = postgres(DATABASE_URL, { max: 4, onnotice: () => {} });
  role = `wz_mod_bk_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-booking-test-"));
  const key = randomBytes(6).toString("hex");
  schema = schemaName(key, "draft");
  const entry: RegistryEntry = {
    systemId: key,
    slug: SLUG,
    env: "draft",
    revision: 1,
    specHash: "",
    bundleKey: "",
    publishedAt: new Date().toISOString(),
    suspended: false,
    features: { phoneOtp: false },
  };
  rt = createRuntimeApp({
    db,
    registry: new MemoryRegistry([entry], { [key]: [OWNER] }),
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    connectors: "live",
    platform: testPlatform(),
    http: false,
    env: {
      authModeDev: true,
      devLogin: true,
      unsafeLocalExec: true,
      publicScheme: "http",
      platformOrigin: "http://localhost:5173",
      systemsDomain: "localhost",
      nodeEnv: "test",
      kubernetes: false,
    },
  });
  const built = await buildSystem({ spec, files: new Map(Object.entries(r.files)), env: "draft" });
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  const artifactDir = writeArtifact(join(root, "artifacts"), key, 1, built).dir;
  await migrateSystem(db, { systemId: key, env: "draft", spec, runtimeRole: role });
  await rt.loadSystem({ systemKey: key, env: "draft", spec, slug: SLUG, artifactDir });
  const sys = await rt.systems.resolve(SLUG, "draft");
  if (!sys) throw new Error("no system");
  serviceId = await sys.data.transaction("write", SYSTEM_SUBJECT, (d) =>
    d.system.insert("service", { name: "Чистка зубов", price: 3500, duration_min: 60 }),
  );
}, 120_000);

afterAll(async () => {
  await closeExecutors();
  await db?.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`).catch(() => {});
  for (const st of schema ? dropSystemRoleDDL(schema) : []) await db.unsafe(st).catch(() => {});
  await db?.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
  await db?.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await db?.end();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("goal scenarios without a browser", () => {
  const S1 = () => slot(10 * 60);
  const S2 = () => slot(12 * 60);
  const S3 = () => slot(14 * 60);
  let first: string;

  test("GS-booking-1/2: a visitor books; the second on the same time gets CONFLICT; busySlots shows no PII", async () => {
    first = await bookedId(await book("anna@example.ru", S1()));
    expect((await row(first))?.status).toBe("confirmed");
    const second = await book("boris@example.ru", S1());
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error?: { code?: string } }).error?.code).toBe("CONFLICT");
    const day = L.addDays(L.dayKey(Date.now()), 2);
    const busy = await req("POST", "/api/fn/busySlots", {
      body: {
        args: {
          from: new Date(L.zonedAt(day, 0)).toISOString(),
          to: new Date(L.zonedAt(L.addDays(day, 1), 0)).toISOString(),
        },
      },
    });
    expect(busy.status, await busy.clone().text()).toBe(200);
    const { result } = (await busy.json()) as { result: Record<string, unknown>[] };
    expect(result).toEqual([{ starts_at: S1().starts_at, ends_at: S1().ends_at, seat: 1 }]);
    // The visitor does not read bookings directly.
    expect((await req("GET", "/api/data/booking")).status).toBeGreaterThanOrEqual(400);
  });

  test("GS-booking-1: confirmation with both links to the visitor, notice to the owner", async () => {
    await rt.jobsTick({ envs: ["draft"] });
    const [confirm] = mailsTo("anna@example.ru");
    expect(confirm).toContain("Вы записаны");
    expect(linkOf(confirm ?? "", "cancel")).toBeTruthy();
    expect(linkOf(confirm ?? "", "reschedule")).toBeTruthy();
    expect(confirm).toContain("не позже чем за 2 ч");
    expect(mailsTo(OWNER).some((t) => t.includes("Новая запись"))).toBe(true);
  });

  test("GS-booking-4: reschedule by the link — taken time refused, free time moves once, old time free", async () => {
    const link = linkOf(mailsTo("anna@example.ru")[0] ?? "", "reschedule");
    const open = await req("GET", link);
    expect(open.status).toBe(303);
    const to = new URL(open.headers.get("location") ?? "", "http://x");
    expect(to.pathname).toBe("/booking");
    expect(to.searchParams.get("service")).toBe(serviceId);
    expect(to.searchParams.get("reschedule")).toBe(link.split("/").at(-1));

    await bookedId(await book("vera@example.ru", S3()));
    const move = (at: { starts_at: string; ends_at: string }) =>
      `${link}?${new URLSearchParams({ starts_at: at.starts_at, ends_at: at.ends_at })}`;
    const ask = await req("GET", move(S2()));
    expect(ask.status).toBe(200);
    expect(await ask.text()).toContain("Перенести запись?");
    const taken = await req("POST", move(S3()));
    expect(taken.status).toBe(409);
    expect(await taken.text()).toContain("Это время уже занято");
    const done = await req("POST", move(S2()));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Запись перенесена");
    expect(new Date((await row(first))?.starts_at as string).toISOString()).toBe(S2().starts_at);
    expect((await req("POST", move(S2()))).status).toBe(404);
    // A used link says so at once, before the visitor picks a time again.
    expect((await req("GET", link)).status).toBe(404);
    // The old time is free for another visitor.
    await bookedId(await book("gleb@example.ru", S1()));
    await rt.jobsTick({ envs: ["draft"] });
    const moved = mailsTo("anna@example.ru").at(-1) ?? "";
    expect(moved).toContain("перенесена на");
    expect(linkOf(moved, "cancel")).toBeTruthy();
  });

  test("GS-booking-3: cancel by the link frees the time at once; the owner is told", async () => {
    const link = linkOf(mailsTo("anna@example.ru")[0] ?? "", "cancel");
    const page = await req("GET", link);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Отменить запись?");
    expect((await req("POST", link)).status).toBe(200);
    expect(await row(first)).toMatchObject({ status: "cancelled", seat: null });
    await bookedId(await book("dina@example.ru", S2()));
    expect((await req("POST", link)).status).toBe(404);
    expect((await req("GET", link)).status).toBe(404);
    await rt.jobsTick({ envs: ["draft"] });
    expect(mailsTo(OWNER).some((t) => t.includes("отменена"))).toBe(true);
  });

  test("a link closes cancel_until_hours before the start", async () => {
    const start = Math.ceil((Date.now() + 30 * 60_000) / 60_000) * 60_000;
    const id = await bookedId(
      await book("late@example.ru", {
        starts_at: new Date(start).toISOString(),
        ends_at: new Date(start + 3_600_000).toISOString(),
      }),
    );
    await rt.jobsTick({ envs: ["draft"] });
    const mail = mailsTo("late@example.ru")[0] ?? "";
    for (const action of ["cancel", "reschedule"]) {
      const link = linkOf(mail, action);
      expect((await req("GET", link)).status).toBe(410);
      expect((await req("POST", link)).status).toBe(410);
    }
    expect((await row(id))?.status).toBe("confirmed");
  });

  test("the goal panel: scheduleLoad ({period} → {value, previous, base}) counts held slots against working slots", async () => {
    // Two visits of the last week (one of them cancelled — it holds nothing) and one of the week before it.
    const sys = await rt.systems.resolve(SLUG, "draft");
    if (!sys) throw new Error("no system");
    const today = L.dayKey(Date.now());
    const visit = (days: number, minutes: number, extra: Record<string, unknown> = {}) => {
      const day = L.addDays(today, -days);
      return {
        service: serviceId,
        starts_at: new Date(L.zonedAt(day, minutes)).toISOString(),
        ends_at: new Date(L.zonedAt(day, minutes + 60)).toISOString(),
        name: "Анна Тестова",
        phone: "+79991234567",
        email: "past@example.ru",
        ...extra,
      };
    };
    await sys.data.transaction("write", SYSTEM_SUBJECT, async (d) => {
      await d.system.insert("booking", visit(2, 10 * 60, { status: "done" }));
      await d.system.insert("booking", visit(3, 11 * 60, { status: "no_show" }));
      await d.system.insert("booking", visit(3, 12 * 60, { status: "cancelled", seat: null }));
      await d.system.insert("booking", visit(9, 10 * 60, { status: "done" }));
    });
    const login = await req("GET", "/_wizard/dev-login?role=owner");
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const res = await req("POST", "/api/fn/scheduleLoad", { cookie, body: { args: { period: "week" } } });
    expect(res.status, await res.clone().text()).toBe(200);
    const { result } = (await res.json()) as { result: { value: number; previous: number } };
    // Every day 9:00–18:00 with a 60-minute step → 9 slots a day, 63 a week: 2 held now, 1 the week before.
    expect(result).toEqual({ value: 3.2, previous: 1.6, base: 2 });
  });
});

describe("G1 scenarios of the goals (gates without models)", () => {
  let g: G1Runtime;
  beforeAll(async () => {
    g = await startG1Runtime("b214");
  }, 60_000);
  afterAll(async () => {
    await g?.close();
  });

  test("conflict on the same time, the time released by a cancel, one client for two bookings, own bookings only", async () => {
    const r = compiled(
      matrixPlan(registry, "booking", {
        name: "g1",
        params: {},
        withModules: ["catalog", "notify", "client_card", "visitor_cabinet"],
      }),
    );
    const { g0, g1 } = await g.gates(r.spec, r.files);
    expect(blockers(g0), "G0").toEqual([]);
    expect(blockers(g1), "G1").toEqual([]);
    const sc = (text: string) => `SC-${r.spec.acceptance?.find((a) => a.text === text)?.id ?? text}`;
    for (const text of [
      "Второй посетитель на то же время получает отказ, на это время одна запись",
      "Отменённая запись сразу освобождает время для другого посетителя",
      "Две записи с одним контактом дают одного клиента, и обе записи видны в его истории",
    ])
      expect(statusOf(g1, sc(text)), text).toBe("pass");
    expect(statusOf(g1, "PC-visitor-booking-row")).toBe("pass");
  }, 180_000);
});
