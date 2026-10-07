// Goal scenarios of the module «Каталог и прайс» (packages/modules/src/catalog, modules.yaml#catalog catalog): entity
// `service` {name, price, duration_min?, active, …}, the showcase /services, the cabinet section of the owner.
import type { GoalProgram, GoalRun } from "../types.js";
import {
  addRecord,
  blockText,
  component,
  formReady,
  openEntity,
  ownerRole,
  press,
  rubles,
  setFields,
  textOf,
} from "./shared.js";

const SHOWCASE = "/services";
const PRICE = 1500;
const CARD = '[data-testid="wz-itemcard"]';

/** The owner adds a visible item named by the run's marker (cabinet form). */
async function ownerAddsItem(
  t: GoalRun,
  values: Readonly<Record<string, string | boolean>> = {},
): Promise<void> {
  await t.as("owner");
  const area = await openEntity(t, ownerRole(t.spec), "service");
  const fields = t.spec.entities.find((e) => e.name === "service")?.fields ?? [];
  const has = (f: string) => fields.some((x) => x.name === f);
  await addRecord(t, area, {
    ...(has("price") ? { price: String(PRICE) } : {}),
    ...(has("active") ? { active: true } : {}),
    ...values,
  });
  const mine = (await t.newRows("service")).filter((r) => r.name === t.marker);
  if (mine.length !== 1)
    t.fail(
      `новых позиций с этим названием в базе ${mine.length}, ожидалась одна`,
      `новых позиций всего ${(await t.newRows("service")).length}`,
    );
}

/** The showcase as a visitor; the text of the item of this run or null. */
async function visitorSees(t: GoalRun): Promise<string | null> {
  await t.as("visitor");
  await t.open(SHOWCASE);
  return blockText(t, t.marker);
}

/** GS-catalog-1: an item with a price added in the cabinet is on the showcase with the price in rubles. */
const addedWithPrice: GoalProgram = async (t) => {
  t.step("Владелец в кабинете создаёт позицию с названием и ценой");
  await ownerAddsItem(t);

  t.step("Посетитель открывает раздел услуг на сайте");
  const card = await visitorSees(t);
  if (card === null) return t.fail("новой позиции нет на витрине");

  t.step("Позиция видна на витрине с ценой в рублях");
  if (!rubles(PRICE).test(card)) t.fail("у позиции на витрине нет цены в рублях", `на карточке: ${card}`);
};

/** GS-catalog-2: an item taken off the showcase in the cabinet is not shown to a visitor. */
const hiddenItem: GoalProgram = async (t) => {
  t.step("Владелец добавляет позицию на витрину");
  await ownerAddsItem(t);
  const id = (await t.newRows("service"))[0]?.id;

  t.step("Владелец снимает позицию с витрины");
  const area = await openEntity(t, ownerRole(t.spec), "service");
  const row = t.page
    .locator(`${area} [data-testid="wz-datatable-row"]`)
    .filter({ hasText: t.marker })
    .first();
  if ((await row.count()) === 0) t.fail("новой позиции нет в списке кабинета");
  await row.click();
  await t.settle();
  await press(t, "Изменить", area);
  await formReady(t, area);
  await setFields(t, area, { active: false });
  await t.submit(area);
  const error = await textOf(t, `${area} form [role="alert"]`);
  if (error) t.fail("изменение не сохранилось", error);
  const saved = (await t.rows("service")).find((r) => r.id === id);
  if (saved?.active !== false) t.fail("позиция осталась видимой в базе после снятия с витрины");

  t.step("Посетитель открывает раздел услуг");
  const card = await visitorSees(t);

  t.step("Скрытой позиции нет в списке");
  if (card !== null) t.fail("скрытая позиция видна посетителю на витрине", card);
  const api = await t.api("GET", "/api/data/service?limit=100");
  const items = ((api.body as { items?: { id?: unknown }[] } | null)?.items ?? []).map((r) => r.id);
  if (items.includes(id)) t.fail("скрытая позиция отдаётся посетителю через данные");
};

/** GS-catalog-3: the duration of an item is shown on the showcase («60 мин»). */
const duration: GoalProgram = async (t) => {
  t.step("Владелец указывает у позиции длительность 60 минут");
  await ownerAddsItem(t, { duration_min: "60" });

  t.step("Посетитель открывает раздел услуг");
  const card = await visitorSees(t);
  if (card === null) return t.fail("новой позиции нет на витрине");

  t.step("У позиции видно «60 мин»");
  if (!/60\s?мин/.test(card)) t.fail("у позиции на витрине не видно «60 мин»", `на карточке: ${card}`);
};

/** GS-catalog-4: «Выбрать» on the showcase leads to the lead form of the landing or to booking of the item. */
const chooseItem: GoalProgram = async (t) => {
  t.step("Посетитель открывает раздел услуг");
  await t.as("visitor");
  await t.open(SHOWCASE);
  let card = t.page.locator(CARD).first();
  await card.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {});
  if ((await card.count()) === 0) {
    t.step("На витрине пусто: владелец добавляет позицию");
    await ownerAddsItem(t);
    await t.as("visitor");
    await t.open(SHOWCASE);
    card = t.page.locator(CARD).first();
    if ((await card.count()) === 0) t.fail("на витрине нет карточек с кнопкой выбора");
  }

  t.step("Посетитель нажимает «Выбрать» у позиции");
  const cta = card.locator(`[data-testid="wz-itemcard-cta"], button`).first();
  if ((await cta.count()) === 0) t.fail("у карточки нет кнопки выбора");
  await cta.click();
  await t.page
    .waitForURL((u) => u.pathname !== SHOWCASE || u.hash !== "", { timeout: 5_000 })
    .catch(() => {});
  await t.settle();
  await t.page.waitForTimeout(300);

  t.step("Видна форма заявки на главной или запись на выбранную позицию");
  const url = new URL(t.page.url());
  if (url.pathname === "/booking") {
    const pressed = t.page.locator('[data-testid="booking-page"] [aria-pressed="true"]').first();
    if ((await pressed.count()) === 0) t.fail("страница записи открылась без выбранной позиции");
    return;
  }
  const form = t.page.locator(`${component("LeadForm")} form`).first();
  if ((await form.count()) === 0)
    t.fail("после «Выбрать» не видно формы заявки", `адрес ${url.pathname}${url.hash}`);
  const box = await form.boundingBox();
  if (!box || box.y >= t.viewport.height || box.y + box.height <= 0)
    t.fail("форма заявки не появилась на экране", box ? `верх формы ${Math.round(box.y)} px` : undefined);
};

export const CATALOG_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-catalog-1": addedWithPrice,
  "GS-catalog-2": hiddenItem,
  "GS-catalog-3": duration,
  "GS-catalog-4": chooseItem,
};
