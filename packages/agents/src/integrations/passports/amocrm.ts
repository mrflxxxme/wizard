// amoCRM API v4 (https://www.amocrm.ru/developers/content/crm_platform/api-reference): leads, contacts, pipelines and
// statuses, notes, the account. The API lives on the owner's account host (<subdomain>.amocrm.ru); the key is a
// long-lived token of a private integration (Bearer). Lists answer 204 without a body when nothing is found.
// /leads/pipelines stands before /leads/{id}: the mock serves the first operation whose path matches.
import type { ApiSchema } from "../schema.js";
import { arr, bool, int, obj, oneOf, op, path, query, str } from "./kit.js";
import type { Passport } from "./types.js";

const DOCS = "https://www.amocrm.ru/developers/content/crm_platform";

/** A custom field value as the API returns it (value may be text, number or flag). */
const fieldOut = obj(
  {
    field_id: int(),
    field_name: str(),
    field_code: str(undefined, { nullable: true }),
    field_type: str(),
    values: arr(obj({ value: {}, enum_id: int(), enum_code: str() })),
  },
  ["field_id", "values"],
);
/** A custom field value the system sends: by code (PHONE, EMAIL) or by id; text values. */
const fieldIn = obj(
  {
    field_id: int("ID поля аккаунта"),
    field_code: str("Код поля: PHONE, EMAIL…"),
    values: arr(
      obj(
        {
          value: str("Значение"),
          enum_code: oneOf(["WORK", "WORKDD", "MOB", "FAX", "HOME", "OTHER", "PRIV"]),
        },
        ["value"],
      ),
      { maxItems: 10 },
    ),
  },
  ["values"],
);
const fieldsIn = arr(fieldIn, { maxItems: 40 });
const fieldsOut: ApiSchema = { ...arr(fieldOut), nullable: true };

const lead = obj(
  {
    id: int(),
    name: str(),
    price: int("Бюджет, рубли"),
    responsible_user_id: int(),
    status_id: int(),
    pipeline_id: int(),
    created_at: int("Unix-время"),
    updated_at: int(),
    closed_at: int(undefined, { nullable: true }),
    custom_fields_values: fieldsOut,
    _embedded: obj({
      tags: arr(obj({ id: int(), name: str() })),
      contacts: arr(obj({ id: int(), is_main: bool() })),
    }),
  },
  ["id", "name", "status_id", "pipeline_id"],
);
const leadIn = {
  name: str("Название сделки", { maxLength: 255 }),
  price: int("Бюджет, рубли", { minimum: 0 }),
  pipeline_id: int("Воронка"),
  status_id: int("Этап воронки"),
  responsible_user_id: int(),
  custom_fields_values: fieldsIn,
};
const contact = obj(
  {
    id: int(),
    name: str(),
    first_name: str(),
    last_name: str(),
    responsible_user_id: int(),
    created_at: int(),
    updated_at: int(),
    custom_fields_values: fieldsOut,
  },
  ["id", "name"],
);
const contactIn = {
  name: str("Полное имя"),
  first_name: str(),
  last_name: str(),
  responsible_user_id: int(),
  custom_fields_values: fieldsIn,
};
const PHONE = { field_code: "PHONE", values: [{ value: "+70001234567", enum_code: "WORK" }] };
const LEAD = {
  id: 3912171,
  name: "Заявка с сайта №1024",
  price: 25000,
  responsible_user_id: 504141,
  status_id: 143,
  pipeline_id: 3177727,
  created_at: 1791537300,
  updated_at: 1791537360,
  closed_at: null,
  custom_fields_values: null,
  _embedded: { tags: [{ id: 1, name: "сайт" }], contacts: [{ id: 7143599, is_main: true }] },
};
const CONTACT = {
  id: 7143599,
  name: "Анна Тестова",
  first_name: "Анна",
  last_name: "Тестова",
  responsible_user_id: 504141,
  created_at: 1791537300,
  updated_at: 1791537300,
  custom_fields_values: [
    {
      field_id: 3,
      field_name: "Телефон",
      field_code: "PHONE",
      field_type: "multitext",
      values: [{ value: "+70001234567", enum_id: 1, enum_code: "WORK" }],
    },
  ],
};
const page = [
  query("page", "page", int("Страница", { minimum: 1, example: 1 })),
  query("limit", "limit", int("Сколько на странице (до 250)", { minimum: 1, maximum: 250, example: 50 })),
  query("query", "query", str("Поиск по тексту, телефону, почте")),
  query("with", "with", str("Связанные сущности: contacts", { example: "contacts" })),
];
const leadId = path("id", "id", int("ID сделки", { example: LEAD.id }));
const contactId = path("id", "id", int("ID контакта", { example: CONTACT.id }));
const created = (key: string, id: number): unknown => ({
  _links: { self: { href: `https://your-account.amocrm.ru/api/v4/${key}` } },
  _embedded: { [key]: [{ id, request_id: "0" }] },
});
const createdSchema = (key: string): ApiSchema =>
  obj(
    {
      _links: obj({ self: obj({ href: str() }) }),
      _embedded: obj({ [key]: arr(obj({ id: int(), request_id: str(), updated_at: int() }, ["id"])) }, [key]),
    },
    ["_embedded"],
  );

