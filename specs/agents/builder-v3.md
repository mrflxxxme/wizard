# Контракт v3: границы, интерфейсы, правила потоков

Источник решений: `product.yaml#decisions.D77_v3`; план: `docs/plans/2026-10-08-v3.md`. Этот файл — общий контракт для параллельных задач вехи V3. Задача меняет только свои пути (раздел 2). Чужие части использует через интерфейсы раздела 3. Если интерфейс приходится менять, это делается отдельным PR с правкой этого файла.

## 1. Стек v3 (дополняет `architecture.yaml#stack`)

**Публичные страницы систем v3** (`ui/pages/**`, `ui/patterns/**`, `ui/sections/**`):
- React 19 + Tailwind CSS v4 (MIT) + Motion (MIT).
- Tailwind компилируется в `@wizard/build` через JS API `tailwindcss` (`compile` → `build(candidates)`). Кандидаты собираем своим токенайзером строковых литералов, без нативного oxide.
- Тема Tailwind (`@theme`) привязана к CSS-переменным дизайн-системы клиента.
- Запрещены произвольные значения цвета и шрифта (`text-[#…]`, `font-[…]`) и цвета палитры Tailwind по умолчанию. Это проверяет линтер V3-12.

**Кабинеты сотрудников и ui-kit:** как раньше — CSS-переменные и CSS modules. Стиль клиента подставляется через токены.

**Почему Tailwind:**
- модели пишут его лучше всего, в нём меньше токенов, чем в отдельных CSS-файлах;
- паттерны из MIT-источников (shadcn/ui, HyperUI) переносятся почти дословно;
- связь темы с токенами сохраняет единство дизайн-системы.

**GSAP не используем:** его лицензия не входит в список AGENTS.md.

**Чтение страниц (V3-05):** Node-библиотеки `@mozilla/readability` (Apache-2.0), `linkedom` (ISC), `turndown` (MIT) вместо Python-сервиса Crawl4AI с Trafilatura. Тот же результат (страница → чистый markdown), но без второго рантайма и Chromium на сервере. Страницам, которым нужен JavaScript, хватает llms.txt, openapi.json и sitemap.

## 2. Кто чем владеет (owns)

| Задача | Пути |
|---|---|
| V3-01 | `apps/platform-api/src/billing/llm-cap.ts`, `apps/platform-api/src/billing/v3-*.ts`, `tools/deploy/spend.mjs`, `docs/progress/v3-spend.json`, правки `tools/deploy/pilot.mjs` (eval: предрегистрация и потолок), `.github/workflows/eval-pilot.yml` (форма замера с журналом трат) |
| V3-02 | `packages/appspec/src/brief/**`, `apps/platform-api/src/briefs/**`, миграция `platform.system_briefs` |
| V3-05 | `packages/agents/src/research/**`, `.github/workflows/research.yml` (проба поиска из CI) |
| V3-07 | `packages/ui-kit/src/v3/design/**`, `packages/agents/src/builder/v3/art-director.ts` |
| V3-08 | `packages/ui-kit/src/v3/patterns/**`, `packages/build/src/tailwind.ts` и подключение в `build.ts`, `THIRD_PARTY_NOTICES.md` (дописывание) |
| V3-10 | `packages/modules/src/engine/**` (режим «только бэк»), `packages/appspec/src/modules/extend.ts`, `packages/ui-kit/src/v3/headless/**` |
| V3-16 | `packages/llm/src/**` (маршруты v3, allowlist, endpoint vLLM, кэш промптов), `specs/agents/models.yaml` |

Задачи второй очереди (V3-03, 04, 06, 09, 11, 12–15, 17) получают owns при старте — по тем же правилам.

Регистрационные файлы (`src/index.ts` пакетов, `package.json`, `pnpm-lock.yaml`) только дописываются. При конфликте сохраняются обе стороны, а `pnpm-lock.yaml` перегенерируется через `pnpm install`. `specs/backlog.yaml` и `specs/CHANGELOG.md` правит только ведущий интегратор по отчётам задач.

## 3. Интерфейсы

### C1. Бриф системы — `@wizard/appspec` (`src/brief/`)

