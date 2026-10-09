// ЮKassa API v3 (https://yookassa.ru/developers/api): payments, refunds, 54-ФЗ receipts. Basic auth shopId:secretKey,
// Idempotence-Key on every POST, notifications without a signature (IP list + re-read). The catalog connector
// yookassa (@wizard/connectors) already pays records, handles notifications and receipts — this passport is for direct
// calls; facts agree with specs/connectors/yookassa.yaml.
import { anyObj, arr, bool, header, int, num, obj, oneOf, op, path, query, str } from "./kit.js";
import type { Passport } from "./types.js";

const DOCS = "https://yookassa.ru/developers/api";

const amount = obj(
  {
    value: str("Сумма в рублях строкой, копейки через точку: 3025.00", { maxLength: 16 }),
    currency: str("Код валюты ISO-4217", { minLength: 3, maxLength: 3 }),
  },
  ["value", "currency"],
);

const item = obj(
  {
    description: str("Название товара или услуги", { maxLength: 128 }),
    quantity: num("Количество", { minimum: 0 }),
    amount,
    vat_code: int("Ставка НДС: 1 без НДС, 2 0%, 3 10%, 4 20%, 5 10/110, 6 20/120, 11 22%, 12 22/122", {
      minimum: 1,
      maximum: 12,
    }),
    payment_mode: oneOf(["full_prepayment", "full_payment"], "Признак способа расчёта"),
    payment_subject: oneOf(["commodity", "service", "job", "payment", "another"], "Признак предмета расчёта"),
  },
  ["description", "quantity", "amount", "vat_code"],
);

const customer = obj({
  full_name: str("ФИО или название организации", { maxLength: 256 }),
  email: str("Почта для чека", { format: "email" }),
  phone: str("Телефон для чека, только цифры: 79000000000", { maxLength: 15 }),
});

const receipt = obj(
  {
    customer,
    items: arr(item, { maxItems: 100 }),
    tax_system_code: int("Система налогообложения 1–6", { minimum: 1, maximum: 6 }),
  },
  ["customer", "items"],
);

const payment = obj(
  {
    id: str("Идентификатор платежа", { maxLength: 36 }),
    status: oneOf(["pending", "waiting_for_capture", "succeeded", "canceled"]),
    paid: bool(),
    amount,
    income_amount: amount,
    description: str(undefined, { maxLength: 128 }),
    recipient: obj({ account_id: str(), gateway_id: str() }, ["account_id"]),
    payment_method: obj({ type: str(), id: str(), saved: bool(), title: str() }, ["type"]),
    confirmation: obj({ type: str(), confirmation_url: str(undefined, { format: "uri" }) }, ["type"]),
    captured_at: str(undefined, { format: "date-time" }),
    created_at: str(undefined, { format: "date-time" }),
    expires_at: str(undefined, { format: "date-time" }),
    test: bool(),
    refunded_amount: amount,
    refundable: bool(),
    receipt_registration: oneOf(["pending", "succeeded", "canceled"]),
    metadata: anyObj("Метаданные магазина: строки до 512 символов"),
    cancellation_details: obj({ party: str(), reason: str() }),
  },
  ["id", "status", "paid", "amount", "created_at", "test"],
);

const refund = obj(
  {
    id: str("Идентификатор возврата", { maxLength: 36 }),
    payment_id: str(undefined, { maxLength: 36 }),
    status: oneOf(["pending", "succeeded", "canceled"]),
    amount,
    created_at: str(undefined, { format: "date-time" }),
    description: str(undefined, { maxLength: 250 }),
  },
  ["id", "payment_id", "status", "amount", "created_at"],
);

const idem = header(
  "Idempotence-Key",
  "idempotenceKey",
  str("Ключ идемпотентности до 64 символов (UUID v4); повтор с тем же ключом не создаёт второй объект", {
    minLength: 1,
    maxLength: 64,
    example: "6f1c3a2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b",
  }),
  true,
);
const paymentId = path(
  "payment_id",
  "paymentId",
  str("Идентификатор платежа", { example: "2d3fa9b1-000f-5000-8000-1c2b3a4d5e6f" }),
);

