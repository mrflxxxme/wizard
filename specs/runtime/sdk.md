# @wizard/sdk — контракт для сгенерированного кода

Нормативно для `packages/sdk` (M0-07), `apps/runtime` (M0-09), гейта G0 (M0-10) и промптов строителя.
Связанные спеки: `runtime.yaml` (исполнение), `../appspec/appspec.schema.json` (источник типов), `../connectors/`.
Эталонный код: `examples/`. API похож на Convex по стилю, код Convex не копируется (AGENTS.md).

## 1. Раскладка исходников системы

```
functions/<name>.ts        одна функция на файл, `export default query|mutation|action({...})`
ui/**/<Page>.tsx           страница по `page.file` (строитель кладёт в ui/pages/, builder.yaml): `export default function <Page>()`; ui/components/*.tsx — общие части
_generated/wizard.d.ts     результат generateTypes(spec); только чтение для агента
assets/logo.(png|webp)     логотип из панели «Стиль» (пишет только платформа, ../platform/api.yaml#uploadAsset)
```

- MUST: имя функции = `function.name` из AppSpec, файл = `function.file`. Прочие файлы `functions/**` (например, `functions/lib/*.ts`) — вспомогательные модули без default-экспорта функции. Видимость (`public`) и роли (`roles`) задаёт только спека, в коде их нет.
- MUST: `functions/**` импортирует только `@wizard/sdk` и относительные файлы внутри `functions/`. `ui/**` импортирует только `@wizard/sdk`, `@wizard/ui-kit` и относительные файлы внутри `ui/`. React напрямую не импортируется: хуки React реэкспортирует `@wizard/sdk`, JSX компилируется с `jsxImportSource: "@wizard/sdk"` (§1.1).
- MUST NOT (G0, статический анализ AST; полный список с областями — `../quality/gates.yaml#G0.forbidden_api`, он источник истины): `eval`, `new Function`, динамический `import()`, `require`, `process`, `globalThis`/`window` в `functions/**`, `fetch`/`XMLHttpRequest`/`WebSocket` в любом файле, `fs`, `child_process`, строки SQL как аргументы SDK, `dangerouslySetInnerHTML`, `localStorage` с полями `pii≠none`, `console.*` в `functions/**`; в `ui/**` — `parent`, `top`, `opener`, `postMessage`, `window.name` (мост превью не должен подделываться, L3-16).
- MUST: в `functions/**` нет клиентских хуков (`use*`), в `ui/**` нет определений `query/mutation/action`.
- Тест: фикстуры G0 — по одной положительной и отрицательной на каждое правило этого раздела.

### 1.1 Сборка и типизация кода системы (L2-06)

```
tsconfig.system (packages/build/tsconfig.system.json — architecture.yaml#interfaces.build_system; его же использует G0-TS-01):
{ strict: true, module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", jsxImportSource: "@wizard/sdk",
  noEmit: true, types: [], paths: {"@wizard/sdk": [sdk.d.ts], "@wizard/ui-kit": [ui-kit.d.ts]} }
```

- `@wizard/sdk` экспортирует `./jsx-runtime` (реэкспорт `react/jsx-runtime`); G0-IMP-01 считает его частью `@wizard/sdk`. Относительные импорты без расширения (`./lib/occupancy`) допустимы.
- `packages/sdk` поставляет рукописный `src/sdk.d.ts` = §5; G0 компилирует код системы против него, а не против исходников SDK.
- MUST (L3-13): сборка идёт в каталоге-копии ревизии; резолвер отклоняет пути вне `ui/**`, `functions/**` и любые пакеты, кроме `@wizard/sdk` и `@wizard/ui-kit`; loaders — только ts/tsx; `define`/`process.env` не пробрасываются. `.env` и файлы хоста в бандл не попадают никогда (`../platform/deploy.yaml#local.bundles_never_contain_env`).

### 1.2 Шпаргалка строителя (целиком в системном промпте строителя; источник истины — §5 и `packages/sdk/src/sdk.d.ts`)

Это не Convex: `ctx.db.query("t")`, `ctx.db.insert("t", …)`, `withIndex`, `collect()`, `ctx.auth`, `defineQuery`, `v.union`, `v.any`, `v.null`, `.optional()` цепочкой — не существуют (G0-TS-01: TS2305/TS2339/TS2551). Значения в `functions/**` импортируются только так: `import { query, mutation, action, v } from "@wizard/sdk"` (нужные из них); типы `QueryCtx`, `MutationCtx`, `ActionCtx`, `Doc`, `ClientDoc`, `Id` — только `import type { … } from "@wizard/sdk"`. Других серверных имён в модуле нет (§5).

