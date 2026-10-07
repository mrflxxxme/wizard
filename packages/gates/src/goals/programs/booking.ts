// Goal scenarios of the module «Запись по слотам» (packages/modules/src/booking, modules.yaml#catalog booking): the
// page /booking (service → [resource] → day → free time → contacts with consent), entity `booking` {starts_at, ends_at,
// seat, status, …}, the one-time links of the e-mails (/_wizard/hooks/message/cancel|reschedule/<token>).
import type { AppSpec } from "@wizard/appspec";
import type { GoalOutboxMessage, GoalProgram, GoalRun } from "../types.js";
import {
  enumLabel,
  formReady,
  openEntity,
  ownerRole,
  plain,
  press,
  recordAction,
  setFields,
  textOf,
} from "./shared.js";

export const BOOKING_PAGE = "/booking";
const PAGE = '[data-testid="booking-page"]';
const DONE = '[data-testid="booking-done"]';
const SLOTS = '[data-testid="booking-slots"] button';
/** The first day of the list may be today with its time already past: the scenarios book from the third day on. */
const FIRST_DAY = 2;

/** Waits until the time section shows the free slots or says there are none (busySlots loads after the day click). */
async function slotsLoaded(t: GoalRun): Promise<void> {
  const sections = t.page.locator(`${PAGE} > section`);
  const time = sections.nth((await sections.count()) - 1);
  await time
    .locator('[data-testid="booking-slots"], [data-testid="wz-empty"]')
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => {});
}

/**
 * A bookable service of the run (30 minutes), added by the owner: the seed's durations go up to 600 minutes and may
 * not fit a working day (or the part of it before a break) at all.
 */
export async function ensureService(t: GoalRun): Promise<void> {
  if ((await t.rows("service")).some((r) => String(r.name ?? "").startsWith(t.marker))) return;
  const doc: Record<string, unknown> = { name: `${t.marker} услуга` };
  for (const f of t.spec.entities.find((e) => e.name === "service")?.fields ?? []) {
    if (f.name === "duration_min") doc[f.name] = 30;
    else if (f.name === "active") doc[f.name] = true;
    else if (f.required && f.default === undefined && doc[f.name] === undefined)
      doc[f.name] =
        f.type === "bool"
          ? true
          : f.type === "enum"
            ? f.enum?.[0]?.value
            : ["int", "decimal", "money"].includes(f.type)
              ? Math.max(typeof f.min === "number" ? f.min : 0, 1000)
              : t.marker;
  }
  await t.as("owner");
  const r = await t.api("POST", "/api/data/service", doc);
  if (r.status >= 300)
    t.fail("владелец не может добавить услугу для записи", JSON.stringify(r.body).slice(0, 200));
}

/**
 * The choices before the day (service, resource) where none is made: the run's own service (ensureService), else the
 * shortest («· 55 мин»), else the first option. A fixed choice (the service of a reschedule link) is text without
 * buttons.
 */
async function pickChoices(t: GoalRun, n: number): Promise<void> {
  const sections = t.page.locator(`${PAGE} > section`);
  for (let i = 0; i < n - 2; i++) {
    const s = sections.nth(i);
    if ((await s.locator('[aria-pressed="true"]').count()) > 0) continue;
    const buttons = s.getByRole("button");
    if ((await buttons.count()) === 0) {
      if ((await s.locator('[data-testid="wz-empty"]').count()) > 0)
        t.fail(`на странице записи нечего выбрать: ${plain(await s.innerText().catch(() => ""))}`);
      continue;
    }
    const minutes = (await buttons.allInnerTexts()).map((x) =>
      Number(/(\d+)\s*мин/.exec(x)?.[1] ?? Number.NaN),
    );
    let pick = 0;
    minutes.forEach((m, k) => {
      if (Number.isFinite(m) && !(m >= (minutes[pick] as number))) pick = k;
    });
    const own = (await buttons.allInnerTexts()).findIndex((x) => x.includes(t.marker));
    if (own >= 0) pick = own;
    await buttons.nth(pick).click();
    await t.settle();
  }
}

export interface ChosenSlot {
  /** «10:00» as the slot button shows it. */
  time: string;
  /** Caption of the day button. */
  day: string;
  /** Index of the day button. */
  dayIndex: number;
}

