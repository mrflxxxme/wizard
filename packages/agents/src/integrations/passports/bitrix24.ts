// Битрикс24 REST through an incoming webhook (https://apidocs.bitrix24.ru/): CRM leads, deals, contacts and their
// statuses. The webhook URL https://<portal>/rest/<user>/<code>/ carries the key in the path: the portal host and the
// user are the account, the code is the secret (auth kind path, no prefix). Values come back as strings.
import type { ApiSchema } from "../schema.js";
import { anyObj, arr, int, num, obj, oneOf, op, query, str } from "./kit.js";
import type { Passport } from "./types.js";

const DOCS = "https://apidocs.bitrix24.ru";
const ref = (entity: string, method: string) => `${DOCS}/api-reference/crm/${entity}/${method}.html`;

const time = obj({
  start: num(),
  finish: num(),
  duration: num(),
  processing: num(),
  date_start: str(),
  date_finish: str(),
});
/** Every answer is {result, time}; lists add total and next (offset of the next page, 50 per page). */
const answer = (result: ApiSchema, list = false): ApiSchema =>
  obj({ result, time, ...(list ? { total: int(), next: int() } : {}) }, ["result"]);
const TIME = {
  start: 1791537300.1,
  finish: 1791537300.2,
  duration: 0.1,
  processing: 0.05,
  date_start: "2026-10-09T12:15:00+03:00",
  date_finish: "2026-10-09T12:15:00+03:00",
};
const nstr = (description?: string): ApiSchema => str(description, { nullable: true });

const multi = (types: readonly string[]) =>
  arr(obj({ VALUE: str("Значение"), VALUE_TYPE: oneOf(types) }, ["VALUE"]), { maxItems: 10 });
const multiOut = arr(obj({ ID: str(), VALUE_TYPE: str(), VALUE: str(), TYPE_ID: str() }));
const phoneIn = multi(["WORK", "MOBILE", "HOME", "OTHER"]);
const emailIn = multi(["WORK", "HOME", "OTHER"]);
const params = obj({ REGISTER_SONET_EVENT: oneOf(["Y", "N"], "Уведомить ответственного в ленте") });
const idParam = query("id", "id", int("ID записи", { minimum: 1, example: 1024 }), true);

const leadFields = obj({
  TITLE: str("Название лида", { maxLength: 255 }),
  NAME: str(),
  LAST_NAME: str(),
  PHONE: phoneIn,
  EMAIL: emailIn,
  COMMENTS: str(),
  SOURCE_ID: str("Источник: WEB, CALL…"),
  STATUS_ID: str("Статус: NEW, IN_PROCESS, CONVERTED…"),
  OPPORTUNITY: num("Сумма"),
  CURRENCY_ID: str(undefined, { example: "RUB" }),
  ASSIGNED_BY_ID: int("Ответственный"),
});
const lead = obj(
  {
    ID: str(),
    TITLE: str(),
    NAME: nstr(),
    LAST_NAME: nstr(),
    STATUS_ID: str(),
    SOURCE_ID: nstr(),
    OPPORTUNITY: nstr("Сумма строкой: 25000.00"),
    CURRENCY_ID: nstr(),
    ASSIGNED_BY_ID: nstr(),
    COMMENTS: nstr(),
    DATE_CREATE: str(undefined, { format: "date-time" }),
    PHONE: multiOut,
    EMAIL: multiOut,
  },
  ["ID", "TITLE", "STATUS_ID"],
);
const dealFields = obj({
  TITLE: str("Название сделки", { maxLength: 255 }),
  STAGE_ID: str("Стадия: NEW, PREPARATION, WON, LOSE… (в воронках — C<id>:NEW)"),
  CATEGORY_ID: int("Воронка (0 — общая)"),
  OPPORTUNITY: num("Сумма"),
  CURRENCY_ID: str(),
  CONTACT_ID: int(),
  COMMENTS: str(),
  SOURCE_ID: str(),
  ASSIGNED_BY_ID: int(),
});
const deal = obj(
  {
    ID: str(),
    TITLE: str(),
    STAGE_ID: str(),
    CATEGORY_ID: nstr(),
    OPPORTUNITY: nstr(),
    CURRENCY_ID: nstr(),
    CONTACT_ID: nstr(),
    ASSIGNED_BY_ID: nstr(),
    CLOSED: oneOf(["Y", "N"]),
    DATE_CREATE: str(undefined, { format: "date-time" }),
  },
  ["ID", "TITLE", "STAGE_ID"],
);
const contact = obj(
  { ID: str(), NAME: nstr(), LAST_NAME: nstr(), PHONE: multiOut, EMAIL: multiOut, DATE_CREATE: str() },
  ["ID"],
);
const listBody = (filter: Record<string, ApiSchema>, example: unknown): ApiSchema =>
  obj(
    {
      filter: obj(filter),
      select: arr(str(), { maxItems: 50 }),
      order: obj({ DATE_CREATE: oneOf(["ASC", "DESC"]), ID: oneOf(["ASC", "DESC"]) }),
      start: int("Смещение страницы (next из прошлого ответа)", { minimum: 0 }),
    },
    [],
    { example },
  );
