# L2. Аудит спек: исполнимость автономными агентами, скорость до M0, экономия токенов

Дата: 2026-09-30. Предмет: `specs/**`, `AGENTS.md`, `specs/README.md`, а также фактическое состояние репозитория (коммит `104fb50` плюс незакоммиченная работа агента appspec). Линза аудита: сможет ли агент закрыть задачу M0 только по спекам, проверяемы ли критерии в CI без сети и ключей, насколько быстро собирается M0, сколько токенов уходит на чтение спек. Согласованность файлов между собой, безопасность и верность концепции в этот аудит не входят. Их касаюсь только там, где они мешают исполнению задачи.

## 0. Итог

- **Находок 31:** блокирующих (blocker) 8, крупных (major) 15, мелких (minor) 8.
- **Нынешний граф M0 в идеале занимает 13,5 агенто-дня** по критическому пути `01→02→03→04→10→13→15→16→17`. На деле граф не исполним: фикстур взять неоткуда (L2-01), нет черновой схемы с данными для превью (L2-04), слить работу в main нельзя без основателя (L2-02). Если поправить оценки (M0-09 ≈ 5–6 дней, M0-08 ≈ 4, M0-13 ≈ 3, M0-16 ≈ 3,5), получается около 17–20 дней.
- **Предлагаемый граф:** 10 новых задач, 4 задачи разделены, 6 лишних зависимостей убраны. **Критический путь около 12 агенто-дней при 6–7 агентах в пике.** Если допустить перекрытие M0-09 и M0-23 через интерфейс `DataAccess`, путь сокращается примерно до 10 дней (см. §3).
- **Токены:** сейчас задача M0 требует прочитать от 400 до 1 600 строк спек, то есть 12–40 тыс. токенов, а M0-16 вместе с HTML-макетом около 75 тыс. Нарезка по якорям и вехам (L2-23) экономит 40–60 % на самых тяжёлых задачах.

## 1. Находки