- `systemBriefSchema` (zod) и тип `SystemBrief`:
  - `goals[] {id, text, success}`;
  - `audience`;
  - `scenarios[] {id, actor: visitor|client|staff|owner|system, when, then[], goalId?, moduleHint?, priority: must|should}`;
  - `roles[] {id, name, can[]}`;
  - `data[] {entity, fields[] {name, pii?}, retention}`;
  - `integrations[] {id, name, direction: out|in, contractRef?, secretRef?}`;
  - `design {archetype?, pinned?, references[]}`;
  - `outOfScope[] {text, substitute?}`;
  - `assumptions[] {text, source: default|owner_skip}`;
  - `qa[] {q, a, recommended, chosen: recommended|option|custom|delegated}`;
  - `capability[] {requirement, level: modules|custom|not_yet}`.
- `BriefVersion` — `{version, brief, diff, author: agent|owner, createdAt}`; `briefDiff(a, b)` — по полям.
- `briefDiagrams(brief)` → `{journey, dataRoles, integrations}`. Это графы (узлы и рёбра с подписями на русском), их рисует UI, а не модель. Функция без побочных эффектов: на любом валидном брифе отдаёт граф и не бросает исключений.
- Сценарии брифа — критерии приёмки: харнесс V3-11 превращает `must`-сценарии в список фич и проверок в браузере.

### C2. Дизайн-система клиента — `@wizard/ui-kit` (`src/v3/design/`)

- `ARCHETYPES` — 12–16 описаний данными: id, имя по-русски, пары шрифтов из каталога D64, правила палитры, сетки, ритма, движения и изображений, подходящие ниши и цели.
- `designSystemV3({archetype, brandColor?, seed, niche, voice})` → `DesignSystemV3`. Чистая детерминированная функция без модели. Внутри:
  - `fonts {display, text}`;
  - `palette {light, dark}` в OKLCH;
  - `type` (шкала);
  - `space`, `radius`;
  - `grid {columns, maxWidth, rhythm}`;
  - `motion {profile, durations, easing}`;
  - `imagery {style, treatment}`.
- `designSystemCss(ds)` → CSS-переменные плюс `@theme` для Tailwind; `designLint(ds)` → контраст и правила.
- Выбор архетипа — `pickArchetype({niche, goals, seed, recent[]})`. Он детерминированный и учитывает память ниши (последние сборки).

### C3. Библиотека паттернов — `@wizard/ui-kit` (`src/v3/patterns/`)

- `PATTERNS: PatternMeta[]`, где `PatternMeta`:
  - `id`, `sectionType`, `variant`;
  - `archetypes[]` — каким архетипам подходит;
  - `slots` — zod-схема контента;
  - `needs` — `lead | booking | catalog | cart | content | null`;
  - `source` — TSX-текст, который копируется в систему как `ui/patterns/<id>.tsx`;
  - `license`, `origin`.
- Паттерн импортирует только `react`, `motion/react`, `@wizard/ui-kit/v3/headless` (для `needs`) и свои соседние файлы. Цвета и шрифты берёт только из темы.
- `patternFor({sectionType, archetype, seed, used[]})` — детерминированный выбор с разнообразием.

### C4. Headless-хуки модулей — `@wizard/ui-kit` (`src/v3/headless/`)

`useLeadForm(entity)`, `useBooking(…)`, `useCatalog(…)`, `useContent(…)` (позже `useCart(…)`).
- Данные, права, согласие на ПДн (G2-PII-04) и состояния — поверх `@wizard/sdk`; разметки нет.
- Паттерны с `needs` подключают эти хуки. Так визуал генерируется, а логика остаётся модульной.
- «Контент и блог» (V3-24): `useEntry(entity, {path, slugField?, slug?})` — запись по slug адреса (посетителю — только опубликованная); `useRubric({path, …})` — записи рубрики адреса и список рубрик; `richText(text)` → блоки подмножества markdown (абзацы, `##`, списки, цитаты, безопасные ссылки, картинки своего домена) — паттерн рисует их React-элементами, HTML владельца не вставляется; `safeHref`, `slugFromPath`, `useEntryTitle`. Блок согласия форм паттернов размечен как `ConsentCheckbox` (`data-testid="wz-consent"`, флажок и ссылка на политику) — его ищет G1-RENDER-01.

