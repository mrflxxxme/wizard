// compile.ts of «Интернет-магазин» (manifest.hook, V3-23): goods with stock, orders with their lines, payments through
// the built-in ЮKassa connector (54-FZ receipt by the lines, the buyer's secret of an order a visitor pays without
// login), self-pickup points, delivery by СДЭК (a quote the module computes on the server) or the shop's courier, the
// stock journal. Canonical names (the v3 front, the goal programs and the integration layer rely on them): SHOP_NAMES,
// SHOP_ROUTES, SHOP_FUNCTIONS, SHOP_PAYMENT.
import type { Entity, Field, ModuleFragments, Workflow } from "@wizard/appspec";
import type { ModuleContext } from "../types.js";

/** Entities and fields of the module contract. */
export const SHOP_NAMES = {
  product: "product",
  category: "product_category",
  order: "shop_order",
  line: "shop_order_line",
  payment: "shop_payment",
  move: "stock_move",
  point: "pickup_point",
  quote: "delivery_quote",
} as const;

/** Public screens: the goods, the cart with the checkout, the order of a buyer. */
export const SHOP_ROUTES = { shop: "/shop", cart: "/cart", order: "/order/:id" } as const;

/** Functions of the module (the v3 headless hooks and the goal programs call them by name). */
export const SHOP_FUNCTIONS = {
  place: "shopPlaceOrder",
  order: "shopOrder",
  cdek: "shopCdekOptions",
  saveQuote: "shopSaveQuote",
  returnStock: "shopReturnStock",
  paid: "shopOrderPaid",
} as const;

/** The ЮKassa connector integration and its binding (POST /api/pay/shop_pay {binding: "order"}). */
export const SHOP_PAYMENT = { integration: "shop_pay", binding: "order" } as const;

/** Statuses of an order; awaiting_payment and refunded exist only with the online payment. */
export const ORDER_STATUSES = [
  { value: "awaiting_payment", label: "Ждёт оплаты" },
  { value: "new", label: "Новый" },
  { value: "paid", label: "Оплачен" },
  { value: "assembling", label: "Собирается" },
  { value: "ready", label: "Готов к выдаче" },
  { value: "shipped", label: "Передан в доставку" },
  { value: "done", label: "Выполнен" },
  { value: "canceled", label: "Отменён" },
  { value: "refunded", label: "Возврат оплаты" },
] as const;

/** Statuses of an order that count as a sale (the goal panel). */
export const SOLD_STATUSES = ["paid", "assembling", "ready", "shipped", "done"] as const;

export const DELIVERY_METHODS = [
  { value: "pickup", label: "Самовывоз" },
  { value: "cdek", label: "СДЭК, пункт выдачи" },
  { value: "courier", label: "Курьер" },
] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number]["value"];

/** VAT of the goods → ЮKassa vat_code (connectors/yookassa.yaml#receipts_54fz.vat_code_values). */
export const VAT_CODES = { none: 1, vat0: 2, vat10: 3, vat22: 11 } as const;