Функция — `functions/<имя>.ts`, ровно один `export default` (G0-FN-01); параметры `handler` не аннотировать: типы `ctx` и `args` выводятся из `args`. Если handler вызывает `ctx.runQuery`/`ctx.runMutation`, укажи тип результата handler явно (`async (ctx, args): Promise<{ … }> =>`), иначе TS7022 (тип функции ссылается сам на себя).

```ts
// functions/leadList.ts — query: только чтение
import { query, v } from "@wizard/sdk";

export default query({
  args: { status: v.optional(v.enum("new", "done")), limit: v.optional(v.int({ min: 1, max: 100 })) },
  handler: async (ctx, args) => {
    if (args.status) return ctx.db.lead.list({ where: { status: args.status }, order: "desc", limit: 100 });
    return ctx.db.lead.list({ order: "desc", limit: args.limit ?? 50 });
  },
});
```

```ts
// functions/leadCreate.ts — mutation: чтение и запись в одной транзакции
import { mutation, v } from "@wizard/sdk";

export default mutation({
  args: { name: v.string({ min: 2, max: 200 }), phone: v.phone(), comment: v.optional(v.string({ max: 2000 })), serviceId: v.id("service") },
  handler: async (ctx, args) => {
    const service = await ctx.db.service.get(args.serviceId);
    if (!service) throw ctx.error("NOT_FOUND", { message: "Услуга не найдена" });
    const id = await ctx.db.lead.insert({ name: args.name.trim(), phone: args.phone, comment: args.comment ?? null, service: service.id, status: "new" });
    await ctx.scheduler.runAfter(0, "leadNotify", { leadId: id });
    return { id };
  },
});
```

```ts
// functions/leadNotify.ts — action: внешний мир, без ctx.db
import { action, v } from "@wizard/sdk";

export default action({
  args: { leadId: v.id("lead") },
  handler: async (ctx, { leadId }): Promise<{ found: boolean }> => {
    const fresh = await ctx.runQuery("leadList", { status: "new" });
    ctx.log.info("lead_notify", { pending: fresh.length });
    // ctx.connectors.<integration.name>: email.sendTemplate / telegram.sendToUser — получатель по userId
    return { found: fresh.some((l) => l.id === leadId) };
  },
});
```

