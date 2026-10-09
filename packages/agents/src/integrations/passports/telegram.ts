// Telegram Bot API (https://core.telegram.org/bots/api): the system's own bot — messages, photos, inline buttons, its
// webhook. The token is a path segment (/bot<token>/method, auth kind path). Notifications to the owner and staff
// are already the catalog connector telegram (@wizard/connectors, specs/connectors/telegram.yaml) — this passport is
// for a bot the system runs itself; the same rules hold: no ПДн in messages, the webhook's secret_token header.

import type { ApiSchema } from "../schema.js";
import { arr, bool, int, obj, oneOf, op, str } from "./kit.js";
import type { Passport } from "./types.js";

const DOCS = "https://core.telegram.org/bots/api";

/** Every answer is {ok, result}; errors are {ok: false, error_code, description}. */
const answer = (result: ApiSchema): ApiSchema =>
  obj({ ok: bool(), result, description: str() }, ["ok", "result"]);

const chat = obj(
  {
    id: int("ID чата (у групп и каналов — отрицательный)"),
    type: oneOf(["private", "group", "supergroup", "channel"]),
    title: str(),
    username: str(),
    first_name: str(),
  },
  ["id", "type"],
);
const message = obj(
  {
    message_id: int(),
    date: int("Unix-время"),
    chat,
    text: str(),
    caption: str(),
  },
  ["message_id", "date", "chat"],
);
const chatId = str("ID чата (число строкой) или @username канала", { minLength: 1, maxLength: 64 });
const parseMode = oneOf(["HTML", "MarkdownV2"], "Разметка текста");
const keyboard = obj(
  {
    inline_keyboard: arr(
      arr(
        obj(
          {
            text: str("Текст кнопки", { minLength: 1, maxLength: 64 }),
            url: str("Ссылка кнопки", { format: "uri" }),
            callback_data: str("Данные нажатия (1–64 байта)", { minLength: 1, maxLength: 64 }),
          },
          ["text"],
        ),
      ),
    ),
  },
  ["inline_keyboard"],
);
const MESSAGE = {
  message_id: 42,
  date: 1791537300,
  chat: { id: 100000001, type: "private", first_name: "Анна" },
  text: "Новая заявка №1024 — откройте систему, чтобы посмотреть детали",
};
const OK_TRUE = { ok: true, result: true, description: "Webhook was set" };