/**
 * On the open booking page: picks the first option of every choice before the day (service, resource) unless one is
 * chosen, then the day (from `day` on, skipping days without free time) and the slot (`time`, else the first).
 */
export async function chooseSlot(t: GoalRun, o: { day?: number; time?: string } = {}): Promise<ChosenSlot> {
  const sections = t.page.locator(`${PAGE} > section`);
  try {
    await sections.nth(2).waitFor({ state: "attached", timeout: 5_000 });
  } catch {
    t.fail("страница записи не открылась", await textOf(t, "body"));
  }
  const n = await sections.count();
  await pickChoices(t, n);
  const days = sections.nth(n - 2).getByRole("button");
  const time = sections.nth(n - 1);
  const total = await days.count();
  for (let d = o.day ?? FIRST_DAY; d < total; d++) {
    await days.nth(d).click();
    await t.settle();
    await slotsLoaded(t);
    const slots = time.locator(SLOTS);
    if ((await slots.count()) === 0) {
      if (o.time) t.fail(`время ${o.time} не предлагается`, plain(await time.innerText().catch(() => "")));
      continue;
    }
    const button = o.time ? slots.filter({ hasText: o.time }).first() : slots.first();
    if ((await button.count()) === 0)
      t.fail(`время ${o.time} не предлагается`, plain(await time.innerText().catch(() => "")));
    const label = plain(await button.innerText());
    await button.click();
    await t.settle();
    return { time: label, day: plain(await days.nth(d).innerText()), dayIndex: d };
  }
  return t.fail("на ближайшие дни нет свободного времени для записи");
}

/** Slot captions offered on the open booking page for the chosen day. */
export async function offeredTimes(t: GoalRun): Promise<string[]> {
  await slotsLoaded(t);
  const sections = t.page.locator(`${PAGE} > section`);
  const n = await sections.count();
  const slots = sections.nth(n - 1).locator(SLOTS);
  return (await slots.allInnerTexts()).map(plain);
}

/** Opens /booking and selects the day `dayIndex` (and the first service and resource). */
export async function openDay(t: GoalRun, dayIndex: number): Promise<void> {
  await t.open(BOOKING_PAGE);
  const sections = t.page.locator(`${PAGE} > section`);
  await sections.nth(2).waitFor({ state: "attached", timeout: 5_000 });
  const n = await sections.count();
  await pickChoices(t, n);
  await sections
    .nth(n - 2)
    .getByRole("button")
    .nth(dayIndex)
    .click();
  await t.settle();
}

/** Fills the contacts (consents ticked) and sends the booking form. */
export async function sendBooking(t: GoalRun): Promise<void> {
  await t.fillForm(PAGE);
  await t.submit(PAGE);
}

/** The page confirms the booking: «Вы записаны», or «Заявка на запись отправлена» when staff confirms bookings. */
async function expectBooked(t: GoalRun): Promise<void> {
  const done = t.page.locator(DONE).first();
  try {
    await done.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    t.fail("после записи нет подтверждения «Вы записаны»", await textOf(t, PAGE));
  }
  const text = await textOf(t, DONE);
  if (!/Вы записаны|Заявка на запись отправлена/.test(text)) t.fail("после записи нет «Вы записаны»", text);
}

/** A visitor books on /booking like a person and sees «Вы записаны» with the time. */
export async function bookVisit(t: GoalRun, o: { day?: number } = {}): Promise<ChosenSlot> {
  await ensureService(t);
  await t.as("visitor");
  await t.open(BOOKING_PAGE);
  const slot = await chooseSlot(t, o);
  await sendBooking(t);
  await expectBooked(t);
  const done = await textOf(t, DONE);
  if (!done.includes(slot.time)) t.fail("после записи не видно её времени", done);
  return slot;
}

/**
 * An e-mail of the system. G1 runs the runtime with connectors: 'outbox' — the runtime records which template goes to
 * whom about which record together with the rendered letter (B2-28: subject, text, one-time links), so `rendered` is
 * true and the programs follow the real links. A runtime that records the marker only gives the template's body from
 * the spec ({{cancel_link}} in place of a link) and `rendered` false.
 */
export interface Mail {
  template: string | null;
  subject: string;
  text: string;
  rendered: boolean;
  message: GoalOutboxMessage;
}

type Template = { subject?: unknown; body?: unknown };