- `v.*` (полный список): `string({min?, max?, pattern?})`, `int({min?, max?})`, `number({min?, max?})`, `money({min?, max?})`, `boolean()`, `date()`, `datetime()`, `email()`, `phone()`, `id("<entity>" | "users")`, `literal(x)`, `enum("a", "b", …)` (значения — отдельными аргументами, не массивом), `array(v.X, {max?})`, `object({…})`, `optional(v.X)`, `nullable(v.X)`, `pagination()`. Необязательный аргумент — `v.optional(v.string())`.
- `ctx` у всех: `user {id, role, attrs, isAdmin}` (`id = null` у публичной роли), `now: Date`, `error(CODE, {message})` → `throw ctx.error(…)`, `log.info|warn|error(msg, {числа/булевы})`.
- query: `ctx.db`, `ctx.systemDb` — чтение. mutation: то же + запись и `ctx.scheduler.runAfter(ms, "fn", args)` / `runAt(date, "fn", args)`. action: `ctx.runQuery("fn", args)`, `ctx.runMutation("fn", args)`, `ctx.connectors.<integration>`, `ctx.http.fetch` (только `function.egress`), `ctx.scheduler`; `ctx.db` в action нет.
- `ctx.db.<entity>` (имя сущности из спеки — свойство, не строка): `get(id)`, `getBy("<unique-поле>", value)`, `list({where?, order?: "asc"|"desc", limit?})`, `first({where?, order?})`, `count({where?})`, `paginate({where?, order?}, {cursor, numItems})` → `{items, continueCursor, isDone}`; в mutation ещё `insert(doc) → id`, `patch(id, partial)`, `delete(id)`. Других методов нет. `where` — префикс индекса сущности (§2.4), иначе TS2322.
- Страница `ui/…/<Page>.tsx` — `export default function <Page>()`; данные — `useQuery("fn", args)` → `{data, error, isLoading, refetch}`, `useMutation("fn")` → `[run, {pending, error}]`, `useEntityList("entity", {filter, sort, limit})`, `useEntity("entity", id)`, `useEntityMutation("entity")` → `{create, update, remove}`, `useUser()`, `useParams()`, `useNavigate()`; хуки React (`useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`) — тоже из `@wizard/sdk`, `react` не импортировать. Компоненты — из `@wizard/ui-kit`. Функции из `functions/**` в ui/** не импортировать — только по имени.

## 2. Серверная часть

### 2.1 Виды функций

| Вид | Доступ к данным | Транзакция | Лимиты | Внешний мир |
|---|---|---|---|---|
| `query` | `ctx.db` (чтение), `ctx.systemDb` (чтение) | одна, `REPEATABLE READ READ ONLY` | ≤ 1 с, ≤ 4000 прочитанных документов | нет |
| `mutation` | `ctx.db`, `ctx.systemDb` (чтение+запись), `ctx.scheduler` | одна, `SERIALIZABLE` | ≤ 1 с, ≤ 4000 прочитанных, ≤ 500 записанных документов | нет |
| `action` | только `ctx.runQuery/ctx.runMutation` | нет (каждый вызов — своя транзакция) | ≤ 30 с, ≤ 20 вызовов runQuery/runMutation | `ctx.connectors`, `ctx.http` (M2) |

Общие лимиты: аргументы ≤ 1 МиБ, результат ≤ 4 МиБ (JSON), документ ≤ 1 МиБ, `list.limit` ≤ 1000 с `where` и ≤ 100 без него (G0-IDX-01), `paginate.numItems` ≤ 200.
В режиме unsafe-local (M0–M1, `WIZARD_UNSAFE_LOCAL_EXEC=1`) жёсткий потолок любого вызова — 5 с (backlog M0-09).
Превышение → ошибка `LIMIT_EXCEEDED` (время → `TIMEOUT`), транзакция откатывается.
Тест: функции-фикстуры с бесконечным циклом, чтением 4001 документа и 501 записью дают ожидаемые коды.

### 2.2 Семантика транзакций

- MUST: mutation исполняется в одной транзакции `SERIALIZABLE`. При ошибке сериализации (SQLSTATE 40001/40P01) runtime повторяет handler целиком до 3 раз с джиттером 10–50 мс, затем `CONFLICT`. Поэтому handler MUST быть детерминированным относительно `ctx.db` и не иметь внешних эффектов.
- MUST: `ctx.scheduler.*` в mutation пишет задание в ту же транзакцию (outbox): откат — задания нет.
- MUST: события инвалидации (`runtime.yaml#realtime`) публикуются только после коммита.
- `ctx.now` — время начала транзакции, одинаковое внутри вызова.
- Тест: 20 параллельных `registerTicket` при `capacity=5` создают ровно 5 билетов (examples/functions/registerTicket.ts).

### 2.3 Права внутри функций

- `ctx.db` работает **от имени вызывающего**: применяются `ops`, `rowFilter`, `hiddenFields`, `readonlyFields` его роли и RLS — ровно как в data API. Скрытые поля отсутствуют в документах, строки вне `rowFilter` невидимы (`get` → `null`).
- `ctx.systemDb` — доступ от имени системы (роль БД `sys_<key>_<env>_system`, M2-01; логическое имя роли — `__system`), без матрицы прав. SHOULD применяться только для агрегатов и проверок инвариантов (лимиты, счётчики). MUST NOT возвращать клиенту поля с `pii≠none`, прочитанные через `ctx.systemDb`, если роль вызывающего их не видит. G2 перечисляет в отчёте все вызовы `ctx.systemDb`; G1 проверяет это сценариями приёмки.
- MUST (runtime, M2; L3-22): документы из `ctx.systemDb` помечаются, и при сериализации результата `/api/fn` поля `pii≠none`, невидимые роли вызывающего, вырезаются. `ctx.systemDb` в функции, доступной public-роли, — блокер G2 без `function.systemDbReason`. Тест: публичная query возвращает `ctx.systemDb.<сущность с ПДн>.list()` → в ответе нет phone/email.
- Функции, запущенные планировщиком или воркфлоу, исполняются с `ctx.user = { id: null, role: "__system", attrs: {}, isAdmin: false }`, и `ctx.db` для них эквивалентен `ctx.systemDb`.
- Тест: query, читающая `ticket` через `ctx.db` от роли `participant`, не видит чужих билетов; та же через `ctx.systemDb` видит.

### 2.4 Доступ к данным: `ctx.db.<entity>`

- `get(id)`, `getBy(uniqueField, value)` — точечное чтение.
- `list({ where, order, limit })`, `first(...)`, `count({ where })`, `paginate({ where, order }, { cursor, numItems })`. `limit` по умолчанию 100; максимум — §2.1 (L1-35).
- `where` — аналог `withIndex` (G0-IDX-01 проверяет его через tsc): ключи MUST образовывать префикс объявленного индекса сущности (порядок полей индекса). Последний ключ префикса может быть диапазоном `{gt|gte|lt|lte}`. Фильтров по неиндексированным полям в SDK нет — это правило G0 проверяет через типы (`IndexWhere<E>`) и tsc.
- Неявные индексы (создаёт `toDDL`, объявлять не нужно): `id`, `created_at`, каждое `unique`-поле, каждое `ref`-поле, `ownerField`.
- Порядок: по полям индекса, затем `created_at`, затем `id`; `order: "asc" | "desc"` (по умолчанию `asc`). Без `where` — по `created_at`.
- `insert(doc) → Id`, `patch(id, partial)`, `delete(id)`. Системные поля (`id, created_at, updated_at, created_by`) не пишутся. `created_by = ctx.user.id`.
- `ref` на пользователей — `Id<"users">`; `users` — системная сущность runtime (`runtime.yaml#postgres.system_tables`), в `ctx.db` её нет: контакты пользователей видит только хост (коннекторы по `userId`). Ссылаться на неё можно полем `ref` с `entity: "users"`.
- Тест: `ctx.db.ticket.list({ where: { status: "paid" } })` без индекса по `status` не проходит tsc; с индексом `[stream, status]` проходит только `{ stream, status? }`.

### 2.5 Контекст и служебные API

- `ctx.user: { id, role, attrs, isAdmin }`; для публичной роли `id = null`. `attrs` — поля системной сущности `users`, кроме контактов (`phone`, `email`, `telegram_*` видит только хост): сейчас `display_name`.
- `ctx.error(code, details?)` возвращает `WizardError`, использовать как `throw ctx.error(...)`. `code` — `^[A-Z][A-Z0-9_]{2,40}$`; `details.message` — текст для пользователя на русском, SHOULD присутствовать. Клиент получает `{ error: { code, message, details } }` с HTTP 400.
- `ctx.scheduler.runAfter(delayMs, name, args)`, `runAt(isoOrDate, name, args)`, `cancel(jobId)`. Доставка at-least-once; вызываемая функция SHOULD быть идемпотентной.
- `ctx.runQuery(name, args)`, `ctx.runMutation(name, args)` — только в action; исполняются с тем же `ctx.user`.
- `ctx.connectors.<integration>` — только в action; имя = `integration.name` из AppSpec, тип — по `integration.connector` (`../connectors/connector-interface.md`). Получатели задаются `userId`, а не телефоном/email/chat_id: адрес подставляет хост.
- `ctx.http.fetch(url, init)` — M2, только action, только хосты из `function.egress`; в M0–M1 бросает `EGRESS_DISABLED`.
- `ctx.log.info|warn|error(message, fields?)` — `fields` только числа, булевы и `Id`; строки маскируются. `console.*` в функциях запрещён (G0).

## 3. Клиентская часть (страницы React)

- MUST (L1-28): все запросы SDK и ui-kit к `/api/*` (включая `/api/auth/*`) и `/_wizard/qr/*` несут заголовок `X-Wizard-Request: 1` и `credentials: "same-origin"` (`runtime.yaml#auth.csrf`).
- `useQuery(name, args | "skip")` → `{ data, error, isLoading, refetch }`. Вызов `POST /api/fn/:name`; ответ содержит `deps` (сущности, прочитанные функцией). Хук перезапрашивает данные при событии инвалидации по любой сущности из `deps` (дебаунс 100 мс).
- `useMutation(name)` → `[run, { pending, error }]`; `run` для mutation и action. `run` отклоняется с `WizardError`.
- `useEntityList(entity, { filter, sort, page, limit })` → `GET /api/data/:entity` (`runtime.yaml#data_api`); `filter` — по видимым полям, `sort` — `"field"` или `"-field"`, `limit ≤ 100`. Перезапрос при инвалидации `entity`.
- `useEntity(entity, id)`, `useEntityMutation(entity)` → `{ create, update, remove }`.
- Согласие на ПДн (M0, L1-03): `run(args, { consent: true })` и `create(doc, { consent: true })` — SDK добавляет в тело запроса `_consent: { policyVersion, textHash }`, беря оба значения из RoleSpec (`compliance.policyVersion`, `compliance.consentTextHash`, `runtime.yaml#service_endpoints.role_spec`); время и `ip_hmac` ставит сервер. Без него create/update сущности с ПДн или вызов функции с `collectsPii` ролью без `isAdmin` → 422 `CONSENT_REQUIRED`. Передавать `consent: true` можно только после явной отметки пользователем компонента `ConsentCheckbox` (`../ui/ui-kit.yaml`).
- `useUser()` → `{ user, isLoading, login, logout }`; `user = { id, role, displayName, isAdmin } | null`; `login({ role, next })` ведёт на `/login` (`runtime.yaml#auth.login_page`).
- `usePayment(integration)` → `{ pay(bindingId, id, token?), pending, error }`: `POST /api/pay/:integration`, затем переход на страницу оплаты ЮKassa (`../connectors/yookassa.yaml`); `token` — секрет покупателя для записи гостя (`yookassa.yaml#config_schema.accessField`, V3-23).
- `useParams()`, `useNavigate()` — маршруты из `pages[].route`.
- Картинки (M2-47): значение поля `image` — `fileId` (строка), как у `file`. Показывать — только компонентом `Image` из `@wizard/ui-kit` (`<Image fileId={row.photo} alt="…" />`: srcset вариантов `GET /api/files/:fileId/img/480|960|1600`, lazy, alt обязателен); загружать — `ImageField` или `RecordForm` (`POST /api/files`, роль с create/update на сущность; публичная роль картинки не загружает). Свой `<img src>` на `/api/files/…` не собирать. Блоки лендинга (`Hero`, `Features` и др.) принимают `image: { fileId, alt }`.
- M3: `useAiAction(action)` → `{ run(entity, id), pending, error }` — `POST /api/ai/:action {entity, id}` (`runtime.yaml#ai_actions`); `run` возвращает `{ item, filled, skipped }`, где `item` — запись с мета `_aiFilled: string[]` (поля, последним записанным в которые был ИИ). Ошибки: 403 `FORBIDDEN` (нет `update` на сущность), 404, 429 `AI_LIMIT_REACHED` / `RATE_LIMITED` (public-роль, ≤ 10/ч на сеть клиента), 402 `AI_CREDITS_EXHAUSTED`, 503 `AI_UNAVAILABLE`. Вывод generate — только текст: показывать текстовым узлом, не как HTML.
- Реалтайм: одно SSE-соединение `GET /api/events` на вкладку, открывает его SDK (fetch streaming с `X-Wizard-Request: 1`, не EventSource). После переподключения SDK перезапрашивает все активные запросы.
- Тест (M0-07): хуки против локального hono-мока: загрузка, ошибка с `code`, перезапрос по SSE `invalidate`.

## 4. Генерация типов

`generateTypes(spec: AppSpec) → string` (экспорт `@wizard/sdk/codegen`, исполняется на платформе, не в системе). Реализация живёт в `packages/appspec` (`src/types-gen.ts`), `@wizard/sdk/codegen` её реэкспортирует; снапшот-тест — за M0-07 (L2-17).

- MUST: результат — содержимое `_generated/wizard.d.ts`, которое дополняет (module augmentation) интерфейсы `Entities`, `Roles`, `Functions`, `Connectors`, `Payments` модуля `@wizard/sdk`.
- Отображение типов полей: `string|text|email|phone|url|file|image|qr_token → string`, `int|decimal → number` (точность `numeric(18,6)` проверяет runtime), `money → number` (рубли, ≤ 2 знаков после запятой), `bool → boolean`, `date → string` (`YYYY-MM-DD`), `datetime → string` (ISO 8601 UTC), `enum → union значений`, `ref → Id<"entity">`, `json → Json`.
- `doc`: необязательное поле → `T | null`. `insert`: необязательные поля и поля с `default` — опциональны. `clientDoc`: поля, скрытые хотя бы для одной роли, — опциональны. `where`: объединение объектов-префиксов каждого индекса, включая неявные (`{}` в объединение MUST NOT входить: иначе tsc пропустит любой `where`). `unique`: объединение имён unique-полей.
- `functions`: `{ <name>: typeof import("../functions/<file без .ts>").default }`.
- Тест: снапшот для `../appspec/examples/forum.json`; `tsc --noEmit` на `examples/` против сгенерированного файла проходит (backlog M0-07).

Фрагмент результата для форума (нормативна форма, не порядок):

```ts
import type { EmailConnector, Id, QrConnector, Range, TelegramConnector, YookassaConnector } from "@wizard/sdk";
declare module "@wizard/sdk" {
  interface Roles { organizer: true; moderator: true; speaker: true; partner: true; participant: true; volunteer: true; visitor: true }
  interface Entities {
    stream: {
      doc: { name: string; capacity: number; description: string | null };
      insert: { name: string; capacity: number; description?: string | null };
      clientDoc: { name: string; capacity: number; description: string | null };
      where: { created_at: string | Range<string> };
      unique: never;
    };
    // ...
  }
  interface Functions { partnerQuota: typeof import("../functions/partnerQuota").default /* ... */ }
  interface Connectors { yookassa: YookassaConnector; telegram: TelegramConnector; email: EmailConnector; qr: QrConnector }
  interface Payments { yookassa: "ticket" }
}
```

## 5. Декларация модуля (MUST: реализация удовлетворяет ей; расширять можно, сужать нельзя)

```ts
declare module "@wizard/sdk" {
  // ---------- реестр: generateTypes дополняет эти интерфейсы (module augmentation) ----------
  // Раздельные интерфейсы, а не один Register: иначе типы функций и ctx ссылаются друг на друга по кругу.
  export interface Entities {}     // <entity>: { doc; insert; clientDoc; where; unique }
  export interface Roles {}        // <role>: true
  export interface Functions {}    // <name>: typeof import("../functions/<file>").default
  export interface Connectors {}   // <integration.name>: TelegramConnector | EmailConnector | ...
  export interface Payments {}     // <integration.name>: union id привязок (bindings[].id)