export const amocrm: Passport = {
  id: "amocrm",
  name: "amoCRM",
  aliases: ["amocrm", "амосрм", "амоцрм", "амокрм", "амо", "amo", "амоcrm"],
  domains: ["amocrm.ru", "amocrm.com"],
  summary_ru:
    "CRM: сделки (заявки) и контакты — создать, изменить, найти; воронки и этапы; примечания к сделкам.",
  docsUrl: `${DOCS}/api-reference`,
  reviewed: "2026-10-09",
  baseUrl: "https://{host}/api/v4",
  sandboxBaseUrl: null,
  auth: { kind: "bearer", name: null },
  account: {
    label_ru: "Адрес аккаунта amoCRM",
    example: "mycompany.amocrm.ru",
    suffixes: ["amocrm.ru", "amocrm.com"],
    customHost: false,
    reserved: ["www", "api", "developers", "help", "id", "market", "status", "auth"],
    placeholder: "your-account.amocrm.ru",
  },
  key: {
    fields: [
      {
        key: "account",
        label_ru: "Адрес аккаунта amoCRM",
        hint_ru: "Адрес из строки браузера, когда вы в amoCRM: mycompany.amocrm.ru",
        example: "mycompany.amocrm.ru",
      },
      {
        key: "token",
        label_ru: "Долгосрочный токен",
        hint_ru:
          "amoCRM → amoМаркет → ⋯ → Создать интеграцию → Внешняя интеграция → вкладка «Ключи и доступы» → «Долгосрочный токен»",
        example: "eyJ0eXAi••••••••",
        pattern: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
        error_ru: "Долгосрочный токен amoCRM — длинная строка из трёх частей через точку",
      },
    ],
    compose: "plain",
    where_ru:
      "В amoCRM создайте внешнюю интеграцию (amoМаркет → ⋯ → Создать интеграцию) и выпустите долгосрочный токен на нужный срок; нужны права администратора аккаунта.",
  },
  operations: [
    op({
      id: "getAccount",
      method: "GET",
      path: "/account",
      summary: "Параметры аккаунта (проверка ключа)",
      response: obj(
        {
          id: int(),
          name: str(),
          subdomain: str(),
          created_at: int(),
          current_user_id: int(),
          country: str(),
          currency: str(),
          is_unsorted_on: bool(),
          is_technical_account: bool(),
        },
        ["id", "name", "subdomain"],
      ),
      example: {
        id: 29085955,
        name: "Студия Вега",
        subdomain: "your-account",
        created_at: 1700000000,
        current_user_id: 504141,
        country: "RU",
        currency: "RUB",
        is_unsorted_on: true,
        is_technical_account: false,
      },
    }),
    op({
      id: "listLeads",
      method: "GET",
      path: "/leads",
      summary: "Сделки: страница, поиск (пусто — ответ 204 без тела)",
      params: page,
      response: obj(
        {
          _page: int(),
          _links: obj({ self: obj({ href: str() }) }),
          _embedded: obj({ leads: arr(lead) }, ["leads"]),
        },
        ["_embedded"],
      ),
      example: {
        _page: 1,
        _links: { self: { href: "https://your-account.amocrm.ru/api/v4/leads?page=1&limit=50" } },
        _embedded: { leads: [LEAD] },
      },
    }),
    op({
      id: "listPipelines",
      method: "GET",
      path: "/leads/pipelines",
      summary: "Воронки и их этапы (ID для status_id и pipeline_id)",
      response: obj(
        {
          _total_items: int(),
          _embedded: obj(
            {
              pipelines: arr(
                obj(
                  {
                    id: int(),
                    name: str(),
                    sort: int(),
                    is_main: bool(),
                    is_archive: bool(),
                    _embedded: obj({
                      statuses: arr(
                        obj(
                          {
                            id: int(),
                            name: str(),
                            sort: int(),
                            color: str(),
                            type: int(),
                            pipeline_id: int(),
                          },
                          ["id", "name"],
                        ),
                      ),
                    }),
                  },
                  ["id", "name"],
                ),
              ),
            },
            ["pipelines"],
          ),
        },
        ["_embedded"],
      ),
      example: {
        _total_items: 1,
        _embedded: {
          pipelines: [
            {
              id: 3177727,
              name: "Воронка",
              sort: 1,
              is_main: true,
              is_archive: false,
              _embedded: {
                statuses: [
                  {
                    id: 32392156,
                    name: "Первичный контакт",
                    sort: 10,
                    color: "#99ccff",
                    type: 0,
                    pipeline_id: 3177727,
                  },
                  {
                    id: 142,
                    name: "Успешно реализовано",
                    sort: 10000,
                    color: "#CCFF66",
                    type: 0,
                    pipeline_id: 3177727,
                  },
                  {
                    id: 143,
                    name: "Закрыто и не реализовано",
                    sort: 11000,
                    color: "#D5D8DB",
                    type: 0,
                    pipeline_id: 3177727,
                  },
                ],
              },
            },
          ],
        },
      },
    }),
    op({
      id: "getLead",
      method: "GET",
      path: "/leads/{id}",
      summary: "Сделка по ID",
      params: [leadId, query("with", "with", str("Связанные сущности: contacts", { example: "contacts" }))],
      response: lead,
      example: LEAD,
    }),
    op({
      id: "createLeadsComplex",
      method: "POST",
      path: "/leads/complex",
      summary: "Сделка вместе с контактом одним запросом (заявка с сайта)",
      body: arr(
        obj(
          {
            ...leadIn,
            _embedded: obj({
              contacts: arr(obj(contactIn), { maxItems: 1 }),
              tags: arr(obj({ name: str() }, ["name"]), { maxItems: 10 }),
            }),
          },
          [],
        ),
        {
          maxItems: 50,
          example: [
            {
              name: "Заявка с сайта №1024",
              price: 25000,
              _embedded: {
                contacts: [{ first_name: "Анна", custom_fields_values: [PHONE] }],
                tags: [{ name: "сайт" }],
              },
            },
          ],
        },
      ),
      response: arr(
        obj(
          {
            id: int(),
            contact_id: int(),
            company_id: int(undefined, { nullable: true }),
            request_id: arr(str()),
            merged: bool(),
          },
          ["id"],
        ),
      ),
      example: [{ id: LEAD.id, contact_id: CONTACT.id, company_id: null, request_id: ["0"], merged: false }],
    }),
    op({
      id: "createLeads",
      method: "POST",
      path: "/leads",
      summary: "Создать сделки (до 50 за запрос)",
      body: arr(obj({ ...leadIn, _embedded: obj({ contacts: arr(obj({ id: int() }, ["id"])) }) }), {
        maxItems: 50,
        example: [{ name: "Повторная продажа", price: 12000, _embedded: { contacts: [{ id: CONTACT.id }] } }],
      }),
      response: createdSchema("leads"),
      example: created("leads", LEAD.id),
    }),
    op({
      id: "updateLead",
      method: "PATCH",
      path: "/leads/{id}",
      summary: "Изменить сделку: этап, бюджет, поля",
      params: [leadId],
      body: obj(leadIn, [], { example: { status_id: 142, price: 25000 } }),
      response: obj({ id: int(), updated_at: int() }, ["id"]),
      example: { id: LEAD.id, updated_at: 1791540000 },
    }),
    op({
      id: "updateLeads",
      method: "PATCH",
      path: "/leads",
      summary: "Изменить несколько сделок",
      body: arr(obj({ id: int(), ...leadIn }, ["id"]), {
        maxItems: 50,
        example: [{ id: LEAD.id, status_id: 142 }],
      }),
      response: createdSchema("leads"),
      example: {
        _links: { self: { href: "https://your-account.amocrm.ru/api/v4/leads" } },
        _embedded: { leads: [{ id: LEAD.id, updated_at: 1791540000, request_id: "0" }] },
      },
    }),
    op({
      id: "addLeadNotes",
      method: "POST",
      path: "/leads/notes",
      summary: "Примечание к сделке",
      body: arr(
        obj(
          {
            entity_id: int("ID сделки"),
            note_type: oneOf(["common"]),
            params: obj({ text: str() }, ["text"]),
          },
          ["entity_id", "note_type", "params"],
        ),
        {
          maxItems: 50,
          example: [
            {
              entity_id: LEAD.id,
              note_type: "common",
              params: { text: "Клиент просит перезвонить вечером" },
            },
          ],
        },
      ),
      response: obj(
        {
          _embedded: obj({ notes: arr(obj({ id: int(), entity_id: int(), request_id: str() }, ["id"])) }, [
            "notes",
          ]),
        },
        ["_embedded"],
      ),
      example: { _embedded: { notes: [{ id: 42888817, entity_id: LEAD.id, request_id: "0" }] } },
    }),
    op({
      id: "listContacts",
      method: "GET",
      path: "/contacts",
      summary: "Контакты: страница, поиск по телефону или почте (пусто — 204)",
      params: page.filter((p) => p.name !== "with"),
      response: obj({ _page: int(), _embedded: obj({ contacts: arr(contact) }, ["contacts"]) }, [
        "_embedded",
      ]),
      example: { _page: 1, _embedded: { contacts: [CONTACT] } },
    }),
    op({
      id: "getContact",
      method: "GET",
      path: "/contacts/{id}",
      summary: "Контакт по ID",
      params: [contactId],
      response: contact,
      example: CONTACT,
    }),
    op({
      id: "createContacts",
      method: "POST",
      path: "/contacts",
      summary: "Создать контакты",
      body: arr(obj(contactIn), {
        maxItems: 50,
        example: [{ first_name: "Анна", last_name: "Тестова", custom_fields_values: [PHONE] }],
      }),
      response: createdSchema("contacts"),
      example: created("contacts", CONTACT.id),
    }),
    op({
      id: "updateContact",
      method: "PATCH",
      path: "/contacts/{id}",
      summary: "Изменить контакт",
      params: [contactId],
      body: obj(contactIn, [], { example: { custom_fields_values: [PHONE] } }),
      response: obj({ id: int(), updated_at: int() }, ["id"]),
      example: { id: CONTACT.id, updated_at: 1791540000 },
    }),
  ],
  check: "getAccount",
  docs: {
    getAccount: `${DOCS}/account-info`,
    listLeads: `${DOCS}/leads-api#leads-list`,
    getLead: `${DOCS}/leads-api#lead-detail`,
    createLeadsComplex: `${DOCS}/leads-api#leads-complex-add`,
    createLeads: `${DOCS}/leads-api#leads-add`,
    updateLead: `${DOCS}/leads-api#leads-edit`,
    updateLeads: `${DOCS}/leads-api#leads-edit`,
    addLeadNotes: `${DOCS}/events-and-notes#notes-add`,
    listContacts: `${DOCS}/contacts-api#contacts-list`,
    getContact: `${DOCS}/contacts-api#contact-detail`,
    createContacts: `${DOCS}/contacts-api#contacts-add`,
    updateContact: `${DOCS}/contacts-api#contacts-edit`,
    listPipelines: `${DOCS}/leads_pipelines#pipelines-list`,
  },
  hints: [
    {
      entity: "lead",
      field: "title",
      operation: "createLeadsComplex",
      pointer: "/body/0/name",
      direction: "to_api",
    },
    {
      entity: "lead",
      field: "name",
      operation: "createLeadsComplex",
      pointer: "/body/0/_embedded/contacts/0/first_name",
      direction: "to_api",
    },
    {
      entity: "lead",
      field: "phone",
      operation: "createLeadsComplex",
      pointer: "/body/0/_embedded/contacts/0/custom_fields_values/0/values/0/value",
      direction: "to_api",
    },
    {
      entity: "lead",
      field: "crm_id",
      operation: "createLeadsComplex",
      pointer: "/response/0/id",
      direction: "from_api",
    },
    {
      entity: "deal",
      field: "title",
      operation: "createLeads",
      pointer: "/body/0/name",
      direction: "to_api",
    },
    {
      entity: "deal",
      field: "amount",
      operation: "createLeads",
      pointer: "/body/0/price",
      direction: "to_api",
    },
    {
      entity: "deal",
      field: "status",
      operation: "updateLead",
      pointer: "/body/status_id",
      direction: "to_api",
    },
    {
      entity: "deal",
      field: "status",
      operation: "getLead",
      pointer: "/response/status_id",
      direction: "from_api",
    },
    {
      entity: "client",
      field: "name",
      operation: "createContacts",
      pointer: "/body/0/name",
      direction: "to_api",
    },
    {
      entity: "client",
      field: "crm_id",
      operation: "createContacts",
      pointer: "/response/_embedded/contacts/0/id",
      direction: "from_api",
    },
  ],
  limits_ru:
    "Не больше 7 запросов в секунду на интеграцию: на 429 — пауза, при систематическом превышении amoCRM блокирует IP (403). До 250 записей на страницу и до 50 сущностей в одном запросе на создание; пустой список — ответ 204 без тела.",
  sandbox_ru:
    "Песочницы нет: для проверок — пробный аккаунт amoCRM (14 дней) с отдельной интеграцией и токеном.",
  webhooks: {
    events: ["leads.add", "leads.update", "leads.status", "leads.delete", "contacts.add", "contacts.update"],
    setup_ru:
      "amoCRM → amoМаркет → ⋯ → Веб-хуки: адрес вебхука системы и события (добавление и смена этапа сделки, контакты).",
    verify: "refetch",
    contentType: "form",
    verify_ru:
      "Вебхуки amoCRM не подписаны и приходят формой (leads[add][0][id]=…): поле account[subdomain] должно совпасть с аккаунтом интеграции, сделка перечитывается getLead с ключом.",
    parse(body) {
      for (const [k, v] of Object.entries(body)) {
        const m = /^(leads|contacts)\[(add|update|status|delete|responsible)\]\[0\]\[id\]$/.exec(k);
        const id = Number(v);
        if (!m || !Number.isInteger(id) || id <= 0) continue;
        const event = `${m[1]}.${m[2]}`;
        if (m[2] === "delete") return { event, refetch: null };
        return { event, refetch: { operation: m[1] === "leads" ? "getLead" : "getContact", input: { id } } };
      }
      return null;
    },
  },
  notes_ru: [
    "Адрес API — домен аккаунта владельца (mycompany.amocrm.ru): до ввода ключа в контракте стоит заглушка your-account.amocrm.ru, проверка ключа на ней не пройдёт.",
    "Телефон и почта — не поля сделки, а поля контакта с кодами PHONE и EMAIL; сделку с контактом создаёт createLeadsComplex.",
    "ID воронок и этапов у каждого аккаунта свои — берутся из listPipelines; 142 и 143 — системные «успешно» и «не реализовано».",
  ],
  verify_ru: [
    "путь в интерфейсе amoCRM к выпуску долгосрочного токена и к настройке веб-хуков",
    "числовые значения пользовательских полей при передаче строкой",
    "якоря разделов документации по операциям",
  ],
};