const PAYMENT = {
  id: "2d3fa9b1-000f-5000-8000-1c2b3a4d5e6f",
  status: "pending",
  paid: false,
  amount: { value: "3025.00", currency: "RUB" },
  description: "Заказ №1024",
  recipient: { account_id: "100001", gateway_id: "100002" },
  confirmation: {
    type: "redirect",
    confirmation_url:
      "https://yoomoney.ru/checkout/payments/v2/contract?orderId=2d3fa9b1-000f-5000-8000-1c2b3a4d5e6f",
  },
  created_at: "2026-10-09T09:15:00.000Z",
  test: true,
  refundable: false,
  metadata: { order_id: "1024" },
};
const SUCCEEDED = {
  ...PAYMENT,
  status: "succeeded",
  paid: true,
  income_amount: { value: "2919.13", currency: "RUB" },
  payment_method: {
    type: "bank_card",
    id: "2d3fa9b1-000f-5000-8000-1c2b3a4d5e6f",
    saved: false,
    title: "Bank card *4444",
  },
  captured_at: "2026-10-09T09:16:10.000Z",
  refunded_amount: { value: "0.00", currency: "RUB" },
  refundable: true,
  receipt_registration: "succeeded",
};
const REFUND = {
  id: "2d3fb0c4-0015-5000-9000-1a2b3c4d5e6f",
  payment_id: PAYMENT.id,
  status: "succeeded",
  amount: { value: "1000.00", currency: "RUB" },
  created_at: "2026-10-10T08:00:00.000Z",
  description: "Возврат по заказу №1024",
};
const ITEM = {
  description: "Стрижка мужская",
  quantity: 1,
  amount: { value: "3025.00", currency: "RUB" },
  vat_code: 1,
  payment_mode: "full_payment",
  payment_subject: "service",
};

