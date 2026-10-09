// СДЭК API v2 (https://api-docs.cdek.ru/): tariffs, orders and their statuses, pickup points, cities, webhooks. OAuth 2.0
// client credentials: the key is the owner's Account and Secure password (one oauth2cc: secret value); the runtime
// egress client requests an access token (1 hour) at call time and keeps it in memory; the test environment
// api.edu.cdek.ru has its own public test account.
import { arr, bool, int, num, obj, oneOf, op, path, query, str } from "./kit.js";
import type { Passport } from "./types.js";

const DOCS = "https://api-docs.cdek.ru/";

const location = obj({
  code: int("Код города СДЭК", { example: 44 }),
  postal_code: str("Почтовый индекс"),
  country_code: str("Код страны ISO 3166-1 alpha-2", { maxLength: 2 }),
  city: str("Название города"),
  address: str("Адрес (для доставки до двери)", { maxLength: 255 }),
});
const pkgSize = obj(
  {
    weight: int("Вес, граммы", { minimum: 1 }),
    length: int("Длина, см", { minimum: 1 }),
    width: int("Ширина, см", { minimum: 1 }),
    height: int("Высота, см", { minimum: 1 }),
  },
  ["weight"],
);
const tariffBody = {
  type: int("1 — интернет-магазин, 2 — доставка", { minimum: 1, maximum: 2 }),
  from_location: location,
  to_location: location,
  packages: arr(pkgSize, { maxItems: 255 }),
};
const FROM = { code: 44 };
const TO = { code: 137 };
const PKG = { weight: 1500, length: 30, width: 20, height: 10 };

const request = obj(
  {
    request_uuid: str(),
    type: str("CREATE, UPDATE, DELETE…"),
    state: oneOf(["ACCEPTED", "WAITING", "SUCCESSFUL", "INVALID"]),
    date_time: str("Дата и время: 2026-10-09T12:15:00+0300"),
    errors: arr(obj({ code: str(), message: str() })),
    warnings: arr(obj({ code: str(), message: str() })),
  },
  ["request_uuid", "type", "state"],
);
const entityAnswer = obj(
  { entity: obj({ uuid: str("Идентификатор заказа в СДЭК") }, ["uuid"]), requests: arr(request) },
  ["entity", "requests"],
);
const status = obj(
  { code: str("Код статуса: ACCEPTED, CREATED, …, DELIVERED"), name: str(), date_time: str(), city: str() },
  ["code", "name", "date_time"],
);
const order = obj(
  {
    entity: obj(
      {
        uuid: str(),
        type: int(),
        number: str("Номер заказа в системе"),
        cdek_number: str("Номер заказа СДЭК (трек-номер)"),
        tariff_code: int(),
        delivery_point: str(),
        recipient: obj({ name: str() }),
        statuses: arr(status),
      },
      ["uuid"],
    ),
    requests: arr(request),
  },
  ["entity"],
);
const ORDER_UUID = "72753031-0f6b-4a5c-8d2e-1b3c5d7e9f01";
const ORDER = {
  entity: {
    uuid: ORDER_UUID,
    type: 1,
    number: "1024",
    cdek_number: "1106000001",
    tariff_code: 136,
    delivery_point: "MSK123",
    recipient: { name: "Покупатель Тестовый" },
    // Newest first; «Принят» (ACCEPTED) comes before «Создан» (CREATED) — as the test contour answered on 09.10.2026.
    statuses: [
      { code: "CREATED", name: "Создан", date_time: "2026-10-09T12:15:01+0300", city: "Москва" },
      { code: "ACCEPTED", name: "Принят", date_time: "2026-10-09T12:15:00+0300", city: "Москва" },
    ],
  },
  requests: [
    {
      request_uuid: "5f0a2c4e-6b8d-4f1a-9c3e-5a7b9d1f3e50",
      type: "CREATE",
      state: "SUCCESSFUL",
      date_time: "2026-10-09T12:15:00+0300",
      errors: [],
      warnings: [],
    },
  ],
};
const ACCEPTED = {
  entity: { uuid: ORDER_UUID },
  requests: [
    {
      request_uuid: "5f0a2c4e-6b8d-4f1a-9c3e-5a7b9d1f3e50",
      type: "CREATE",
      state: "ACCEPTED",
      date_time: "2026-10-09T12:15:00+0300",
      errors: [],
      warnings: [],
    },
  ],
};
const orderUuid = path("uuid", "uuid", str("Идентификатор заказа в СДЭК", { example: ORDER_UUID }));