function mailOf(t: GoalRun, m: GoalOutboxMessage): Mail {
  const p = (m.payload ?? {}) as { subject?: unknown; text?: unknown; template?: unknown };
  const template = typeof p.template === "string" ? p.template : null;
  const config = (t.spec.integrations ?? []).find((i) => i.name === m.integration)?.config as
    | { templates?: Record<string, Template> }
    | undefined;
  const tpl = template ? config?.templates?.[template] : undefined;
  const rendered = typeof p.text === "string" && p.text !== "";
  return {
    template,
    subject: String(p.subject ?? tpl?.subject ?? ""),
    text: rendered ? String(p.text) : String(tpl?.body ?? ""),
    rendered,
    message: m,
  };
}

/** E-mails to the visitor of a record since the run started (by address when rendered, else by recipient). */
export function visitorMail(t: GoalRun, recordId: unknown): Mail[] {
  return t
    .outbox("email")
    .filter((m) => {
      const p = (m.payload ?? {}) as { to?: unknown; recipient?: unknown; recordId?: unknown };
      return (
        String(p.to ?? "").toLowerCase() === t.contact.email.toLowerCase() ||
        (p.recipient === "visitor" && String(p.recordId) === String(recordId))
      );
    })
    .map((m) => mailOf(t, m));
}

const linkOf = (text: string, action: string) =>
  new RegExp(`(/_wizard/hooks/message/${action}/[A-Za-z0-9_.~-]+)`).exec(text)?.[1] ?? null;
export const cancelLinkOf = (text: string) => linkOf(text, "cancel");
export const rescheduleLinkOf = (text: string) => linkOf(text, "reschedule");

/** Whether a letter carries the link of an action: the link itself, or its placeholder in an unrendered template. */
export const hasLink = (m: Mail, action: "cancel" | "reschedule") =>
  m.rendered ? linkOf(m.text, action) !== null : m.text.includes(`{{${action}_link}}`);

/** Offsets (minutes, negative — before) of the schedule workflows of an entity relative to a date field. */
export function scheduleOffsets(spec: AppSpec, entity: string): number[] {
  return (spec.workflows ?? []).flatMap((w) =>
    w.trigger.type === "schedule" && w.trigger.entity === entity && w.trigger.relative
      ? [w.trigger.relative.offsetMinutes ?? 0]
      : [],
  );
}

type NotifyStep = { to?: unknown; cancel?: unknown; reschedule?: unknown };

/** Notify steps of the workflows started by a new booking. */
const onCreateNotify = (spec: AppSpec) =>
  (spec.workflows ?? [])
    .filter((w) => w.trigger.type === "on_create" && w.trigger.entity === "booking")
    .flatMap((w) => w.steps.filter((s) => s.type === "notify").map((s) => (s.params ?? {}) as NotifyStep));

const toOwner = (m: GoalOutboxMessage, owners: ReadonlySet<string>) =>
  (m.userId ? owners.has(m.userId) : false) ||
  (m.payload as { recipient?: unknown } | null)?.recipient === "owner";

