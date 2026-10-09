// Goal scenarios of the module «Абонементы и пакеты» (packages/modules/src/packages, modules.yaml#catalog packages,
// B2-18): tariffs `package_plan`, client packages `client_package` (status active | frozen | used_up | expired,
// visits_left, expires_on, ends_at, contacts copied from the client), usage `package_usage`, members' materials
// `package_material` (page /materials). The owner sells through the data API (setup) and checks in the cabinet; the
// visitor books on /booking (the page asks packageCheck first) and opens /materials.
import type { AppSpec } from "@wizard/appspec";
import type { FilledForm, GoalOutboxMessage, GoalProgram, GoalRun } from "../types.js";
import { chooseSlot, isV3Booking } from "./booking.js";
import { create, fieldLabel, formContact, has, ITEM, patch, row, sell, VISITS } from "./package-sale.js";
import { enumLabel, ownerRole, pageRoute, pageText } from "./shared.js";

export { bookingByPackage, ensurePackage, formContact } from "./package-sale.js";

const cabinetOf = (t: GoalRun) => {
  // The shared cabinet of the owner (/cabinet) lists the module sections; other /cabinet/* pages are not it.
  const owner = ownerRole(t.spec);
  const route = t.spec.pages?.some((p) => p.route === "/cabinet" && p.roles.includes(owner))
    ? "/cabinet"
    : pageRoute(t.spec, owner);
  if (!route) t.fail("у владельца нет кабинета с абонементами");
  return route;
};

/** Opens a section of the owner's cabinet (the query makes it a full load even from the same page). */
const openSection = (t: GoalRun, entity: string) => t.open(`${cabinetOf(t)}?section=${entity}#${entity}`);

/** The owner (signed in) adds an active 30-minute service named by the run's marker for the booking page. */
async function ownService(t: GoalRun): Promise<void> {
  await create(t, "service", {
    name: `Услуга ${t.marker}`,
    ...(has(t.spec, "service", "price") ? { price: 1000 } : {}),
    ...(has(t.spec, "service", "duration_min") ? { duration_min: 30 } : {}),
    ...(has(t.spec, "service", "active") ? { active: true } : {}),
  });
}

/**
 * The visitor books on /booking: the run's service (and the first resource), a day with free time, its first time; the
 * form filled by fillForm (name, phone, e-mail, consents) and sent. Returns the filled values.
 */
async function bookOnPage(t: GoalRun): Promise<FilledForm> {
  await t.open("/booking");
  // A v3 booking pattern (V3-18): its marked steps — the run's service by its name, the first resource, a day with free
  // time and its first time (the contacts on screen after it); the module's v2 page: its sections below.
  if (await isV3Booking(t)) await chooseSlot(t);
  else await pickOnV2Page(t);
  await t.page.locator(FORM).waitFor({ state: "visible", timeout: 5_000 });
  const filled = await t.fillForm(PAGE);
  const contact = formContact(t);
  const typed = Object.values(filled);
  if (!typed.includes(contact.email))
    t.fail("форма записи заполнена не той почтой, на которую продан абонемент", typed.join("; "));
  await t.submit(PAGE);
  return filled;
}

/** The module's v2 page /booking: the run's service, the first resource, the first day with free time, its first time. */
async function pickOnV2Page(t: GoalRun): Promise<void> {
  // The run's own service (ownService): the seed's durations may not fit a working day.
  const service = t.page.locator('section[aria-label="Услуга"] button', { hasText: t.marker }).first();
  if ((await service.count()) === 0) t.fail("на странице записи нет услуги для проверки");
  await service.click();
  const resource = t.spec.entities
    .find((e) => e.name === "booking")
    ?.fields.find((f) => f.name === "specialist")?.label;
  if (resource) {
    const first = t.page.locator(`section[aria-label="${resource}"] button`).first();
    if ((await first.count()) === 0) t.fail("на странице записи некого выбрать");
    await first.click();
  }
  const days = t.page.locator('section[aria-label="День"] button');
  const time = t.page.locator('section[aria-label="Время"]');
  const slots = time.locator('[data-testid="booking-slots"] button');
  const none = time.getByText("свободного времени нет");
  let picked = false;
  for (let i = 0; i < (await days.count()) && !picked; i++) {
    await days.nth(i).click();
    // The free time of the day comes from busySlots: wait for the times or «нет свободного времени».
    await Promise.race([
      slots.first().waitFor({ state: "visible", timeout: 5_000 }),
      none.first().waitFor({ state: "visible", timeout: 5_000 }),
    ]).catch(() => {});
    if ((await slots.count()) > 0) {
      await slots.first().click();
      picked = true;
    }
  }
  if (!picked) t.fail("на ближайшие дни нет свободного времени");
}