const LEAD = {
  ID: "1024",
  TITLE: "Заявка с сайта",
  NAME: "Анна",
  LAST_NAME: null,
  STATUS_ID: "NEW",
  SOURCE_ID: "WEB",
  OPPORTUNITY: "25000.00",
  CURRENCY_ID: "RUB",
  ASSIGNED_BY_ID: "1",
  COMMENTS: "Перезвонить вечером",
  DATE_CREATE: "2026-10-09T12:15:00+03:00",
  PHONE: [{ ID: "2048", VALUE_TYPE: "WORK", VALUE: "+70001234567", TYPE_ID: "PHONE" }],
};
const DEAL = {
  ID: "512",
  TITLE: "Заказ №1024",
  STAGE_ID: "NEW",
  CATEGORY_ID: "0",
  OPPORTUNITY: "25000.00",
  CURRENCY_ID: "RUB",
  CONTACT_ID: "77",
  ASSIGNED_BY_ID: "1",
  CLOSED: "N",
  DATE_CREATE: "2026-10-09T12:20:00+03:00",
};
const CONTACT = {
  ID: "77",
  NAME: "Анна",
  LAST_NAME: "Тестова",
  PHONE: [{ ID: "2050", VALUE_TYPE: "MOBILE", VALUE: "+70001234567", TYPE_ID: "PHONE" }],
  DATE_CREATE: "2026-10-09T12:15:00+03:00",
};
const LEAD_IN = {
  TITLE: "Заявка с сайта",
  NAME: "Анна",
  PHONE: [{ VALUE: "+70001234567", VALUE_TYPE: "WORK" }],
  SOURCE_ID: "WEB",
  COMMENTS: "Перезвонить вечером",
};