/** Parameters with defaults as the hook, the functions and the screens read them. */
export interface ShopOptions {
  productLabel: string;
  withCategories: boolean;
  withPhotos: boolean;
  withStock: boolean;
  online: boolean;
  vatCode: number;
  delivery: DeliveryMethod[];
  courierPrice: number;
  cdekFromCity: string;
  parcelWeight: number;
  reserveMinutes: number;
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function shopOptions(params: Readonly<Record<string, unknown>>): ShopOptions {
  const known = new Set<string>(DELIVERY_METHODS.map((d) => d.value));
  const delivery = (Array.isArray(params.delivery) ? params.delivery : ["pickup", "cdek"]).filter(
    (d): d is DeliveryMethod => typeof d === "string" && known.has(d),
  );
  return {
    productLabel: String(params.product_label ?? "Товар"),
    withCategories: params.with_categories !== false,
    withPhotos: params.with_photos !== false,
    withStock: params.with_stock !== false,
    online: params.online_payment !== false,
    vatCode: VAT_CODES[String(params.vat ?? "none") as keyof typeof VAT_CODES] ?? 1,
    delivery: delivery.length ? delivery : ["pickup"],
    courierPrice: num(params.courier_price, 300),
    cdekFromCity: String(params.cdek_from_city ?? "Москва"),
    parcelWeight: num(params.parcel_weight_g, 1000),
    reserveMinutes: num(params.reserve_minutes, 60),
  };
}

const N = SHOP_NAMES;
const pii = (kind: NonNullable<Field["piiKind"]>): Pick<Field, "pii" | "piiKind"> => ({
  pii: "basic",
  piiKind: kind,
});

/** Fields of a product in the order of the cabinet's table: name, price, stock, section, on sale, description. */
export function productFields(o: ShopOptions): Field[] {
  return [
    { name: "name", label: "Название", type: "string", required: true, maxLength: 120 },
    { name: "price", label: "Цена, ₽", type: "money", required: true, min: 0 },
    ...(o.withStock
      ? [
          {
            name: "stock",
            label: "В наличии, шт.",
            type: "int",
            required: true,
            default: 0,
            min: 0,
            max: 1000000,
          } satisfies Field,
        ]
      : []),
    ...(o.withCategories
      ? [
          {
            name: "category",
            label: "Раздел",
            type: "ref",
            ref: { entity: N.category, onDelete: "set_null" },
          } satisfies Field,
        ]
      : []),
    { name: "active", label: "В продаже", type: "bool", required: true, default: true },
    { name: "description", label: "Описание", type: "text", maxLength: 1000 },
    ...(o.withPhotos ? [{ name: "photo", label: "Фото", type: "image" } satisfies Field] : []),
    { name: "sku", label: "Артикул", type: "string", maxLength: 50 },
    ...(o.delivery.includes("cdek")
      ? [{ name: "weight_g", label: "Вес, г", type: "int", min: 1, max: 100000 } satisfies Field]
      : []),
    { name: "sort_order", label: "Порядок в каталоге", type: "int", min: 0, max: 9999 },
  ];
}

/** Fields of an order: number, status, sum, delivery and the buyer first (the cabinet's columns). */
export function orderFields(o: ShopOptions): Field[] {
  const statuses = ORDER_STATUSES.filter(
    (s) => o.online || (s.value !== "awaiting_payment" && s.value !== "refunded"),
  );
  const has = (d: DeliveryMethod) => o.delivery.includes(d);
  return [
    { name: "number", label: "Номер", type: "int", required: true, unique: true, min: 1 },
    {
      name: "status",
      label: "Статус",
      type: "enum",
      required: true,
      default: o.online ? "awaiting_payment" : "new",
      enum: statuses.map((s) => ({ ...s })),
    },
    { name: "total", label: "Сумма, ₽", type: "money", required: true, min: 0 },
    {
      name: "delivery",
      label: "Доставка",
      type: "enum",
      required: true,
      enum: DELIVERY_METHODS.filter((d) => has(d.value)).map((d) => ({ ...d })),
    },
    { name: "name", label: "Покупатель", type: "string", required: true, maxLength: 120, ...pii("fio") },
    { name: "phone", label: "Телефон", type: "phone", required: true, ...pii("phone") },
    { name: "email", label: "Почта (для чека)", type: "email", ...pii("email") },
    { name: "items_summary", label: "Состав заказа", type: "string", maxLength: 600 },
    { name: "items_total", label: "Товары, ₽", type: "money", min: 0 },
    { name: "delivery_price", label: "Доставка, ₽", type: "money", min: 0 },
    ...(has("pickup")
      ? [
          {
            name: "pickup_point",
            label: "Пункт самовывоза",
            type: "ref",
            ref: { entity: N.point, onDelete: "set_null" },
          } satisfies Field,
        ]
      : []),
    ...(has("cdek")
      ? ([
          { name: "cdek_city", label: "Город СДЭК", type: "string", maxLength: 80 },
          { name: "cdek_point", label: "Пункт выдачи СДЭК (код)", type: "string", maxLength: 40 },
          { name: "cdek_point_address", label: "Адрес пункта СДЭК", type: "string", maxLength: 300 },
          { name: "cdek_days", label: "Срок доставки СДЭК", type: "string", maxLength: 40 },
          { name: "track_number", label: "Трек-номер", type: "string", maxLength: 40 },
        ] satisfies Field[])
      : []),
    ...(has("courier")
      ? [
          {
            name: "address",
            label: "Адрес доставки",
            type: "string",
            maxLength: 300,
            ...pii("address"),
          } satisfies Field,
        ]
      : []),
    { name: "comment", label: "Комментарий покупателя", type: "text", maxLength: 1000, ...pii("free_text") },
    // The shop's own note; the module writes there what needs the owner (goods short after a late payment).
    { name: "note", label: "Заметка магазина", type: "string", maxLength: 300, ...pii("free_text") },
    ...(o.online ? [{ name: "pay_until", label: "Оплатить до", type: "datetime" } satisfies Field] : []),
    ...(o.withStock
      ? [{ name: "stock_returned", label: "Остатки возвращены", type: "bool" } satisfies Field]
      : []),
    { name: "token", label: "Ключ покупателя", type: "string", maxLength: 64 },
  ];
}

/** Fields the module's functions keep: never typed in the cabinet. */
export function orderReadonly(o: ShopOptions): string[] {
  return [
    "number",
    "total",
    "delivery",
    "items_summary",
    "items_total",
    "delivery_price",
    ...(o.delivery.includes("pickup") ? ["pickup_point"] : []),
    ...(o.delivery.includes("cdek") ? ["cdek_city", "cdek_point", "cdek_point_address", "cdek_days"] : []),
    ...(o.online ? ["pay_until"] : []),
    ...(o.withStock ? ["stock_returned"] : []),
  ];
}

export function compileShop(ctx: ModuleContext): ModuleFragments {
  const o = shopOptions(ctx.params);
  const cdek = o.delivery.includes("cdek");
  const pickup = o.delivery.includes("pickup");
  const entities: Entity[] = [];
  if (o.withCategories)
    entities.push({
      name: N.category,
      label: "Раздел магазина",
      fields: [
        { name: "name", label: "Название", type: "string", required: true, maxLength: 80 },
        { name: "sort_order", label: "Порядок в каталоге", type: "int", min: 0, max: 9999 },
      ],
    });
  entities.push({
    name: N.product,
    label: o.productLabel,
    fields: productFields(o),
    indexes: [{ fields: ["active", "sort_order"] }, ...(o.withCategories ? [{ fields: ["category"] }] : [])],
  });
  if (pickup)
    entities.push({
      name: N.point,
      label: "Пункт самовывоза",
      fields: [
        { name: "name", label: "Название", type: "string", required: true, maxLength: 80 },
        { name: "address", label: "Адрес", type: "string", required: true, maxLength: 200 },
        { name: "hours", label: "Часы работы", type: "string", maxLength: 120 },
        { name: "active", label: "Работает", type: "bool", required: true, default: true },
        { name: "sort_order", label: "Порядок в списке", type: "int", min: 0, max: 9999 },
      ],
    });
  entities.push(
    {
      name: N.order,
      label: "Заказ",
      fields: orderFields(o),
      indexes: [{ fields: ["status"] }, { fields: ["phone"] }],
      // The buyer's name and contacts are personal data: three years after the order they are cleared, the order
      // itself stays for the shop's accounting (54-FZ receipts live at the fiscal data operator).
      retention: { deleteAfterDays: 1095, anchorField: "created_at", mode: "anonymize" },
    },
    {
      name: N.line,
      label: "Позиция заказа",
      fields: [
        {
          name: "shop_order",
          label: "Заказ",
          type: "ref",
          required: true,
          ref: { entity: N.order, onDelete: "cascade" },
        },
        { name: "name", label: "Товар", type: "string", required: true, maxLength: 120 },
        { name: "qty", label: "Количество", type: "int", required: true, min: 1, max: 999 },
        { name: "price", label: "Цена, ₽", type: "money", required: true, min: 0 },
        { name: "sum", label: "Сумма, ₽", type: "money", required: true, min: 0 },
        {
          name: "product",
          label: o.productLabel,
          type: "ref",
          ref: { entity: N.product, onDelete: "set_null" },
        },
      ],
      indexes: [{ fields: ["shop_order"] }],
    },
  );
  if (o.online)
    entities.push({
      name: N.payment,
      label: "Оплата",
      fields: [
        {
          name: "shop_order",
          label: "Заказ",
          type: "ref",
          required: true,
          ref: { entity: N.order, onDelete: "cascade" },
        },
        {
          name: "kind",
          label: "Операция",
          type: "enum",
          required: true,
          enum: [
            { value: "payment", label: "Оплата" },
            { value: "refund", label: "Возврат" },
          ],
        },
        { name: "amount", label: "Сумма, ₽", type: "money", required: true },
        {
          name: "status",
          label: "Статус",
          type: "enum",
          required: true,
          enum: [
            { value: "pending", label: "Ожидает" },
            { value: "succeeded", label: "Прошла" },
            { value: "canceled", label: "Отменена" },
            { value: "needs_review", label: "Нужна проверка" },
          ],
        },
        {
          name: "provider_payment_id",
          label: "Платёж в ЮKassa",
          type: "string",
          required: true,
          unique: true,
          maxLength: 64,
        },
      ],
      indexes: [{ fields: ["shop_order"] }],
    });
  if (o.withStock)
    entities.push({
      name: N.move,
      label: "Движение остатков",
      fields: [
        {
          name: "product",
          label: o.productLabel,
          type: "ref",
          required: true,
          ref: { entity: N.product, onDelete: "cascade" },
        },
        { name: "qty", label: "Изменение, шт.", type: "int", required: true },
        {
          name: "kind",
          label: "Операция",
          type: "enum",
          required: true,
          enum: [
            { value: "sale", label: "Списание по заказу" },
            { value: "return", label: "Возврат по отмене" },
          ],
        },
        {
          name: "shop_order",
          label: "Заказ",
          type: "ref",
          ref: { entity: N.order, onDelete: "set_null" },
        },
      ],
      indexes: [{ fields: ["product"] }, { fields: ["shop_order"] }],
    });
  if (cdek)
    entities.push({
      name: N.quote,
      label: "Расчёт доставки СДЭК",
      fields: [
        { name: "city", label: "Город", type: "string", required: true, maxLength: 80 },
        { name: "city_code", label: "Код города СДЭК", type: "int", required: true },
        { name: "price", label: "Стоимость, ₽", type: "money", required: true, min: 0 },
        { name: "tariff_code", label: "Тариф", type: "int", required: true },
        { name: "days", label: "Срок", type: "string", maxLength: 40 },
        { name: "weight_g", label: "Вес посылки, г", type: "int", required: true, min: 1 },
        { name: "points", label: "Пункты выдачи", type: "text", required: true, maxLength: 20000 },
        { name: "expires_at", label: "Действует до", type: "datetime", required: true },
      ],
      // A quote lives half an hour: the rows are cleared the next day.
      retention: { deleteAfterDays: 1 },
    });

  const owner = (entity: string, ops: ("read" | "create" | "update" | "delete")[], extra = {}) => ({
    value: { role: "$owner", entity, ops, ...extra },
  });
  const staff = (entity: string, ops: ("read" | "create" | "update")[], extra = {}) => ({
    value: { role: "$staff", entity, ops, ...extra },
  });
  const publicRead = (entity: string, rowFilter?: Record<string, unknown>) => ({
    value: { role: "$public", entity, ops: ["read"], ...(rowFilter ? { rowFilter } : {}) },
  });
  const orderAccess = { readonlyFields: orderReadonly(o), hiddenFields: ["token"] };
  const permissions = [
    publicRead(N.product, { active: true }),
    owner(N.product, ["read", "create", "update", "delete"]),
    staff(N.product, ["read", "update"]),
    ...(o.withCategories
      ? [
          publicRead(N.category),
          owner(N.category, ["read", "create", "update", "delete"]),
          staff(N.category, ["read"]),
        ]
      : []),
    ...(pickup
      ? [
          publicRead(N.point, { active: true }),
          owner(N.point, ["read", "create", "update", "delete"]),
          staff(N.point, ["read"]),
        ]
      : []),
    // Orders come only from the site through shopPlaceOrder (prices, stock and the number are the server's).
    owner(N.order, ["read", "update", "delete"], orderAccess),
    staff(N.order, ["read", "update"], orderAccess),
    owner(N.line, ["read"]),
    staff(N.line, ["read"]),
    ...(o.online ? [owner(N.payment, ["read"]), staff(N.payment, ["read"])] : []),
    ...(o.withStock ? [owner(N.move, ["read"])] : []),
    // The СДЭК quotes are the module's (written by shopSaveQuote); the owner sees what the buyers were offered.
    ...(cdek ? [owner(N.quote, ["read"])] : []),
  ];

  const workflows: Workflow[] = [];
  if (o.online)
    workflows.push({
      // An order not paid in time is cancelled: its goods go back to the stock.
      name: "shop_order_expire",
      label: "Отменить заказ без оплаты",
      trigger: { type: "schedule", entity: N.order, relative: { field: "pay_until", offsetMinutes: 0 } },
      steps: [
        { type: "update", params: { if: { status: ["awaiting_payment"] }, set: { status: "canceled" } } },
      ],
    });
  if (o.withStock)
    workflows.push(
      {
        name: "shop_stock_return",
        label: "Вернуть товары отменённого заказа на склад",
        trigger: { type: "on_status", entity: N.order, field: "status", equals: "canceled" },
        steps: [
          { type: "function", params: { name: SHOP_FUNCTIONS.returnStock, args: { id: "$record.id" } } },
        ],
      },
      {
        // Paid after the cancel (the payment page was open): the goods are taken off the stock again.
        name: "shop_stock_paid",
        label: "Списать товары заказа, оплаченного после отмены",
        trigger: { type: "on_status", entity: N.order, field: "status", equals: "paid" },
        steps: [{ type: "function", params: { name: SHOP_FUNCTIONS.paid, args: { id: "$record.id" } } }],
      },
    );

  const integrations: NonNullable<ModuleFragments["integrations"]> = o.online
    ? [
        {
          value: {
            name: SHOP_PAYMENT.integration,
            connector: "yookassa",
            config: {
              bindings: [
                {
                  id: SHOP_PAYMENT.binding,
                  entity: N.order,
                  amountField: "total",
                  payableStatus: "awaiting_payment",
                  paidStatus: "paid",
                  canceledStatus: "canceled",
                  refundedStatus: "refunded",
                  paymentEntity: { name: N.payment, refField: "shop_order" },
                  description: "Заказ №{{number}}",
                  returnRoute: SHOP_ROUTES.order,
                  accessField: "token",
                  receipt: {
                    customerEmailField: "email",
                    customerPhoneField: "phone",
                    paymentSubject: "commodity",
                    paymentMode: "full_payment",
                    vatCode: o.vatCode,
                    lines: {
                      entity: N.line,
                      refField: "shop_order",
                      nameField: "name",
                      quantityField: "qty",
                      amountField: "sum",
                    },
                    deliveryField: "delivery_price",
                  },
                },
              ],
              refundWindowDays: 14,
            },
            secretRefs: ["secret://yookassa_shop_id", "secret://yookassa_secret_key"],
          },
        },
      ]
    : [];

  return {
    entities: entities.map((value) => ({ value })),
    permissions: permissions as ModuleFragments["permissions"],
    workflows: workflows.map((value) => ({ value })),
    integrations,
  };
}