/** The booking page and its form (packages/modules/src/booking/page.ts). */
const PAGE = '[data-testid="booking-page"]';
const FORM = '[data-testid="booking-form"]';

const doneTitle = (spec: AppSpec) =>
  spec.entities.find((e) => e.name === "booking")?.fields.find((f) => f.name === "status")?.default === "new"
    ? "Заявка на запись отправлена"
    : "Вы записаны";

/** GS-packages-1: a sold package is valid at once — remaining visits and the end date by the tariff. */
const sale: GoalProgram = async (t) => {
  t.step("Владелец заводит тариф и продаёт абонемент клиенту");
  await t.as("owner");
  const id = await sell(t, { phone: "+79990002345" });

  t.step("Абонемент в статусе «Действует»");
  const pkg = await row(t, ITEM, id);
  if (pkg.status !== "active")
    t.fail(`статус проданного абонемента «${String(pkg.status)}», ожидался «active»`);

  t.step("Остаток визитов и дата окончания заполнены по тарифу");
  if (has(t.spec, ITEM, "visits_left") && Number(pkg.visits_left) !== VISITS)
    t.fail(`остаток визитов ${String(pkg.visits_left)}, ожидалось ${VISITS}`);
  if (has(t.spec, ITEM, "expires_on") && !pkg.expires_on) t.fail("у абонемента нет даты окончания");
  if (pkg.phone !== "+79990002345") t.fail("абонемент не получил телефон клиента");

  t.step("Владелец открывает раздел абонементов в кабинете");
  await openSection(t, ITEM);
  await t.expectNear(t.marker, enumLabel(t.spec, ITEM, "status", "active"));
};

/** GS-packages-2: the visitor books with the package's contacts — a visit is written off. */
const writeOff: GoalProgram = async (t) => {
  t.step("Владелец продаёт клиенту абонемент на 4 визита");
  await t.as("owner");
  await ownService(t);
  const id = await sell(t, formContact(t));

  t.step("Посетитель записывается на странице записи с тем же телефоном и почтой");
  await t.as("visitor");
  await bookOnPage(t);
  await t.expectText(doneTitle(t.spec), { within: '[data-testid="booking-done"]', timeoutMs: 8_000 });

  t.step("Визит списан: остаток уменьшился, запись отмечена «Списан с абонемента»");
  await t.runJobs();
  const mine = await t.newRows("booking");
  if (mine.length !== 1) t.fail(`новых записей в базе ${mine.length}, ожидалась одна`);
  const booking = mine[0] as Record<string, unknown>;
  if (booking.package_status !== "written_off" || booking.client_package !== id)
    t.fail(
      "визит не списан с абонемента",
      `отметка записи: ${String(booking.package_status)}, статус: ${String(booking.status)}`,
    );
  const pkg = await row(t, ITEM, id);
  const visits = has(t.spec, ITEM, "visits_left");
  if (visits && Number(pkg.visits_left) !== VISITS - 1)
    t.fail(`остаток визитов ${String(pkg.visits_left)}, ожидалось ${VISITS - 1}`);

  t.step("Владелец открывает абонемент клиента");
  await t.as("owner");
  await openSection(t, ITEM);
  await t.expectNear(t.marker, visits ? String(VISITS - 1) : enumLabel(t.spec, ITEM, "status", "active"));
};

/** GS-packages-3: the package of these contacts has ended — the page refuses, nothing is booked or written off. */
const expired: GoalProgram = async (t) => {
  t.step("У клиента абонемент закончился");
  await t.as("owner");
  await ownService(t);
  const id = await sell(t, formContact(t));
  const ended = has(t.spec, ITEM, "expires_on") ? "expired" : "used_up";
  await patch(t, ITEM, id, { status: ended });

  t.step("Посетитель пытается записаться с телефоном и почтой этого клиента");
  await t.as("visitor");
  await bookOnPage(t);

  t.step("Посетитель видит, что действующего абонемента нет, и не записывается");
  await t.expectText("нет действующего", { within: FORM, timeoutMs: 8_000 });
  if ((await t.page.locator('[data-testid="booking-done"]').count()) > 0)
    t.fail("посетитель записался без действующего абонемента");

  t.step("Записи на это время нет, остаток абонемента не изменился");
  await t.runJobs();
  const mine = (await t.newRows("booking")).filter((b) => b.status !== "cancelled");
  if (mine.length) t.fail("запись без действующего абонемента сохранилась");
  const pkg = await row(t, ITEM, id);
  if (has(t.spec, ITEM, "visits_left") && Number(pkg.visits_left) !== VISITS)
    t.fail(`остаток закончившегося абонемента изменился: ${String(pkg.visits_left)}`);
};

