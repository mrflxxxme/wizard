# Интерфейс Connector (packages/connectors)

Нормативно для всех коннекторов: `yookassa.yaml`, `telegram.yaml`, `email.yaml`, `qr.yaml`.
Коннектор исполняется **на стороне хоста** (runtime), не в песочнице функций. Сгенерированный код видит только
типизированный фасад `ctx.connectors.<integration>` (`../runtime/sdk.md` §5) и компоненты ui-kit.

## 1. Определение

```ts
import type { z } from "zod";

export interface ConnectorDefinition<Config, Actions extends Record<string, ActionDef<any, any>>> {
  id: "yookassa" | "telegram" | "email" | "qr";
  milestone: "M0" | "M1" | "M2";
  configSchema: z.ZodType<Config>;                 // проверяет integration.config при applyOps и G0
  secrets: readonly { name: string; required: boolean; label: string }[]; // ожидаемые secret://<name>
  validateSpec?(config: Config, spec: AppSpec): SpecIssue[];    // ссылки на сущности/поля/статусы; G0
  actions: Actions;                                // вызываемые из action-функций и шагов воркфлоу
  webhooks?: WebhookDef<Config>[];
  routes?: RouteDef<Config>[];                      // собственные эндпоинты runtime (/api/pay, /api/qr/*)
  testMode(env: "draft" | "prod", config: Config, secrets: SecretReader): "test" | "live";
  piiFields: readonly string[];                    // пути во входах/выходах, маскируемые в логах
}

export interface ActionDef<I, O> {
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  effect: boolean;                                 // true — внешний эффект: только action/воркфлоу, с идемпотентностью
  retry: { attempts: number; baseMs: number } | null;
  handler(ctx: ConnectorCtx, input: I): Promise<O>;
}

export interface ConnectorCtx {
  system: { id: string; env: "draft" | "prod"; host: string; spec: AppSpec };
  integration: { name: string; config: unknown };
  secrets: SecretReader;                           // get("yookassa_secret_key") → string; значение не логируется
  mode: "test" | "live";
  idempotencyKey: string;
  users: { contact(userId: string, kind: "email" | "phone" | "telegram_chat"): Promise<string | null> };
  db: SystemDb;                                    // системный доступ к схеме системы (как ctx.systemDb)
  log: ConnectorLogger;
  fetch: typeof fetch;                             // через egress-прокси в M2; allowlist из описания коннектора
}

export interface WebhookDef<Config> {
  name: string;                                    // путь /_wizard/hooks/<connector>/<integration>/<hookToken>
  verify(req: Request, ctx: ConnectorCtx): Promise<boolean>;   // false → 401, тело не разбирается
  handle(req: Request, ctx: ConnectorCtx): Promise<{ status: number }>;
}
```

## 2. Правила

- **Конфиг.** MUST: `integration.config` проходит `configSchema` при каждом `add_integration`/`update_integration`; ошибка → `SCHEMA_INVALID` с JSON Pointer. MUST: `validateSpec` проверяет, что сущности, поля и значения enum из конфига существуют. Тест: фикстура с несуществующим полем в привязке даёт ошибку G0.
- **Секреты.** MUST: в спеке и коде только `secret://<name>`; значения хранит платформа (M0 — `.env` как `WIZARD_SECRET_<SYSTEMID>_<NAME>`, M2 — KMS/OpenBao, путь `systems/<systemId>/<env>/<name>`). Значение читается в момент вызова, не кэшируется дольше 5 минут, не попадает в логи, ошибки и ответы API. Отсутствует обязательный секрет → `SECRET_MISSING`, в UI платформы — карточка «Нужны ключи» (E-ACCESS не нужен: ключи вводит пользователь). Тест: grep логов и ответов на значение тестового секрета — пусто.
- **Получатели.** MUST: код системы не передаёт телефоны, email, chat_id. Он передаёт `userId`, а адрес подставляет `ctx.users.contact` на стороне хоста.
- **Идемпотентность.** MUST: каждый вызов действия с `effect: true` имеет `idempotencyKey`: явный из кода или `<functionRunId|jobId:stepIndex>:<actionName>:<n>`. Результат хранится в `_w_connector_calls` 7 дней; повтор с тем же ключом возвращает сохранённый результат без внешнего вызова. Тест: двойной вызов с одним ключом → один запрос к моку провайдера.
- **Повторы.** Повторяются только ошибки с `retryable: true`: сеть, таймаут, 5xx, 429 (с учётом Retry-After/retry_after). Экспонента `baseMs · 4^n`, ±20% джиттер, не дольше лимита вызывающего (30 с для action; для воркфлоу — через `_w_jobs`). Тест: мок, отвечающий 503, 503, 200, даёт успех с 3 запросами.
- **Тестовый режим.** MUST: `env=draft` всегда `mode=test`. В test-режиме внешние эффекты уходят в песочницу провайдера (ЮKassa — тестовый магазин) или в dev-приёмник `.data/outbox/<system>/<connector>.jsonl` (email, Telegram без тестового бота). В prod `mode=test` допускается только для ЮKassa с явным `config.testMode: true` и баннером «Тестовые платежи» в системе.
- **Логи без ПДн.** Запись лога: `{ts, system, env, integration, connector, action, mode, status, errorCode?, durationMs, idempotencyKey}`. MUST NOT: значения входов/выходов, пути `piiFields`, тексты сообщений, адреса. Тест: e2e с ПДн-маркерами (как в `runtime.yaml#logging`).
- **Вебхуки.** MUST: `verify` до разбора тела; тело ≤ 256 КиБ; обработка идемпотентна по id события провайдера; ответ ≤ 5 с (тяжёлое — в `_w_jobs`). Вебхук меняет данные системы только через `ctx.db` с `role='__system'` и порождает события инвалидации и воркфлоу, как обычная запись.

## 3. Ошибки

`ConnectorError {code, retryable, message (ru), providerCode?}`. Коды:

| code | retryable | Когда |
|---|---|---|
| `CONFIG_INVALID` | нет | конфиг не прошёл схему или ссылки |
| `SECRET_MISSING` | нет | нет значения секрета |
| `AUTH_FAILED` | нет | провайдер отверг ключ (401/403) |
| `INVALID_REQUEST` | нет | провайдер отверг параметры (400/422) |
| `NOT_FOUND` | нет | объект у провайдера не найден |
| `RATE_LIMITED` | да | 429 или лимит коннектора |
| `UPSTREAM_UNAVAILABLE` | да | сеть, таймаут, 5xx |
| `RECIPIENT_UNAVAILABLE` | нет | у пользователя нет контакта или бот заблокирован |
| `PII_BLOCKED` | нет | текст содержит ПДн там, где они запрещены |
| `EGRESS_DISABLED` | нет | M0–M1: коннектор требует сеть, а она запрещена в этом окружении |

В функции `action` ошибка коннектора приходит как `WizardError` с тем же `code` и `details.message`.

## 4. Проверка в гейтах

- G0: `configSchema` + `validateSpec` для каждой интеграции; объявлены все `secrets` с `required: true`.
- G2: тексты шаблонов Telegram не ссылаются на поля `pii≠none` (backlog M1-06); темы писем тоже; сбор карт/паролей вне ЮKassa запрещён (антифрод).
- G1: сценарии приёмки с коннекторами идут в test-режиме против моков провайдеров из `packages/connectors/test/mocks`.
