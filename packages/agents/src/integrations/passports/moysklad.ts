// МойСклад JSON API 1.2 (https://dev.moysklad.ru/doc/api/remap/1.2/): products, stock, customer orders, counterparties,
// webhooks. Bearer token of an employee; links between objects are {meta: {href, type, mediaType}}; money in kopecks;
// dates «2026-10-09 12:15:00.000» (no zone).
import type { ApiSchema } from "../schema.js";
import { arr, bool, int, num, obj, oneOf, op, path, query, str } from "./kit.js";
import type { Passport } from "./types.js";

const DOCS = "https://dev.moysklad.ru/doc/api/remap/1.2";
const BASE = "https://api.moysklad.ru/api/remap/1.2";

const meta = obj(
  {
    href: str(undefined, { format: "uri" }),
    type: str(),
    mediaType: str(),
    metadataHref: str(),
    uuidHref: str(),
    size: int(),
    limit: int(),
    offset: int(),
  },
  ["href", "type"],
);
/** A link to another object in a request: {meta: {href, type, mediaType}}. */
const link = (type: string): ApiSchema =>
  obj(
    {
      meta: obj(
        {
          href: str(`Ссылка на объект ${type}: ${BASE}/entity/${type}/<id>`, { format: "uri" }),
          type: oneOf([type]),
          mediaType: oneOf(["application/json"]),
        },
        ["href", "type", "mediaType"],
      ),
    },
    ["meta"],
  );
const ref = obj({ meta }, ["meta"]);
const list = (row: ApiSchema): ApiSchema => obj({ meta, rows: arr(row) }, ["meta", "rows"]);
const paging = [
  query("limit", "limit", int("Сколько записей (до 1000)", { minimum: 1, maximum: 1000, example: 25 })),
  query("offset", "offset", int("Смещение", { minimum: 0, example: 0 })),
];
const search = query("search", "search", str("Поиск по названию, коду, артикулу"));
const idOf = (example: string) => path("id", "id", str("ID объекта (UUID)", { example }));
const metaOf = (type: string, id: string) => ({
  href: `${BASE}/entity/${type}/${id}`,
  type,
  mediaType: "application/json",
});

const price = obj({ value: num("Цена в копейках"), priceType: obj({ meta, id: str(), name: str() }) }, [
  "value",
]);
const product = obj(
  {
    meta,
    id: str(),
    name: str(),
    code: str(),
    article: str("Артикул"),
    description: str(),
    externalCode: str(),
    archived: bool(),
    pathName: str("Группа товаров"),
    salePrices: arr(price),
    buyPrice: obj({ value: num() }),
    updated: str("Дата: 2026-10-09 12:15:00.000"),
  },
  ["meta", "id", "name"],
);
const productIn = {
  name: str("Название", { maxLength: 255 }),
  code: str(),
  article: str("Артикул", { maxLength: 255 }),
  description: str(undefined, { maxLength: 4096 }),
  externalCode: str("Код во внешней системе"),
  salePrices: arr(
    obj({ value: num("Цена в копейках", { minimum: 0 }), priceType: link("pricetype") }, [
      "value",
      "priceType",
    ]),
  ),
};
const order = obj(
  {
    meta,
    id: str(),
    name: str("Номер заказа"),
    moment: str("Дата: 2026-10-09 12:15:00.000"),
    sum: num("Сумма в копейках"),
    applicable: bool("Проведён"),
    description: str(),
    state: ref,
    agent: ref,
    organization: ref,
    positions: ref,
    payedSum: num(),
    shippedSum: num(),
    reservedSum: num(),
  },
  ["meta", "id", "name", "sum"],
);
const counterparty = obj(
  {
    meta,
    id: str(),
    name: str(),
    phone: str(),
    email: str(),
    companyType: oneOf(["legal", "entrepreneur", "individual"]),
    tags: arr(str()),
  },
  ["meta", "id", "name"],
);