export const telegram: Passport = {
  id: "telegram",
  name: "Telegram Bot API",
  aliases: ["telegram", "телеграм", "телеграмм", "telegrambot", "телеграмбот", "botapi", "tgbot"],
  domains: ["telegram.org"],
  summary_ru: "Свой бот системы: сообщения и фото с кнопками, ответы на нажатия, вебхук обновлений.",
  docsUrl: DOCS,
  reviewed: "2026-10-09",
  baseUrl: "https://api.telegram.org",
  sandboxBaseUrl: null,
  auth: { kind: "path", name: "bot" },
  account: null,
  key: {
    fields: [
      {
        key: "bot_token",
        label_ru: "Токен бота",
        hint_ru: "Напишите @BotFather в Telegram: /newbot (или /token для готового бота) — он пришлёт токен",
        example: "123456789:AA••••••••",
        pattern: /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/,
        error_ru: "Токен бота выглядит как 123456789:AA… — скопируйте его из сообщения @BotFather целиком",
      },
    ],
    compose: "plain",
    where_ru:
      "@BotFather в Telegram: команда /newbot создаёт бота и присылает токен, /token — новый токен готового бота.",
  },
  operations: [
    op({
      id: "getMe",
      method: "GET",
      path: "/getMe",
      summary: "Сведения о боте (проверка токена)",
      response: answer(
        obj(
          {
            id: int(),
            is_bot: bool(),
            first_name: str(),
            username: str(),
            can_join_groups: bool(),
            can_read_all_group_messages: bool(),
            supports_inline_queries: bool(),
          },
          ["id", "is_bot", "first_name"],
        ),
      ),
      example: {
        ok: true,
        result: {
          id: 100000000,
          is_bot: true,
          first_name: "Студия Вега",
          username: "vega_studio_bot",
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        },
      },
    }),
    op({
      id: "sendMessage",
      method: "POST",
      path: "/sendMessage",
      summary: "Отправить текст (до 4096 символов) с кнопками",
      body: obj(
        {
          chat_id: chatId,
          text: str("Текст сообщения", { minLength: 1, maxLength: 4096 }),
          parse_mode: parseMode,
          link_preview_options: obj({ is_disabled: bool() }),
          disable_notification: bool("Без звука"),
          reply_markup: keyboard,
        },
        ["chat_id", "text"],
        {
          example: {
            chat_id: "100000001",
            text: "Новая заявка №1024 — откройте систему, чтобы посмотреть детали",
            reply_markup: {
              inline_keyboard: [[{ text: "Открыть", url: "https://crm.example.com/leads/1024" }]],
            },
          },
        },
      ),
      response: answer(message),
      example: { ok: true, result: MESSAGE },
    }),
    op({
      id: "sendPhoto",
      method: "POST",
      path: "/sendPhoto",
      summary: "Отправить фото по ссылке с подписью",
      body: obj(
        {
          chat_id: chatId,
          photo: str("Ссылка https на картинку или file_id", { minLength: 1 }),
          caption: str("Подпись", { maxLength: 1024 }),
          parse_mode: parseMode,
          reply_markup: keyboard,
        },
        ["chat_id", "photo"],
        {
          example: {
            chat_id: "100000001",
            photo: "https://shop.example.com/img/candle.jpg",
            caption: "Свеча ароматическая — 1 200 ₽",
          },
        },
      ),
      response: answer(message),
      example: {
        ok: true,
        result: {
          message_id: 43,
          date: MESSAGE.date,
          chat: MESSAGE.chat,
          caption: "Свеча ароматическая — 1 200 ₽",
        },
      },
    }),
    op({
      id: "answerCallbackQuery",
      method: "POST",
      path: "/answerCallbackQuery",
      summary: "Ответить на нажатие кнопки",
      body: obj(
        {
          callback_query_id: str(),
          text: str("Всплывающий текст", { maxLength: 200 }),
          show_alert: bool(),
        },
        ["callback_query_id"],
        { example: { callback_query_id: "4382bfdwdsb323b2d9", text: "Готово" } },
      ),
      response: answer(bool()),
      example: { ok: true, result: true },
    }),
    op({
      id: "setWebhook",
      method: "POST",
      path: "/setWebhook",
      summary: "Включить вебхук обновлений бота",
      body: obj(
        {
          url: str("Адрес вебхука системы (https)", { format: "uri" }),
          secret_token: str("Секрет заголовка X-Telegram-Bot-Api-Secret-Token: 1–256 символов A-Za-z0-9_-", {
            minLength: 1,
            maxLength: 256,
          }),
          allowed_updates: arr(str(), { maxItems: 20 }),
          max_connections: int(undefined, { minimum: 1, maximum: 100 }),
          drop_pending_updates: bool(),
        },
        ["url"],
        {
          example: {
            url: "https://crm.example.com/hooks/telegram",
            secret_token: "hook-secret-from-platform",
            allowed_updates: ["message", "callback_query"],
          },
        },
      ),
      response: answer(bool()),
      example: OK_TRUE,
    }),
    op({
      id: "deleteWebhook",
      method: "POST",
      path: "/deleteWebhook",
      summary: "Выключить вебхук",
      body: obj({ drop_pending_updates: bool() }, [], { example: { drop_pending_updates: false } }),
      bodyRequired: false,
      response: answer(bool()),
      example: { ok: true, result: true, description: "Webhook was deleted" },
    }),
    op({
      id: "getWebhookInfo",
      method: "GET",
      path: "/getWebhookInfo",
      summary: "Состояние вебхука и последняя ошибка доставки",
      response: answer(
        obj(
          {
            url: str(),
            has_custom_certificate: bool(),
            pending_update_count: int(),
            last_error_date: int(),
            last_error_message: str(),
            max_connections: int(),
            allowed_updates: arr(str()),
          },
          ["url", "has_custom_certificate", "pending_update_count"],
        ),
      ),
      example: {
        ok: true,
        result: {
          url: "https://crm.example.com/hooks/telegram",
          has_custom_certificate: false,
          pending_update_count: 0,
          max_connections: 40,
          allowed_updates: ["message", "callback_query"],
        },
      },
    }),
  ],
  check: "getMe",
  docs: {
    getMe: `${DOCS}#getme`,
    sendMessage: `${DOCS}#sendmessage`,
    sendPhoto: `${DOCS}#sendphoto`,
    answerCallbackQuery: `${DOCS}#answercallbackquery`,
    setWebhook: `${DOCS}#setwebhook`,
    deleteWebhook: `${DOCS}#deletewebhook`,
    getWebhookInfo: `${DOCS}#getwebhookinfo`,
  },
  hints: [
    {
      entity: "client",
      field: "telegram_chat_id",
      operation: "sendMessage",
      pointer: "/body/chat_id",
      direction: "to_api",
    },
    {
      entity: "client",
      field: "telegram_chat_id",
      operation: "sendPhoto",
      pointer: "/body/chat_id",
      direction: "to_api",
    },
    {
      entity: "product",
      field: "photo",
      operation: "sendPhoto",
      pointer: "/body/photo",
      direction: "to_api",
    },
    {
      entity: "product",
      field: "title",
      operation: "sendPhoto",
      pointer: "/body/caption",
      direction: "to_api",
    },
  ],
  limits_ru:
    "Не больше ~30 сообщений в секунду на бота, 1 в секунду в один чат, 20 в минуту в группу; на 429 — ждать parameters.retry_after секунд. Текст — до 4096 символов, подпись к фото — до 1024.",
  sandbox_ru:
    "Отдельной песочницы для обычной работы нет: для проверок заведите тестового бота у @BotFather. Тестовая среда Telegram (/bot<token>/test/…) требует тестовых аккаунтов и в паспорт не входит.",
  webhooks: {
    events: ["message", "callback_query", "my_chat_member"],
    setup_ru: "Операция setWebhook с адресом вебхука системы, secret_token от платформы и allowed_updates.",
    verify: "header_token",
    tokenField: "x-telegram-bot-api-secret-token",
    contentType: "json",
    verify_ru:
      "Каждый запрос Telegram несёт заголовок X-Telegram-Bot-Api-Secret-Token со значением secret_token из setWebhook: сравнение за постоянное время, иначе 401.",
    parse(body) {
      if (typeof body.update_id !== "number") return null;
      const event =
        ["message", "callback_query", "my_chat_member", "edited_message"].find((k) => k in body) ?? null;
      return { event, refetch: null };
    },
  },
  notes_ru: [
    "Уведомления владельцу и сотрудникам уже умеет встроенный коннектор «Telegram» — паспорт нужен, когда система ведёт своего бота.",
    "Telegram — зарубежный сервис: в сообщениях без персональных данных — только номер заявки и ссылка в систему.",
    "Токен стоит в пути запроса (/bot<токен>/метод): платформа подставляет его на выходе, в коде системы — только secret://.",
  ],
  verify_ru: ["передача chat_id строкой для числовых ID (Bot API принимает Integer or String)"],
};