const toClient = (m: GoalOutboxMessage, id: string) => {
  const p = m.payload as { recipient?: unknown; recordId?: unknown; template?: unknown } | null;
  return p?.recipient === "visitor" && p.recordId === id;
};

/** GS-packages-4: the client who agreed to letters gets the reminder before the end (or with one visit left). */
const reminder: GoalProgram = async (t) => {
  t.step("Владелец продаёт абонемент клиенту, который согласился на письма");
  await t.as("owner");
  const byDate = has(t.spec, ITEM, "ends_at");
  const id = await sell(t, { email: formContact(t).email }, { visits: 2, consent: true });

  t.step("Время сдвигается к дате напоминания (или остаётся последний визит)");
  if (byDate) await t.advance(31 * 1440);
  else {
    await create(t, "package_usage", { client_package: id, kind: "write_off" });
    await t.runJobs();
    await t.runJobs();
    const pkg = await row(t, ITEM, id);
    if (Number(pkg.visits_left) !== 1) t.fail(`после визита остаток ${String(pkg.visits_left)}, ожидался 1`);
  }

  t.step("Клиенту ушло письмо об окончании абонемента");
  const mail = t.outbox("email").filter((m) => toClient(m, id));
  if (mail.length === 0) {
    const all = t.outbox("email");
    t.fail(
      "письма клиенту об окончании абонемента нет в исходящих",
      all.length ? `в исходящих писем: ${all.length}` : "исходящих писем нет",
    );
  }
};

/** GS-packages-5: materials open only to a signed-in client with a valid package of his own. */
const materials: GoalProgram = async (t) => {
  const title = `Урок ${t.marker}`;
  await t.as("owner");
  await create(t, "package_material", { title, link: "https://example.test/lesson" });

  t.step("Посетитель открывает страницу материалов без входа");
  await t.as("visitor");
  await t.open("/materials");
  if ((await pageText(t)).includes(title)) t.fail("материал виден без входа");
  const anon = await t.api("POST", "/api/fn/myMaterials", { args: {} });
  if (anon.status < 400 && JSON.stringify(anon.body).includes(title)) t.fail("материалы отдаются без входа");

  t.step("Клиент входит в кабинет без абонемента и открывает материалы");
  const visitorRole = t.spec.permissions.find((p) => p.entity === ITEM && p.role !== "owner" && p.rowFilter);
  if (!visitorRole) return t.fail("у клиента нет доступа к своим абонементам");
  const key = Object.keys(visitorRole.rowFilter ?? {})[0] as string;
  await t.as({ role: visitorRole.role });
  // The client's contact: his own rows of the seed (packages, bookings) carry the contact he signs in with.
  let contact: string | null = null;
  for (const e of [ITEM, "booking"]) {
    const r = await t.api("GET", `/api/data/${e}?limit=5`);
    const items = (r.body as { items?: Record<string, unknown>[] } | null)?.items ?? [];
    const v = items.find((x) => typeof x[key] === "string")?.[key];
    if (typeof v === "string") {
      contact = v;
      break;
    }
  }
  if (!contact) return t.fail("не удалось узнать контакт клиента для проверки");
  await t.as("owner");
  const own = await t.api("GET", `/api/data/${ITEM}?limit=100&filter[${key}]=${encodeURIComponent(contact)}`);
  for (const p of (own.body as { items?: { id: string }[] } | null)?.items ?? [])
    await patch(t, ITEM, p.id, { status: has(t.spec, ITEM, "expires_on") ? "expired" : "used_up" });
  await t.as({ role: visitorRole.role });
  await t.open("/materials");
  await t.expectText("откроются", { timeoutMs: 8_000 });
  if ((await pageText(t)).includes(title)) t.fail("материал виден клиенту без действующего абонемента");

  t.step("Владелец продаёт клиенту абонемент");
  await t.as("owner");
  await sell(t, { [key]: contact });

  t.step("С действующим абонементом клиент видит материал и ссылку на него");
  await t.as({ role: visitorRole.role });
  await t.open("/materials");
  await t.expectText(title, { timeoutMs: 8_000 });
  const link = t.page.locator('a[href="https://example.test/lesson"]');
  if ((await link.count()) === 0)
    t.fail(`у материала нет ссылки «${fieldLabel(t.spec, "package_material", "link")}»`);
};

export const PACKAGES_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-packages-1": sale,
  "GS-packages-2": writeOff,
  "GS-packages-3": expired,
  "GS-packages-4": reminder,
  "GS-packages-5": materials,
};
