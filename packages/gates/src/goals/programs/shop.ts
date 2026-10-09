// Goal scenarios of the module «Интернет-магазин» (packages/modules/src/shop, modules.yaml#catalog shop, V3-23): goods
// `product` (price, stock), orders `shop_order` from the checkout function, their lines, the payment journal
// `shop_payment` of the ЮKassa connector (the draft's mock payment page), the stock journal `stock_move`, self-pickup
// points `pickup_point` and the СДЭК quote of the passport's mock. The DOM contract is the same on the v2 pages (ui-kit
// ShopProducts, ShopCart, ShopCheckout, ShopOrder) and the v3 patterns (shop-*, cart-*, checkout-*, order-*): product
// cards wz-product[data-wz-product] with wz-cart-add, the checkout's fields wz-field-* (delivery radios, the pickup
// point select, the СДЭК city with wz-cdek-find and the point radios), the consent wz-consent, wz-checkout-submit, the
// order's wz-order-number, wz-order-status and wz-order-pay. The owner prepares goods through the data API.
import type { AppSpec } from "@wizard/appspec";
import type { GoalProgram, GoalRun } from "../types.js";
import { component, enumLabel, ownerRole, pageRoute, rendersComponent, setFields, textOf } from "./shared.js";

const PRODUCT = "product";
const ORDER = "shop_order";
const PAYMENT = "shop_payment";
const MOVE = "stock_move";
const POINT = "pickup_point";
const PRICE = 1250;

const has = (spec: AppSpec, entity: string, field?: string) =>
  spec.entities.some((e) => e.name === entity && (!field || e.fields.some((f) => f.name === field)));

type Method = "pickup" | "cdek" | "courier";

/** Delivery methods of the shop (the order's enum field), in its order. */
const methods = (spec: AppSpec): Method[] =>
  (spec.entities.find((e) => e.name === ORDER)?.fields.find((f) => f.name === "delivery")?.enum ?? []).map(
    (o) => o.value as Method,
  );

async function create(t: GoalRun, entity: string, data: Record<string, unknown>): Promise<string> {
  const r = await t.api("POST", `/api/data/${entity}`, data);
  const item = (r.body as { item?: { id?: string } } | null)?.item;
  if (r.status >= 300 || !item?.id)
    t.fail(
      `не удалось создать запись «${entity}»`,
      `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`,
    );
  return item.id;
}

async function row(t: GoalRun, entity: string, id: string): Promise<Record<string, unknown>> {
  const r = (await t.rows(entity)).find((x) => x.id === id);
  if (!r) t.fail(`записи «${entity}» нет в базе`);
  return r;
}

/** The public page that renders a component of the shop (the route `prefer` first: /shop, /cart). */
function publicPage(t: GoalRun, name: string, prefer: string): string {
  const pub = t.spec.roles.find((r) => r.access === "public")?.name;
  const pages = (t.spec.pages ?? []).filter(
    (p) => (!pub || p.roles.includes(pub)) && rendersComponent(t.files, p.file, name),
  );
  const p = pages.find((x) => x.route === prefer) ?? pages.find((x) => !x.route.includes(":")) ?? pages[0];
  if (!p) return t.fail(`на сайте нет страницы с блоком «${name}»`);
  return p.route;
}

interface Goods {
  product: string;
  name: string;
  point: string | null;
}

/** The owner puts a product of the run on sale (and a self-pickup point when the shop has them). */
async function goods(t: GoalRun, stock = 5): Promise<Goods> {
  await t.as("owner");
  const name = `Товар ${t.marker}`;
  const product = await create(t, PRODUCT, {
    name,
    price: PRICE,
    active: true,
    sort_order: 0,
    ...(has(t.spec, PRODUCT, "stock") ? { stock } : {}),
    ...(has(t.spec, PRODUCT, "weight_g") ? { weight_g: 500 } : {}),
  });
  const point = has(t.spec, POINT)
    ? await create(t, POINT, {
        name: `Пункт ${t.marker}`,
        address: "ул. Проверочная, 1",
        active: true,
        sort_order: 0,
      })
    : null;
  return { product, name, point };
}

