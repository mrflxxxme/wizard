# FU-6 — хвосты интеграции M1-02…M1-07: решения

- 2026-10-01 · FU-6 · Лимит prod_systems (billing.yaml#plans) при publish: под advisory lock org (d.billing.lock) считаются другие системы org, у которых prod_revision is not null ИЛИ есть прогон publish в активном статусе (queued/waiting_lock/running/needs_input) — `prodSystemsCount` в publish/blockers.ts. Без учёта прогонов «в полёте» две параллельные первые публикации проходили обе (у обеих prod_revision ещё null). Повторная публикация системы, уже стоящей в prod, лимит не проверяет. Освобождённые от учёта org (Config.billingExemptOrgs) не ограничены.
- 2026-10-01 · FU-6 · GET /systems/:id publishBlockers дополнен PLAN_LIMIT (есть в enum api.yaml и в platform-screens.yaml S5): система не в prod, org не освобождена и prodSystemsCount ≥ лимита тарифа. Текст «Лимит опубликованных систем тарифа» — в BLOCKER_RU и в ru.ts платформы (уже был).
- 2026-10-01 · FU-6 · publish и rollback идут без кредитов: insertRun вызывается без billing, hold не ставится, settleRun на финише ничего не пишет (used = 0). Основание — billing.yaml#run_charging.style_and_compliance («rollback, publish — без LLM и без кредитов»). Тест: публикация и откат prod при available = 0 проходят, строк ledger с их run_id нет.
- 2026-10-01 · FU-6 · import_table (M1-07) идёт через billing как build: insertRun(…, d.billing) ставит hold(−IMPORT_CAP_MILLI = 15 кр.) в транзакции createImport (402 INSUFFICIENT_CREDITS {available, required} синхронно, исходник удаляется), finalize → release + charge по факту (Σ llm_calls), refund — по REFUND_CODES. Примечание строки charge — «Списание за импорт таблицы по факту».
- 2026-10-01 · FU-6 · PHONE_LOGIN_PLAN_REQUIRED уже возвращался specPublishBlockers для Free; добавлены тесты (Free блокирует, start/business — нет) и DOM-тест карточки публикации: у каждого кода enum publishBlockers из api.yaml есть русская подсказка.
- 2026-10-01 · FU-6 · Поллер _w_jobs (M1-09 runner) при connectors: 'live' выполняет шаг notify через `runNotifyStep` @wizard/connectors (шаблон рендерит коннектор, ключ `<jobId>:<step>:<action>:0`, ConnectorError → WizardError с тем же кодом → повтор задания по backoff). В режиме outbox (G1, превью, по умолчанию) остаётся фасад outboxConnectors M1-09. Шаг без записи (cron) по-прежнему идёт через фасад.
- 2026-10-01 · FU-6 · Зарезервированные slug: platform-api (services/slug.ts) берёт общий `RESERVED_SYSTEM_SLUGS` через реэкспорт @wizard/runtime (architecture.yaml: platform-api не зависит от connectors напрямую); свой список удалён.
- 2026-10-01 · FU-6 · Свой бот Telegram при публикации: шаг `telegram_webhook` («Подключаю Telegram-бота системы») после gate_G0_prod и до apply_migration — `publishTelegramBots` из @wizard/runtime (новый экспорт: ConnectorHost runtime с секретами системы и настройками платформы) делает getMe и setWebhook для каждой интеграции telegram с bot=own; общий бот платформы пропускается (у него один вебхук платформы). Режим: live при WIZARD_CONNECTORS=live, иначе outbox — вызовы записываются в .data/outbox/<schemaKey>/telegram.jsonl без сети (локальный prod `<slug>.localhost` Telegram всё равно не достанет). Ошибка Bot API → run_failed GATES_FAILED с русским текстом (retryable для UPSTREAM_UNAVAILABLE/RATE_LIMITED), prod не тронут. В failure_codes workflows.yaml отдельного кода нет — выбран GATES_FAILED как «предусловие публикации не выполнено». Откат prod и deleteWebhook при удалении системы — не подключены (удаления системы в M1 нет).
- 2026-10-01 · FU-6 · @wizard/connectors добавлен в devDependencies @wizard/platform-api только для тестов (заглушка Bot API @wizard/connectors/mocks, testPlatform) — как e2e в M1-04; в граф пакетов (architecture.yaml#monorepo depends_on) не входит, код src/ его не импортирует.
- 2026-10-01 · FU-6 · .env.example: добавлен WIZARD_TELEGRAM_OAUTH_BASE с комментарием (M1-05). В deploy.yaml его пока нет — см. «Spec updates».

## Spec updates

Строки, которые нужно внести в specs/ (агентам specs/ менять нельзя):

1. `specs/connectors/telegram.yaml#secrets` — после telegram_webhook_secret:
   ```yaml
     - { name: telegram_client_secret, required: false, label: "Client secret входа через Telegram (OIDC, Basic client_id:client_secret на token endpoint; client_id — числовой префикс токена бота); при bot=own и входе через Telegram" }
   ```
   И в `#bot_api` (рядом с setWebhook):
   ```yaml
     setWebhook: "{url, secret_token, allowed_updates:['message','my_chat_member']} — при публикации ревизии (шаг telegram_webhook до apply_migration; workflows.yaml#workflows.publish) и смене токена (bot=own)"
   ```
2. `specs/platform/deploy.yaml#local.env_vars.M1` — дописать в конец списка:
   ```yaml
       M1: [WIZARD_TELEGRAM_BOT_TOKEN, WIZARD_TELEGRAM_WEBHOOK_SECRET, WIZARD_TELEGRAM_BOT_USERNAME, WIZARD_TELEGRAM_API_BASE, WIZARD_TELEGRAM_OAUTH_BASE, WIZARD_SMTP_HOST, WIZARD_SMTP_PORT, WIZARD_SMTP_USER, WIZARD_SMTP_PASSWORD, WIZARD_MAIL_DOMAIN, WIZARD_CONNECTORS]   # общий бот уведомлений платформы (connectors/telegram.yaml#bot); WIZARD_TELEGRAM_OAUTH_BASE — база OIDC Telegram (заглушки), по умолчанию https://oauth.telegram.org
   ```
3. `specs/platform/db.yaml` — новая таблица вне схемы platform (как pii_vault — в тест колонок M0-15 не входит):
   ```yaml
     wz_runtime.otp_sends:
       milestone: M1
       purpose: "Глобальные счётчики OTP по всем системам (runtime.yaml#auth, M1-05): только HMAC адреса и сети клиента; DML — роль runtime. В облаке создаёт миграция M2-06, локально — runtime при первом использовании (CREATE IF NOT EXISTS под advisory xact lock)"
       columns:
         id: "bigint generated always as identity pk"
         destination_hmac: "bytea not null"
         system_id: "text not null"                 # schema_key
         env: "text not null"
         channel: "text not null"                   # email | phone
         ip_hmac: "bytea"
         org_key: "text"                            # org_id системы (для SMS-бюджета org), иначе schema_key
         billable: "boolean not null default false" # SMS prod — тратит бюджет org
         sent_at: "timestamptz not null default now()"
       indexes: ["(destination_hmac, sent_at)", "(system_id, ip_hmac, sent_at)", "(org_key, sent_at) where billable"]
       retention: "строки старше 2 суток удаляются при вставке"
   ```
4. `specs/platform/db.yaml#deployments.definition` — дописать в конец:
   ```yaml
         org_id = systems.org_id, plan = orgs.plan ('free' | 'start' | 'business') — для SMS-бюджета org (M1-05) и лимитов коннекторов по тарифу (ctx.system.plan, M1-06); features.phoneOtp остаётся производным от plan
   ```
5. `specs/platform/workflows.yaml#workflows.publish.steps` — после gate_G2:
   ```yaml
         - { name: telegram_webhook, kind: step, does: "для интеграций telegram с bot=own: getMe (проверка токена) и setWebhook на prod-хост (connectors/telegram.yaml#bot_api); WIZARD_CONNECTORS≠live — вызовы пишутся в outbox; ошибка → run_failed GATES_FAILED, prod не тронут" }
   ```
6. `specs/platform/billing.yaml#run_charging` — дописать:
   ```yaml
     import_table: "hold(−15 кр., потолок импорта) в транзакции createImport, idempotency hold:<runId>; finish — как build: release, charge(−min(used, 15 кр.)); refund по кодам refunds. available < 15 → 402 INSUFFICIENT_CREDITS"
   ```