  export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
  const idBrand: unique symbol;
  export type Id<E extends string> = string & { readonly [idBrand]: E };
  export type EntityName = keyof Entities & string;
  export type RoleName = keyof Roles & string;
  type Ent<E extends EntityName> = Entities[E] extends EntityShape ? Entities[E] : never;
  interface EntityShape { doc: object; insert: object; clientDoc: object; where: object; unique: string }
  export type SystemFields<E extends string> = {
    id: Id<E>; created_at: string; updated_at: string | null; created_by: Id<"users"> | null;
  };
  export type Doc<E extends EntityName> = SystemFields<E> & Ent<E>["doc"];
  export type ClientDoc<E extends EntityName> = SystemFields<E> & Ent<E>["clientDoc"];
  export type Insert<E extends EntityName> = Ent<E>["insert"];
  export type Patch<E extends EntityName> = Partial<Ent<E>["insert"]>;
  export type Range<T> = { gt?: T; gte?: T; lt?: T; lte?: T };
  export type IndexWhere<E extends EntityName> = Ent<E>["where"];

  // ---------- валидаторы ----------
  export interface Validator<T> { readonly kind: string; readonly isOptional: boolean; readonly __t?: T }
  export type Infer<V> = V extends Validator<infer T> ? T : never;
  export type ArgsShape = Record<string, Validator<unknown>>;
  type OptKeys<S extends ArgsShape> = { [K in keyof S]: undefined extends Infer<S[K]> ? K : never }[keyof S];
  export type InferArgs<S extends ArgsShape> =
    { [K in Exclude<keyof S, OptKeys<S>>]: Infer<S[K]> } & { [K in OptKeys<S>]?: Infer<S[K]> };
  export interface PaginationOpts { cursor: string | null; numItems: number }
  export const v: {
    string(o?: { min?: number; max?: number; pattern?: RegExp }): Validator<string>;
    int(o?: { min?: number; max?: number }): Validator<number>;
    number(o?: { min?: number; max?: number }): Validator<number>;
    money(o?: { min?: number; max?: number }): Validator<number>;
    boolean(): Validator<boolean>;
    date(): Validator<string>;
    datetime(): Validator<string>;
    email(): Validator<string>;
    phone(): Validator<string>;
    id<E extends EntityName | "users">(entity: E): Validator<Id<E>>;
    literal<const T extends string | number | boolean>(value: T): Validator<T>;
    enum<const T extends readonly [string, ...string[]]>(...values: T): Validator<T[number]>;
    array<T>(item: Validator<T>, o?: { max?: number }): Validator<T[]>;
    object<S extends ArgsShape>(shape: S): Validator<InferArgs<S>>;
    optional<T>(inner: Validator<T>): Validator<T | undefined>;
    nullable<T>(inner: Validator<T>): Validator<T | null>;
    pagination(): Validator<PaginationOpts>;
  };