| ID | Сев. | Задача / файл | Проблема | Исправление |
|---|---|---|---|---|
| L2-01 | blocker | M0-06, M0-12, M0-13, M0-14, M0-15, M0-17; `quality/eval.yaml#fixtures` | Приёмка M0-12…M0-15 требует «fixture-прогон форума», но фикстуры записываются только в M0-17, то есть после этих задач. Записать их можно только в live-режиме: нужны ключи (E-ACCESS) и уже работающий харнесс. Поиск фикстуры идёт по sha256 полного запроса, поэтому любая правка промпта даёт FIXTURE_MISS и снова требует live-прогона. Кроме того, `eval.yaml` нет в `specs:` задачи M0-06, хотя формат фикстур описан именно там. | Новая задача **M0-21**: скриптованные «золотые» фикстуры `demo/*`, которые генерируются из `examples/forum.json` и `runtime/examples`, ключи не нужны. В `eval.yaml#fixtures` добавить режим поиска по последовательности для suite=demo (§4.3). Добавить M0-21 в зависимости M0-12 и M0-13, а `eval.yaml#fixtures` — в specs задачи M0-06. |
| L2-02 | blocker | `escalation.yaml#E-EXTERNAL`, `AGENTS.md` | «Пуш в main» считается эскалацией. Значит, каждое слияние задачи требует основателя, и при 25+ задачах M0 он становится узким местом. | Разрешить PR с auto-merge при зелёном CI (§4.1). |
| L2-03 | blocker | `backlog.yaml` | В бэклоге нет статуса и захвата задач. M0-01 уже закрыта, M0-02…04 сейчас делает другой агент, но из backlog этого не видно. Параллельные агенты возьмут одну и ту же задачу. | Добавить поля `status` и `claimed_by`, писать их может только диспетчер (§4.1). |
| L2-04 | blocker | `platform/workflows.yaml#workflows.build`, M0-15, M0-17 | Ни один шаг и ни одна задача не применяет DDL и RLS к `app_<key>_draft` и не наполняет черновую схему данными. Превью откроется без таблиц или пустым. E2E-сценарий «участник регистрируется → QrTicket» невыполним, потому что нет ни одного `ticket_type` и `stream`. | Добавить шаги `migrate_draft` и `seed_draft` (§4.4) и включить их в приёмку M0-26. |
| L2-05 | blocker | `architecture.yaml#interfaces` | Не определены контракты между пакетами. У `runGates(level, ctx)` форма `ctx` не описана. Нет хост-интерфейса строителя (хранилище ревизий и файлов, события, `runStep`). Нет способа запустить runtime внутри процесса для G1. Не решено, куда писать usage: в `.data/usage.jsonl` или в `platform.llm_calls` (known-issues #10). В итоге M0-10, M0-11, M0-13, M0-15 и M0-26 придумают несовместимые формы. | Добавить в `interfaces` описания `gate_context`, `runtime_handle`, `build_system`, `agent_host`, `usage_sink` (§4.2). |
| L2-06 | blocker | M0-09, M0-10, M0-15; `runtime/sdk.md`; `ui-kit.yaml#wz_id` | Сборку бандла делят три задачи: esbuild-плагин в M0-09, G0-BUILD-01 в M0-10, «сборка бандла» в M0-15. Не описан tsconfig для кода систем. При `NodeNext` из `tsconfig.base.json` строка `import "./lib/occupancy"` в `examples/functions/registerTicket.ts` не компилируется. Автоматический `react/jsx-runtime` нарушает G0-IMP-01. | Новый пакет **M0-20** `packages/build`. В sdk.md описать `tsconfig.system` с `moduleResolution: Bundler` и `jsxImportSource: "@wizard/sdk"`, при этом `@wizard/sdk/jsx-runtime` реэкспортирует react (§4.5). |
| L2-07 | blocker | M0-11; `examples/forum.json` AC4–AC6; `bakery.json` AC7; `gates.yaml#G1-AC-COVER` | G1 на форуме требует шагов `runWorkflows`/`advanceTime` (движок воркфлоу `_w_jobs`), а также `simulate` с моками коннекторов и QR. Ни одна задача M0 этого не делает. `check.milestone` у AC5 (M2) и AC6 не задан, поэтому G1-AC-COVER провалит сборку. | Задать `check.milestone` (AC5: M2; AC6 и AC7 кондитерской: M1). В G1-AC-COVER учитывать только AC с milestone ≤ `WIZARD_MILESTONE`. Исполнение воркфлоу перенести в M1 с записью в CHANGELOG (§4.4). |
| L2-08 | blocker | M0-01 (закрыта), `package.json` | Скрипт `dev` вызывает `scripts/dev.mjs`, которого нет. `e2e` вызывает `@wizard/e2e`, которого нет. У приложений нет точки входа и dev-скрипта. Не решено, как запускать TS: `--experimental-strip-types` в Node 22 не резолвит `./x.js`→`.ts` (в appspec импорты с `.js`). В CI нет Playwright и браузеров. | Новая задача **M0-27** (e2e и dev-оркестрация). В `architecture.yaml#stack` записать: `dev_exec: "tsx (MIT) для apps в M0–M1; пакеты экспортируют src/*.ts"`. |
| L2-09 | major | M0-09 | Объём M0-09 при оценке в 2 дня реально около 5–6 дней: data API, права, RLS, dev-вход, функции в vm/worker с лимитами и SERIALIZABLE-повторами, статика, bridge.js, плагин wz-id, RoleSpec. Неявно задача требует ещё SSE-инвалидации, QR-check (e2e), CONSENT_REQUIRED и реестр систем. Реестр описан через `platform.deployments`, а эта таблица появляется только в M0-15, то есть позже. Агенту приходится читать около 9 файлов, которых нет в `specs:`. | Разделить на M0-09 (ядро и FileRegistry), **M0-23** (функции) и **M0-24** (превью, мост, SSE, QR). M0-09 создаёт точки монтирования маршрутов, чтобы M0-23 и M0-24 правили разные файлы (§5). |
| L2-10 | major | M0-15 | Зависимость от M0-13 выстраивает всё в одну цепочку. Шаги gate_G1 и qa_explain из `workflows.yaml#build` требуют M0-11 и M0-14, которых нет в deps. Приёмка «события fixture-прогонов» — это интеграционная проверка, а не проверка API. | M0-15 делать автономно, с фейковыми агентами через `agent_host`, deps `[M0-03, M0-20]`. Подключение реальных агентов вынести в **M0-26** (§5). |
| L2-11 | major | M0-16 | Зависит от M0-15, хотя UI можно строить на моке API. Приёмка ссылается на `docs/wizard-concept-v3.html` (89 КБ, около 30 тыс. токенов), а формулировка «структура — да» не проверяется автоматически. | deps `[M0-08]`. Мок API и SSE строить по `api.yaml` и `workflows.yaml#events`. Приёмку перевести на `test_ids` из `platform-screens.yaml` (§5). |
| L2-12 | major | M0-08 | За 2 дня нужно сделать 17 компонентов, токены, 5 шрифтов, привязку к данным, memory-DataSource, wz_id, демо и Playwright. Зависимость от M0-07 не нужна: sdk требуется только адаптеру `sdkDataSource`. | Разделить на M0-08 (основа, все типы пропсов, примитивы, AppShell, DataSource; deps `[M0-02]`) и **M0-25** (компоненты). Демо собирать из `demo/stories/*.tsx` по glob, чтобы не было общего файла. |
| L2-13 | major | M0-10 | G0-TS-01 компилирует `ui/**`, а эти файлы импортируют `@wizard/ui-kit`, поэтому нужна скрытая зависимость от типов ui-kit. G0-BUILD-01 требует сборщика. Критерий «≤ 20 с на 4 vCPU» нестабилен на раннерах CI. | deps `[M0-04, M0-07, M0-08, M0-20]`. Время проверять как мягкое условие (предупреждение и запись в отчёт), жёсткий предел поставить 60 с. |
| L2-14 | major | M0-13; `agents/builder.yaml#loop` и `platform/workflows.yaml#build` | Неясно, кто владеет циклом «гейт → QA → fix». В builder.yaml его ведёт харнесс строителя, в workflows.yaml — воркфлоу платформы, со своими лимитами (≤ 3 итерации против 5 ошибок подряд). Это верный путь к переделке в M0-26 и M1-01. В deps не хватает фикстур и типов ui-kit. | Цикл реализует `runBuild(host)` в packages/agents, а каждый шаг оборачивается в `host.runStep`. workflows.yaml описывает только границы шагов (§4.2). deps `[M0-10, M0-12, M0-21]`. |
| L2-15 | major | M0-11 | В `specs:` нет `qa.yaml#seed` и контракта runtime. Кто владеет генератором seed, не определено: qa.yaml относит его к QA, а gates.yaml#G1.setup его использует. Шаги `callFn` (AC1, AC2, AC4) требуют исполнителя функций. | Владелец генератора — `packages/gates` (`generateSeed`); M0-14 его только вызывает. deps `[M0-09, M0-10, M0-23]` (§5). |
| L2-16 | major | M0-14 | Условие «≥ 6 проверок» выполняется тривиально: `permission_auto` для форума даёт 7×8×4 = 224 PC-проверки. | Требовать ≥ 1 SC-проверку на каждый AC scenario/constraint с milestone ≤ M0 и статус pass на золотой ревизии (§5). |
| L2-17 | major | M0-07, `sdk.md#4` | По sdk.md `generateTypes` экспортируется из `@wizard/sdk/codegen`, но уже реализован в `packages/appspec/src/types-gen.ts` (агентом appspec). Агент M0-07 либо продублирует его, либо полезет в чужой пакет, над которым сейчас идёт работа. | Закрепить: реализация живёт в appspec, `@wizard/sdk/codegen` её реэкспортирует, snapshot-тест за M0-07. Правка sdk.md#4 и запись в CHANGELOG. |
| L2-18 | major | M0-18; `milestones.yaml` M0 exit | Приёмка запускается только с ключами и в CI не проверяется. Условие выхода M0 («1 из 12 live») требует E-ACCESS. Если запросить доступ в конце, M0 простоит в ожидании. Брифы называются `cg-*`, а по `eval.yaml` должны быть `gd-*`. | Эскалировать E-ACCESS (Cloud.ru FM и Z.ai) **в день 0**. Для CI сделать приёмку в fixture-режиме, live-отчёт коммитить отдельно. Переименовать `cg-*` в `gd-*` (§5). |
| L2-19 | major | параллельные волны | Места, где параллельные задачи будут конфликтовать при слиянии: `pnpm-lock.yaml`, `specs/CHANGELOG.md`, корневой `package.json`, `packages/agents/src/index.ts` (M0-12/13/14), `apps/runtime/src/app.ts` (M0-23/24). | Добавить `.gitattributes` с правилом `specs/CHANGELOG.md merge=union`, правило пересборки lockfile, раздельные sub-path exports `@wizard/agents/{orchestrator,builder,qa,core}`, точки монтирования маршрутов в runtime (§4.1, §5). |
| L2-20 | major | CI `.github/workflows/ci.yml` | Нет установки chromium и e2e-джоба. `/opt/pw-browsers` существует только локально. Приёмка M0-08, M0-16 и M0-17 в CI не выполнится. | Входит в M0-27: `pnpm exec playwright install --with-deps chromium` в CI, локально `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`. |
| L2-21 | major | `backlog.yaml` (оценки) | Оценки занижены в 1,5–2,5 раза: M0-09 2→6 (после разделения 2,5+2+1,5), M0-08 2→4 (1,5+2,5), M0-13 2,5→3, M0-15 2→3, M0-16 2,5→3,5, M0-11 1,5→2, M0-17 1→1,5. | Обновить `estimate_days` (§5). |
| L2-22 | major | M0-06 | Путь в приёмке `tools/fixtures/*.jsonl` не совпадает с `eval.yaml` (`<suite>/<name>.jsonl`). Нет режима последовательного поиска фикстур. Хранилище usage не определено. | Правка приёмки M0-06 (§5), `UsageSink` (§4.2). |
| L2-23 | major | `AGENTS.md` п.2, `specs/README.md` | Каждая задача начинается с чтения целиком product.yaml и architecture.yaml (16 тыс. символов, около 5,5 тыс. токенов). `specs:` задач указывают на файлы целиком, где смешаны M0–M3: api.yaml 49 тыс. символов (M0-часть 19 тыс.), db.yaml 25 тыс. (M0-часть 8 тыс.). Нет инструмента для нарезки. | Задача **M0-19**: `tools/specs/slice.mjs` плюс якоря в `specs:` (валидатор уже отрезает `#…`). Таблица чтения — §6. |
| L2-24 | minor | M0-15, `db.yaml#conventions` | «information_schema совпадает с db.yaml (генерируется скриптом tools/specs)», но скрипт никто не делает. | Включить в приёмку M0-15: тест парсит `db.yaml` (таблицы с milestone M0) и сравнивает имена колонок. |
| L2-25 | minor | M0-15 | Не указан инструмент контрактного теста OpenAPI. | Использовать ajv (уже есть в devDeps) по `components.schemas` плюс собственный сопоставитель путей, без новых зависимостей. |
| L2-26 | minor | M0-17, `platform-screens.yaml#S9` | E2E кондитерской удваивает объём M0, а условие выхода M0 требует только форум. | Оставить кондитерскую до G0 в золотом прогоне (M0-22). Playwright-сценарий S9 перенести в M1 как неблокирующий (перенос между вехами — не эскалация). |
| L2-27 | minor | M0-10 | Проверки уровня warning (LINT-01, A11Y-01, I18N-01, PH-01) не нужны для прототипа. | Перенести в M1 (`since: M1` в gates.yaml). Экономия около 0,5 дня. |
| L2-28 | minor | `runtime.yaml` (M0-09/24) | В тексте M0 без меток вехи: rate limits, полный CSP, PWA manifest и sw.js, HMAC userIdHash, OTP. | Пометить `since: M1`; в M0 оставить только dev-login, базовые заголовки и `frame-ancestors`. |
| L2-29 | minor | `platform-screens.yaml#preview_contract.src` и `api.yaml#getPreviewUrl` | В preview_contract URL несёт HMAC-токен, а в api.yaml это M2. Агент M0-16/M0-24 не поймёт, делать ли токен. | Уточнить в preview_contract: «M0: url = dev-login без токена; HMAC — M2». |
| L2-30 | minor | M0-05 | Корпус генерирует сам исполнитель, поэтому precision легко подогнать. Не указан источник словаря ФИО. | В приёмку добавить ≥ 50 жёстких негативов (номера заказов, даты, цены, ИНН юрлиц как не-ПДн) и встроенный синтетический словарь ≥ 300 имён и ≥ 300 фамилий без внешней загрузки. |
| L2-31 | minor | M0-07 | Приёмка проверяет tsc только для `examples/functions`. `examples/ui/*.tsx` (с QrScanner) никто не типизирует. | Проверку `examples/ui` включить в приёмку M0-25 (после появления типов ui-kit). |

## 2. Покомпонентная оценка задач M0 (кратко)

| Задача | Исполнима по `specs:`? | Приёмка в CI без сети/ключей | Зависимости | Параллельность | Оценка (факт → предложение) |
|---|---|---|---|---|---|
| M0-01 | закрыта не полностью (L2-08) | да | — | — | 0,5 (закрыта) + M0-27 |
| M0-02 | да | да | ок | безопасно с M0-05 | 1 (в работе) |
| M0-03 | да (нужна ещё схема) | да | ок | ок | 1 (в работе) |
| M0-04 | да | да (Postgres-сервис в CI) | ок | ок | 1,5 (в работе) |
| M0-05 | почти (L2-30) | да | ок | ок | 1 |
| M0-06 | нет: формат фикстур и UsageSink (L2-01, L2-22) | да, после правки | ок | ок | 1,5 |
| M0-07 | почти (L2-06, L2-17) | да | ок | конфликт с appspec по types-gen (L2-17) | 1 |
| M0-08 | нет: перегружена (L2-12) | да, после M0-27 | лишняя зависимость от M0-07 | ок | 2 → 1,5 + 2,5 (M0-25) |
| M0-09 | нет (L2-09) | да | не хватает реестра, сборщика | ок | 2 → 2,5 + 2 + 1,5 |
| M0-10 | почти (L2-06, L2-13) | время нестабильно | не хватает ui-kit и build | ок | 1,5 → 2 |
| M0-11 | нет (L2-07, L2-15) | да | не хватает M0-23 | ок | 1,5 → 2 |
| M0-12 | да, при фикстурах | только с M0-21 | лишняя зависимость от M0-03, нет M0-21 | ок | 1,5 → 2 |
| M0-13 | нет (L2-05, L2-14) | только с M0-21 | не хватает M0-21 | делит пакет с M0-14 (L2-19) | 2,5 → 3 |
| M0-14 | да | только с M0-21 | ок | см. L2-19 | 1 |
| M0-15 | нет (L2-04, L2-05, L2-10) | контракт да, события нет | лишняя зависимость от M0-13, нет M0-11/14 | ок | 2 → 3 (автономно) + 1,5 (M0-26) |
| M0-16 | почти (L2-11) | «структура» не проверяется | лишняя зависимость от M0-15 | ок | 2,5 → 3,5 |
| M0-17 | нет пакета e2e (L2-08) | да | нужны M0-26, M0-27 | — | 1 → 1,5 |
| M0-18 | да | нет, нужны ключи (L2-18) | ок | ок | 1 |

## 3. Критический путь и волны M0 (предлагаемый граф)

Допущение: день 0 — сегодня. M0-01 закрыта. M0-02…04 заканчивает агент appspec к дню 1–1,5.

**Критический путь:** `M0-04 (д1–1,5) → M0-09 (2,5) → M0-23 (2) → M0-11 (2) → M0-14 (1) → M0-26 (1,5) → M0-17 (1,5)`. **Итого около 12 агенто-дней.** Вторая по длине ветка — строитель: `M0-05 → M0-06 → M0-12 → M0-13` заканчивается к дню 7,5, запас 1,5 дня.

| Волна | Окно (дни) | Задачи (агентов) | Что разблокирует |
|---|---|---|---|
| W0 | 0 – 1,5 | appspec M0-02…04 (1), M0-05 (1), M0-07 (1), M0-08 (1), M0-20 (1), M0-19 → M0-27 (1) | **6 агентов** |
| W1 | 1 – 4 | M0-06 (д1–2,5), M0-21 (д1–2,5), M0-09 (д1,5–4), M0-10 (д1,5–3,5), M0-15 (д1–4), M0-25 (д1,5–4), M0-16 (д1,5–5) | **7 агентов**, пик |
| W2 | 2,5 – 6 | M0-12 (д2,5–4,5), M0-22 (д2,5–3,5), M0-23 (д4–6), M0-24 (д4–5,5) | 4 агента, плюс хвосты M0-15/16/25 |
| W3 | 4,5 – 8,5 | M0-13 (д4,5–7,5), M0-11 (д6–8), M0-18 (д7,5–8,5) | 3 агента |
| W4 | 8 – 9 | M0-14 | 1 агент |
| W5 | 9 – 10,5 | M0-26 | 1 агент |
| W6 | 10,5 – 12 | M0-17 | 1 агент |

**Как сократить ещё** (решения product.yaml не затрагиваются, всё оформляется записью в CHANGELOG):
1. Первым делом (за день) M0-09 выпускает `apps/runtime/src/data/access.ts`, модуль `DataAccess` с интерфейсом. Тогда M0-23 можно начать с дня 2,5, а не с дня 4. Экономия около 1,5 дня.
2. Исполнение воркфлоу (`_w_jobs`-поллер, retention, шаги notify), моки email, telegram и ЮKassa, а также `runWorkflows`/`advanceTime` в DSL перенести в M1. В M0 `ctx.scheduler` пишет в outbox без исполнения (L2-07).
3. Предупреждающие проверки G0 перенести в M1 (L2-27). Rate limits, CSP, PWA и OTP в runtime тоже в M1 (L2-28).
4. Кондитерская в M0 доходит только до G0 в золотом прогоне; её e2e переходит в M1 (L2-26).
5. Шрифты ui-kit в M0 — один Onest (woff2) плюс системный стек. Остальные 4 шрифта — M1: в токенах уже есть fallback.
6. Экран S2 (вопросы) в M0 обязан поддерживать только кнопку «Остальное — по рекомендации» и выбор варианта. Свободный ответ перенести в M1.

**Единственное действие человека на пути M0:** E-ACCESS (ключи Cloud.ru FM и Z.ai в GitHub Secrets и `.env`) нужно запросить в день 0. Ключи нужны только для M0-18 и условия выхода «1 из 12 live». Всё остальное делается на золотых фикстурах.

## 4. Правки спек (точный YAML)

### 4.1 Процесс (L2-02, L2-03, L2-19)

`specs/escalation.yaml`, у E-EXTERNAL:
```yaml
  - id: E-EXTERNAL
    when: "Необратимое/внешнее действие: публикация в интернет вне staging, отправка писем реальным людям, прямой push в main в обход PR, force-push, удаление данных вне тестовых схем"
    not: "Мерж PR задачи в main через auto-merge после зелёного CI — не эскалация"
```

`specs/backlog.yaml`, в каждую задачу (пишет только агент-диспетчер, исполнитель меняет лишь свою строку при захвате):
```yaml
    status: todo          # todo | in_progress | done
    claimed_by: null      # id сессии агента
# текущие значения: M0-01 done; M0-02, M0-03, M0-04 in_progress (claimed_by: appspec-agent)
```

`AGENTS.md`, раздел «Порядок работы», заменить п. 1, 5, 6 и добавить п. 7:
```
1. Возьми задачу со status: todo, у которой все deps в status: done; поставь status: in_progress, claimed_by: <сессия> отдельным коммитом в main через PR.
5. Перед PR: `pnpm lint && pnpm typecheck && pnpm test && node tools/specs/validate.mjs`.
6. Ветка `task/<id>`, коммит `<id>: <что сделано>`, PR в main с auto-merge; прямой push в main запрещён.
7. Конфликт в pnpm-lock.yaml: взять версию main, выполнить `pnpm install`, закоммитить. CHANGELOG — только дописывать в конец.
```
В корень репозитория добавить `.gitattributes` со строкой `specs/CHANGELOG.md merge=union`.

### 4.2 Интерфейсы (L2-05, L2-14, L2-22)

`specs/architecture.yaml#interfaces`, добавить:
```yaml
  gate_context: "packages/gates: GateContext {spec, prevSpec: AppSpec|null, specVersion, files: ReadonlyMap<path, string> (ui/**, functions/**), env: 'draft'|'prod', systemKey, db: postgres.Sql (роль wizard_owner, только теневые/эфемерные схемы), runtime?: RuntimeHandle (G1), checks?: Check[] (G1, от QA), milestone: 'M0'|… (по умолчанию env WIZARD_MILESTONE), now?: Date, signal?: AbortSignal}"
  runtime_handle: "apps/runtime: createRuntimeApp({db, registry: SystemRegistry, clock?, connectors?: 'outbox'|'live'}) -> {fetch(req): Promise<Response>, loadSystem({systemKey, env, spec, artifactDir}), outbox(): OutboxMessage[]}; SystemRegistry {resolve(slug, env)}: FileRegistry(.data/artifacts/registry.json) — M0-09, DbRegistry(platform.deployments) — M0-26"
  build_system: "packages/build: buildSystem({spec, files, env, platformOrigin?}) -> {ok, errors: Check[], client: Map<path, Uint8Array>, serverFunctions: string (ESM), wzMap, manifest}; writeArtifact(root, systemId, revision, result) по runtime.yaml#system_loading.artifact_layout"
  agent_host: "packages/agents: BuildHost {route (llm_call), runGates(level, ctx), qa: {generate, explain}, store: {getSpec(): {spec, version}, applyOps(ops, expectedVersion, idemKey), writeFile(path, content), readFile(path), listFiles(prefix?), commitFiles()}, emit(type, payload) (workflows.yaml#events), runStep<T>(name, fn): Promise<T>, signal}. runBuild(host, {card, cap, mode}) реализует builder.yaml#loop целиком; каждый LLM-вызов и гейт идёт через host.runStep (M0 — identity, M1 — DBOS.runStep). workflows.yaml#build описывает только имена шагов и события, не дублирует цикл"
  usage_sink: "packages/llm: UsageSink {write(UsageRecord)}; по умолчанию JsonlUsageSink(.data/usage.jsonl); platform-api подставляет DbUsageSink(platform.llm_calls)"
```
`specs/architecture.yaml#stack`, добавить: `dev_exec: "tsx (MIT) для запуска apps в M0–M1; пакеты экспортируют src/*.ts без сборки; vite — для platform-web и ui-kit/demo"`.

### 4.3 Фикстуры (L2-01)

`specs/quality/eval.yaml#fixtures`, заменить `lookup` и добавить `golden`:
```yaml
  lookup:
    - "suite=demo (скриптованные «золотые»): поиск по (callType, порядковый номер вызова этого callType в прогоне); из request сравниваются только tools[].name; разрешено в CI; промах → FIXTURE_MISS"
    - "suite=eval|unit: поиск по key (sha256 канонического запроса); при нескольких совпадениях — по порядку записи"
    - "Промах → FIXTURE_MISS с callType и первыми 200 символами последнего сообщения; сеть не используется"
    - "WIZARD_FIXTURE_LENIENT=1 (только локально) — для suite=eval|unit промах → следующая неиспользованная запись того же callType"
  golden: "node tools/fixtures/gen-golden.mjs <name> детерминированно пишет tools/fixtures/demo/<name>.jsonl из tools/fixtures/golden/<name>.yaml (Analysis, ответы, SystemCard, план, сценарии QA) + specs/appspec/examples/<name>.json (apply_ops батчами ≤50 через specToOps) + исходников кода (write_file). Ключи и сеть не нужны; usage — оценка символы/3.2"
```
Имена: `demo/forum.jsonl`, `demo/bakery.jsonl` (в eval.yaml сейчас `confectionery`, а пример называется `bakery.json`).

### 4.4 Черновая схема, seed и объём G1 в M0 (L2-04, L2-07)

`specs/platform/workflows.yaml#workflows.build.steps`, после `gate_G0` вставить:
```yaml
      - { name: migrate_draft, kind: tx, does: "planMigration(spec(preview_revision)|null, spec, {env: 'draft'}) → toDDL+toRLS в app_<key>_draft под wizard_owner; destructive в draft допустим; при несовместимости типов — DROP SCHEMA … CASCADE и создание заново (M0)" }
      - { name: seed_draft, kind: tx, does: "только при создании схемы: gates.generateSeed(spec, sha256(systemKey)) (qa.yaml#seed) + пользователи dev-<role> для каждой роли; повторно не сидировать" }
```
Затем идут существующие шаги бандла и перезагрузки (их вынести в отдельный шаг `bundle_and_reload` после `seed_draft`).

`specs/appspec/examples/forum.json`: у AC5 `"check": {..., "milestone": "M2"}`, у AC6 `"milestone": "M1"`. В `bakery.json` у AC7 `"milestone": "M1"`.

`specs/quality/gates.yaml#G1.checks`, у G1-AC-COVER: `what: "Каждый AC с check.milestone ≤ ctx.milestone (нет поля = M0) имеет ≥1 исполнимую проверку; AC более поздних вех — status=skip"`.

`specs/runtime/runtime.yaml#workflows.execution`: `"M0: ctx.scheduler и триггеры только пишут в _w_jobs (outbox), поллер не запускается; M1: поллер/DBOS (M1-01)"`. Записать в CHANGELOG как самостоятельное решение (перенос между вехами).

### 4.5 Код систем (L2-06)

`specs/runtime/sdk.md`, новый §1.1:
```
tsconfig.system (packages/build/tsconfig.system.json, его же использует G0-TS-01):
{ strict: true, module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", jsxImportSource: "@wizard/sdk",
  noEmit: true, types: [], paths: {"@wizard/sdk": [sdk.d.ts], "@wizard/ui-kit": [ui-kit.d.ts]} }
@wizard/sdk экспортирует ./jsx-runtime (реэкспорт react/jsx-runtime); G0-IMP-01 считает его частью @wizard/sdk.
packages/sdk поставляет рукописный src/sdk.d.ts = §5 (G0 компилирует против него, а не против исходников).
```

## 5. Задачи: изменённые и новые (YAML для `specs/backlog.yaml`)

Изменения в существующих задачах (показаны только изменённые поля):
```yaml
  - id: M0-06
    specs: [specs/security/data-boundary.yaml, specs/agents/models.yaml, "specs/quality/eval.yaml#fixtures"]
    acceptance:
      - "Тест: callType из pii_forbidden_for_T1.always и import_mapping без containsPiiHint=false никогда не маршрутизируются в T1; при orgPolicy.ruOnly=true или региональном ограничении провайдера всё идёт в T0"
      - "Тест: перед отправкой в T1 сообщения проходят pii.scrub; найденные ПДн логируются только счётчиком категорий"
      - "Fixture-провайдер: suite=demo — по (callType, порядковый номер), suite=eval|unit — по sha256 канонического запроса (eval.yaml#fixtures); FIXTURE_MISS без сети; режим record дописывает tools/fixtures/<suite>/<name>.jsonl"
      - "Тест на локальном HTTP-сервере-заглушке: тело запроса с tools не содержит включённого thinking и response_format"
      - "UsageSink (architecture.yaml#interfaces.usage_sink), по умолчанию .data/usage.jsonl"

  - id: M0-07
    specs: [specs/runtime/sdk.md, "specs/appspec/appspec.schema.json"]
    acceptance:
      - "tsc --noEmit с tsconfig.system на specs/runtime/examples/functions против generateTypes(forum.json) проходит; ctx.db.ticket.list({where:{status:'paid'}}) без индекса — ошибка tsc (test-d)"
      - "packages/sdk/src/sdk.d.ts соответствует sdk.md §5; contract.test-d.ts покрывает каждый экспорт"
      - "@wizard/sdk/codegen реэкспортирует generateTypes из @wizard/appspec; снапшот для forum.json"
      - "Клиентские хуки против локального hono-мока: загрузка, ошибка с code, перезапрос по SSE invalidate"

  - id: M0-08
    title: "packages/ui-kit: основа — токены (themeToTokens/applyTokens), a11y-примитивы Button/Badge/Field, AppShell, DataSource + createMemoryDataSource, экспорт типов пропсов ВСЕХ компонентов M0 (реализации — заглушки для M0-25)"
    deps: [M0-02]
    specs: ["specs/ui/ui-kit.yaml#scope", "specs/ui/ui-kit.yaml#tokens", "specs/ui/ui-kit.yaml#a11y", "specs/ui/ui-kit.yaml#responsive", "specs/ui/ui-kit.yaml#data_binding", "specs/ui/ui-kit.yaml#states", "specs/ui/ui-kit.yaml#components.AppShell"]
    estimate_days: 1.5
    acceptance:
      - "ui-kit.yaml#tokens.acceptance (vitest контраста 16³, детерминизм themeToTokens, Playwright applyTokens < 50 мс, dark)"
      - "packages/ui-kit/src/index.ts экспортирует все компоненты scope.M0 с типами пропсов по спеке; tsc проходит"
      - "demo собирается из demo/stories/*.tsx (glob), одна история на компонент"

  - id: M0-09
    title: "apps/runtime (ядро): хост-маршрутизация, FileRegistry, загрузка LoadedSystem, data API (CRUD, фильтры, пагинация) с правами + контекст RLS, dev-login, /_wizard/health, /_wizard/spec (RoleSpec); createRuntimeApp"
    deps: [M0-04, M0-07]
    specs: ["specs/runtime/runtime.yaml#routing", "specs/runtime/runtime.yaml#system_loading", "specs/runtime/runtime.yaml#postgres", "specs/runtime/runtime.yaml#data_api", "specs/runtime/runtime.yaml#permissions", "specs/runtime/runtime.yaml#auth.dev_login_M0", "specs/runtime/runtime.yaml#service_endpoints", "specs/architecture.yaml#interfaces"]
    estimate_days: 2.5
    acceptance:
      - "Матрица role×entity×op для форума (генерируется из permissions) даёт ожидаемые 200/201/403/404 через createRuntimeApp().fetch"
      - "RLS: прямой SELECT под wizard_runtime с контекстом роли без read → 0 строк"
      - "Две системы на разных *.localhost-хостах не видят данных друг друга"
      - "Модуль apps/runtime/src/data/access.ts (DataAccess) экспортирован; маршруты /api/fn, /api/events, /_wizard/qr, статика смонтированы из src/routes/{fn,events,qr,static}.ts (заглушки 501) — их реализуют M0-23 и M0-24"

  - id: M0-10
    deps: [M0-04, M0-07, M0-08, M0-20]
    specs: ["specs/quality/gates.yaml#report", "specs/quality/gates.yaml#G0", "specs/agents/builder.yaml#code_conventions", "specs/runtime/sdk.md", "specs/architecture.yaml#interfaces.gate_context"]
    estimate_days: 2
    acceptance:
      - "Каждая blocker-проверка G0 имеет положительную и отрицательную фикстуру в packages/gates/test/fixtures/<checkId>/; warning-проверки — since: M1"
      - "runGates('G0') на форуме (forum.json + specs/runtime/examples) → passed; отчёт по gates.yaml#report"
      - "Время G0 на форуме записывается в отчёт; тест падает при > 60 с (цель ≤ 20 с — мягкая)"

  - id: M0-11
    deps: [M0-09, M0-10, M0-23]
    specs: ["specs/quality/gates.yaml#G1", "specs/quality/gates.yaml#scenario_dsl", "specs/agents/qa.yaml#seed", "specs/agents/qa.yaml#checks.permission_auto", "specs/architecture.yaml#interfaces"]
    estimate_days: 2
    acceptance:
      - "gates.generateSeed(spec, key) детерминирован и проходит DLP (qa.yaml#seed)"
      - "На форуме: AC1–AC4, AC7 → pass; AC5, AC6 → skip (milestone); G1-AC-COVER pass"
      - "Намеренно сломанная спека (участнику открыт read ticket без rowFilter) проваливает ровно PC-participant-ticket-row и SC-AC… из списка ожиданий теста"
      - "После набора тестов count(schemas like 'app_%_g1_%') = 0"

  - id: M0-12
    deps: [M0-06, M0-21]
    specs: [specs/agents/orchestrator.yaml, "specs/agents/models.yaml#call_policy", "specs/architecture.yaml#interfaces"]
    estimate_days: 2
    acceptance:
      - "Fixture demo/forum: бриф → 3–7 вопросов, у каждого 2–4 варианта и ровно один recommended; forkId ∈ fork_taxonomy"
      - "Карточка валидна по SystemCard; credits.expected ∈ [12, 35]; табличный тест state_machine"
      - "packages/agents/src/core (tool-loop, zod→JSON Schema, события) экспортирован как @wizard/agents/core"

  - id: M0-13
    deps: [M0-10, M0-12, M0-21]
    specs: [specs/agents/builder.yaml, "specs/agents/models.yaml#call_policy", "specs/platform/workflows.yaml#events", "specs/architecture.yaml#interfaces.agent_host"]
    estimate_days: 3
    acceptance:
      - "runBuild(host) на demo/forum и demo/bakery доходит до G0=passed без вмешательства (G1/QA в host — фейки)"
      - "cap=1 → budget_exceeded до превышения; 5 провалов typecheck подряд → needs_user с 4 кнопками, 6-го LLM-вызова нет"
      - "Инструменты — zod-схемы; ошибки инструментов возвращаются модели структурно"

  - id: M0-14
    acceptance:
      - "На золотой ревизии форума: ≥1 SC-проверка на каждый AC scenario/constraint с milestone ≤ M0 (AC1–AC4), все pass в G1; PC-проверки из permission AC (AC7) — pass"
      - "Фикстура с открытым delete у участника → Explanation {category: permission_too_broad, fix.kind: ops}"
      - "Повторный G1 без изменения AC не вызывает LLM (кеш determinism)"

  - id: M0-15
    title: "apps/platform-api: миграции M0-таблиц, API M0, in-process очередь с runStep, SSE событий, блокировка; агенты — через agent_host (в тестах фейки)"
    deps: [M0-03, M0-20]
    specs: ["specs/platform/api.yaml (slice --milestone M0)", "specs/platform/workflows.yaml#execution", "specs/platform/workflows.yaml#run_lifecycle", "specs/platform/workflows.yaml#system_stage", "specs/platform/workflows.yaml#events", "specs/platform/db.yaml (slice --milestone M0)", "specs/architecture.yaml#interfaces"]
    estimate_days: 3
    acceptance:
      - "Контрактный тест (ajv по components.schemas) на все операции x-milestone=M0"
      - "Колонки M0-таблиц после migrate совпадают с db.yaml (тест парсит YAML)"
      - "Прогон с фейковым builder эмитит события, валидные по workflows.yaml#events, и они доходят по SSE; рестарт → WORKER_RESTARTED"

  - id: M0-16
    deps: [M0-08]
    specs: ["specs/ui/platform-screens.yaml (slice --milestone M0)", "specs/ui/ui-kit.yaml#tokens", "specs/platform/api.yaml (slice --milestone M0)", "specs/platform/workflows.yaml#events"]
    estimate_days: 3.5
    acceptance:
      - "Экраны S1–S6: все test_ids из platform-screens.yaml присутствуют; Playwright против мок-API (msw или hono) и записанной ленты событий"
      - "Изменение токена в «Стиле» отражается в превью-заглушке через postMessage apply-theme-tokens без перезагрузки iframe"
      - "Мост: сообщения с чужим origin/source отбрасываются (vitest)"

  - id: M0-17
    deps: [M0-16, M0-26, M0-27]
    estimate_days: 1.5
    acceptance:
      - "`pnpm e2e` (fixture demo/forum) без сети к LLM: S1 → «Остальное по рекомендации» → «Строить» → G0 и G1 passed → превью → смена акцента → участник регистрируется с согласием → QrTicket → волонтёр сканирует: ok, повтор: duplicate"
      - "README: раздел «Запуск прототипа» с 3 командами"

  - id: M0-18
    acceptance:
      - "CI: `node tools/eval/run.mjs --harness --llm-mode=fixture --briefs=ev-01-forum-registration` выдаёт таблицу {g0_pass, g0g1_pass, tokens, ₽, мин}"
      - "Live (после E-ACCESS, вручную): отчёт tools/eval/results/<дата>-harness.md закоммичен; ≥1 из 12 брифов G0=passed"
      - "Брифы переименованы cg-* → gd-* (eval.yaml#briefs.format)"
```

Новые задачи:
```yaml
  - id: M0-19
    title: "tools/specs/slice.mjs + якорные списки чтения в backlog + процесс (status/claimed_by, .gitattributes, AGENTS.md)"
    milestone: M0
    deps: []
    specs: [specs/README.md, AGENTS.md, specs/backlog.yaml]
    owner: docs
    parallel_group: m0-w0
    estimate_days: 0.5
    acceptance:
      - "`node tools/specs/slice.mjs <file>[#a.b] [--milestone M0]` печатает поддерево; для api.yaml оставляет операции x-milestone ≤ M0 и транзитивно нужные components.schemas; для db.yaml/ui-kit.yaml/platform-screens.yaml — элементы с milestone ≤ M0"
      - "`node tools/specs/slice.mjs --task M0-15` печатает объединение specs задачи; объём ≤ 50% полного текста файлов"
      - "validate.mjs проверяет, что якоря в backlog.specs существуют"

  - id: M0-20
    title: "packages/build: esbuild-сборка системы (ui + functions), плагин wz-id, wz-map.json, tsconfig.system, writeArtifact"
    milestone: M0
    deps: [M0-02]
    specs: ["specs/architecture.yaml#interfaces.build_system", "specs/runtime/sdk.md", "specs/ui/ui-kit.yaml#wz_id", "specs/runtime/runtime.yaml#system_loading", "specs/runtime/runtime.yaml#static"]
    owner: platform
    parallel_group: m0-w0
    estimate_days: 1.5
    acceptance:
      - "Сборка форума (forum.json + specs/runtime/examples) → раскладка .data/artifacts/<id>/<rev>/…; manifest.json содержит specHash и bundleKey"
      - "wzId стабилен: повторная сборка того же исходника даёт идентичный wz-map.json; правка другого файла не меняет wzId в этом"
      - "env=prod: в бандле нет wz-map.json и bridge.js; сборка без сети"

  - id: M0-21
    title: "Золотые фикстуры demo/forum: tools/fixtures/gen-golden.mjs, specToOps, golden/forum.yaml (Analysis, ответы, карточка, план, сценарии QA)"
    milestone: M0
    deps: [M0-03]
    specs: ["specs/quality/eval.yaml#fixtures", "specs/agents/orchestrator.yaml#schemas", "specs/agents/orchestrator.yaml#system_card", "specs/agents/builder.yaml#tools", "specs/agents/qa.yaml#checks", specs/appspec/ops.yaml]
    owner: qa
    parallel_group: m0-w1
    estimate_days: 1.5
    acceptance:
      - "specToOps(forum.json) + applyOps на emptySpec → спека, эквивалентная forum.json (deep-equal без порядка)"
      - "gen-golden forum детерминирован (два запуска — байт-в-байт); фикстуры проходят pii.detect = 0 и поиск секретов = 0"
      - "Порядок callType в demo/forum.jsonl: interview, interview, card, plan, build_ops×N, build_code×M, qa_generate"

  - id: M0-22
    title: "Пример «кондитерская»: specs/runtime/examples/bakery/{functions,ui} (calcPrice, freeSlots, placeOrder, 4 страницы) + golden/bakery.yaml + demo/bakery.jsonl"
    milestone: M0
    deps: [M0-07, M0-08, M0-21]
    specs: [specs/appspec/examples/bakery.json, specs/runtime/sdk.md, "specs/ui/platform-screens.yaml#screens.S9"]
    owner: frontend
    parallel_group: m0-w2
    estimate_days: 1
    acceptance:
      - "tsc (tsconfig.system) на examples/bakery против generateTypes(bakery.json) проходит"
      - "gen-golden bakery детерминирован"

  - id: M0-23
    title: "apps/runtime: функции — node:vm в worker_threads (WIZARD_UNSAFE_LOCAL_EXEC), ctx.db/systemDb поверх DataAccess, лимиты, SERIALIZABLE с повторами, scheduler → _w_jobs (без исполнения), /api/fn"
    milestone: M0
    deps: [M0-09, M0-20]
    specs: ["specs/runtime/runtime.yaml#functions", "specs/runtime/sdk.md", "specs/architecture.yaml#interfaces.runtime_handle"]
    owner: platform
    parallel_group: m0-w2
    estimate_days: 2
    acceptance:
      - "Функции из specs/runtime/examples вызываются через /api/fn; fetch недоступен; бесконечный цикл прерывается ≤ 5 с"
      - "20 параллельных registerTicket при capacity=5 → ровно 5 билетов"
      - "query через ctx.db от participant не видит чужих билетов, через ctx.systemDb — видит; 4001 чтение → LIMIT_EXCEEDED"

  - id: M0-24
    title: "apps/runtime: превью — статика бандлов, /_wizard/bridge.js (preview_contract), SSE /api/events (in-process), QR online (/_wizard/qr/check, выдача qr_token), CONSENT_REQUIRED минимально"
    milestone: M0
    deps: [M0-09, M0-20]
    specs: ["specs/runtime/runtime.yaml#static", "specs/runtime/runtime.yaml#realtime", "specs/ui/platform-screens.yaml#preview_contract", "specs/connectors/qr.yaml#token", "specs/connectors/qr.yaml#endpoints", "specs/connectors/qr.yaml#checkin_algorithm"]
    owner: platform
    parallel_group: m0-w2
    estimate_days: 1.5
    acceptance:
      - "Бандл форума отдаётся на http://<slug>--draft.localhost:4100; bridge.js: set-role, apply-theme-tokens, чужой origin игнорируется"
      - "Создание билета: организатор получает invalidate с id, другой участник — без id, посетитель — ничего"
      - "AC4 форума через HTTP: второй check того же payload → duplicate; 20 параллельных check → ровно один ok"

  - id: M0-25
    title: "packages/ui-kit: компоненты M0 — Catalog, ItemCard, RecordForm, DataTable, RecordCard, StatusBoard, QrTicket, QrScanner(online), CabinetLayout, StatsReport; sdkDataSource; демо"
    milestone: M0
    deps: [M0-08]
    specs: ["specs/ui/ui-kit.yaml#components (slice --milestone M0)", "specs/ui/ui-kit.yaml#states", "specs/ui/ui-kit.yaml#wz_id", "specs/runtime/sdk.md"]
    owner: frontend
    parallel_group: m0-w1
    estimate_days: 2.5
    acceptance:
      - "Каждый компонент — acceptance из своего раздела ui-kit.yaml (Playwright на демо «форум»/«кондитерская» через createMemoryDataSource)"
      - "Скриншоты 1280 и 390 px, light/dark, scrollWidth ≤ innerWidth"
      - "tsc на specs/runtime/examples/ui против типов ui-kit и generateTypes(forum.json) проходит"

  - id: M0-26
    title: "Интеграция: platform-api ← orchestrator/builder/QA/gates/build/runtime (agent_host, DbRegistry, migrate_draft, seed_draft, bundle_and_reload); золотые прогоны форума и кондитерской"
    milestone: M0
    deps: [M0-12, M0-13, M0-14, M0-15, M0-23, M0-24]
    specs: ["specs/platform/workflows.yaml#workflows.interview_turn", "specs/platform/workflows.yaml#workflows.build", "specs/platform/workflows.yaml#events", "specs/architecture.yaml#interfaces"]
    owner: platform
    parallel_group: m0-w5
    estimate_days: 1.5
    acceptance:
      - "Fixture demo/forum через API: POST /systems → answers → approve → run_finished succeeded; G0 и G1 passed; каждое событие валидно по workflows.yaml#events (ajv)"
      - "После прогона draft-схема содержит seed и dev-пользователей; /_wizard/health отдаёт revision = preview_revision"
      - "demo/bakery доходит до G0=passed; журнал usage: ни одной T1-записи с callType из pii_forbidden_for_T1.always"

  - id: M0-27
    title: "e2e и dev-оркестрация: пакет e2e (@wizard/e2e, Playwright), scripts/dev.mjs (db:up, tsx apps, vite, ожидание health), dev-скрипты apps, CI-джоб e2e"
    milestone: M0
    deps: [M0-01]
    specs: [AGENTS.md, "specs/architecture.yaml#stack", "specs/milestones.yaml"]
    owner: platform
    parallel_group: m0-w0
    estimate_days: 1
    acceptance:
      - "`pnpm dev` поднимает заглушки platform-api :4000, runtime :4100, platform-web :5173 и ждёт их health; Ctrl-C гасит всё"
      - "`pnpm e2e` запускает smoke-тест Playwright (chromium из PLAYWRIGHT_BROWSERS_PATH или установленный в CI)"
      - "CI: отдельный джоб e2e с `playwright install --with-deps chromium`; артефакты — отчёт и скриншоты"
```
Итоговый список задач M0 с `parallel_group`: `m0-w0` = {02–04 (в работе), 05, 07, 08, 19, 20, 27}; `m0-w1` = {06, 09, 10, 15, 16, 21, 25}; `m0-w2` = {12, 22, 23, 24}; `m0-w3` = {11, 13, 18}; `m0-w4` = {14}; `m0-w5` = {26}; `m0-w6` = {17}. Внутри каждой волны задачи правят разные каталоги; общие точки (index.ts пакетов, маршруты runtime) разведены в L2-19.

## 6. Экономия токенов: объём чтения на задачу

«Сейчас» — это обязательная база (`AGENTS.md`, `product.yaml`, `architecture.yaml`, 20,6 тыс. символов) плюс `specs:` задачи плюс спеки, которые нужны неявно. Токены посчитаны грубо: 1 токен ≈ 3 символа.

| Задача | Сейчас: строк / ≈ токенов | После L2-23: список чтения | ≈ токенов |
|---|---|---|---|
| M0-05 | 395 / 13k | data-boundary.yaml#categories,#detectors,#scrub,#tests | 6k |
| M0-06 | 630 / 23k | data-boundary#routing,#call_types; models.yaml (без #usage_record.storage); eval#fixtures | 15k |
| M0-07 | 830 / 20k | sdk.md; appspec schema — только через `src/schema.ts` appspec | 14k |
| M0-08 | 1 600 / 35k | см. §5 (якоря) | 12k |
| M0-09 (старая) | 920 / 40k | делится на M0-09, M0-23, M0-24 по 12–15k | 3 × 14k |
| M0-10 | 480 / 16k | gates#report,#G0; builder#code_conventions; sdk.md §1, §4 | 11k |
| M0-11 | 920 / 25k | gates#G1,#scenario_dsl; qa#seed,#checks; forum.json#/acceptance | 12k |
| M0-12 | 665 / 25k | orchestrator.yaml; models#call_policy | 16k |
| M0-13 | 740 / 25k | builder.yaml; models#call_policy; workflows#events; interfaces.agent_host | 17k |
| M0-15 | 1 530 / 40k | api.yaml и db.yaml по срезу M0 (19k + 8k символов); workflows без M1-воркфлоу | 18k |
| M0-16 | 1 000 + HTML / ≈ 75k | platform-screens по срезу M0; ui-kit#tokens; api по срезу M0; без HTML | 22k |

Дополнительно:
- В `AGENTS.md` п.2 заменить «прочитай product.yaml, architecture.yaml» на «прочитай `product.yaml#decisions,#non_goals` и `architecture.yaml#stack,#interfaces,#monorepo`». Это экономит около 3 тыс. токенов на задачу, на 27 задачах M0 около 80 тыс.
- Правило DoD для каждого пакета: публичный API — это `src/index.ts` с однострочными JSDoc. Агенты следующих задач читают только его, а не исходники. Добавить в AGENTS.md одной строкой.
- Инструменты строителя `get_ui_kit_docs` и `get_sdk_docs` (продукт) должны отдавать фрагменты через тот же `slice.mjs`, собранный в `packages/agents/assets` на этапе build. Тогда не нужно держать вторую копию документации.
