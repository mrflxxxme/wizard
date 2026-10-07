// Goal scenarios of the module «Клиенты с историей» (packages/modules/src/client_card, modules.yaml#catalog
// client_card): entity `client` {name, phone, email, …}, the page «Клиенты и история» (/clients) — the clients list and
// the card with the history of the client's records in the other modules (bookings, leads, deals).
import type { GoalProgram, GoalRun } from "../types.js";
import { bookVisit } from "./booking.js";
import {
  addRecord,
  entityPage,
  formReady,
  leaveLead,
  ownerRole,
  pageText,
  press,
  seedTexts,
  setFields,
  textOf,
} from "./shared.js";

const CARD = 'section[aria-label="Карточка"]';
const ROW = '[data-testid="wz-datatable-row"]';

/** The owner's page with the clients and their history. */
function clientsPage(t: GoalRun): string {
  const page = entityPage(t, ownerRole(t.spec), "client", "/clients");
  if (!page) return t.fail("у владельца нет страницы «Клиенты и история»");
  return page.route;
}

/** Clients created by the run: its contact or its marker as the name. */
async function myClients(t: GoalRun): Promise<Record<string, unknown>[]> {
  const digits = t.contact.phone.slice(-10);
  return (await t.newRows("client")).filter(
    (c) =>
      c.name === t.marker ||
      String(c.email ?? "").toLowerCase() === t.contact.email ||
      String(c.phone ?? "")
        .replace(/\D/g, "")
        .endsWith(digits),
  );
}

/** The owner opens «Клиенты и история» and the card of the client of this run; returns the history rows showing `text`. */
async function openCard(t: GoalRun, name: string, text: string): Promise<number> {
  await t.as("owner");
  await t.open(clientsPage(t));
  const row = t.page.locator(ROW).filter({ hasText: name }).first();
  try {
    await row.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    t.fail("клиента нет в списке клиентов", await textOf(t, "body"));
  }
  await row.click();
  await t.settle();
  const card = t.page.locator(CARD).first();
  try {
    await card.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    t.fail("карточка клиента не открылась");
  }
  const history = card.locator(ROW).filter({ hasText: text });
  await history
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => {});
  return history.count();
}

/** One client of the run's contact (no duplicate). */
async function oneClient(t: GoalRun): Promise<Record<string, unknown>> {
  await t.runJobs();
  const mine = await myClients(t);
  if (mine.length !== 1) return t.fail(`клиентов с этим контактом ${mine.length}, ожидался один`);
  return mine[0] as Record<string, unknown>;
}

/** GS-client_card-1: two bookings with one contact — one client, both visits with dates in the card. */
const twoVisits: GoalProgram = async (t) => {
  t.step("Посетитель дважды записывается с одним и тем же контактом");
  await bookVisit(t);
  await bookVisit(t);

  t.step("Клиент один, без дубля");
  const client = await oneClient(t);

  t.step("Владелец открывает клиента: в карточке обе записи с датами");
  const rows = await openCard(t, String(client.name), t.marker);
  if (rows < 2) t.fail(`в карточке клиента записей ${rows}, ожидались обе`);
  const texts = await t.page.locator(CARD).first().locator(ROW).filter({ hasText: t.marker }).allInnerTexts();
  if (!texts.every((x) => /\d{2}\.\d{2}\.\d{4}/.test(x))) t.fail("у записей в карточке клиента нет дат");
};

/** GS-client_card-2: two leads with one phone — one client, both leads in the card's «Заявки». */
const twoLeads: GoalProgram = async (t) => {
  t.step("Посетитель дважды оставляет заявку с одним и тем же телефоном");
  await t.as("visitor");
  await leaveLead(t);
  await leaveLead(t);

  t.step("Клиент один, без дубля");
  const client = await oneClient(t);

  t.step("Владелец открывает «Клиенты и история» и выбирает клиента: обе заявки в карточке");
  const rows = await openCard(t, String(client.name), t.marker);
  if (rows < 2) t.fail(`в разделе «Заявки» карточки заявок ${rows}, ожидались обе`);
};

/** GS-client_card-3: a deal with the client chosen is in the «Сделки» of the client's card. */
const dealInCard: GoalProgram = async (t) => {
  t.step("Владелец добавляет клиента");
  await t.as("owner");
  await t.open(clientsPage(t));
  await addRecord(t, 'section[aria-label="Клиенты"]');
  const client = (await t.newRows("client")).find((c) => c.name === t.marker);
  if (!client) return t.fail("новый клиент не сохранился");

  t.step("Владелец создаёт сделку и выбирает в ней клиента");
  const board = entityPage(t, ownerRole(t.spec), "deal", "/deals");
  if (!board) return t.fail("у владельца нет доски сделок");
  await t.open(board.route);
  await press(t, "Добавить");
  await formReady(t, "body");
  await t.fillForm("body");
  await setFields(t, "body", { client: String(client.id) });
  await t.submit("body");
  const deal = (await t.newRows("deal")).find((d) => d.title === t.marker);
  if (!deal) return t.fail("сделка не сохранилась", await textOf(t, 'form [role="alert"]'));
  if (deal.client !== client.id) t.fail("в сделке не сохранился выбранный клиент");

  t.step("Владелец открывает карточку клиента: в разделе «Сделки» есть эта сделка");
  // The card shows the client's name (the marker) once and the deal's title (the marker too) in its rows.
  const rows = await openCard(t, t.marker, t.marker);
  if (rows < 1) t.fail("в разделе «Сделки» карточки нет этой сделки");
};

/** GS-client_card-4: without signing in, the clients page and data are closed. */
const clientsClosed: GoalProgram = async (t) => {
  t.step("Посетитель открывает адрес страницы клиентов без входа");
  await t.as("visitor");
  await t.open(clientsPage(t));

  t.step("Страница и данные клиентов недоступны без входа");
  const text = await pageText(t);
  const leaked = seedTexts(t, "client").find((v) => text.includes(v));
  if (leaked) t.fail("посетитель без входа видит данные клиента на экране");
  const r = await t.api("GET", "/api/data/client?limit=5");
  if (r.status !== 401 && r.status !== 403) t.fail(`клиенты отдаются без входа (HTTP ${r.status})`);
};

export const CLIENT_CARD_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-client_card-1": twoVisits,
  "GS-client_card-2": twoLeads,
  "GS-client_card-3": dealInCard,
  "GS-client_card-4": clientsClosed,
};