export const bitrix24: Passport = {
  id: "bitrix24",
  name: "Битрикс24",
  aliases: ["битрикс24", "bitrix24", "б24", "b24", "битрикс24crm", "bitrix24crm"],
  domains: ["bitrix24.ru", "bitrix24.by", "bitrix24.kz", "bitrix24.com", "bitrix24.eu", "bitrix24.de"],
  summary_ru:
    "CRM через входящий вебхук: лиды, сделки и контакты — создать, изменить, найти; статусы и стадии.",
  docsUrl: DOCS,
  reviewed: "2026-10-09",
  baseUrl: "https://{host}/rest/{user}",
  sandboxBaseUrl: null,
  auth: { kind: "path", name: null },
  account: {
    label_ru: "Адрес портала Битрикс24",
    example: "mycompany.bitrix24.ru",
    suffixes: ["bitrix24.ru", "bitrix24.by", "bitrix24.kz", "bitrix24.com", "bitrix24.eu", "bitrix24.de"],
    customHost: true,
    reserved: ["www", "apidocs", "helpdesk", "dev", "training", "marketplace", "auth2", "oauth", "util"],
    placeholder: "your-portal.bitrix24.ru",
  },
  key: {
    fields: [
      {
        key: "webhook_url",
        label_ru: "Адрес входящего вебхука",
        hint_ru:
          "Битрикс24 → Разработчикам → Другое → Входящий вебхук: права «CRM», затем скопируйте «Вебхук для вызова REST API»",
        example: "https://mycompany.bitrix24.ru/rest/1/••••••••/",
      },
    ],
    compose: "webhook_url",
    where_ru:
      "Битрикс24 → Разработчикам → Другое → Входящий вебхук с правами CRM. Адрес вставляйте только в окно ключа: в нём секретный код.",
  },
  operations: [
    op({
      id: "getLeadFields",
      method: "GET",
      path: "/crm.lead.fields.json",
      summary: "Описание полей лида (проверка вебхука и прав CRM)",
      response: answer(anyObj("Поля: тип, обязательность, подпись")),
      example: {
        result: {
          ID: { type: "integer", isRequired: false, isReadOnly: true, title: "ID" },
          TITLE: { type: "string", isRequired: false, isReadOnly: false, title: "Название лида" },
        },
        time: TIME,
      },
    }),
    op({
      id: "addLead",
      method: "POST",
      path: "/crm.lead.add.json",
      summary: "Создать лид (заявку)",
      body: obj({ fields: leadFields, params }, ["fields"], {
        example: { fields: LEAD_IN, params: { REGISTER_SONET_EVENT: "Y" } },
      }),
      response: answer(int("ID нового лида")),
      example: { result: 1024, time: TIME },
    }),
    op({
      id: "updateLead",
      method: "POST",
      path: "/crm.lead.update.json",
      summary: "Изменить лид",
      body: obj({ id: int(undefined, { minimum: 1 }), fields: leadFields, params }, ["id", "fields"], {
        example: { id: 1024, fields: { STATUS_ID: "IN_PROCESS" } },
      }),
      response: answer({ type: "boolean" }),
      example: { result: true, time: TIME },
    }),
    op({
      id: "getLead",
      method: "GET",
      path: "/crm.lead.get.json",
      summary: "Лид по ID",
      params: [idParam],
      response: answer(lead),
      example: { result: LEAD, time: TIME },
    }),
    op({
      id: "listLeads",
      method: "POST",
      path: "/crm.lead.list.json",
      summary: "Лиды с фильтром, по 50 на страницу",
      body: listBody(
        { STATUS_ID: str(), SOURCE_ID: str(), ASSIGNED_BY_ID: int(), PHONE: str("Поиск по телефону") },
        {
          filter: { STATUS_ID: "NEW" },
          select: ["ID", "TITLE", "NAME", "STATUS_ID", "PHONE"],
          order: { DATE_CREATE: "DESC" },
          start: 0,
        },
      ),
      response: answer(arr(lead), true),
      example: { result: [LEAD], total: 1, time: TIME },
    }),
    op({
      id: "addDeal",
      method: "POST",
      path: "/crm.deal.add.json",
      summary: "Создать сделку",
      body: obj({ fields: dealFields, params }, ["fields"], {
        example: { fields: { TITLE: "Заказ №1024", OPPORTUNITY: 25000, CURRENCY_ID: "RUB", CONTACT_ID: 77 } },
      }),
      response: answer(int("ID новой сделки")),
      example: { result: 512, time: TIME },
    }),
    op({
      id: "updateDeal",
      method: "POST",
      path: "/crm.deal.update.json",
      summary: "Изменить сделку: стадия, сумма, поля",
      body: obj({ id: int(undefined, { minimum: 1 }), fields: dealFields, params }, ["id", "fields"], {
        example: { id: 512, fields: { STAGE_ID: "WON" } },
      }),
      response: answer({ type: "boolean" }),
      example: { result: true, time: TIME },
    }),
    op({
      id: "getDeal",
      method: "GET",
      path: "/crm.deal.get.json",
      summary: "Сделка по ID",
      params: [{ ...idParam, schema: int("ID сделки", { minimum: 1, example: 512 }) }],
      response: answer(deal),
      example: { result: DEAL, time: TIME },
    }),
    op({
      id: "listDeals",
      method: "POST",
      path: "/crm.deal.list.json",
      summary: "Сделки с фильтром, по 50 на страницу",
      body: listBody(
        { STAGE_ID: str(), CATEGORY_ID: int(), ASSIGNED_BY_ID: int(), CONTACT_ID: int() },
        { filter: { CATEGORY_ID: 0 }, select: ["ID", "TITLE", "STAGE_ID", "OPPORTUNITY"], start: 0 },
      ),
      response: answer(arr(deal), true),
      example: { result: [DEAL], total: 1, time: TIME },
    }),
    op({
      id: "addContact",
      method: "POST",
      path: "/crm.contact.add.json",
      summary: "Создать контакт",
      body: obj(
        {
          fields: obj({ NAME: str(), LAST_NAME: str(), PHONE: phoneIn, EMAIL: emailIn, SOURCE_ID: str() }),
          params,
        },
        ["fields"],
        {
          example: {
            fields: {
              NAME: "Анна",
              LAST_NAME: "Тестова",
              PHONE: [{ VALUE: "+70001234567", VALUE_TYPE: "MOBILE" }],
            },
          },
        },
      ),
      response: answer(int("ID нового контакта")),
      example: { result: 77, time: TIME },
    }),
    op({
      id: "listContacts",
      method: "POST",
      path: "/crm.contact.list.json",
      summary: "Контакты по телефону или почте (поиск дубля)",
      body: listBody(
        { PHONE: str(), EMAIL: str(), ASSIGNED_BY_ID: int() },
        { filter: { PHONE: "+70001234567" }, select: ["ID", "NAME", "LAST_NAME", "PHONE"] },
      ),
      response: answer(arr(contact), true),
      example: { result: [CONTACT], total: 1, time: TIME },
    }),
    op({
      id: "listStatuses",
      method: "POST",
      path: "/crm.status.list.json",
      summary: "Справочники: статусы лидов (STATUS), стадии сделок (DEAL_STAGE), источники (SOURCE)",
      body: obj(
        {
          filter: obj({ ENTITY_ID: str("STATUS, DEAL_STAGE, SOURCE…") }),
          order: obj({ SORT: oneOf(["ASC", "DESC"]) }),
        },
        [],
        {
          example: { filter: { ENTITY_ID: "DEAL_STAGE" }, order: { SORT: "ASC" } },
        },
      ),
      response: answer(
        arr(
          obj({ ID: str(), ENTITY_ID: str(), STATUS_ID: str(), NAME: str(), SORT: {}, CATEGORY_ID: {} }, [
            "STATUS_ID",
            "NAME",
          ]),
        ),
      ),
      example: {
        result: [
          { ID: "1", ENTITY_ID: "DEAL_STAGE", STATUS_ID: "NEW", NAME: "Новая", SORT: "10" },
          { ID: "7", ENTITY_ID: "DEAL_STAGE", STATUS_ID: "WON", NAME: "Сделка успешна", SORT: "60" },
        ],
        time: TIME,
      },
    }),
  ],
  check: "getLeadFields",
  docs: {
    getLeadFields: ref("leads", "crm-lead-fields"),
    addLead: ref("leads", "crm-lead-add"),
    updateLead: ref("leads", "crm-lead-update"),
    getLead: ref("leads", "crm-lead-get"),
    listLeads: ref("leads", "crm-lead-list"),
    addDeal: ref("deals", "crm-deal-add"),
    updateDeal: ref("deals", "crm-deal-update"),
    getDeal: ref("deals", "crm-deal-get"),
    listDeals: ref("deals", "crm-deal-list"),
    addContact: ref("contacts", "crm-contact-add"),
    listContacts: ref("contacts", "crm-contact-list"),
    listStatuses: ref("status", "crm-status-list"),
  },
  hints: [
    {
      entity: "lead",
      field: "name",
      operation: "addLead",
      pointer: "/body/fields/NAME",
      direction: "to_api",
    },
    {
      entity: "lead",
      field: "phone",
      operation: "addLead",
      pointer: "/body/fields/PHONE/0/VALUE",
      direction: "to_api",
    },
    {
      entity: "lead",
      field: "email",
      operation: "addLead",
      pointer: "/body/fields/EMAIL/0/VALUE",
      direction: "to_api",
    },
    {
      entity: "lead",
      field: "comment",
      operation: "addLead",
      pointer: "/body/fields/COMMENTS",
      direction: "to_api",
    },
    {
      entity: "lead",
      field: "crm_id",
      operation: "addLead",
      pointer: "/response/result",
      direction: "from_api",
    },
    {
      entity: "deal",
      field: "title",
      operation: "addDeal",
      pointer: "/body/fields/TITLE",
      direction: "to_api",
    },
    {
      entity: "deal",
      field: "amount",
      operation: "addDeal",
      pointer: "/body/fields/OPPORTUNITY",
      direction: "to_api",
    },
    {
      entity: "deal",
      field: "status",
      operation: "updateDeal",
      pointer: "/body/fields/STAGE_ID",
      direction: "to_api",
    },
    {
      entity: "deal",
      field: "status",
      operation: "getDeal",
      pointer: "/response/result/STAGE_ID",
      direction: "from_api",
    },
    {
      entity: "client",
      field: "name",
      operation: "addContact",
      pointer: "/body/fields/NAME",
      direction: "to_api",
    },
    {
      entity: "client",
      field: "phone",
      operation: "addContact",
      pointer: "/body/fields/PHONE/0/VALUE",
      direction: "to_api",
    },
    {
      entity: "booking",
      field: "name",
      operation: "addLead",
      pointer: "/body/fields/NAME",
      direction: "to_api",
    },
  ],
  limits_ru:
    "Около 2 запросов в секунду на портал (с запасом до 50 подряд; на тарифе «Энтерпрайз» — 5): при превышении — 503 QUERY_LIMIT_EXCEEDED, пауза и повтор. Списки — по 50 записей, следующая страница — start = next. Есть и лимит времени выполнения методов (503 OPERATION_TIME_LIMIT).",
  sandbox_ru:
    "Песочницы нет: для проверок — бесплатный или пробный портал Битрикс24 с отдельным входящим вебхуком.",
  webhooks: {
    events: ["ONCRMLEADADD", "ONCRMLEADUPDATE", "ONCRMDEALADD", "ONCRMDEALUPDATE", "ONCRMCONTACTADD"],
    setup_ru:
      "Битрикс24 → Разработчикам → Другое → Исходящий вебхук: адрес вебхука системы и события; код авторизации (application_token) — в окно ключа.",
    verify: "body_token",
    tokenField: "auth[application_token]",
    contentType: "form",
    verify_ru:
      "Исходящий вебхук приходит формой с полем auth[application_token]: сравнение с сохранённым кодом за постоянное время, затем запись перечитывается getLead/getDeal.",
    parse(body) {
      const event = typeof body.event === "string" ? body.event.toUpperCase() : null;
      const id = Number(body["data[FIELDS][ID]"]);
      if (!event?.startsWith("ONCRM")) return null;
      if (!Number.isInteger(id) || id <= 0 || event.endsWith("DELETE")) return { event, refetch: null };
      if (event.startsWith("ONCRMLEAD")) return { event, refetch: { operation: "getLead", input: { id } } };
      if (event.startsWith("ONCRMDEAL")) return { event, refetch: { operation: "getDeal", input: { id } } };
      return { event, refetch: null };
    },
  },
  notes_ru: [
    "Адрес API — портал владельца и пользователь вебхука (mycompany.bitrix24.ru/rest/1): до ввода ключа в контракте стоит заглушка your-portal.bitrix24.ru.",
    "Код вебхука — секрет в пути запроса: платформа подставляет его на выходе, в коде и брифе — только secret://.",
    "Битрикс24 возвращает числа и ID строками, пустые поля — null; телефоны и почта — списки {VALUE, VALUE_TYPE}.",
    "Коробочный Битрикс24 работает так же по адресу своего сервера (свой домен в адресе вебхука).",
  ],
  verify_ru: [
    "фильтр crm.lead.list по PHONE",
    "тип SORT в crm.status.list (строка или число)",
    "вебхук без прав CRM: код ответа crm.lead.fields (401 или 403)",
  ],
};