  // ---------- данные ----------
  export interface ListOptions<E extends EntityName> { where?: IndexWhere<E>; order?: "asc" | "desc"; limit?: number }
  export interface Page<T> { items: T[]; continueCursor: string | null; isDone: boolean }
  export interface TableReader<E extends EntityName> {
    get(id: Id<E>): Promise<Doc<E> | null>;
    getBy<K extends Ent<E>["unique"] & keyof Doc<E>>(field: K, value: Doc<E>[K]): Promise<Doc<E> | null>;
    list(opts?: ListOptions<E>): Promise<Doc<E>[]>;
    first(opts?: Omit<ListOptions<E>, "limit">): Promise<Doc<E> | null>;
    count(opts?: { where?: IndexWhere<E> }): Promise<number>;
    paginate(opts: Omit<ListOptions<E>, "limit">, page: PaginationOpts): Promise<Page<Doc<E>>>;
  }
  export interface TableWriter<E extends EntityName> extends TableReader<E> {
    insert(doc: Insert<E>): Promise<Id<E>>;
    patch(id: Id<E>, patch: Patch<E>): Promise<void>;
    delete(id: Id<E>): Promise<void>;
  }
  export type DbReader = { readonly [E in EntityName]: TableReader<E> };
  export type DbWriter = { readonly [E in EntityName]: TableWriter<E> };