const PRODUCT_ID = "7944ef04-f831-11e5-7a69-971500188b19";
const ORDER_ID = "36ac1a8c-6f2e-11ee-0a80-0d4e0012a3b5";
const AGENT_ID = "12a8b923-692c-11e6-8a84-bae500003344";
const ORG_ID = "850c8195-f504-11e5-8a84-bae50000015e";
const PRODUCT = {
  meta: metaOf("product", PRODUCT_ID),
  id: PRODUCT_ID,
  name: "Свеча ароматическая",
  code: "00001",
  article: "SV-01",
  externalCode: "sv01",
  archived: false,
  pathName: "Свечи",
  salePrices: [
    {
      value: 120000,
      priceType: {
        meta: metaOf("pricetype", "672559f1-cbf3-11e1-9eb9-889ffa6f49fd"),
        id: "672559f1-cbf3-11e1-9eb9-889ffa6f49fd",
        name: "Цена продажи",
      },
    },
  ],
  buyPrice: { value: 45000 },
  updated: "2026-10-09 12:15:00.000",
};
const ORDER = {
  meta: metaOf("customerorder", ORDER_ID),
  id: ORDER_ID,
  name: "00042",
  moment: "2026-10-09 12:15:00.000",
  sum: 360000,
  applicable: true,
  description: "Заказ с сайта №1024",
  agent: { meta: metaOf("counterparty", AGENT_ID) },
  organization: { meta: metaOf("organization", ORG_ID) },
  positions: {
    meta: {
      ...metaOf("customerorder", ORDER_ID),
      href: `${BASE}/entity/customerorder/${ORDER_ID}/positions`,
      type: "customerorderposition",
      size: 1,
      limit: 1000,
      offset: 0,
    },
  },
  payedSum: 0,
  shippedSum: 0,
  reservedSum: 360000,
};
const COUNTERPARTY = {
  meta: metaOf("counterparty", AGENT_ID),
  id: AGENT_ID,
  name: "Анна Тестова",
  phone: "+70001234567",
  email: "client@example.com",
  companyType: "individual",
  tags: ["сайт"],
};
const listMeta = (type: string, size: number) => ({
  href: `${BASE}/entity/${type}`,
  type,
  mediaType: "application/json",
  size,
  limit: 25,
  offset: 0,
});

