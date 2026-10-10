// Module «Интернет-магазин» (specs/modules/modules.yaml#catalog shop, origin: new, V3-23): goods with stock, the cart
// and the checkout, orders and their lines, payment through the built-in ЮKassa connector with a 54-FZ receipt by the
// order's lines, delivery by СДЭК to a pickup point (the passport's client: mock until the key passes its check),
// self-pickup or the shop's courier, the stock journal. The owner sees orders, their statuses, payments and the stock
// in the cabinet; the buyer's contacts are personal data (pii, three years, then cleared). On the v3 front the public
// screens are composed from the patterns shop-*, cart-*, checkout-* and order-*; on v2 they are pages.ts.
import type { ModuleManifest } from "@wizard/appspec";
import type { GenContext, ModuleContext, ModuleDefinition } from "../types.js";
import { CDEK_CLIENT_FILES, CDEK_CLIENT_REF } from "./cdek-client.js";
import {
  compileShop,
  SHOP_FUNCTIONS as F,
  SHOP_NAMES as N,
  SHOP_ROUTES as R,
  SOLD_STATUSES,
  shopOptions,
  shopStatusFlows,
} from "./compile.js";
import {
  CART_WEIGHT_FILE,
  CDEK_OPTIONS_FILE,
  cartWeightSource,
  cdekOptionsSource,
  EXPIRE_ORDER_FILE,
  expireOrderSource,
  ORDER_FILE,
  ORDER_PAID_FILE,
  orderPaidSource,
  orderSource,
  PLACE_ORDER_FILE,
  placeOrderSource,
  REFUND_FILE,
  RETURN_STOCK_FILE,
  refundSource,
  returnStockSource,
  SAVE_QUOTE_FILE,
  SET_STATUS_FILE,
  STOCK_ADJUST_FILE,
  saveQuoteSource,
  setStatusSource,
  stockAdjustSource,
} from "./functions.js";
import { cartPage, orderPage, productPage, shopPage } from "./pages.js";

/** Roles that open the public pages and call the public functions: everyone (the visitor's own cabinet included). */
const PUBLIC = ["$public", "$owner", "$staff", "$visitor"];
const CDEK = { param: "delivery", includes: "cdek" };
const sold = { status: [...SOLD_STATUSES] };
const permission = (text: string, role: string, entity: string, op: string, expect: string) => ({
  value: { text, check: { type: "permission", role, entity, op, expect } },
});