export const yookassa: Passport = {
  id: "yookassa",
  name: "ЮKassa",
  aliases: ["юkassa", "юкасса", "yookassa", "yukassa", "ukassa", "юкаса", "яндекскасса", "yandexkassa"],
  domains: ["yookassa.ru"],
  summary_ru: "Приём платежей: создание и проверка платежа, подтверждение и отмена, возвраты, чеки 54-ФЗ.",
  docsUrl: DOCS,
  reviewed: "2026-10-09",
  baseUrl: "https://api.yookassa.ru/v3",
  sandboxBaseUrl: null,
  auth: { kind: "header", name: "Authorization" },
  account: null,
  key: {
    fields: [
      {
        key: "shop_id",
        label_ru: "Идентификатор магазина (shopId)",
        hint_ru: "Личный кабинет ЮKassa → Интеграция → Ключи API: shopId над списком ключей",
        example: "100001",
        pattern: /^\d{3,12}$/,
        error_ru: "shopId — это число из личного кабинета ЮKassa",
      },
      {
        key: "secret_key",
        label_ru: "Секретный ключ",
        hint_ru: "Там же — «Выпустить секретный ключ»; у тестового магазина ключ начинается с test_",
        example: "test_••••••••",
        pattern: /^(test|live)_[A-Za-z0-9_-]{8,}$/,
        error_ru: "Секретный ключ ЮKassa начинается с test_ или live_",
      },
    ],
    compose: "basic",
    where_ru:
      "Личный кабинет ЮKassa → Интеграция → Ключи API. Для черновика системы — ключи тестового магазина (test_…).",
  },
  operations: [
    op({
      id: "getShop",
      method: "GET",
      path: "/me",
      summary: "Информация о магазине (проверка ключа)",
      response: obj(
        {
          account_id: str("Идентификатор магазина"),
          test: bool("Тестовый магазин"),
          fiscalization_enabled: bool(),
          payment_methods: arr(str()),
          status: oneOf(["enabled", "disabled"]),
        },
        ["account_id"],
      ),
      example: {
        account_id: "100001",
        test: true,
        fiscalization_enabled: true,
        payment_methods: ["bank_card", "sbp", "yoo_money"],
        status: "enabled",
      },
    }),
    op({
      id: "createPayment",
      method: "POST",
      path: "/payments",
      summary: "Создать платёж и получить ссылку на оплату",
      params: [idem],
      body: obj(
        {
          amount,
          description: str("Описание платежа", { maxLength: 128 }),
          capture: bool("true — списать сразу, false — двухстадийная оплата"),
          confirmation: obj(
            {
              type: oneOf(["redirect", "embedded", "qr", "external", "mobile_application"]),
              return_url: str("Куда вернуть покупателя после оплаты", { format: "uri", maxLength: 2048 }),
              locale: oneOf(["ru_RU", "en_US"]),
            },
            ["type"],
          ),
          payment_method_data: obj(
            { type: oneOf(["bank_card", "sbp", "yoo_money", "sberbank", "tinkoff_bank"]) },
            ["type"],
          ),
          receipt,
          metadata: obj({ order_id: str("Номер заказа в системе", { maxLength: 512 }) }),
        },
        ["amount"],
        {
          example: {
            amount: { value: "3025.00", currency: "RUB" },
            description: "Заказ №1024",
            capture: true,
            confirmation: { type: "redirect", return_url: "https://shop.example.com/orders/1024" },
            receipt: { customer: { email: "client@example.com" }, items: [ITEM] },
            metadata: { order_id: "1024" },
          },
        },
      ),
      response: payment,
      example: PAYMENT,
    }),
    op({
      id: "getPayment",
      method: "GET",
      path: "/payments/{payment_id}",
      summary: "Платёж по идентификатору (проверка уведомления)",
      params: [paymentId],
      response: payment,
      example: SUCCEEDED,
    }),
    op({
      id: "listPayments",
      method: "GET",
      path: "/payments",
      summary: "Список платежей с фильтром",
      params: [
        query("limit", "limit", int("Сколько платежей вернуть", { minimum: 1, maximum: 100, example: 10 })),
        query("status", "status", oneOf(["pending", "waiting_for_capture", "succeeded", "canceled"])),
        query("created_at.gte", "createdAtGte", str("Созданы не раньше", { format: "date-time" })),
        query("cursor", "cursor", str("Курсор следующей страницы (next_cursor)")),
      ],
      response: obj({ type: oneOf(["list"]), items: arr(payment), next_cursor: str() }, ["type", "items"]),
      example: { type: "list", items: [SUCCEEDED] },
    }),
    op({
      id: "capturePayment",
      method: "POST",
      path: "/payments/{payment_id}/capture",
      summary: "Подтвердить платёж в статусе waiting_for_capture",
      params: [paymentId, idem],
      body: obj({ amount }, [], { example: { amount: { value: "3025.00", currency: "RUB" } } }),
      bodyRequired: false,
      response: payment,
      example: SUCCEEDED,
    }),
    op({
      id: "cancelPayment",
      method: "POST",
      path: "/payments/{payment_id}/cancel",
      summary: "Отменить платёж в статусе waiting_for_capture",
      params: [paymentId, idem],
      response: payment,
      example: {
        ...PAYMENT,
        status: "canceled",
        cancellation_details: { party: "merchant", reason: "canceled_by_merchant" },
      },
    }),
    op({
      id: "createRefund",
      method: "POST",
      path: "/refunds",
      summary: "Вернуть деньги покупателю (полностью или частично)",
      params: [idem],
      body: obj(
        {
          payment_id: str("Платёж, по которому возврат", { maxLength: 36 }),
          amount,
          description: str("Причина возврата", { maxLength: 250 }),
          receipt,
        },
        ["payment_id", "amount"],
        {
          example: {
            payment_id: PAYMENT.id,
            amount: { value: "1000.00", currency: "RUB" },
            description: "Возврат по заказу №1024",
          },
        },
      ),
      response: refund,
      example: REFUND,
    }),
    op({
      id: "getRefund",
      method: "GET",
      path: "/refunds/{refund_id}",
      summary: "Возврат по идентификатору",
      params: [path("refund_id", "refundId", str("Идентификатор возврата", { example: REFUND.id }))],
      response: refund,
      example: REFUND,
    }),
    op({
      id: "createReceipt",
      method: "POST",
      path: "/receipts",
      summary: "Отдельный чек 54-ФЗ (например, зачёт предоплаты)",
      params: [idem],
      body: obj(
        {
          type: oneOf(["payment", "refund"]),
          payment_id: str(undefined, { maxLength: 36 }),
          customer,
          items: arr(item, { maxItems: 100 }),
          send: bool("Отправить чек сразу (всегда true)"),
          settlements: arr(
            obj({ type: oneOf(["cashless", "prepayment", "postpayment", "consideration"]), amount }, [
              "type",
              "amount",
            ]),
          ),
          tax_system_code: int(undefined, { minimum: 1, maximum: 6 }),
        },
        ["type", "customer", "items", "send", "settlements"],
        {
          example: {
            type: "payment",
            payment_id: PAYMENT.id,
            customer: { email: "client@example.com" },
            items: [ITEM],
            send: true,
            settlements: [{ type: "prepayment", amount: { value: "3025.00", currency: "RUB" } }],
          },
        },
      ),
      response: obj(
        {
          id: str(),
          type: oneOf(["payment", "refund"]),
          payment_id: str(),
          status: oneOf(["pending", "succeeded", "canceled"]),
        },
        ["id", "type", "status"],
      ),
      example: {
        id: "rt-2d3fc1d2-0000-5000-a000-1a2b3c4d5e6f",
        type: "payment",
        payment_id: PAYMENT.id,
        status: "pending",
      },
    }),
  ],
  check: "getShop",
  docs: {
    getShop: `${DOCS}#get_me`,
    createPayment: `${DOCS}#create_payment`,
    getPayment: `${DOCS}#get_payment`,
    listPayments: `${DOCS}#get_payments_list`,
    capturePayment: `${DOCS}#capture_payment`,
    cancelPayment: `${DOCS}#cancel_payment`,
    createRefund: `${DOCS}#create_refund`,
    getRefund: `${DOCS}#get_refund`,
    createReceipt: `${DOCS}#create_receipt`,
  },
  hints: [
    {
      entity: "order",
      field: "total",
      operation: "createPayment",
      pointer: "/body/amount/value",
      direction: "to_api",
    },
    {
      entity: "order",
      field: "number",
      operation: "createPayment",
      pointer: "/body/metadata/order_id",
      direction: "to_api",
    },
    {
      entity: "client",
      field: "email",
      operation: "createPayment",
      pointer: "/body/receipt/customer/email",
      direction: "to_api",
    },
    {
      entity: "client",
      field: "phone",
      operation: "createPayment",
      pointer: "/body/receipt/customer/phone",
      direction: "to_api",
    },
    {
      entity: "order",
      field: "payment_id",
      operation: "createPayment",
      pointer: "/response/id",
      direction: "from_api",
    },
    {
      entity: "order",
      field: "payment_url",
      operation: "createPayment",
      pointer: "/response/confirmation/confirmation_url",
      direction: "from_api",
    },
    {
      entity: "order",
      field: "payment_status",
      operation: "getPayment",
      pointer: "/response/status",
      direction: "from_api",
    },
    {
      entity: "booking",
      field: "price",
      operation: "createPayment",
      pointer: "/body/amount/value",
      direction: "to_api",
    },
  ],
  limits_ru:
    "Публичных лимитов частоты нет; на 429 — подождать и повторить с тем же Idempotence-Key. Ответ 500 — результат неизвестен: повторить с тем же ключом или перечитать объект. Ключ идемпотентности ЮKassa хранит 24 часа.",
  sandbox_ru:
    "Тестовый магазин создаётся в личном кабинете ЮKassa, ключ начинается с test_, хост тот же (api.yookassa.ru); тестовые карты — в разделе «Тестирование» документации. В черновике системы — только тестовый магазин.",
  webhooks: {
    events: ["payment.succeeded", "payment.waiting_for_capture", "payment.canceled", "refund.succeeded"],
    setup_ru:
      "Личный кабинет ЮKassa → Интеграция → HTTP-уведомления: адрес вебхука системы и нужные события.",
    verify: "refetch",
    contentType: "json",
    verify_ru:
      "ЮKassa не подписывает уведомления: адрес источника — из списка IP ЮKassa (тот же, что у встроенного коннектора yookassa), статус платежа перечитывается GET /payments/{id}; решение — только по ответу API.",
    parse(body) {
      const event = typeof body.event === "string" ? body.event : null;
      const id = (body.object as { id?: unknown } | undefined)?.id;
      if (body.type !== "notification" || !event || typeof id !== "string") return null;
      if (event.startsWith("payment."))
        return { event, refetch: { operation: "getPayment", input: { paymentId: id } } };
      if (event.startsWith("refund."))
        return { event, refetch: { operation: "getRefund", input: { refundId: id } } };
      return { event, refetch: null };
    },
  },
  notes_ru: [
    "Оплату заказов на сайте уже умеет встроенный коннектор «ЮKassa» (оплата записи, уведомления, чеки 54-ФЗ) — паспорт нужен для прямых вызовов: сверка, возвраты, отчёты.",
    "Каждый POST — с Idempotence-Key (UUID v4, до 64 символов): повтор с тем же ключом не создаёт второй платёж.",
    "Сумма — строкой в рублях с копейками через точку («3025.00»); почта и телефон покупателя уходят в ЮKassa только для чека.",
  ],
  verify_ru: [
    "состав ответа GET /me, кроме account_id",
    "принимает ли POST /payments/{id}/cancel запрос без тела (встроенный коннектор отправляет {})",
    "receipt.items[].quantity — число (в старых примерах документации — строка)",
  ],
};