export const cdek: Passport = {
  id: "cdek",
  name: "СДЭК",
  aliases: ["сдэк", "сдек", "cdek", "sdek"],
  domains: ["cdek.ru"],
  summary_ru:
    "Доставка: расчёт стоимости и сроков, заказ на доставку, статусы и трек-номер, пункты выдачи, вебхуки статусов.",
  docsUrl: DOCS,
  reviewed: "2026-10-09",
  baseUrl: "https://api.cdek.ru/v2",
  sandboxBaseUrl: "https://api.edu.cdek.ru/v2",
  auth: { kind: "bearer", name: null },
  account: null,
  key: {
    fields: [
      {
        key: "client_id",
        label_ru: "Идентификатор клиента (Account)",
        hint_ru: "Личный кабинет СДЭК → Интеграция → Ключи API (нужен договор интернет-магазина)",
        example: "••••••••",
        pattern: /^[A-Za-z0-9_-]{8,128}$/,
        error_ru: "Ключ СДЭК — латинские буквы и цифры без пробелов",
      },
      {
        key: "client_secret",
        label_ru: "Пароль клиента (Secure password)",
        hint_ru: "Там же, рядом с Account",
        example: "••••••••",
        pattern: /^[A-Za-z0-9_-]{8,128}$/,
        error_ru: "Ключ СДЭК — латинские буквы и цифры без пробелов",
      },
    ],
    compose: "oauth_client_credentials",
    where_ru:
      "Личный кабинет СДЭК → Интеграция: Account и Secure password. Токен доступа (живёт час) рантайм получает по ним сам при вызове и обновляет.",
    token: { path: "/oauth/token", ttlSeconds: 3600 },
  },
  operations: [
    op({
      id: "listCities",
      method: "GET",
      path: "/location/cities",
      summary: "Города СДЭК по названию (проверка ключа)",
      params: [
        query("country_codes", "countryCodes", str("Код страны", { example: "RU" })),
        query("city", "city", str("Название города", { example: "Москва" })),
        query("size", "size", int("Сколько городов вернуть", { minimum: 1, maximum: 1000, example: 1 })),
        query("page", "page", int("Номер страницы", { minimum: 0, example: 0 })),
      ],
      response: arr(
        obj(
          {
            code: int("Код города СДЭК"),
            city: str(),
            fias_guid: str(),
            country_code: str(),
            country: str(),
            region: str(),
            region_code: int(),
            longitude: num(),
            latitude: num(),
            time_zone: str(),
          },
          ["code", "city"],
        ),
      ),
      example: [
        {
          code: 44,
          city: "Москва",
          country_code: "RU",
          country: "Россия",
          region: "Москва",
          region_code: 81,
          longitude: 37.6156,
          latitude: 55.7522,
          time_zone: "Europe/Moscow",
        },
      ],
    }),
    op({
      id: "calculateTariff",
      method: "POST",
      path: "/calculator/tariff",
      summary: "Стоимость и срок доставки по коду тарифа",
      body: obj(
        { ...tariffBody, tariff_code: int("Код тарифа: 136 — посылка склад-склад, 137 — склад-дверь") },
        ["tariff_code", "from_location", "to_location", "packages"],
        { example: { type: 1, tariff_code: 136, from_location: FROM, to_location: TO, packages: [PKG] } },
      ),
      response: obj(
        {
          delivery_sum: num("Стоимость доставки без услуг"),
          period_min: int("Срок, рабочих дней, от"),
          period_max: int("до"),
          calendar_min: int(),
          calendar_max: int(),
          weight_calc: int("Расчётный вес, граммы"),
          total_sum: num("Итого с услугами"),
          currency: str(),
          services: arr(obj({ code: str(), sum: num() })),
        },
        ["delivery_sum", "period_min", "period_max", "total_sum"],
      ),
      example: {
        delivery_sum: 390,
        period_min: 2,
        period_max: 3,
        calendar_min: 2,
        calendar_max: 4,
        weight_calc: 1500,
        total_sum: 390,
        currency: "RUB",
        services: [],
      },
    }),
    op({
      id: "calculateTariffList",
      method: "POST",
      path: "/calculator/tarifflist",
      summary: "Все доступные тарифы с ценами и сроками",
      body: obj(tariffBody, ["from_location", "to_location", "packages"], {
        example: { type: 1, from_location: FROM, to_location: TO, packages: [PKG] },
      }),
      response: obj(
        {
          tariff_codes: arr(
            obj(
              {
                tariff_code: int(),
                tariff_name: str(),
                tariff_description: str(),
                delivery_mode: int(
                  "1 дверь-дверь, 2 дверь-склад, 3 склад-дверь, 4 склад-склад, 6 дверь-постамат…",
                ),
                delivery_sum: num(),
                period_min: int(),
                period_max: int(),
                calendar_min: int(),
                calendar_max: int(),
              },
              ["tariff_code", "delivery_sum", "period_min", "period_max"],
            ),
          ),
        },
        ["tariff_codes"],
      ),
      example: {
        tariff_codes: [
          {
            tariff_code: 136,
            tariff_name: "Посылка склад-склад",
            tariff_description: "Услуга экономичной доставки товаров по России",
            delivery_mode: 4,
            delivery_sum: 390,
            period_min: 2,
            period_max: 3,
            calendar_min: 2,
            calendar_max: 4,
          },
          {
            tariff_code: 137,
            tariff_name: "Посылка склад-дверь",
            tariff_description: "Услуга экономичной доставки товаров по России",
            delivery_mode: 3,
            delivery_sum: 520,
            period_min: 2,
            period_max: 4,
            calendar_min: 2,
            calendar_max: 5,
          },
        ],
      },
    }),
    op({
      id: "createOrder",
      method: "POST",
      path: "/orders",
      summary: "Заказ на доставку (ответ 202: заказ принят в обработку)",
      body: obj(
        {
          type: int("1 — интернет-магазин, 2 — доставка", { minimum: 1, maximum: 2 }),
          number: str("Номер заказа в системе", { maxLength: 40 }),
          tariff_code: int(),
          comment: str(undefined, { maxLength: 255 }),
          shipment_point: str("Код ПВЗ, где магазин сдаёт посылку"),
          delivery_point: str("Код ПВЗ или постамата получателя"),
          from_location: location,
          to_location: location,
          recipient: obj(
            {
              name: str("ФИО получателя", { maxLength: 255 }),
              email: str(undefined, { format: "email" }),
              phones: arr(obj({ number: str("Телефон: +79000000000", { maxLength: 24 }) }, ["number"]), {
                maxItems: 10,
              }),
            },
            ["name", "phones"],
          ),
          packages: arr(
            obj(
              {
                number: str("Номер упаковки", { maxLength: 40 }),
                weight: int("Вес, граммы", { minimum: 1 }),
                length: int(),
                width: int(),
                height: int(),
                comment: str(),
                items: arr(
                  obj(
                    {
                      name: str(undefined, { maxLength: 255 }),
                      ware_key: str("Артикул", { maxLength: 50 }),
                      payment: obj({ value: num("Наложенный платёж за единицу, 0 — оплачено") }, ["value"]),
                      cost: num("Объявленная стоимость единицы"),
                      weight: int("Вес единицы, граммы"),
                      amount: int("Количество", { minimum: 1 }),
                    },
                    ["name", "ware_key", "payment", "cost", "weight", "amount"],
                  ),
                ),
              },
              ["number", "weight"],
            ),
            { maxItems: 255 },
          ),
        },
        ["tariff_code", "recipient", "packages"],
        {
          example: {
            type: 1,
            number: "1024",
            tariff_code: 136,
            shipment_point: "MSK005",
            delivery_point: "MSK123",
            recipient: { name: "Покупатель Тестовый", phones: [{ number: "+70001234567" }] },
            packages: [
              {
                number: "1024-1",
                weight: 1500,
                length: 30,
                width: 20,
                height: 10,
                items: [
                  {
                    name: "Свеча ароматическая",
                    ware_key: "SV-01",
                    payment: { value: 0 },
                    cost: 1200,
                    weight: 500,
                    amount: 3,
                  },
                ],
              },
            ],
          },
        },
      ),
      status: 202,
      response: entityAnswer,
      example: ACCEPTED,
    }),
    op({
      id: "getOrder",
      method: "GET",
      path: "/orders/{uuid}",
      summary: "Заказ, его статусы и трек-номер",
      params: [orderUuid],
      response: order,
      example: ORDER,
    }),
    op({
      id: "findOrder",
      method: "GET",
      path: "/orders",
      summary: "Заказ по номеру СДЭК или номеру заказа магазина",
      params: [
        query("cdek_number", "cdekNumber", str("Номер заказа СДЭК")),
        query("im_number", "imNumber", str("Номер заказа в системе")),
      ],
      response: order,
      example: ORDER,
    }),
    op({
      id: "deleteOrder",
      method: "DELETE",
      path: "/orders/{uuid}",
      summary: "Удалить заказ, пока его не приняли на склад",
      params: [orderUuid],
      status: 202,
      response: entityAnswer,
      example: { ...ACCEPTED, requests: [{ ...ACCEPTED.requests[0], type: "DELETE" }] },
    }),
    op({
      id: "listDeliveryPoints",
      method: "GET",
      path: "/deliverypoints",
      summary: "Пункты выдачи и постаматы в городе",
      params: [
        query("city_code", "cityCode", int("Код города СДЭК", { example: 44 })),
        query("postal_code", "postalCode", str("Почтовый индекс")),
        query("type", "type", oneOf(["PVZ", "POSTAMAT", "ALL"], "Тип пункта")),
        query("country_code", "countryCode", str(undefined, { example: "RU" })),
        query("size", "size", int(undefined, { minimum: 1, maximum: 1000, example: 50 })),
        query("page", "page", int(undefined, { minimum: 0, example: 0 })),
      ],
      response: arr(
        obj(
          {
            code: str("Код пункта"),
            name: str(),
            type: oneOf(["PVZ", "POSTAMAT"]),
            owner_code: str(),
            work_time: str(),
            address_comment: str(),
            location: obj(
              {
                country_code: str(),
                region: str(),
                city_code: int(),
                city: str(),
                postal_code: str(),
                longitude: num(),
                latitude: num(),
                address: str(),
                address_full: str(),
              },
              ["city_code", "address"],
            ),
            is_handout: bool("Выдаёт заказы"),
            is_reception: bool("Принимает отправления"),
            have_cashless: bool(),
            have_cash: bool(),
            allowed_cod: bool("Наложенный платёж"),
            weight_max: num(),
          },
          ["code", "type", "location"],
        ),
      ),
      example: [
        {
          code: "MSK123",
          name: "На Тверской",
          type: "PVZ",
          owner_code: "cdek",
          work_time: "Пн-Пт 09:00-21:00, Сб-Вс 10:00-18:00",
          address_comment: "Вход со двора",
          location: {
            country_code: "RU",
            region: "Москва",
            city_code: 44,
            city: "Москва",
            postal_code: "125009",
            longitude: 37.6077,
            latitude: 55.7602,
            address: "ул. Тверская, 1",
            address_full: "Россия, Москва, ул. Тверская, 1",
          },
          is_handout: true,
          is_reception: true,
          have_cashless: true,
          have_cash: true,
          allowed_cod: true,
          weight_max: 30,
        },
      ],
    }),
    op({
      id: "createWebhook",
      method: "POST",
      path: "/webhooks",
      summary: "Подписка на события (смена статуса заказа)",
      body: obj(
        {
          type: oneOf(["ORDER_STATUS", "PRINT_FORM", "DOWNLOAD_PHOTO", "PREALERT_CLOSED"]),
          url: str("Адрес вебхука системы", { format: "uri" }),
        },
        ["type", "url"],
        { example: { type: "ORDER_STATUS", url: "https://shop.example.com/hooks/cdek" } },
      ),
      response: entityAnswer,
      example: {
        entity: { uuid: "0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6" },
        requests: [
          { request_uuid: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", type: "CREATE", state: "SUCCESSFUL" },
        ],
      },
    }),
    op({
      id: "listWebhooks",
      method: "GET",
      path: "/webhooks",
      summary: "Действующие подписки (чтобы не подписаться дважды)",
      response: arr(obj({ uuid: str(), type: str(), url: str() }, ["uuid", "type", "url"])),
      example: [
        {
          uuid: "0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6",
          type: "ORDER_STATUS",
          url: "https://shop.example.com/hooks/cdek",
        },
      ],
    }),
  ],
  check: "listCities",
  docs: {
    listCities: DOCS,
    calculateTariff: DOCS,
    calculateTariffList: DOCS,
    createOrder: DOCS,
    getOrder: DOCS,
    findOrder: DOCS,
    deleteOrder: DOCS,
    listDeliveryPoints: DOCS,
    createWebhook: DOCS,
    listWebhooks: DOCS,
  },
  hints: [
    {
      entity: "order",
      field: "number",
      operation: "createOrder",
      pointer: "/body/number",
      direction: "to_api",
    },
    {
      entity: "client",
      field: "name",
      operation: "createOrder",
      pointer: "/body/recipient/name",
      direction: "to_api",
    },
    {
      entity: "client",
      field: "phone",
      operation: "createOrder",
      pointer: "/body/recipient/phones/0/number",
      direction: "to_api",
    },
    {
      entity: "client",
      field: "email",
      operation: "createOrder",
      pointer: "/body/recipient/email",
      direction: "to_api",
    },
    {
      entity: "order",
      field: "delivery_point",
      operation: "createOrder",
      pointer: "/body/delivery_point",
      direction: "to_api",
    },
    {
      entity: "order",
      field: "delivery_id",
      operation: "createOrder",
      pointer: "/response/entity/uuid",
      direction: "from_api",
    },
    {
      entity: "order",
      field: "track_number",
      operation: "getOrder",
      pointer: "/response/entity/cdek_number",
      direction: "from_api",
    },
    {
      entity: "order",
      field: "delivery_status",
      operation: "getOrder",
      pointer: "/response/entity/statuses/0/code",
      direction: "from_api",
    },
    {
      entity: "order",
      field: "delivery_price",
      operation: "calculateTariff",
      pointer: "/response/total_sum",
      direction: "from_api",
    },
    {
      entity: "product",
      field: "sku",
      operation: "createOrder",
      pointer: "/body/packages/0/items/0/ware_key",
      direction: "to_api",
    },
    {
      entity: "product",
      field: "weight",
      operation: "createOrder",
      pointer: "/body/packages/0/items/0/weight",
      direction: "to_api",
    },
  ],
  limits_ru:
    "Токен доступа живёт 3600 секунд — платформа обновляет его заранее; на 401 — новый токен и один повтор. Заказ создаётся асинхронно: ответ 202, итог — в requests[].state или вебхуке ORDER_STATUS. Вес — в граммах, размеры — в сантиметрах.",
  sandbox_ru:
    "Тестовая среда — api.edu.cdek.ru/v2 с общей тестовой учётной записью из документации СДЭК (Account и Secure password опубликованы там); заказы в ней не исполняются. Боевая — api.cdek.ru/v2 с ключами договора.",
  webhooks: {
    events: ["ORDER_STATUS", "PRINT_FORM", "DOWNLOAD_PHOTO", "PREALERT_CLOSED"],
    setup_ru:
      "Операция createWebhook (POST /v2/webhooks) с типом ORDER_STATUS и адресом вебхука системы; перед этим — listWebhooks.",
    verify: "refetch",
    contentType: "json",
    verify_ru:
      "СДЭК не подписывает вебхуки: по uuid из уведомления заказ перечитывается getOrder с ключом, статус берётся из ответа API.",
    parse(body) {
      const type = typeof body.type === "string" ? body.type : null;
      const uuid = typeof body.uuid === "string" ? body.uuid : null;
      if (!type || !uuid) return null;
      return {
        event: type,
        refetch: type === "ORDER_STATUS" ? { operation: "getOrder", input: { uuid } } : null,
      };
    },
  },
  notes_ru: [
    "Ключ интеграции — Account и Secure password (одно значение oauth2cc:): токен доступа рантайм получает при вызове, держит в памяти до истечения и нигде не сохраняет.",
    "Даты СДЭК — со смещением без двоеточия (+0300), в контракте они строки без формата.",
    "Печать накладных и вызов курьера в паспорт не вошли — добавляются по документации отдельной операцией.",
    "Сверен с учебным контуром api.edu.cdek.ru 09.10.2026 (tools/integrations/sandbox-check.mjs): токен — по параметрам в теле формы, expires_in 3599; ответы всех операций, кроме createWebhook, совпали с паспортом; cdek_number — строка; statuses — новые первыми.",
  ],
  verify_ru: [
    "адреса страниц документации по операциям (портал api-docs.cdek.ru)",
    "лимиты частоты запросов (в документации не найдены)",
    "uuid в вебхуке ORDER_STATUS — идентификатор заказа",
  ],
};