/** The card of a product on the shop's page («Показать ещё» until it shows). */
async function card(t: GoalRun, product: string) {
  const sel = `[data-testid="wz-product"][data-wz-product="${product}"]`;
  for (let i = 0; i < 8; i++) {
    const c = t.page.locator(sel).first();
    if ((await c.count()) > 0) return c;
    const more = t.page.getByRole("button", { name: "Показать ещё", exact: true }).first();
    if ((await more.count()) === 0) break;
    await more.click();
    await t.settle();
  }
  const c = t.page.locator(sel).first();
  if ((await c.count()) === 0) t.fail("товара нет в магазине", await textOf(t, "main"));
  return c;
}

/** The visitor opens the shop and puts the product into the cart. */
async function addToCart(t: GoalRun, g: Goods): Promise<void> {
  await t.open(publicPage(t, "ShopProducts", "/shop"));
  const c = await card(t, g.product);
  const add = c.locator('[data-testid="wz-cart-add"]').first();
  if ((await add.count()) === 0) t.fail("у товара нет кнопки «В корзину»");
  if (await add.isDisabled())
    t.fail("кнопка «В корзину» недоступна", await textOf(t, `[data-wz-product="${g.product}"]`));
  await add.click();
  await t.settle();
  const inCart = await t.page.evaluate(() => window.localStorage.getItem("wz-cart:v1") ?? "");
  if (!inCart.includes(g.product)) t.fail("товар не попал в корзину");
}

interface Placed {
  order: string;
  /** The page went to the payment (online) — not paid yet. */
  paying: boolean;
}

const CHECKOUT = component("ShopCheckout");

/**
 * The visitor opens the cart, chooses the delivery (a self-pickup point of the run, the СДЭК point of the quote or the
 * courier's address), types his contacts, consents and sends the checkout (not waiting for its outcome).
 */
async function fillCheckout(
  t: GoalRun,
  g: Goods,
  method: Method,
  check?: () => Promise<void>,
): Promise<void> {
  await t.open(publicPage(t, "ShopCheckout", "/cart"));
  const line = t.page.locator(`[data-testid="wz-cart-line"][data-wz-product="${g.product}"]`).first();
  if ((await line.count()) === 0) t.fail("в корзине нет товара", await textOf(t, "main"));
  const form = t.page.locator(`${CHECKOUT} form`).first();
  try {
    await form.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    t.fail("на странице корзины нет формы оформления заказа");
  }
  if (methods(t.spec).length > 1) await setFields(t, CHECKOUT, { delivery: method });
  if (method === "pickup") {
    if (!g.point) t.fail("у магазина нет пунктов самовывоза");
    const select = t.page.locator(`${CHECKOUT} [data-testid="wz-field-pickup_point"] select`).first();
    const radio = t.page
      .locator(`${CHECKOUT} [data-testid="wz-field-pickup_point"] input[value="${g.point}"]`)
      .first();
    await t.page
      .waitForFunction(
        ([sel, id]) => !!document.querySelector(`${sel} option[value="${id}"], ${sel} input[value="${id}"]`),
        [`${CHECKOUT} [data-testid="wz-field-pickup_point"]`, g.point] as const,
        { timeout: 5_000 },
      )
      .catch(() => {});
    if ((await select.count()) > 0) await select.selectOption(g.point);
    else if ((await radio.count()) > 0) await radio.check({ force: true });
    else t.fail("пункта самовывоза нет в списке");
  }
  if (method === "courier") await setFields(t, CHECKOUT, { address: "г. Казань, ул. Тестовая, д. 1, кв. 2" });
  if (method === "cdek") {
    await setFields(t, CHECKOUT, { cdek_city: "Москва" });
    await t.page.locator(`${CHECKOUT} [data-testid="wz-cdek-find"]`).first().click();
    const points = t.page.locator(`${CHECKOUT} [data-testid="wz-field-cdek_point"] input[type="radio"]`);
    try {
      await points.first().waitFor({ state: "attached", timeout: 8_000 });
    } catch {
      t.fail("пункты выдачи СДЭК не появились", await textOf(t, CHECKOUT));
    }
    await points.first().check({ force: true });
    await t.settle();
  }
  await setFields(t, CHECKOUT, {
    name: `Покупатель ${t.marker}`,
    phone: t.contact.phone,
    email: t.contact.email,
  });
  if (check) await check();
  const consent = t.page.locator(`${CHECKOUT} [data-testid="wz-consent"] input[type="checkbox"]`).first();
  if ((await consent.count()) === 0)
    t.fail("в оформлении заказа нет согласия на обработку персональных данных");
  await consent.check({ force: true });
  await t.page.locator(`${CHECKOUT} [data-testid="wz-checkout-submit"]`).first().click();
}

