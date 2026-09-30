# Аудит 04: техническая реализуемость (30.09.2026)

Что проверялось: предположения из разделов 3.x, 6 и решения №13 [концепции](../concept.md). Источники: клон `get-convex/chef` (последний коммит 13.03.2026), `nucex`, документация и issue-трекеры (ссылки в тексте).

| # | Предположение | Вердикт | Коротко |
|---|---|---|---|
| T1 | Chef годится как донор оболочки «чат + превью», стриминга и работы с контекстом | **Частично** | Ценны промпты и приёмы работы с контекстом. Код переносится плохо: AI SDK 4, цикл агента на стороне клиента, WebContainer, бэкенд на Convex |
| T2 | Правила Chef про Convex переносятся на наш SDK поверх Postgres | **Подтверждено** | Большая часть правил переносится напрямую, а часть наш SDK закрывает конструктивно |
| T3 | Схема на систему, RLS, realtime и миграции из diff спеки при 1k–10k систем | **Частично** | До ~2k схем на кластер работает. Дальше нужен шардинг. LISTEN/NOTIFY как основа realtime не годится |
| T4 | Изоляты workerd с лимитами и egress-allowlist достаточны для чужого кода | **Опровергнуто** в текущей формулировке | README workerd прямо требует ещё одного слоя изоляции, например ВМ |
| T5a | AI SDK + OpenAI-совместимые GLM/Kimi/DeepSeek с tool calling | **Частично** | Работает при выключенном thinking. Передача `reasoning_content` обратно в API сломана или нестабильна |
| T5b | Модели из таблицы 3.5 есть в Cloud.ru FM в контуре РФ | **Частично** | Qwen3-235B и DeepSeek V4 Flash во внутреннем контуре нет |
| T5c | pg-boss для durable многошаговых прогонов | **Частично** | Это очередь, а не движок воркфлоу. Лучше подходит DBOS Transact |
| T6 | Соло-основатель делает v0.1 за 4 месяца | **Опровергнуто** | Нужно 145–180 чел.-дней при ~65 доступных. Требуются сокращения |
| — | Управляемый Postgres в Cloud.ru: `wal_level=logical`, пулер | **Не удалось проверить** | В открытой документации ответа нет. Вопрос в поддержку в неделю 0 |

## T1. Chef как донор

**Фактический стек** (`package.json`, `vite.config.ts`):