export const shopManifest: ModuleManifest = {
  id: "shop",
  version: 1,
  name: "Интернет-магазин",
  summary:
    "Товары с остатками, корзина и заказ на сайте, оплата через ЮKassa с чеком 54-ФЗ, доставка СДЭК, самовывоз или курьер; заказы и оплаты в кабинете",
  status: "ready",
  order: 35,
  origin: { kind: "new" },
  goals: ["sell_online"],
  requires: [
    {
      module: "notify",
      reason: "владелец узнаёт о заказах и оплатах, покупатель получает письмо с номером и ссылкой на заказ",
    },
  ],
  params: [
    { name: "product_label", label: "Как называть товар", type: "string", maxLength: 40, default: "Товар" },
    { name: "with_categories", label: "Разделы магазина", type: "bool", default: true },
    { name: "with_photos", label: "Фото товаров", type: "bool", default: true },
    {
      name: "with_stock",
      label: "Склад и остатки",
      type: "bool",
      default: true,
      description: "Заказ списывает остатки, закончившийся товар не купить; отмена возвращает товар на склад",
    },
    {
      name: "online_payment",
      label: "Оплата на сайте через ЮKassa",
      type: "bool",
      default: true,
      description: "Покупатель платит сразу после оформления, чек по 54-ФЗ отправляет ЮKassa",
    },
    {
      name: "vat",
      label: "НДС в чеке",
      type: "enum",
      options: [
        { value: "none", label: "Без НДС" },
        { value: "vat0", label: "НДС 0%" },
        { value: "vat10", label: "НДС 10%" },
        { value: "vat22", label: "НДС 22%" },
      ],
      default: "none",
    },
    {
      name: "delivery",
      label: "Способы получения",
      type: "enum_list",
      options: [
        { value: "pickup", label: "Самовывоз" },
        { value: "cdek", label: "СДЭК до пункта выдачи" },
        { value: "courier", label: "Курьер магазина" },
      ],
      minItems: 1,
      default: ["pickup", "cdek"],
    },
    {
      name: "courier_price",
      label: "Стоимость курьера, ₽",
      type: "int",
      min: 0,
      max: 10000,
      default: 300,
    },
    {
      name: "cdek_from_city",
      label: "Город отправки СДЭК",
      type: "string",
      maxLength: 80,
      default: "Москва",
    },
    {
      name: "parcel_weight_g",
      label: "Вес товара по умолчанию, г",
      type: "int",
      min: 50,
      max: 30000,
      default: 1000,
    },
    {
      name: "reserve_minutes",
      label: "Сколько ждать оплату, мин",
      type: "int",
      min: 15,
      max: 1440,
      default: 60,
      description: "Неоплаченный заказ отменяется, его товары возвращаются на склад",
    },
  ],
  links: [{ module: "staff", effect: "сотрудники с разделом «Магазин» собирают заказы и меняют остатки" }],
  provides: {
    entities: [N.order, N.payment, N.product, N.move, N.category, N.point, N.line, N.quote],
    routes: [R.shop, R.product, R.cart, R.order],
  },
  hook: true,
  fragments: {
    acceptance: [
      permission("Посетитель без входа видит товары", "$public", N.product, "read", "allow"),
      permission("Посетитель без входа не меняет товары и остатки", "$public", N.product, "update", "deny"),
      permission("Посетитель не создаёт заказ мимо оформления", "$public", N.order, "create", "deny"),
      permission("Посетитель не читает заказы", "$public", N.order, "read", "deny"),
      permission("Владелец видит заказы", "$owner", N.order, "read", "allow"),
      permission("Владелец меняет товары и остатки", "$owner", N.product, "update", "allow"),
    ],
  },
  functions: [
    {
      name: F.place,
      kind: "mutation",
      file: PLACE_ORDER_FILE,
      public: true,
      roles: PUBLIC,
      collectsPii: true,
      purpose: "заказ из корзины: цены, остатки и доставка — с сервера, списание остатков, номер заказа",
      systemDbReason:
        "Посетитель не меняет товары и не видит заказы: функция списывает остатки, создаёт заказ с ценами из каталога и отдаёт только его номер и сумму",
    },
    {
      name: F.order,
      kind: "query",
      file: ORDER_FILE,
      public: true,
      roles: PUBLIC,
      purpose: "страница заказа его покупателю по секрету заказа: товары, суммы, статус и доставка",
      systemDbReason:
        "Покупатель без входа не читает заказы: функция отдаёт заказ только по его секрету и без контактов покупателя",
    },
    {
      name: F.cdek,
      kind: "action",
      file: CDEK_OPTIONS_FILE,
      public: true,
      roles: PUBLIC,
      when: CDEK,
      purpose: "пункты выдачи СДЭК в городе покупателя и стоимость доставки посылки",
    },
    {
      name: "shopCartWeight",
      kind: "query",
      file: CART_WEIGHT_FILE,
      roles: ["$owner"],
      when: CDEK,
      purpose: "вес корзины для расчёта доставки СДЭК",
    },
    {
      name: F.saveQuote,
      kind: "mutation",
      file: SAVE_QUOTE_FILE,
      roles: ["$owner"],
      when: CDEK,
      purpose: "расчёт доставки СДЭК на 30 минут: заказ берёт цену из него, а не со страницы",
    },
    {
      name: F.returnStock,
      kind: "mutation",
      file: RETURN_STOCK_FILE,
      roles: ["$owner"],
      when: { param: "with_stock" },
      purpose: "отменённый заказ один раз возвращает свои товары на склад",
    },
    {
      name: F.paid,
      kind: "mutation",
      file: ORDER_PAID_FILE,
      roles: ["$owner"],
      when: { param: "with_stock" },
      purpose: "заказ, оплаченный после отмены, снова списывает свои товары",
    },
    {
      name: F.setStatus,
      kind: "mutation",
      file: SET_STATUS_FILE,
      // Called by the cabinet's buttons (POST /api/fn): only the shop's roles.
      public: true,
      roles: ["$owner", "$staff"],
      purpose: "статус заказа меняется только по допустимым переходам; оплату и возврат ставит ЮKassa",
      systemDbReason:
        "Статус заказа закрыт для прямой правки: функция меняет его только по переходам магазина, оплату и возврат ставит ЮKassa",
    },
    {
      name: F.refund,
      kind: "action",
      file: REFUND_FILE,
      public: true,
      roles: ["$owner"],
      when: { param: "online_payment" },
      purpose: "владелец возвращает покупателю всю сумму оплаченного заказа через ЮKassa",
    },
    {
      name: F.expire,
      kind: "mutation",
      file: EXPIRE_ORDER_FILE,
      roles: ["$owner"],
      when: { param: "online_payment" },
      purpose: "заказ без оплаты отменяется по времени, если платёж не идёт и не ждёт проверки",
    },
    {
      name: F.stockAdjust,
      kind: "mutation",
      file: STOCK_ADJUST_FILE,
      roles: ["$owner"],
      when: { param: "with_stock" },
      purpose: "ручная правка остатка в кабинете попадает в журнал движения остатков",
    },
  ],
  screens: [
    {
      id: "shop",
      audience: "public",
      route: R.shop,
      title: "Магазин",
      roles: PUBLIC,
      components: ["LandingSection", "ShopProducts"],
      nav: true,
    },
    {
      id: "product",
      audience: "public",
      route: R.product,
      title: "Товар",
      roles: PUBLIC,
      components: ["LandingSection", "ShopProduct"],
    },
    {
      id: "cart",
      audience: "public",
      route: R.cart,
      title: "Корзина",
      roles: PUBLIC,
      components: ["LandingSection", "ShopCart", "ShopCheckout"],
      nav: true,
    },
    {
      id: "order",
      audience: "public",
      route: R.order,
      title: "Заказ",
      roles: PUBLIC,
      components: ["LandingSection", "ShopOrder"],
    },
    {
      id: "orders",
      audience: "cabinet",
      route: "/cabinet",
      title: "Магазин",
      roles: ["$owner", "$staff"],
      components: ["CabinetLayout", "DataTable", "RecordCard", "RecordForm"],
    },
  ],
  metrics: [
    {
      id: "orders_sold",
      label: "Продано заказов",
      goal: "sell_online",
      unit: "count",
      better: "up",
      compute: { kind: "count", entity: N.order, dateField: "created_at", where: sold },
    },
    {
      id: "revenue",
      label: "Выручка магазина",
      goal: "sell_online",
      unit: "rub",
      better: "up",
      compute: { kind: "sum", entity: N.order, field: "total", dateField: "created_at", where: sold },
    },
    {
      id: "average_order",
      label: "Средний чек",
      goal: "sell_online",
      unit: "rub",
      better: "up",
      compute: { kind: "avg", entity: N.order, field: "total", dateField: "created_at", where: sold },
    },
  ],
  goalScenarios: [
    {
      id: "GS-shop-1",
      goal: "sell_online",
      title: "Посетитель кладёт товар в корзину, оформляет заказ и оплачивает его через ЮKassa",
      when: { param: "online_payment" },
      steps: [
        { actor: "visitor", text: "Открывает магазин и нажимает «В корзину» у товара" },
        { actor: "visitor", text: "В корзине выбирает способ получения, пишет имя и телефон, даёт согласие" },
        { actor: "visitor", text: "Оформляет заказ и оплачивает его на странице оплаты (тестовый магазин)" },
      ],
      expect: [
        { kind: "page_text", text: "На странице заказа — его номер и статус «Оплачен»" },
        {
          kind: "record",
          text: "Оплата заказа прошла, сумма — из цен магазина; чек 54-ФЗ — по позициям заказа",
        },
      ],
    },
    {
      id: "GS-shop-2",
      goal: "sell_online",
      title: "Посетитель выбирает доставку СДЭК: пункт выдачи, цену и срок",
      when: CDEK,
      steps: [
        { actor: "visitor", text: "Кладёт товар в корзину и выбирает доставку СДЭК" },
        { actor: "visitor", text: "Пишет город, находит пункты выдачи и выбирает один" },
        { actor: "visitor", text: "Оформляет заказ" },
      ],
      expect: [
        { kind: "page_text", text: "До оформления видны стоимость и срок доставки СДЭК" },
        { kind: "record", text: "В заказе — пункт выдачи СДЭК, стоимость доставки входит в сумму" },
      ],
    },
    {
      id: "GS-shop-3",
      goal: "sell_online",
      title: "Закончившийся товар не купить, заказ списывает остатки",
      when: { param: "with_stock" },
      steps: [
        { actor: "owner", text: "Ставит у товара остаток 1 шт." },
        { actor: "visitor", text: "Покупает этот товар" },
        { actor: "visitor", text: "Снова открывает магазин" },
      ],
      expect: [
        { kind: "record", text: "Остаток товара стал 0, списание есть в движении остатков" },
        { kind: "denied", text: "У товара «Нет в наличии», заказать его больше нельзя" },
      ],
    },
    {
      id: "GS-shop-4",
      goal: "sell_online",
      title: "Владелец видит заказы, их статусы, оплаты и остатки в кабинете",
      steps: [
        { actor: "visitor", text: "Оформляет заказ на сайте" },
        { actor: "owner", text: "Открывает кабинет: заказы, оплаты и товары" },
      ],
      expect: [
        { kind: "record", text: "Заказ виден с номером, статусом и суммой; у товара виден остаток" },
        { kind: "page_text", text: "Контакты покупателя видит только магазин" },
      ],
    },
    {
      id: "GS-shop-5",
      goal: "sell_online",
      title: "Неоплаченный заказ отменяется по времени, товар возвращается на склад",
      when: { param: "online_payment" },
      steps: [
        { actor: "visitor", text: "Оформляет заказ и не оплачивает его" },
        { actor: "system", text: "Время на оплату заканчивается" },
      ],
      expect: [
        { kind: "status", text: "Заказ в статусе «Отменён»" },
        { kind: "record", text: "Остаток товара вернулся" },
      ],
    },
    {
      id: "GS-shop-6",
      goal: "sell_online",
      title: "Заказ без оплаты на сайте оформляется и ждёт магазин",
      when: { param: "online_payment", equals: false },
      steps: [
        { actor: "visitor", text: "Кладёт товар в корзину и оформляет заказ" },
        { actor: "owner", text: "Открывает заказы в кабинете" },
      ],
      expect: [
        { kind: "page_text", text: "Покупатель видит номер заказа и статус «Новый»" },
        { kind: "status", text: "Заказ в кабинете в статусе «Новый»" },
      ],
    },
  ],
  tests: {
    matrix: [
      { name: "по умолчанию: самовывоз и СДЭК, оплата ЮKassa, склад", params: {}, withModules: ["notify"] },
      {
        name: "без онлайн-оплаты и склада: самовывоз и курьер",
        params: { online_payment: false, with_stock: false, delivery: ["pickup", "courier"] },
        withModules: ["notify"],
      },
      {
        name: "только СДЭК, без разделов и фото, НДС 22%",
        params: { delivery: ["cdek"], with_categories: false, with_photos: false, vat: "vat22" },
        withModules: ["notify"],
      },
      {
        name: "магазин рядом с лендингом и заявками",
        params: { delivery: ["pickup", "courier"], product_label: "Букет" },
        withModules: ["landing", "leads", "notify"],
      },
      { name: "сотрудники собирают заказы", params: {}, withModules: ["staff", "notify"] },
    ],
    gates: ["G0", "G1"],
  },
};