  // ---------- контекст ----------
  export interface CurrentUser {
    id: Id<"users"> | null; role: RoleName | "__system";
    attrs: Readonly<Record<string, string | number | boolean>>; isAdmin: boolean;
  }
  export interface ErrorDetails { message?: string; [k: string]: Json | undefined }
  export class WizardError extends Error {
    readonly code: string; readonly details: ErrorDetails; readonly status?: number;   // HTTP-статус ответа runtime (клиент)
    constructor(code: string, details?: ErrorDetails);
  }
  export interface Logger {
    info(msg: string, f?: Record<string, number | boolean | null>): void;
    warn(msg: string, f?: Record<string, number | boolean | null>): void;
    error(msg: string, f?: Record<string, number | boolean | null>): void;
  }
  export type JobId = string & { readonly __job: true };
  export interface Scheduler {
    runAfter<N extends FunctionName>(delayMs: number, name: N, args: FnArgs<N>): Promise<JobId>;
    runAt<N extends FunctionName>(at: Date | string, name: N, args: FnArgs<N>): Promise<JobId>;
    cancel(id: JobId): Promise<void>;
  }
  interface BaseCtx { user: CurrentUser; now: Date; error(code: string, details?: ErrorDetails): WizardError; log: Logger }
  export interface QueryCtx extends BaseCtx { db: DbReader; systemDb: DbReader }
  export interface MutationCtx extends BaseCtx { db: DbWriter; systemDb: DbWriter; scheduler: Scheduler }
  export interface ActionCtx extends BaseCtx {
    scheduler: Scheduler;
    connectors: Connectors;
    http: { fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text(): Promise<string>; json(): Promise<Json> }> };
    runQuery<N extends QueryName>(name: N, args: FnArgs<N>): Promise<FnResult<N>>;
    runMutation<N extends MutationName>(name: N, args: FnArgs<N>): Promise<FnResult<N>>;
  }

  // ---------- определения функций ----------
  export type FnKind = "query" | "mutation" | "action";
  export interface FunctionDef<K extends FnKind, A, R> { readonly kind: K; readonly args: ArgsShape; readonly __a?: A; readonly __r?: R }
  type Def<S extends ArgsShape, C, R> = { args: S; handler: (ctx: C, args: InferArgs<S>) => R | Promise<R> };
  export function query<S extends ArgsShape, R>(d: Def<S, QueryCtx, R>): FunctionDef<"query", InferArgs<S>, R>;
  export function mutation<S extends ArgsShape, R>(d: Def<S, MutationCtx, R>): FunctionDef<"mutation", InferArgs<S>, R>;
  export function action<S extends ArgsShape, R>(d: Def<S, ActionCtx, R>): FunctionDef<"action", InferArgs<S>, R>;

  export type FunctionName = keyof Functions & string;
  type NamesOf<K extends FnKind> = { [N in FunctionName]: Functions[N] extends FunctionDef<K, any, any> ? N : never }[FunctionName];
  export type QueryName = NamesOf<"query">;
  export type MutationName = NamesOf<"mutation">;
  export type ActionName = NamesOf<"action">;
  export type FnArgs<N extends FunctionName> = Functions[N] extends FunctionDef<FnKind, infer A, any> ? A : never;
  export type FnResult<N extends FunctionName> = Functions[N] extends FunctionDef<FnKind, any, infer R> ? R : never;

  // ---------- коннекторы (адреса получателей подставляет хост) ----------
  export interface TelegramConnector {
    sendToUser(i: { userId: Id<"users">; text: string; buttons?: { text: string; url: string }[]; idempotencyKey?: string }):
      Promise<{ delivered: boolean; reason?: "not_linked" | "blocked" | "test_mode" }>;
  }
  export interface EmailConnector {
    sendTemplate(i: { userId: Id<"users">; template: string; params: Record<string, string | number>; attachQrOf?: { entity: EntityName; id: string }; idempotencyKey?: string }):
      Promise<{ messageId: string }>;
  }
  export interface YookassaConnector {
    refund(i: { binding: string; id: string; amount?: number; reason?: string; idempotencyKey?: string }): Promise<{ refundId: string; status: "pending" | "succeeded" | "canceled" }>;
    getPaymentStatus(i: { binding: string; id: string }): Promise<"none" | "pending" | "waiting_for_capture" | "succeeded" | "canceled">;
  }
  export interface QrConnector {
    revoke(i: { entity: EntityName; id: string }): Promise<void>;
  }

  // ---------- клиент ----------
  export interface QueryState<T> { data: T | undefined; error: WizardError | undefined; isLoading: boolean; refetch(): void }
  export function useQuery<N extends QueryName>(name: N, args: FnArgs<N> | "skip"): QueryState<FnResult<N>>;
  export function useMutation<N extends MutationName | ActionName>(name: N):
    [(args: FnArgs<N>, opts?: CallOptions) => Promise<FnResult<N>>, { pending: boolean; error: WizardError | undefined }];
  export interface CallOptions { consent?: true }   // SDK добавляет _consent (security/compliance.yaml#system_package.consent)
  export type FilterOps<T> = { eq?: T; ne?: T; lt?: T; lte?: T; gt?: T; gte?: T; in?: T[]; contains?: string };
  export type EntityFilter<E extends EntityName> = { [K in keyof ClientDoc<E>]?: ClientDoc<E>[K] | FilterOps<ClientDoc<E>[K]> };
  export type SortKey<E extends EntityName> = (keyof ClientDoc<E> & string) | `-${keyof ClientDoc<E> & string}`;
  export interface EntityListOptions<E extends EntityName> { filter?: EntityFilter<E>; sort?: SortKey<E> | SortKey<E>[]; page?: number; limit?: number }
  export interface EntityListState<E extends EntityName> {
    items: ClientDoc<E>[]; total: number; page: number; limit: number; hasMore: boolean;
    isLoading: boolean; error: WizardError | undefined; refetch(): void;
  }
  export function useEntityList<E extends EntityName>(entity: E, opts?: EntityListOptions<E>): EntityListState<E>;
  export function useEntity<E extends EntityName>(entity: E, id: Id<E> | string | undefined): QueryState<ClientDoc<E> | null>;
  export function useEntityMutation<E extends EntityName>(entity: E): {
    create(doc: Insert<E>, opts?: CallOptions): Promise<ClientDoc<E>>;
    update(id: Id<E> | string, patch: Patch<E>, opts?: CallOptions): Promise<ClientDoc<E>>;   // _consent нужен и при update строк с ПДн (runtime.yaml#data_api)
    remove(id: Id<E> | string): Promise<void>;
  };
  export interface ClientUser { id: Id<"users">; role: RoleName; displayName: string; isAdmin: boolean }
  export function useUser(): {
    user: ClientUser | null; isLoading: boolean;
    login(o?: { role?: RoleName; next?: string }): void; logout(): Promise<void>;
  };
  export function usePayment<I extends keyof Payments & string>(integration: I):
    { pay(binding: Payments[I], id: string): Promise<void>; pending: boolean; error: WizardError | undefined };
  // M3 (M3-02): action — aiActions[].name
  export function useAiAction(action: string): {
    run<E extends EntityName>(entity: E, id: Id<E> | string):
      Promise<{ item: ClientDoc<E> & { _aiFilled: string[] }; filled: string[]; skipped: string[] }>;
    pending: boolean; error: WizardError | undefined;
  };
  export function useParams<T extends Record<string, string> = Record<string, string>>(): T;
  export function useNavigate(): (to: string) => void;
  export { useState, useEffect, useMemo, useCallback, useRef } from "react";
}
```

## 6. Проверка соответствия

- M0-07: `packages/sdk/test/contract.test-d.ts` — тип-тесты (`expectTypeOf`) на каждый экспорт раздела 5; `tsc --noEmit` на `specs/runtime/examples` с `_generated/wizard.d.ts` из `forum.json`.
- M0-09: интеграционные тесты runtime на лимиты (2.1), транзакции (2.2), права в функциях (2.3).
- M0-10: G0 — правила раздела 1 и `where` только по индексам (через tsc).

## 7. Исходящий HTTP из action (M2-52, D71)

- `ctx.http.fetch(url, { method?, headers?, body? })` → `{ status, ok, headers.get("content-type"), text(), json() }`. Запрос делает runtime, а не код системы: только `https://` на стандартный порт, только хосты из `functions[].egress` этой функции (любой публичный адрес, кроме доменов платформы и внутренних зон; проверка G2-EGRESS-01), без редиректов.
- Секреты — только ссылкой `secret://<имя>` из `functions[].secretRefs` в значении заголовка или в query: `headers: { Authorization: "Bearer secret://crm_token" }`. Значение подставляет runtime, код его не видит.
- Лимиты: 10 запросов на вызов, 60 в минуту на систему, тело ≤ 256 КиБ, ответ ≤ 2 МиБ, 10 с на запрос. Ошибки: `EGRESS_FORBIDDEN` (адрес не объявлен или ведёт во внутреннюю сеть), `EGRESS_FAILED` (сервис недоступен), `LIMIT_EXCEEDED`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`; без настроенного egress — `EGRESS_DISABLED`. Подробности — runtime.yaml#functions.egress.