/** E-mails to the owner since the run started. */
export function ownerMail(t: GoalRun): Mail[] {
  const owners = new Set(t.userIds("owner"));
  return t
    .outbox("email")
    .filter((m) => toOwner(m, owners))
    .map((m) => mailOf(t, m));
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/** Bookings that hold a seat at a start time (not cancelled). */
async function holding(t: GoalRun, startsAt: string): Promise<Record<string, unknown>[]> {
  return (await t.rows("booking")).filter(
    (r) => r.starts_at != null && iso(r.starts_at) === startsAt && r.seat != null && r.status !== "cancelled",
  );
}

/** The booking of this run: the only new row. */
async function myBooking(t: GoalRun): Promise<Record<string, unknown>> {
  const mine = await t.newRows("booking");
  if (mine.length !== 1) return t.fail(`новых записей в базе ${mine.length}, ожидалась одна`);
  return mine[0] as Record<string, unknown>;
}

/** GS-booking-1: a visitor books free time and sees «Вы записаны»; the owner sees it; both get e-mails. */
const bookFreeTime: GoalProgram = async (t) => {
  t.step("Посетитель выбирает услугу, день и свободное время, вводит данные, соглашается и записывается");
  await bookVisit(t);

  t.step("Запись в кабинете владельца со статусом по умолчанию");
  const booking = await myBooking(t);
  const field = t.spec.entities.find((e) => e.name === "booking")?.fields.find((f) => f.name === "status");
  const expected = String(field?.default ?? "confirmed");
  if (booking.status !== expected)
    t.fail(`статус новой записи «${String(booking.status)}», ожидался «${expected}»`);
  await t.as("owner");
  await openEntity(t, ownerRole(t.spec), "booking");
  await t.expectNear(t.marker, enumLabel(t.spec, "booking", "status", expected));

  t.step("Посетителю ушло подтверждение, владельцу — письмо о новой записи");
  await t.runJobs();
  const steps = onCreateNotify(t.spec);
  const visitorStep = steps.find((s) => typeof s.to === "string" && s.to.startsWith("$record."));
  if (visitorStep) {
    const mail = visitorMail(t, booking.id);
    if (mail.length === 0) t.fail("письма посетителю о записи нет в исходящих");
    if (visitorStep.cancel && !mail.some((m) => hasLink(m, "cancel")))
      t.fail("в письме посетителю нет ссылки отмены");
    if (visitorStep.reschedule && !mail.some((m) => hasLink(m, "reschedule")))
      t.fail("в письме посетителю нет ссылки переноса");
  }
  if (steps.some((s) => s.to === "$owner") && ownerMail(t).length === 0)
    t.fail("письма владельцу о новой записи нет в исходящих");
};

/** GS-booking-2: the second visitor (page opened earlier) sending the same time is refused; one booking holds it. */
const sameTimeRefused: GoalProgram = async (t) => {
  t.step("Второй посетитель открывает страницу записи и выбирает время");
  await ensureService(t);
  await t.as("visitor");
  const late = t.page;
  await t.open(BOOKING_PAGE);
  const slot = await chooseSlot(t);

  t.step("Первый посетитель записывается на это время");
  const first = await t.newTab();
  t.useTab(first);
  await t.open(BOOKING_PAGE);
  await chooseSlot(t, { day: slot.dayIndex, time: slot.time });
  await sendBooking(t);
  await expectBooked(t);
  const booking = await myBooking(t);
  const startsAt = iso(booking.starts_at);
  const seat = t.spec.entities.find((e) => e.name === "booking")?.fields.find((f) => f.name === "seat");
  const capacity = typeof seat?.max === "number" ? seat.max : 1;
  if (capacity > 1) {
    t.step("Остальные места на это время занимают другие посетители");
    const consent = await consentOf(t);
    for (let k = 1; k <= capacity; k++) {
      if (k === Number(booking.seat)) continue;
      const doc: Record<string, unknown> = { seat: k, consent_messages: false };
      for (const f of ["service", "specialist", "starts_at", "ends_at", "name", "phone", "email"])
        if (booking[f] != null) doc[f] = f === "starts_at" || f === "ends_at" ? iso(booking[f]) : booking[f];
      const r = await t.api("POST", "/api/data/booking", {
        ...doc,
        ...(consent ? { _consent: consent } : {}),
      });
      if (r.status >= 300)
        t.fail(`место ${k} на это время не занялось (HTTP ${r.status})`, JSON.stringify(r.body));
    }
  }

  t.step("Второй посетитель отправляет запись на то же время");
  t.useTab(late);
  await sendBooking(t);
  await t.expectText("Это время только что заняли", { within: PAGE });

  t.step("На это время одна запись на место");
  const held = await holding(t, startsAt);
  if (held.length !== capacity)
    t.fail(`на это время ${held.length} записей при ${capacity} местах`, `время ${slot.time}`);

  t.step("Занятое время больше не предлагается");
  // The page asks for the busy times again after the refusal: give the answer a moment.
  let offered = await offeredTimes(t);
  for (let i = 0; i < 15 && offered.includes(slot.time); i++) {
    await t.page.waitForTimeout(200);
    offered = await offeredTimes(t);
  }
  if (offered.includes(slot.time)) t.fail(`занятое время ${slot.time} всё ещё предлагается`);
};

/** Consent object of the system (the data API asks it for a booking with personal data). */
async function consentOf(t: GoalRun): Promise<{ policyVersion: string; textHash: string } | null> {
  const r = await t.api("GET", "/_wizard/spec");
  const c = (r.body as { compliance?: { policyVersion?: string; consentTextHash?: string } } | null)
    ?.compliance;
  return c?.policyVersion && c.consentTextHash
    ? { policyVersion: c.policyVersion, textHash: c.consentTextHash }
    : null;
}

/** Opens a one-time link of an e-mail; returns the page's text (an expired link answers 404/410 with a page). */
async function openLink(t: GoalRun, path: string): Promise<string> {
  await t.page.goto(`${new URL(t.page.url()).origin}${path}`, { waitUntil: "load", timeout: 15_000 });
  await t.settle();
  return textOf(t, "body");
}

/** The confirmation button of a one-time link page (a plain HTML form). */
async function confirmLink(t: GoalRun): Promise<string> {
  const button = t.page.locator('form[method="post"] button[type="submit"]').first();
  if ((await button.count()) === 0)
    t.fail("на странице ссылки нет кнопки подтверждения", await textOf(t, "body"));
  await Promise.all([t.page.waitForLoadState("load").catch(() => {}), button.click()]);
  await t.settle();
  return textOf(t, "body");
}

/** Share of cancelled bookings among the rows. */
const cancelShare = (rows: readonly Record<string, unknown>[]) =>
  rows.length ? rows.filter((r) => r.status === "cancelled").length / rows.length : 0;

/** The visitor's letter about a new booking with the link of an action (rendered or as the template's placeholder). */
async function letterWithLink(t: GoalRun, action: "cancel" | "reschedule"): Promise<Mail> {
  const booking = await myBooking(t);
  await t.runJobs();
  const mail = visitorMail(t, booking.id).find((m) => hasLink(m, action));
  if (!mail) return t.fail(`в письме посетителю нет ссылки ${action === "cancel" ? "отмены" : "переноса"}`);
  return mail;
}

/** The owner opens the booking of this run in the cabinet (its card); returns the area of the section. */
async function ownerOpensBooking(t: GoalRun): Promise<string> {
  await t.as("owner");
  const area = await openEntity(t, ownerRole(t.spec), "booking");
  const row = t.page
    .locator(`${area} [data-testid="wz-datatable-row"]`)
    .filter({ hasText: t.marker })
    .first();
  try {
    await row.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    t.fail("записи нет в списке кабинета владельца");
  }
  await row.click();
  await t.settle();
  return area;
}

/** GS-booking-3: the cancel link of the e-mail cancels the booking and frees its time; the owner is told. */
const cancelByLink: GoalProgram = async (t) => {
  t.step("Посетитель записывается и получает письмо со ссылкой отмены");
  const slot = await bookVisit(t);
  const letter = await letterWithLink(t, "cancel");
  const shareBefore = cancelShare(await t.rows("booking"));
  const before = ownerMail(t).length;

  const link = letter.rendered ? cancelLinkOf(letter.text) : null;
  if (link) {
    t.step("Посетитель открывает ссылку отмены из письма и подтверждает отмену");
    const ask = await openLink(t, link);
    if (!ask.includes("Отменить запись?"))
      t.fail("ссылка отмены не открыла вопрос об отмене", ask.slice(0, 200));
    const done = await confirmLink(t);
    if (!done.includes("Запись отменена"))
      t.fail("после подтверждения нет «Запись отменена»", done.slice(0, 200));
  } else {
    // A runtime without rendered letters (marker only): no one-time link to follow — the cancellation goes through
    // the cabinet, the same status. The G1 runtime renders letters since B2-28 and takes the branch above.
    t.step("Запись отменяется (ссылка письма не создаётся в режиме проверки — отмена в кабинете владельца)");
    const area = await ownerOpensBooking(t);
    await recordAction(t, area, "to_cancelled");
  }

  t.step("Запись в статусе «Отменена»");
  await t.runJobs();
  const booking = await myBooking(t);
  if (booking.status !== "cancelled")
    t.fail(`статус записи «${String(booking.status)}», ожидался «cancelled»`);

  t.step("Посетитель снова открывает страницу записи на тот же день: время снова доступно");
  await t.as("visitor");
  await openDay(t, slot.dayIndex);
  const offered = await offeredTimes(t);
  if (!offered.includes(slot.time)) t.fail(`освободившееся время ${slot.time} не предлагается`);

  t.step("Владельцу ушло письмо об отмене");
  const mails = ownerMail(t).slice(before);
  if (!mails.some((m) => /отмен/i.test(`${m.template ?? ""} ${m.subject} ${m.text}`)))
    t.fail("письма владельцу об отмене нет в исходящих");

  t.step("Доля отмен выросла");
  if (!(cancelShare(await t.rows("booking")) > shareBefore)) t.fail("доля отменённых записей не выросла");
};

const moscowTime = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" }).format(
    d,
  );