export const moysklad: Passport = {
  id: "moysklad",
  name: "МойСклад",
  aliases: ["мойсклад", "moysklad", "moisklad"],
  domains: ["moysklad.ru"],
  summary_ru: "Товары и цены, остатки, заказы покупателей и контрагенты, вебхуки изменений.",
  docsUrl: DOCS,
  reviewed: "2026-10-09",
  baseUrl: BASE,
  sandboxBaseUrl: null,
  auth: { kind: "bearer", name: null },
  account: null,
  key: {
    fields: [
      {
        key: "token",
        label_ru: "Токен доступа МойСклад",
        hint_ru:
          "МойСклад → Настройки → Безопасность → Токены → «Создать токен» (от сотрудника с нужными правами)",
        example: "••••••••••••••••",
        pattern: /^[A-Za-z0-9]{20,128}$/,
        error_ru: "Токен МойСклад — строка из латинских букв и цифр, скопируйте его целиком",
      },
    ],
    compose: "plain",
    where_ru:
      "В МойСклад выпустите токен доступа для сотрудника с правами на товары и заказы (Настройки → Безопасность → Токены).",
  },
  operations: [
    op({
      id: "listOrganizations",
      method: "GET",
      path: "/entity/organization",
      summary: "Юрлица аккаунта (проверка ключа; ссылка organization для заказа)",
      params: [query("limit", "limit", int(undefined, { minimum: 1, maximum: 1000, example: 10 }))],
      response: list(obj({ meta, id: str(), name: str(), inn: str() }, ["meta", "id", "name"])),
      example: {
        meta: listMeta("organization", 1),
        rows: [{ meta: metaOf("organization", ORG_ID), id: ORG_ID, name: "ИП Тестова А. А." }],
      },
    }),
    op({
      id: "listProducts",
      method: "GET",
      path: "/entity/product",
      summary: "Товары: страница, поиск",
      params: [...paging, search],
      response: list(product),
      example: { meta: listMeta("product", 1), rows: [PRODUCT] },
    }),
    op({
      id: "getProduct",
      method: "GET",
      path: "/entity/product/{id}",
      summary: "Товар по ID",
      params: [idOf(PRODUCT_ID)],
      response: product,
      example: PRODUCT,
    }),
    op({
      id: "createProduct",
      method: "POST",
      path: "/entity/product",
      summary: "Создать товар",
      body: obj(productIn, ["name"], {
        example: { name: "Свеча ароматическая", article: "SV-01", externalCode: "sv01" },
      }),
      response: product,
      example: PRODUCT,
    }),
    op({
      id: "updateProduct",
      method: "PUT",
      path: "/entity/product/{id}",
      summary: "Изменить товар (цены, описание)",
      params: [idOf(PRODUCT_ID)],
      body: obj(productIn, [], { example: { description: "Соевый воск, 40 часов горения" } }),
      response: product,
      example: { ...PRODUCT, description: "Соевый воск, 40 часов горения" },
    }),
    op({
      id: "getStock",
      method: "GET",
      path: "/report/stock/all",
      summary: "Остатки товаров по всем складам",
      params: [...paging, search],
      response: list(
        obj(
          {
            meta,
            name: str(),
            code: str(),
            article: str(),
            externalCode: str(),
            stock: num("Остаток"),
            reserve: num("Резерв"),
            inTransit: num("Ожидание"),
            quantity: num("Доступно: остаток − резерв + ожидание"),
            price: num("Себестоимость, копейки"),
            salePrice: num("Цена продажи, копейки"),
          },
          ["name", "stock"],
        ),
      ),
      example: {
        meta: { ...listMeta("stock", 1), href: `${BASE}/report/stock/all` },
        rows: [
          {
            meta: metaOf("product", PRODUCT_ID),
            name: "Свеча ароматическая",
            code: "00001",
            article: "SV-01",
            externalCode: "sv01",
            stock: 12,
            reserve: 3,
            inTransit: 0,
            quantity: 9,
            price: 45000,
            salePrice: 120000,
          },
        ],
      },
    }),
    op({
      id: "listCustomerOrders",
      method: "GET",
      path: "/entity/customerorder",
      summary: "Заказы покупателей: страница, поиск",
      params: [...paging, search],
      response: list(order),
      example: { meta: listMeta("customerorder", 1), rows: [ORDER] },
    }),
    op({
      id: "getCustomerOrder",
      method: "GET",
      path: "/entity/customerorder/{id}",
      summary: "Заказ покупателя по ID",
      params: [idOf(ORDER_ID)],
      response: order,
      example: ORDER,
    }),
    op({
      id: "createCustomerOrder",
      method: "POST",
      path: "/entity/customerorder",
      summary: "Создать заказ покупателя с позициями и резервом",
      body: obj(
        {
          name: str("Номер; пусто — присвоит МойСклад"),
          organization: link("organization"),
          agent: link("counterparty"),
          description: str(undefined, { maxLength: 4096 }),
          externalCode: str("Номер заказа в системе"),
          positions: arr(
            obj(
              {
                quantity: num("Количество", { minimum: 0 }),
                price: num("Цена за единицу, копейки", { minimum: 0 }),
                discount: num("Скидка, %", { minimum: 0, maximum: 100 }),
                vat: int("НДС, %"),
                reserve: num("Сколько зарезервировать"),
                assortment: link("product"),
              },
              ["quantity", "assortment"],
            ),
            { maxItems: 100 },
          ),
        },
        ["organization", "agent"],
        {
          example: {
            organization: { meta: metaOf("organization", ORG_ID) },
            agent: { meta: metaOf("counterparty", AGENT_ID) },
            description: "Заказ с сайта №1024",
            externalCode: "1024",
            positions: [
              { quantity: 3, price: 120000, reserve: 3, assortment: { meta: metaOf("product", PRODUCT_ID) } },
            ],
          },
        },
      ),
      response: order,
      example: ORDER,
    }),
    op({
      id: "updateCustomerOrder",
      method: "PUT",
      path: "/entity/customerorder/{id}",
      summary: "Изменить заказ: статус, описание, проведение",
      params: [idOf(ORDER_ID)],
      body: obj({ state: link("state"), description: str(), applicable: bool() }, [], {
        example: { description: "Передан в доставку" },
      }),
      response: order,
      example: { ...ORDER, description: "Передан в доставку" },
    }),
    op({
      id: "listCounterparties",
      method: "GET",
      path: "/entity/counterparty",
      summary: "Контрагенты: поиск по имени, телефону, почте",
      params: [...paging, search],
      response: list(counterparty),
      example: { meta: listMeta("counterparty", 1), rows: [COUNTERPARTY] },
    }),
    op({
      id: "createCounterparty",
      method: "POST",
      path: "/entity/counterparty",
      summary: "Создать контрагента (покупателя)",
      body: obj(
        {
          name: str("Имя или название", { maxLength: 255 }),
          phone: str(undefined, { maxLength: 255 }),
          email: str(undefined, { maxLength: 255 }),
          companyType: oneOf(["legal", "entrepreneur", "individual"]),
          description: str(),
          tags: arr(str(), { maxItems: 20 }),
        },
        ["name"],
        {
          example: { name: "Анна Тестова", phone: "+70001234567", companyType: "individual", tags: ["сайт"] },
        },
      ),
      response: counterparty,
      example: COUNTERPARTY,
    }),
    op({
      id: "createWebhook",
      method: "POST",
      path: "/entity/webhook",
      summary: "Вебхук на создание или изменение объектов",
      body: obj(
        {
          url: str("Адрес вебхука системы", { format: "uri" }),
          action: oneOf(["CREATE", "UPDATE", "DELETE"]),
          entityType: str("Тип объекта: customerorder, product, counterparty…"),
        },
        ["url", "action", "entityType"],
        {
          example: {
            url: "https://shop.example.com/hooks/moysklad",
            action: "UPDATE",
            entityType: "customerorder",
          },
        },
      ),
      response: obj({ meta, id: str(), url: str(), action: str(), entityType: str(), enabled: bool() }, [
        "id",
        "url",
        "action",
        "entityType",
      ]),
      example: {
        meta: metaOf("webhook", "e3a1a4b2-6f2e-11ee-0a80-0d4e0012a3b6"),
        id: "e3a1a4b2-6f2e-11ee-0a80-0d4e0012a3b6",
        url: "https://shop.example.com/hooks/moysklad",
        action: "UPDATE",
        entityType: "customerorder",
        enabled: true,
      },
    }),
  ],
  check: "listOrganizations",
  docs: {
    listOrganizations: `${DOCS}/dictionaries/#suschnosti-jurlico`,
    listProducts: `${DOCS}/dictionaries/#suschnosti-towar`,
    getProduct: `${DOCS}/dictionaries/#suschnosti-towar`,
    createProduct: `${DOCS}/dictionaries/#suschnosti-towar`,
    updateProduct: `${DOCS}/dictionaries/#suschnosti-towar`,
    getStock: `${DOCS}/reports/#otchety-otchet-ostatki`,
    listCustomerOrders: `${DOCS}/documents/#dokumenty-zakaz-pokupatelq`,
    getCustomerOrder: `${DOCS}/documents/#dokumenty-zakaz-pokupatelq`,
    createCustomerOrder: `${DOCS}/documents/#dokumenty-zakaz-pokupatelq`,
    updateCustomerOrder: `${DOCS}/documents/#dokumenty-zakaz-pokupatelq`,
    listCounterparties: `${DOCS}/dictionaries/#suschnosti-kontragent`,
    createCounterparty: `${DOCS}/dictionaries/#suschnosti-kontragent`,
    createWebhook: `${DOCS}/dictionaries/#suschnosti-vebhuki`,
  },
  hints: [
    {
      entity: "product",
      field: "title",
      operation: "listProducts",
      pointer: "/response/rows/0/name",
      direction: "from_api",
    },
    {
      entity: "product",
      field: "sku",
      operation: "listProducts",
      pointer: "/response/rows/0/article",
      direction: "from_api",
    },
    {
      entity: "product",
      field: "price",
      operation: "listProducts",
      pointer: "/response/rows/0/salePrices/0/value",
      direction: "from_api",
    },
    {
      entity: "product",
      field: "stock",
      operation: "getStock",
      pointer: "/response/rows/0/quantity",
      direction: "from_api",
    },
    {
      entity: "order",
      field: "number",
      operation: "createCustomerOrder",
      pointer: "/body/externalCode",
      direction: "to_api",
    },
    {
      entity: "order",
      field: "comment",
      operation: "createCustomerOrder",
      pointer: "/body/description",
      direction: "to_api",
    },
    {
      entity: "order",
      field: "total",
      operation: "createCustomerOrder",
      pointer: "/response/sum",
      direction: "from_api",
    },
    {
      entity: "client",
      field: "name",
      operation: "createCounterparty",
      pointer: "/body/name",
      direction: "to_api",
    },
    {
      entity: "client",
      field: "phone",
      operation: "createCounterparty",
      pointer: "/body/phone",
      direction: "to_api",
    },
    {
      entity: "client",
      field: "email",
      operation: "createCounterparty",
      pointer: "/body/email",
      direction: "to_api",
    },
  ],
  limits_ru:
    "Не больше 45 запросов за 3 секунды на аккаунт, 5 параллельных от сотрудника и 20 от аккаунта; на 429 — пауза. До 1000 записей на страницу (limit, offset). Цены и суммы — в копейках.",
  sandbox_ru: "Песочницы нет: для проверок — пробный аккаунт МойСклад (14 дней) и токен его сотрудника.",
  webhooks: {
    events: ["CREATE", "UPDATE", "DELETE"],
    setup_ru:
      "Операция createWebhook: адрес вебхука системы, действие и тип объекта (например, UPDATE customerorder).",
    verify: "refetch",
    contentType: "json",
    verify_ru:
      "Вебхуки МойСклад не подписаны: accountId события должен совпасть с аккаунтом интеграции, объект перечитывается по ID из meta.href с ключом.",
    parse(body) {
      const events = Array.isArray(body.events) ? body.events : [];
      const e = events[0] as { meta?: { href?: unknown; type?: unknown }; action?: unknown } | undefined;
      const href = typeof e?.meta?.href === "string" ? e.meta.href : null;
      const type = typeof e?.meta?.type === "string" ? e.meta.type : null;
      const action = typeof e?.action === "string" ? e.action : null;
      if (!href || !type || !action) return null;
      const id = /\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(href)?.[1] ?? null;
      const event = `${type}.${action}`;
      if (!id || action === "DELETE") return { event, refetch: null };
      if (type === "customerorder")
        return { event, refetch: { operation: "getCustomerOrder", input: { id } } };
      if (type === "product") return { event, refetch: { operation: "getProduct", input: { id } } };
      return { event, refetch: null };
    },
  },
  notes_ru: [
    "Связи между объектами — ссылки {meta: {href, type, mediaType}}: для заказа нужны organization (listOrganizations) и agent (контрагент).",
    "Остаток для витрины — quantity из getStock (остаток минус резерв плюс ожидание).",
    "API МойСклад отвечает только сжатым телом (Accept-Encoding: gzip): egress-клиент рантайма просит и распаковывает сжатие сам.",
  ],
  verify_ru: [
    "ответ МойСклад на запрос без Accept-Encoding: gzip (рантайм шлёт его всегда)",
    "путь в интерфейсе к выпуску токена (Настройки → Безопасность → Токены)",
    "якоря страниц документации по операциям",
    "имя заголовка паузы при 429",
  ],
};