### C5. Модули — бэкенд-рецепты (`@wizard/modules`, `@wizard/appspec`)

- `compilePlan(plan, {front: "v2" | "backend"})`:
  - `backend` — AppSpec, функции, автоматизации, метрики, сценарии целей и кабинеты сотрудников, без публичных страниц лендинга и главной;
  - `v2` — нынешний путь, не меняется.
- `ExtensionOp` (`src/modules/extend.ts`) — `add_field | add_entity | add_role | add_function | add_automation`. `applyExtensions(spec, ops)` → `{spec, rejected[] {op, reasonRu}}`. После применения работают гейты RLS, ПДн (`markExtraPii`) и миграций.

### C6. Харнесс сборки v3 — `@wizard/agents` (`src/builder/v3/`)

Этапы:
1. `brief` (актуальная версия);
2. `design` (C2: архетип и токены);
3. `skeleton` (каркас страниц из паттернов — превью ≤ 5 мин);
4. `scenarios` (по одному: страницы и фирменные секции, проверка в браузере);
5. `critic` (V3-13);
6. `template_gate` (V3-14);
7. `techreview` (V3-15);
8. `gates` (G0–G2).

После каждого этапа и каждого сценария сохраняется чекпоинт. Кошелёк и время: потолки 500 ₽ и 30 мин, правило остановки — по D77 (10).

Точки расширения харнесса (`src/builder/v3/harness/types.ts`):
- `V3Host.hooks.{critic, template_gate, techreview}` — этапы V3-13…15. Без хука этап «skipped». `V3HookResult.blockers` → GATES_FAILED. `redesign {avoid}` → арт-директор выбирает другой архетип без модели. `design` → токены критика становятся `ctx.design` следующих этапов.
- Шаблонность проверяется дважды:
  - сразу после каркаса — смена архетипа и новый каркас до сценариев, не больше одного раза за прогон, закреплённое владельцем направление не меняется;
  - после сценариев — только запись в память и заметка.
- `V3Host.integrations` (V3-20) — слой интеграций брифа поверх бэкенда: контракты, клиент на моке до проверки ключом, egress только к хостам контракта.
- Ход сборки для холста (V3-17) — снимок `progress` в событиях `build_stage` и `step_*` (`workflows.yaml#events.schemas.v3_progress`). Его собирает хост.

Шов между харнессом (V3-11) и сборщиком страниц (V3-12) — `src/builder/v3/contract.ts`: `V3BuildContext`, `PageComposer {skeleton, scenario}`, `V3ComposeResult`, `V3PagePlan`. Харнесс вызывает `PageComposer`, V3-12 его реализует; внутренности друг друга они не импортируют.

### C7. Модели — `@wizard/llm`

- Новые callType: `interview_v3`, `brief_extract`, `art_direction`, `page_compose`, `signature_section`, `critic_visual`, `techreview`, `research`.
- Маршруты — в `models.yaml`.
- Allowlist моделей отклоняет западные API на ключах платформы (D18).
- Провайдер `openai_compatible` с `baseUrlEnv` позволяет подключить свой vLLM, а позже BYOK (V3-33).

### C8. Исследование — `@wizard/agents` (`src/research/`)

- Инструменты `web_search` (Yandex Search API, ключ `YANDEX_SEARCH_API_KEY`, каталог — `YANDEX_FOLDER_ID`) и `read_page` (C1 стека).
- Лимиты на сборку, кэш, журнал вызовов, egress по D46.
- Без ключа инструменты работают в режиме «только известные адреса».

## 4. Правила потоков (бережливый харнесс, D77 (18б))

- В задачах — только ступени 0–1: `WIZARD_LLM_MODE=fixture`, записанные ответы, тесты CI.
- Живые вызовы моделей и поиска — только через журнал трат V3-01, с предрегистрацией. Поиск расходует баланс Yandex Cloud, поэтому ответы записываются в фикстуры и дальше переиспользуются.
- Перед сдачей задача проходит полный набор: `pnpm lint`, полный `pnpm typecheck` без обрезки вывода, `pnpm test` пакетов задачи, `node tools/specs/validate.mjs`.
- Отчёт задачи содержит: что сделано, что решено самостоятельно (строка для CHANGELOG), какие интерфейсы раздела 3 реализованы и как это проверено.