/** «YYYY-MM-DDTHH:MM» of an instant in Moscow (a datetime-local field of the browser in Europe/Moscow). */
const moscowLocal = (d: Date) => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 16);

/** GS-booking-4: the reschedule link moves the booking once to another free time; the old time is free again. */
const rescheduleByLink: GoalProgram = async (t) => {
  t.step("Посетитель записывается и получает письмо со ссылкой переноса");
  const slot = await bookVisit(t);
  const letter = await letterWithLink(t, "reschedule");
  const sent = visitorMail(t, (await myBooking(t)).id).length;
  const link = letter.rendered ? rescheduleLinkOf(letter.text) : null;

  let newTime: string;
  if (link) {
    t.step("Посетитель открывает ссылку переноса из письма");
    await openLink(t, link);
    if (new URL(t.page.url()).pathname !== BOOKING_PAGE) t.fail("ссылка переноса не открыла страницу записи");
    await t.expectText("Перенос записи", { within: PAGE });

    t.step("Посетитель выбирает другой день и время и подтверждает перенос");
    const next = await chooseSlot(t, { day: slot.dayIndex + 1 });
    const move = t.page.locator('[data-testid="booking-move"]').getByRole("link").first();
    if ((await move.count()) === 0) t.fail("нет кнопки «Перенести на это время»");
    await Promise.all([t.page.waitForLoadState("load").catch(() => {}), move.click()]);
    await t.settle();
    const done = await confirmLink(t);

    t.step("Посетитель видит «Запись перенесена»");
    if (!done.includes("Запись перенесена"))
      t.fail("после переноса нет «Запись перенесена»", done.slice(0, 200));
    newTime = next.time;
  } else {
    // No rendered letter (see cancelByLink): the move goes through the cabinet's form — the same fields.
    t.step(
      "Запись переносится на неделю вперёд (ссылка письма не создаётся в режиме проверки — перенос в кабинете)",
    );
    const booking = await myBooking(t);
    const from = new Date(iso(booking.starts_at));
    const length = new Date(iso(booking.ends_at ?? booking.starts_at)).getTime() - from.getTime();
    let to = new Date(from.getTime() + 7 * 86_400_000);
    if ((await holding(t, to.toISOString())).length > 0) to = new Date(from.getTime() + 14 * 86_400_000);
    const area = await ownerOpensBooking(t);
    await press(t, "Изменить", area);
    await formReady(t, area);
    await setFields(t, area, {
      starts_at: moscowLocal(to),
      ...(booking.ends_at != null ? { ends_at: moscowLocal(new Date(to.getTime() + length)) } : {}),
    });
    await t.submit(area);
    const error = await textOf(t, `${area} form [role="alert"]`);
    if (error) t.fail("перенос не сохранился", error);
    newTime = moscowTime(to);
  }

  t.step("Запись на новом времени, старое время снова свободно");
  const booking = await myBooking(t);
  const at = moscowTime(new Date(iso(booking.starts_at)));
  if (at !== newTime) t.fail(`запись на ${at}, а выбрано ${newTime}`);
  await t.as("visitor");
  await openDay(t, slot.dayIndex);
  if (!(await offeredTimes(t)).includes(slot.time)) t.fail(`старое время ${slot.time} не освободилось`);

  t.step("Посетителю ушло письмо «Время записи изменено» с новыми ссылками");
  await t.runJobs();
  const moved = visitorMail(t, booking.id)
    .slice(sent)
    .find((m) => /изменено|перенесен|moved/i.test(`${m.template ?? ""} ${m.subject} ${m.text}`));
  if (!moved) return t.fail("письма о переносе посетителю нет в исходящих");
  if (!hasLink(moved, "reschedule")) t.fail("в письме о переносе нет новой ссылки переноса");

  if (link) {
    t.step("Повторно ссылка не работает");
    const again = await openLink(t, link);
    if (!again.includes("Ссылка недействительна"))
      t.fail("старая ссылка переноса снова работает", again.slice(0, 200));
  }
};

export const BOOKING_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-booking-1": bookFreeTime,
  "GS-booking-2": sameTimeRefused,
  "GS-booking-3": cancelByLink,
  "GS-booking-4": rescheduleByLink,
};