/** fillCheckout, then the order by the address the page went to (the payment page or the order's page). */
async function placeOrder(
  t: GoalRun,
  g: Goods,
  method: Method,
  check?: () => Promise<void>,
): Promise<Placed> {
  await fillCheckout(t, g, method, check);
  const left = await t.page
    .waitForURL((u) => u.pathname.startsWith("/_wizard/pay-mock") || u.pathname.startsWith("/order/"), {
      timeout: 15_000,
    })
    .then(() => true)
    .catch(() => false);
  if (!left)
    t.fail(
      "заказ не оформился",
      (await textOf(t, `${CHECKOUT} [role="alert"]`)) || (await textOf(t, CHECKOUT)),
    );
  await t.settle();
  const url = new URL(t.page.url());
  const order = url.pathname.startsWith("/order/")
    ? decodeURIComponent(url.pathname.slice("/order/".length))
    : (url.searchParams.get("id") ?? "");
  if (!order) t.fail("не удалось узнать номер заказа", url.pathname);
  return { order, paying: url.pathname.startsWith("/_wizard/pay-mock") };
}

/** On the draft's payment page the visitor pays; the page goes back to the order. */
async function pay(t: GoalRun): Promise<void> {
  const confirm = t.page.locator('[data-testid="wz-pay-confirm"]').first();
  if ((await confirm.count()) === 0) t.fail("нет страницы оплаты");
  await confirm.click();
  const back = await t.page
    .waitForURL((u) => u.pathname.startsWith("/order/"), { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!back) t.fail("после оплаты страница заказа не открылась", await textOf(t, "body"));
  await t.settle();
}

/** The status the order's page shows (waits up to 8 s for `want`). */
async function orderStatus(t: GoalRun, want: string): Promise<void> {
  const el = t.page.locator('[data-testid="wz-order-status"]').first();
  for (let i = 0; i < 32; i++) {
    if (((await el.innerText().catch(() => "")) || "").trim() === want) return;
    await t.page.waitForTimeout(250);
  }
  t.fail(`на странице заказа нет статуса «${want}»`, await textOf(t, component("ShopOrder")));
}

const label = (t: GoalRun, value: string) => enumLabel(t.spec, ORDER, "status", value);

/** The method a scenario uses: pickup, else the courier, else СДЭК. */
const firstMethod = (spec: AppSpec): Method => {
  const all = methods(spec);
  return all.includes("pickup") ? "pickup" : all.includes("courier") ? "courier" : "cdek";
};

const cabinetOf = (t: GoalRun) => {
  const owner = ownerRole(t.spec);
  const route = t.spec.pages?.some((p) => p.route === "/cabinet" && p.roles.includes(owner))
    ? "/cabinet"
    : pageRoute(t.spec, owner);
  if (!route) t.fail("у владельца нет кабинета с заказами");
  return route;
};

/** GS-shop-1: the cart, the checkout and the payment on the payment page (the draft's mock of ЮKassa). */
const buyAndPay: GoalProgram = async (t) => {
  const g = await goods(t);
  t.step("Посетитель открывает магазин и нажимает «В корзину» у товара");
  await t.as("visitor");
  await addToCart(t, g);
  t.step("В корзине выбирает способ получения, пишет имя и телефон, даёт согласие");
  const method = firstMethod(t.spec);
  const placed = await placeOrder(t, g, method);
  t.step("Оформляет заказ и оплачивает его на странице оплаты (тестовый магазин)");
  if (!placed.paying) t.fail("после оформления не открылась страница оплаты");
  await pay(t);
  t.step("На странице заказа — его номер и статус «Оплачен»");
  const o = await row(t, ORDER, placed.order);
  await t.expectText(`№${String(o.number)}`, { within: component("ShopOrder") });
  await orderStatus(t, label(t, "paid"));
  t.step("Оплата заказа прошла, сумма — из цен магазина");
  const paid = await row(t, ORDER, placed.order);
  if (paid.status !== "paid") t.fail(`статус заказа «${String(paid.status)}», ожидался «paid»`);
  if (Math.round(Number(paid.items_total) * 100) !== PRICE * 100)
    t.fail("сумма товаров заказа не из цены магазина", String(paid.items_total));
  const pays = (await t.rows(PAYMENT)).filter((p) => p.shop_order === placed.order);
  if (!pays.some((p) => p.kind === "payment" && p.status === "succeeded"))
    t.fail("в журнале оплат нет прошедшей оплаты заказа");
  if (pays.some((p) => Math.round(Number(p.amount) * 100) !== Math.round(Number(paid.total) * 100)))
    t.fail("сумма оплаты не равна сумме заказа");
};

/** GS-shop-2: СДЭК — the city, the points of the passport's mock, the price and the term before the order. */
const cdekDelivery: GoalProgram = async (t) => {
  const g = await goods(t);
  t.step("Кладёт товар в корзину и выбирает доставку СДЭК");
  await t.as("visitor");
  await addToCart(t, g);
  t.step("Пишет город, находит пункты выдачи и выбирает один");
  let quote = "";
  const placed = await placeOrder(t, g, "cdek", async () => {
    quote = await textOf(t, `${CHECKOUT} [data-testid="wz-cdek-quote"]`);
  });
  t.step("До оформления видны стоимость и срок доставки СДЭК");
  if (!/₽/.test(quote) || !/дн/.test(quote)) t.fail("стоимость и срок доставки СДЭК не показаны", quote);
  t.step("В заказе — пункт выдачи СДЭК, стоимость доставки входит в сумму");
  const o = await row(t, ORDER, placed.order);
  if (o.delivery !== "cdek" || typeof o.cdek_point !== "string" || !o.cdek_point)
    t.fail("в заказе нет пункта выдачи СДЭК");
  const delivery = Math.round(Number(o.delivery_price) * 100);
  if (!(delivery > 0)) t.fail("стоимость доставки СДЭК не вошла в заказ");
  if (Math.round(Number(o.total) * 100) !== PRICE * 100 + delivery) t.fail("сумма заказа без доставки");
};

/** GS-shop-3: the stock of 1 piece is written off by the order; the product is «Нет в наличии», a second order fails. */
const stockOut: GoalProgram = async (t) => {
  t.step("Ставит у товара остаток 1 шт.");
  const g = await goods(t, 1);
  t.step("Покупает этот товар");
  await t.as("visitor");
  await addToCart(t, g);
  await placeOrder(t, g, firstMethod(t.spec));
  t.step("Остаток товара стал 0, списание есть в движении остатков");
  const p = await row(t, PRODUCT, g.product);
  if (Number(p.stock) !== 0) t.fail(`остаток товара ${String(p.stock)}, ожидался 0`);
  const moves = (await t.rows(MOVE)).filter((m) => m.product === g.product);
  if (!moves.some((m) => m.kind === "sale" && Number(m.qty) === -1))
    t.fail("списания нет в движении остатков");
  t.step("Снова открывает магазин");
  await t.open(publicPage(t, "ShopProducts", "/shop"));
  const c = await card(t, g.product);
  t.step("У товара «Нет в наличии», заказать его больше нельзя");
  const add = c.locator('[data-testid="wz-cart-add"]').first();
  if ((await add.count()) > 0 && !(await add.isDisabled()))
    t.fail("закончившийся товар можно положить в корзину");
  if (!/Нет в наличии/i.test((await c.innerText().catch(() => "")) || ""))
    t.fail("у закончившегося товара нет надписи «Нет в наличии»");
  // The page held the old stock: an order of the last piece from such a cart is refused by the server.
  await t.page.evaluate(
    ([id, name]) =>
      window.localStorage.setItem(
        "wz-cart:v1",
        JSON.stringify([{ id, name, price: 1250, qty: 1, max: null }]),
      ),
    [g.product, g.name] as const,
  );
  const before = (await t.rows(ORDER)).length;
  await fillCheckout(t, g, firstMethod(t.spec));
  await t.expectText("закончился", { within: CHECKOUT, timeoutMs: 8_000 });
  if ((await t.rows(ORDER)).length !== before) t.fail("заказ сверх остатка сохранился");
};

/** GS-shop-4: the owner's cabinet — the order with its number, status and sum, its payment, the product's stock. */
const ownerSees: GoalProgram = async (t) => {
  const g = await goods(t, 3);
  t.step("Оформляет заказ на сайте");
  await t.as("visitor");
  await addToCart(t, g);
  const placed = await placeOrder(t, g, firstMethod(t.spec));
  if (placed.paying) await pay(t);
  t.step("Контакты покупателя видит только магазин");
  const pageText = await textOf(t, "body");
  if (
    pageText.includes(t.contact.phone.replace(/\D/g, "").slice(-10)) ||
    pageText.includes(`Покупатель ${t.marker}`)
  )
    t.fail("страница заказа показывает контакты покупателя");
  const anon = await t.api("GET", `/api/data/${ORDER}`);
  if (anon.status < 400) t.fail("посетитель без входа читает заказы");
  const o = await row(t, ORDER, placed.order);
  t.step("Открывает кабинет: заказы, оплаты и товары");
  await t.as("owner");
  await t.open(`${cabinetOf(t)}?section=${ORDER}#${ORDER}`);
  t.step("Заказ виден с номером, статусом и суммой; у товара виден остаток");
  await t.expectNear(`Покупатель ${t.marker}`, label(t, String(o.status)));
  if (has(t.spec, PAYMENT)) {
    await t.open(`${cabinetOf(t)}?section=${PAYMENT}#${PAYMENT}`);
    await t.expectText(enumLabel(t.spec, PAYMENT, "status", "succeeded"));
  }
  await t.open(`${cabinetOf(t)}?section=${PRODUCT}#${PRODUCT}`);
  if (has(t.spec, PRODUCT, "stock")) await t.expectNear(g.name, "2");
  else await t.expectText(g.name);
};

/** GS-shop-5: an order not paid in time is cancelled and its goods are back in stock. */
const unpaidExpires: GoalProgram = async (t) => {
  const g = await goods(t, 2);
  t.step("Оформляет заказ и не оплачивает его");
  await t.as("visitor");
  await addToCart(t, g);
  const placed = await placeOrder(t, g, firstMethod(t.spec));
  const o = await row(t, ORDER, placed.order);
  if (o.status !== "awaiting_payment") t.fail(`статус нового заказа «${String(o.status)}»`);
  t.step("Время на оплату заканчивается");
  const until = Date.parse(String(o.pay_until ?? ""));
  const minutes = Number.isFinite(until) ? Math.ceil((until - t.now.getTime()) / 60_000) + 1 : 24 * 60;
  await t.advance(Math.max(1, minutes));
  await t.runJobs();
  t.step("Заказ в статусе «Отменён»");
  const late = await row(t, ORDER, placed.order);
  if (late.status !== "canceled") t.fail(`статус заказа «${String(late.status)}», ожидался «canceled»`);
  t.step("Остаток товара вернулся");
  if (has(t.spec, PRODUCT, "stock")) {
    const p = await row(t, PRODUCT, g.product);
    if (Number(p.stock) !== 2) t.fail(`остаток товара ${String(p.stock)}, ожидался 2`);
  }
};

/** GS-shop-6: without the payment on the site the order is placed and waits as «Новый». */
const offlineOrder: GoalProgram = async (t) => {
  const g = await goods(t);
  t.step("Кладёт товар в корзину и оформляет заказ");
  await t.as("visitor");
  await addToCart(t, g);
  const placed = await placeOrder(t, g, firstMethod(t.spec));
  if (placed.paying) t.fail("магазин без оплаты на сайте отправил покупателя платить");
  t.step("Покупатель видит номер заказа и статус «Новый»");
  const o = await row(t, ORDER, placed.order);
  await t.expectText(`№${String(o.number)}`, { within: component("ShopOrder") });
  await orderStatus(t, label(t, "new"));
  t.step("Заказ в кабинете в статусе «Новый»");
  await t.as("owner");
  await t.open(`${cabinetOf(t)}?section=${ORDER}#${ORDER}`);
  await t.expectNear(`Покупатель ${t.marker}`, label(t, "new"));
};

export const SHOP_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-shop-1": buyAndPay,
  "GS-shop-2": cdekDelivery,
  "GS-shop-3": stockOut,
  "GS-shop-4": ownerSees,
  "GS-shop-5": unpaidExpires,
  "GS-shop-6": offlineOrder,
};