- Remix 2.15 на Vite, деплой на Vercel (`@vercel/remix`, `waitUntil` из `@vercel/functions`).
- AI SDK `ai@^4.3.2` с провайдерами Anthropic, OpenAI, Google, Bedrock и xAI. Для сравнения: nucex уже на `ai@7.0.101`, а AI SDK 7 вышел 25.06.2026 ([vercel.com/blog/ai-sdk-7](https://vercel.com/blog/ai-sdk-7)).
- Бэкенд самого Chef работает на Convex (`convex/`): сообщения хранятся сжатыми lz4 (`convex/lz4.ts`, `compressMessages.ts`), есть сабчаты, шаринг и снапшоты. Авторизация через WorkOS и Convex OAuth, флаги через LaunchDarkly.
- `@webcontainer/api 1.5.1-internal.10`. Это коммерческий продукт StackBlitz, внутренняя сборка.

**Как устроен ход агента.** Это главная находка.

- Инструменты в `chef-agent/tools/*.ts` описаны только схемами, `execute` у них нет.
- Сервер (`app/lib/.server/llm/convex-agent.ts`) делает один `streamText`.
- Инструменты выполняет **браузер**: `useChat({ maxSteps: 64, onToolCall })` вызывает `workbenchStore.waitOnToolCall` (`app/components/chat/Chat.tsx:377`), а код исполняет `app/lib/runtime/action-runner.ts` внутри WebContainer.
- Файлы модель пишет не инструментом, а XML-тегами `<boltArtifact>/<boltAction type="file">` прямо в тексте ответа. Их разбирает `chef-agent/message-parser.ts`.
- Вывод: закрыл вкладку — сборка остановилась. Для durable-прогонов в очереди эта схема непригодна.

**Превью и деплой.**

- Превью — Vite dev server внутри WebContainer в iframe (`app/lib/stores/previews.ts`, `app/components/workbench/Preview.tsx`). Прокси `proxy/` подменяет домены, чтобы имитировать разных пользователей. `iframe-worker/` делает скриншоты через postMessage.
- Деплой — `case 'deploy'` в `action-runner.ts:429`: codegen, затем `tsc --noEmit`, затем `convex dev --once` внутри контейнера.
- Проекты заводятся через `bigBrainHost/api/create_project` (`convex/convexProjects.ts:261`), публикация идёт через `app/lib/.server/deploy-simple.ts`.

**Контекст** (`chef-agent/ChatContextManager.ts`). Суммаризации через LLM нет: `convex/summarize.ts` только генерирует заголовок чата из пяти слов. Вместо неё работают три механизма:

1. **Свёртка истории по бюджету символов.** Параметры: `maxCollapsedMessagesSize=65536`, `minCollapsedMessagesSize=8192` (`app/lib/hooks/useLaunchDarkly.ts`); для моделей без кэша — 8192 (`maxSizeForModel`). Граница свёртки сдвигается **скачком** до минимального бюджета, чтобы следующие ходы попадали в кэш промпта. Старые результаты инструментов выбрасываются, в тексте остаются однострочники вида «The assistant edited the file X successfully» (`abbreviateToolInvocation`).
2. **Релевантные файлы по LRU.** Не больше 16 файлов и 8 КБ, плюс `PREWARM_PATHS`.
3. **Кэшируемый префикс.** Промпт делится на `ROLE_SYSTEM_PROMPT` и `GENERAL_SYSTEM_PROMPT_PRELUDE` (~15k токенов гайдлайнов). Точка кэша ставится на последнем системном сообщении.

Дополнительно: при `MAX_CONSECUTIVE_DEPLOY_ERRORS=5` ошибках деплоя подряд инструменты отключаются (`toolChoice: 'none'`). Когда контекст разрастается, пользователя подталкивают начать сабчат (`SubchatLimitNudge.tsx`).

**Рендер хода.** `ToolCall.tsx` (757 строк, статусы по каждому инструменту), `AssistantMessage.tsx`, `StreamingIndicator.tsx`, `Markdown.tsx`. Расход токенов передаётся аннотациями `dataStream.writeMessageAnnotation` (`encodeUsageAnnotation`).

**Лицензия.** `LICENSE` — Apache-2.0 (Copyright 2025 Convex). В `package.json` осталось `"MIT"` от форка bolt.diy (MIT). Заимствовать можно, если сохранить NOTICE и копирайты обеих лицензий.

**Что брать:**

| Модуль | Как брать |
|---|---|
| `chef-agent/prompts/*` (структура `system.ts`, `outputInstructions.ts`, `solutionConstraints.ts`, `convexGuidelines.ts`) | как шаблон наших промптов |
| `ChatContextManager.ts`: свёртка с гистерезисом под кэш, аббревиатуры инструментов | переписать под `UIMessage.parts` из AI SDK 7 |
| `ToolCall.tsx`, `StreamingIndicator.tsx`, `Markdown.tsx`, `MessageInput.tsx`, раскладка на `allotment` | копировать с адаптацией |
| аннотации usage (`app/lib/common/usage.ts`, `annotations.ts`) | как идею, ledger у нас свой |
| rewind (`api.messages.rewindChat`) | как UX-паттерн отката к ревизии спеки |

**Что выбросить:**

- WebContainer (`app/lib/webcontainer`, `action-runner.ts`, терминал, `FileTree`, CodeMirror, `proxy/`, `iframe-worker/`, `template/`, снапшоты);
- весь `convex/` бэкенд, WorkOS, LaunchDarkly, Vercel;
- XML-протокол boltArtifact;
- клиентский цикл инструментов.

**Оценка.** Реально переносится ~10–15% кода. Оболочка на AI SDK 7 (чат, стрим событий прогона, карточки инструментов, iframe-превью, история, откат) займёт 10–12 дней с донором или 13–16 дней с нуля. Экономия около 3–4 дней, а основная ценность Chef — в промптах.

## T2. Уроки промптов Chef про Convex

Ключевые правила из `chef-agent/prompts/convexGuidelines.ts` (957 строк):

- Единый синтаксис `query({ args, handler })`. Валидаторы аргументов **всегда**, а return-валидаторы **не использовать на старте** (стр. 125), потому что они дают лишние ошибки.
- Публичные функции (`query/mutation/action`) отделены от внутренних (`internal*`). Вызовы идут только по ссылкам `api.x.y` / `internal.x.y`, передавать саму функцию нельзя.
- Query и mutation — транзакции с лимитом в 1 секунду. Action не имеет доступа к `ctx.db`, живёт до 10 минут и обращается к данным через `ctx.runQuery/runMutation`. Вызовов из action должно быть как можно меньше, иначе возникают гонки.
- `filter` запрещён, только `withIndex`. Имя индекса перечисляет его поля, порядок полей фиксирован, системные индексы не объявляются.
- Лимиты названы явно: 8 МиБ, 16 384 прочитанных документа, 8192 записи, 1 МиБ на запись.
- Пагинация через `paginationOptsValidator`. Строгие `Id<'table'>` вместо строк.
- Cron только через `interval/cron`, отложенный запуск через `scheduler.runAfter`. В хранилище лежат id, а не URL.
- Запрещённые к правке файлы (`EXCLUDED_FILE_PATHS`). Длинные эталонные примеры целых приложений. Деплой после каждого изменения как самопроверка.

Что это значит для нас. Схему, индексы и права задаёт AppSpec, а не код модели. Поэтому SDK выводит типы из спеки, `ctx.db` видит только сущности системы, а права применяются runtime'ом, не кодом. Индексы объявляются в спеке, а запрос без индекса отклоняет G0.

```ts
// @wizard/sdk — минимальный эскиз
import { v, query, mutation, action, type Id } from "@wizard/sdk";

export const listOpenLeads = query({
  args: { stage: v.enum("new", "call", "won"), page: v.pagination() },
  handler: async (ctx, { stage, page }) =>
    ctx.db.leads                       // типы генерируются из AppSpec.entities
      .withIndex("by_stage_createdAt", q => q.eq("stage", stage))
      .order("desc")
      .paginate(page),                 // права роли ctx.user применяет runtime + RLS
});

export const moveLead = mutation({
  args: { id: v.id("leads"), stage: v.enum("new", "call", "won") },
  handler: async (ctx, { id, stage }) => {
    const lead = await ctx.db.leads.get(id);
    if (!lead) throw ctx.error("NOT_FOUND", { id });
    await ctx.db.leads.patch(id, { stage });           // одна транзакция, ≤1 с
    await ctx.scheduler.runAfter(0, "notifyManager", { id });
  },
});

export const notifyManager = action({
  args: { id: v.id("leads") },
  internal: true,                                      // не публикуется в API
  handler: async (ctx, { id }) => {
    const lead = await ctx.runQuery("getLead", { id }); // action не видит ctx.db
    await ctx.connectors.telegram.send({                // секрет и allowlist у хоста
      chat: ctx.env.ref("MANAGER_CHAT"),
      text: `Лид ${lead.name} → ${lead.stage}`,
    });
  },
});
// Лимиты: query/mutation 1 с и 4k документов; action 30 с, fetch только через
// ctx.connectors/ctx.http по egress-allowlist; ни SQL, ни process, ни eval.
```

## T3. Runtime на Postgres

**Схема на систему.** Одна система — это 15–30 таблиц, их индексы, TOAST и последовательности. 10k систем дают около миллиона строк в `pg_class` и `pg_attribute`. Известные эффекты: `pg_dump` 11k схем занимает около 3 часов ([postgrespro, тред pg_dump и тысячи схем](https://postgrespro.com/list/thread-id/2064050)), а relcache каждого бэкенда растёт, когда пул обслуживает много тенантов. Практический потолок — единицы тысяч схем на кластер ([PlanetScale](https://planetscale.com/blog/approaches-to-tenancy-in-postgres)).

Выводы:

- таблица `app → shard` с первого дня, лимит ~1,5–2k схем на кластер;
- бэкап через снапшоты провайдера и PITR, а не через `pg_dump`;
- черновики бесплатного тарифа держать в отдельном кластере с TTL.

**Пулинг.**

- PgBouncer ≥1.21 в режиме transaction с `max_prepared_statements`.
- Запросы всегда с полностью квалифицированными именами `app_x.leads`, без опоры на `search_path`.
- Контекст пользователя задаётся только через `set_config('app.user_id', …, true)` внутри `BEGIN`. Сессионный `SET` в режиме transaction протекает между тенантами ([pgbouncer#246](https://github.com/pgbouncer/pgbouncer/issues/246)).

**RLS.**

- Политики должны быть простыми: `owner_id = (select current_setting('app.user_id')::uuid)`, где подзапрос в скобках вычисляется один раз, а колонки проиндексированы.
- Членство в группах хранить в денормализованной таблице, без join'ов в политиках.
- RLS служит вторым рубежом. Первый — построитель запросов runtime'а, проверяют оба в G2.

**Realtime.**

- LISTEN/NOTIFY берёт глобальную блокировку на коммите, и при нагрузке коммиты сериализуются ([Recall.ai](https://www.recall.ai/blog/postgres-listen-notify-does-not-scale)). Payload ограничен 8000 байт.
- Supabase Realtime (Postgres Changes) обрабатывает изменения в одном потоке и проверяет RLS на каждого подписчика ([docs](https://supabase.com/docs/guides/realtime/postgres-changes)).
- ElectricSQL (Apache-2) даёт shapes по одной таблице с `WHERE`. Нужны Elixir-сервис и слот репликации ([docs](https://electric-sql.com/docs/guides/shapes)).

Рекомендация для v0.1: все записи идут через runtime (CRUD, функции, воркфлоу). После коммита runtime публикует событие инвалидации «app, entity, id» в шину: in-process плюс Redis/NATS pub/sub. Клиент по SSE или WebSocket получает сигнал и заново запрашивает данные, как делает Convex. WAL-потребитель (`pg-logical-replication`, pgoutput) или Electric — только если появится запись в обход runtime.

**Миграции из diff спеки.**

- Свой дифф ревизий превращается в типизированные миграционные операции, операции — в DDL через Kysely (`withSchema`).
- Транзакционный DDL с `lock_timeout`.
- Разрушающие изменения делаются по схеме expand/contract.
- pgroll (Apache-2) решает ту же задачу, но создаёт версионные схемы с view на каждую миграцию, а это удваивает нагрузку на каталог при тысячах схем. Брать его паттерн, а не инструмент.
- Библиотеки: `kysely` + `postgres` (postgres.js), `zod`, PgBouncer.

## T4. Изоляция кастомного кода

| Вариант | Оценка |
|---|---|
| workerd (Apache-2) | Лучшие лимиты и холодный старт. Но README: «workerd on its own does not contain suitable defense-in-depth… you must run it inside an appropriate secure sandbox, such as a virtual machine» ([github.com/cloudflare/workerd](https://github.com/cloudflare/workerd)) |
| isolated-vm | в режиме maintenance, авторы предупреждают о рисках ([README](https://github.com/laverdet/isolated-vm)) |
| Deno (процесс с `--allow-net`) | права удобные, но класс риска V8 тот же. Deno Sandbox — управляемый сервис на Firecracker вне РФ |
| gVisor (runsc) | работает на обычных ВМ без KVM, накладные расходы на I/O 10–30% |
| Firecracker | самая сильная изоляция, но нужен KVM: вложенная виртуализация Cloud.ru или Bare Metal (проверить) |

Рекомендуемые слои:

1. **Статика в G0.** Импорт только `@wizard/sdk`, без `eval`, `Function` и динамического `import`. Бандлинг через esbuild.
2. **workerd.** Лимиты CPU и памяти. Сети нет, вместо неё binding'и к хосту.
3. **Процессы workerd в gVisor-подах.** Отдельный пул узлов k8s, NetworkPolicy пропускает трафик только к RPC runtime'а. Один под обслуживает небольшую группу тенантов, а платный тариф получает отдельный под.
4. **Egress-прокси с allowlist и секреты на стороне хоста.** Доступ к БД идёт через RPC с ролью конкретной системы и RLS.

Стоимость на старте: 2–3 дополнительные ВМ (оценка, цены Cloud.ru не проверялись) и 8–10 дней работы в v0.2.

## T5. Агентный движок

**AI SDK и OpenAI-совместимые модели.**

- nucex работает на `@ai-sdk/openai-compatible` 3.0.48 с `supportsStructuredOutputs: false`, `includeUsage: true` и thinking, выключенным константой (`/home/user/nucex/apps/convex/agent/provider.ts`).
- Причина ошибки 400 у DeepSeek: в режиме thinking с инструментами `reasoning_content` нужно возвращать во всех последующих запросах, иначе API отвечает 400 ([документация DeepSeek](https://api-docs.deepseek.com/guides/thinking_mode)). Адаптеры AI SDK этого не делали ([openai-agents-js#791](https://github.com/openai/openai-agents-js/issues/791), [opencode#24114](https://github.com/anomalyco/opencode/issues/24114)).
- Провайдеры `deepseek` и `moonshotai` в AI SDK 7 ещё недавно дробили reasoning-стрим ([vercel/ai#20546](https://github.com/vercel/ai/issues/20546), исправлено).
- У Kimi K2.x протокол reasoning такой же, проверять на стенде.

Политика:

- thinking выключен для ходов с инструментами;
- рассуждения делаются отдельным вызовом без инструментов;
- structured output не используется: только инструменты с zod-схемами, серверная валидация и цикл исправления, как в nucex;
- контрактные тесты на каждую пару «провайдер × модель» в eval-стенде.

**Модели Cloud.ru FM.** Во внутреннем контуре, где данные остаются в Cloud.ru, есть GLM-4.7 и GLM-5.1, Kimi-K2.6, DeepSeek-V4-Pro, Qwen3.5-397B, Qwen3-Coder-Next, MiniMax-M2.5/M3, GigaChat 3.5 и gpt-oss-120b. DeepSeek-V4-Flash, GLM-5.2 и Claude/GPT есть только как **внешние**, с передачей данных наружу ([список моделей](https://cloud.ru/docs/foundation-models/ug/topics/overview__available__models)). Для 152-ФЗ роутеру нужен allowlist только внутренних моделей.

**Durable-прогоны.**

- pg-boss — это очередь заданий. Мемоизации шагов в нём нет, чекпоинты пришлось бы писать самим. Мажорные версии ломали схему (v10, v11), и за ним числится ряд «подводных камней» в 12.x ([AgLedger](https://agledger.ai/blog/pg-boss-production-lessons/)).
- Альтернативы:
  - **DBOS Transact TS** (MIT): библиотека внутри процесса поверх того же Postgres. Durable-воркфлоу со шагами, очереди с конкурентностью, cron, сообщения ([dbos.dev](https://www.dbos.dev/dbos-transact)).
  - graphile-worker (MIT): тоже только очередь.
  - Vercel Workflow SDK + `world-postgres`: использует graphile-worker, связан с `WorkflowAgent` из AI SDK 7, но молод ([useworkflow.dev](https://useworkflow.dev/worlds/postgres)).
  - Inngest self-hosted: сервер под SSPL, поддержка Postgres экспериментальная.
  - Temporal: слишком тяжёл в эксплуатации для одного человека.
- **Рекомендация: DBOS Transact.** Каждый LLM-шаг и каждый батч операций становится шагом воркфлоу. Прогресс пишется в таблицу событий прогона, UI читает её по SSE, поэтому переподключение не теряет ход, в отличие от `useChat` у Chef.

## T6. v0.1 за 4 месяца

| Модуль | Дни |
|---|---|
| Аккаунты, организации, кредиты, ledger, оплата ЮKassa | 10–12 |
| Оболочка чата, события прогона, превью | 10–12 |
| AppSpec: zod, операции, CAS, ревизии, откат | 8–10 |
| DDL/RLS, CRUD-API, построитель запросов, права | 12–15 |
| Diff-миграции, draft/prod, публикация | 10–12 |
| 10 блоков + темы | 20–25 |
| Воркфлоу (события, расписание, вебхуки) | 8–10 |
| 5 коннекторов (amoCRM с OAuth самый тяжёлый) | 12–15 |
| Оркестратор, планировщик, строители | 15–20 |
| G0–G2 (генерация и прогон сценариев, матрица прав) | 10–12 |
| Eval-стенд, 50 брифов | 6–8 |
| Инфраструктура Cloud.ru, домены и TLS, бэкапы, наблюдаемость, 152-ФЗ | 10–12 |
| Realtime-инвалидация | 3–4 |
| **Итого** | **145–180** |

Доступно ~85 рабочих дней, из них ~20% уйдёт на дизайн-партнёров. Остаётся около 65 дней, то есть объём превышен в 2,2–2,8 раза.

Главные поглотители времени:

- качество блоков calendar и booking;
- миграции живых данных;
- настройка агентов на открытых моделях;
- OAuth amoCRM;
- тесты безопасности мультитенантности;
- свои домены клиентов.

Сокращения до ~70 дней:

- 6 блоков: table, form, card, kanban, calendar с записью, простой dashboard;
- 3 коннектора: Telegram, email, ЮKassa;
- поддомены вместо своих доменов;
- в prod только аддитивные миграции, разрушающие закрыты;
- один строитель с профилями инструментов вместо четырёх, планировщик внутри оркестратора;
- G1 как проверки по seed-данным без генерации тестов агентом;
- оплата по счёту на время беты.

## Что меняется в концепции

1. **§3.4, решение №13.** Chef — донор промптов и приёмов работы с контекстом, а не оболочки. UI пишется заново на AI SDK 7. Цикл агента серверный и durable, UI подписан на события прогона.
2. **§3.4.** Вместо pg-boss взять DBOS Transact, если pg-boss не выиграет на прототипе недели 0.
3. **§3.2.** Изоляция делается в два слоя: workerd внутри gVisor в отдельном пуле узлов. Без второго слоя кастомный код не запускается.
4. **§3.2.** Шардинг схем по кластерам (~2k на кластер), черновики в отдельном кластере с TTL, бэкапы через PITR. Имена в SQL всегда квалифицированы, контекст задаётся только через `SET LOCAL`.
5. **§3.2.** Realtime строится как инвалидация из runtime через pub/sub. LISTEN/NOTIFY и WAL в v0.1 не нужны.
6. **§3.5.** Убрать Qwen3-235B и DeepSeek V4 Flash, в контуре РФ только внутренние модели Cloud.ru: резерв Qwen3.5-397B, строители GLM-5.1 / DeepSeek-V4-Pro / MiniMax-M3. Thinking выключен в ходах с инструментами. Роутер пропускает только allowlist внутренних моделей.
7. **§6.** Объём v0.1 сократить, как в T6, или сдвинуть бету на 6-й месяц.
8. **§8, неделя 0.** Добавить вопросы в Cloud.ru: `wal_level`, пулер, лимиты числа схем и объектов, вложенная виртуализация или gVisor в Managed Kubernetes.