/** Notes for the plan screen. */
export function shopWarnings(ctx: ModuleContext): string[] {
  const o = shopOptions(ctx.params);
  const out: string[] = [];
  if (o.online)
    out.push(
      "Оплата на сайте заработает после ключей ЮKassa (shopId и секретный ключ; для черновика — тестовый магазин). Чеки по 54-ФЗ включаются в личном кабинете ЮKassa. Адрес HTTP-уведомлений для кабинета ЮKassa — на странице /_wizard/payments опубликованной системы (вход владельцем).",
    );
  if (o.delivery.includes("cdek"))
    out.push(
      "Доставка СДЭК считает цены по тестовым данным, пока вы не подключите ключ СДЭК (Account и Secure password) — до этого не публикуйте магазин с доставкой СДЭК.",
    );
  out.push(
    "Оферта, «Доставка и оплата» и «Возврат» (/offer, /delivery, /returns) собираются из реквизитов продавца: перед публикацией укажите название, ИНН и адрес (ОГРН или ОГРНИП — если есть) в данных оператора персональных данных.",
  );
  return out;
}

export const shopModule: ModuleDefinition = {
  manifest: shopManifest,
  compile: compileShop,
  screens: { shop: shopPage, product: productPage, cart: cartPage, order: orderPage },
  files: {
    [PLACE_ORDER_FILE]: placeOrderSource,
    [ORDER_FILE]: orderSource,
    [CDEK_OPTIONS_FILE]: cdekOptionsSource,
    [CART_WEIGHT_FILE]: cartWeightSource,
    [SAVE_QUOTE_FILE]: saveQuoteSource,
    [RETURN_STOCK_FILE]: returnStockSource,
    [ORDER_PAID_FILE]: orderPaidSource,
    [SET_STATUS_FILE]: setStatusSource,
    [REFUND_FILE]: refundSource,
    [EXPIRE_ORDER_FILE]: expireOrderSource,
    [STOCK_ADJUST_FILE]: stockAdjustSource,
    // The СДЭК client of the passport in mock mode, only with СДЭК delivery (the integration layer may replace it).
    ...Object.fromEntries(
      Object.entries(CDEK_CLIENT_FILES).map(([path, src]) => [
        path,
        (ctx: GenContext) => (shopOptions(ctx.params).delivery.includes("cdek") ? src : ""),
      ]),
    ),
  },
  warnings: shopWarnings,
  statusFlows: shopStatusFlows,
};

/** The СДЭК client files the module ships (functions/integrations/cdek/**) when its delivery includes СДЭК. */
export { CDEK_CLIENT_FILES, CDEK_CLIENT_REF };
