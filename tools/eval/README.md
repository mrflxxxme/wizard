# Eval-стенд: бриф → AppSpec и бриф → система

Нормативно: `specs/quality/eval.yaml`. Два режима:

- **spec_only** (по умолчанию) — по брифу на русском один вызов модели собирает черновик AppSpec. Ответ проверяется по `specs/appspec/appspec.schema.json`, своей схемы у стенда нет. Так сравниваются модели между собой. Первый вопрос недели 0: **GLM-5.1 в контуре Cloud.ru (T0) против GLM-5.3 от Z.ai (T1)**. Node 22, без зависимостей и без сборки.
- **замер D67 на сервере** (`tools/eval/server/`, брифы `mvp-*`) — те же брифы, что пишет клиент в кабинете, проходят настоящий конвейер сервера пилота через его API. Запуск — `bootstrap-pilot → eval`, подробности в [docs/ops/eval-d67.md](../../docs/ops/eval-d67.md).
- **замер v3 на сервере** (`tools/eval/server/v3.mjs`, брифы `v3-*`, V3-18) — путь v3 владельца: грилл-интервью, ТЗ файлом, направления, «Собрать», сборка по снимкам хода, G0–G2; отчёт чекпоинта `v3-a-checkpoint1-<дата>`. Там же проба маршрутов v3 (`probe.mjs`, ≤ 30 ₽). Запуск — `eval-pilot` (порог `v3`) и `v3-probe`, подробности в [docs/ops/eval-pilot.md](../../docs/ops/eval-pilot.md).
- **harness** (`--harness`) — полный путь продукта: оркестратор (`@wizard/agents/orchestrator`) → карточка → строитель (`@wizard/agents/builder`, memory-host) → G0 → QA (`@wizard/agents/qa`) → G1 на настоящем `apps/runtime`. G2 до M2 не запускается. TypeScript-пакеты грузятся через `tsx` из workspace, нужны `pnpm install` и Postgres (`pnpm db:up`, `DATABASE_URL`).

## Harness

```bash
# CI (каждый PR): без сети, по записанной фикстуре
node tools/eval/run.mjs --harness --llm-mode=fixture --briefs=ev-01-forum-registration
# механика и pii_leaks на всех брифах: бриф без своей фикстуры проигрывает демо-фикстуру своего сегмента
node tools/eval/run.mjs --harness --llm-mode=fixture --dry-run
# live, вручную (ключи в .env; G1 исполняет сгенерированный код → только локально)
WIZARD_UNSAFE_LOCAL_EXEC=1 node tools/eval/run.mjs --harness --llm-mode=live --models=glm-5.3,glm-5.1
```

| Флаг | Значение |
|---|---|
| `--llm-mode=fixture\|live\|record` | по умолчанию `WIZARD_LLM_MODE`, иначе `fixture`. `record` пишет `tools/fixtures/eval/<briefId>.jsonl` |
| `--models=a,b` | id из `specs/agents/models.yaml#models`: модель ставится первой в цепочку plan/build_ops/build_code/fix, её уровень становится уровнем сборки. Роутер и границы ПДн работают как в продукте. Без флага используется модель по умолчанию |
| `--briefs=id1,id2` | подмножество брифов |
| `--dry-run` | только с `fixture`. Бриф без своей фикстуры проигрывает демо-сценарий своего сегмента (ev, hz → forum, gd → bakery) с добавленными предложениями-канарейками. Так проверяется механика и `pii_leaks`, а не качество |
| `--out=dir` | куда писать результаты (по умолчанию `tools/eval/results`) |
| `--gates=G0` | G1 заменяется заглушкой: сгенерированный код не исполняется, `WIZARD_UNSAFE_LOCAL_EXEC` не нужен, `g0g1_pass` не измеряется («—»). Так работает live в CI |
| `--max-cost-rub=N` | бюджет прогона: когда расход достигает N ₽, новые брифы не стартуют (`skipped`) |
| `--baseline=path\|none` | с чем сравнивать доли `g0_pass`/`g0g1_pass` (по умолчанию `tools/eval/baseline.json`). Падение больше чем на 5 п. п. даёт код выхода 1 |
| `--preflight` | только проверить опции. Код 3 — нет ключей провайдеров (печатаются имена переменных), 0 — можно запускать |

CI, бюджет live-прогонов, журнал расходов и baseline описаны в [docs/ops/eval.md](../../docs/ops/eval.md) (`tools/eval/ci.mjs`).

Какая фикстура проигрывается: сначала своя `tools/fixtures/eval/<briefId>.jsonl`, иначе демо (`ev-01` → `demo/forum`, `gd-01` → `demo/bakery`). Демо-сценарий идёт со своим брифом и ответами из `tools/fixtures/golden/<name>.yaml`, потому что вопросы оркестратора зависят от текста. Бриф без фикстуры в режиме `fixture` пропускается (`skipped`), это не провал.

Ответы на вопросы берутся из `answers` брифа, остальное решается «по рекомендациям». Эскалации строителя получают автоответ: первый раз retry, затем rollback. G1 видит поля compliance, которые заполняют владелец и платформа (синтетический оператор и текст согласия, `harness/qa.ts`).

Результаты: `results/<YYYY-MM-DD>-harness.{json,md}` для live (коммитятся, это отчёт для вехи и baseline) и `results/<stamp>-harness-fixture|-record|-dry.{json,md}` для остальных режимов (в git не попадают). В таблице по брифам есть `g0_pass`, `g0g1_pass`, `tokens`, `₽`, `мин` и `до превью, мин`, в сводной по моделям ещё `coverage`, `credits`, вопросы, `pii_leaks`, **p80 времени сборки** (`minutes_p80`: от брифа до финального гейта) и **время до первого превью** (среднее и `first_preview_minutes_p80`: до первой ревизии с G0 passed; брифы, не дошедшие до превью, считаются отдельно). p80 — 80-й перцентиль по рангу. Те же агрегаты лежат в JSON (`aggregates`). Цели M2 (`eval.yaml#thresholds.by_milestone.M2`: p80 ≤ 30 и ≤ 10 мин) проверяются только для live и попадают в отчёт предупреждением; в fixture время не показательно. Метрики — `eval.yaml#metrics`. JSON читает `week0.mjs`: `valid` = `g0_pass`, `attempts` = номер прогона G0, на котором он впервые прошёл, `score` = покрытие ожиданий по финальной спеке.

Код выхода 1, если нарушен жёсткий порог (`eval.yaml#thresholds.hard`): `pii_leaks > 0`, `FIXTURE_MISS`, демо-фикстура не дошла до G0+G1 или доля `g0_pass`/`g0g1_pass` упала больше чем на 5 п. п. к baseline (`eval.yaml#regression`).

### pii_leaks

Метрика не зависит от детектора `packages/pii`. Она складывается из двух частей:

1. Точные вхождения значений `canaries` брифа в исходящих T1-payload: без учёта регистра, телефон ещё и по цифрам без разделителей.
2. T1-вызовы с callType из `models.yaml#pii_forbidden_for_T1.always`.

В live и record запросы перехватываются обёрткой `fetch` роутера: всё, что уходит не на хост T0-провайдера, считается T1. В fixture HTTP нет, поэтому проверяется то, что роутер отправил бы на T1 при том же решении `decideTier`: scrubbed-сообщения и инструменты. Payload проверяется в памяти и не сохраняется. В spec_only scrub нет, поэтому брифы с канарейками на T1 не отправляются.

## Быстрый старт

```bash
# без сети, на заглушке — проверить, что стенд работает
node tools/eval/run.mjs --dry-run

# боевой прогон: модели с "enabled": true из models.json (по умолчанию glm-5.1 и glm-5.3)
export CLOUDRU_API_KEY=...        # ключ сервисного аккаунта Cloud.ru Foundation Models
export ZAI_API_KEY=...            # ключ Z.ai
node tools/eval/run.mjs
```

Итог печатается markdown-таблицей. Полные данные (спеки, ошибки, токены, латентность) лежат в `tools/eval/results/<timestamp>-spec_only.json`, таблица — рядом в `.md`. В git они не попадают.

## Переменные окружения

| Переменная | Зачем | По умолчанию |
|---|---|---|
| `CLOUDRU_API_KEY` | ключ Cloud.ru FM (`Authorization: Bearer`) | — |
| `CLOUDRU_BASE_URL` | OpenAI-совместимый base URL | `https://foundation-models.api.cloud.ru/v1` |
| `ZAI_API_KEY` | ключ Z.ai | — |
| `ZAI_BASE_URL` | OpenAI-совместимый base URL | `https://api.z.ai/api/paas/v4` |
| `DEEPSEEK_API_KEY` | ключ DeepSeek API (необязательно, только для претендентов `deepseek-*`) | — |
| `DEEPSEEK_BASE_URL` | OpenAI-совместимый base URL | `https://api.deepseek.com` |

Запрос идёт на `<BASE_URL>/chat/completions`. Ключ нужен только для провайдеров выбранных моделей.

## Флаги

| Флаг | Значение |
|---|---|
| `--dry-run` | без сети: ответы из `lib/stub.mjs`. Каждый третий бриф сначала отвечает битым JSON, чтобы проверить цикл ретраев |
| `--models=a,b` / `--models=all` | какие модели гонять (id из `models.json`) |
| `--briefs=id1,id2` | подмножество брифов |
| `--mode=tools` / `--mode=json` | вызов инструмента `submit_app_spec` (по умолчанию) или JSON в тексте ответа |
| `--response-format=none\|json_object\|json_schema` | для `--mode=json`: как просить JSON у API. `json_schema` проверяет, насколько строго провайдер держит схему. Строгость задаётся `json_schema_strict` в `models.json` |
| `--max-retries=2` | сколько раз переспрашивать при невалидном ответе; ошибки валидации уходят модели обратно |
| `--concurrency=2` | параллельных запросов |
| `--config=path` | другой файл моделей |

## Модели и цены — `models.json`

Каждая модель: `id` (те же id, что в каталоге `specs/agents/models.yaml`; `ext-glm-5.2` — только для eval), `tier` (T0/T1), `provider` (`cloudru`, `zai` или `deepseek`), `model` (id у провайдера), `price` (₽ за 1M токенов с НДС: `input`, `cached_input`, `output`), `extra_body` (добавляется в тело запроса). Можно переопределить `mode`, `response_format`, `tool_choice` (`auto`, `required`, `force`), `temperature`, `max_tokens`, `timeout_ms`.

- id моделей Cloud.ru взяты из [списка моделей](https://cloud.ru/docs/foundation-models/ug/topics/overview__available__models) (30.09.2026): `zai-org/GLM-5.1`, `moonshotai/Kimi-K2.6`, `deepseek-ai/DeepSeek-V4-Pro`, `Qwen/Qwen3-Coder-Next`. Все они внутренние, то есть работают в РФ.
- Z.ai: `glm-5.3`, base URL из [quick start](https://docs.z.ai/guides/overview/quick-start). Thinking выключен через `extra_body.thinking`.
- DeepSeek (T1, претендент, по умолчанию выключен): `deepseek-v4.1-flash` (`deepseek-flash`) и `deepseek-v4-pro-0813` (`deepseek-v4-pro`), запуск `--models=deepseek-v4.1-flash`. Thinking у DeepSeek включён по умолчанию, поэтому `extra_body.thinking` выключает его в каждом запросе. Цены — часов пик ([docs/founder/models-research.md](../../docs/founder/models-research.md) §2).
- Как выключить thinking у моделей Cloud.ru, не проверено **[?]**. Если латентность и выходные токены GLM-5.1 заметно выше ожидаемых, попробуйте `"extra_body": {"chat_template_kwargs": {"enable_thinking": false}}`.
- Цены проверяйте перед прогоном. Cloud.ru — тарифы от 28.09.2026. Z.ai — $1.4 / $0.26 кэш / $4.4 за 1M при курсе 95 ₽/$ плюс 22% НДС, который Wizard платит как налоговый агент.

## Что считается

| Метрика | Как |
|---|---|
| **Валидно** | JSON разобран и проходит `specs/appspec/appspec.schema.json` (валидатор JSON Schema из `tools/specs/validate.mjs`), плюс согласованность: права, страницы и критерии ссылаются на существующие роли и сущности, у `ref` есть существующая сущность, у `enum` есть варианты |
| **Попыток** | 1 — ответ валиден с первого раза. Больше 1 — понадобились ретраи |
| **Скор** | 0.2 · роли + 0.3 · сущности + 0.3 · фичи + 0.2 · приёмка, считается только для валидных ответов |
| Роли / сущности | доля ожидаемых, найденных в `roles[]` и `entities[]` (id, имя, подпись) |
| Фичи | доля `must_have_features`, найденных где угодно в спеке |
| Приёмка | доля `acceptance_criteria`, найденных в `acceptance[]` и `workflows[]` |
| Латентность | сумма по попыткам, отдельно первая попытка (в JSON) |
| Токены, ₽ | из `usage`: вход, кэш (`prompt_tokens_details.cached_tokens`), выход, по таблице цен |

Сопоставление нечёткое: подстрока в нижнем регистре, ё→е. Ожидание записывается как `"Подпись :: стем1|стем2|stem3"`. Паттерны — основы слов на русском и английском, потому что модели называют сущности латиницей. Не ставьте в паттерн голые числа и слишком короткие основы: они совпадут с чем угодно.

**Скор — это грубый фильтр, а не оценка качества.** Он ловит пропущенные роли и сущности, но не проверяет, что права разумны. Поэтому 3–5 спек каждой модели нужно прочитать глазами: они лежат в `runs[].spec`.

## Брифы — `briefs/*.json`

Набор M2 (`M2-12`): 30 брифов — 9 по B2B-ивентам (`ev-*`), 8 по товарам на заказ (`gd-*`), 13 горизонтальных (`hz-*`, вне двух полигонов: салон красоты, ремонт техники, учебный центр, онбординг, склад, прокат, коворкинг, сервис-деск, фонд). В 9 брифах есть канарейки. Формат задаёт `eval.yaml#briefs.format`, проверку делают `lib/briefs.mjs` и `test/briefs.test.ts`:

```json
{ "id": "gd-01-...", "segment": "events|made_to_order|horizontal", "title": "...", "text": "бриф как от пользователя, 300–1500 символов",
  "answers": { "F-LOGIN": "email_or_telegram" },
  "canaries": ["Hiroshi Tanaka-Weller", "@procure_desk_ht"],
  "expected": { "roles": [], "entities": [], "must_have_features": [], "acceptance_criteria": [] } }
```

Брифы `v3-*` (V3-18, чекпоинт 1 v3) берутся только через `loadBriefs("v3")` или по id. Кроме полей выше у них есть:

- `class` — `site`, `booking`, `crm` или `shop` (D77 (12));
- `answers` — ответы по темам грилл-интервью: основа подписи варианта, `delegate`, `recommended` или `{text}`;
- `rest_after` — после скольких ответов нажимается «Дальше решай сам»;
- `tz` — файл ТЗ `{format: md|txt, text}`;
- `direction` — `1`, `2`, `3` или `delegate`.

`canaries` — синтетические ПДн, вставленные в `text`: ФИО латиницей, @handle, телефон не РФ. Другие ПДн в брифах запрещены: `packages/pii` не должен найти в `text` ничего, кроме канареек и значений из `pii-allowlist.txt` (тест). `expected` не меняется в одном PR с промптами.

Еженедельный (или ночной) smoke берёт 5 брифов по ротации `lib/rotation.mjs`: каждый раз сначала выполняются условия (≥ 1 ev, gd, hz и ≥ 1 бриф с канарейками), остальные места получают брифы, которые дольше всех не запускались. Так подряд идущие прогоны покрывают весь набор за ⌈N/5⌉ запусков (30 брифов — за 6). Для недельного периода передайте `periodDays = 7`: тогда подмножество одно на всю ISO-неделю.

### Брифы дизайн-партнёров (`partner-brief.mjs`)

По `eval.yaml#briefs.set` в наборе должно быть по 3 брифа от каждого дизайн-партнёра. В репозитории лежит только **синтетический пересказ**: свои формулировки, без ФИО, телефонов, почт, адресов и названий реальных клиентов, при необходимости с канарейками. Оригинал хранится в бакете S3 eval в РФ под ключом `eval/partners/<P01…P99>/<id брифа>.<ext>` (L3-07). В брифе остаётся только ссылка на него:

```json
"partner": { "ref": "P01", "original": { "key": "eval/partners/P01/hz-14-….txt", "sha256": "…", "bytes": 1234 } }
```

`ref` — псевдоним партнёра. Соответствие псевдонима и компании основатель хранит вне репозитория.

```bash
# 1. написать пересказ tools/eval/briefs/<id>.json (без блока partner); 2. загрузить оригинал из каталога вне репозитория:
node tools/eval/partner-brief.mjs upload ~/partners/p01-brief-2.txt --partner=P01 --brief=hz-14-…
# достать оригинал для сверки (по умолчанию во временный каталог ОС; после работы удалить):
node tools/eval/partner-brief.mjs fetch --brief=hz-14-… [--out=/вне/репозитория]
# проверка для CI (её же выполняет test/partner-brief.test.ts): ни один отслеживаемый файл не совпадает с оригиналом
node tools/eval/partner-brief.mjs check
```

Скрипт не пишет оригиналы в репозиторий. `upload` отказывает, если файл лежит внутри репозитория, если пересказа ещё нет, если пересказ совпадает с оригиналом, содержит дословный фрагмент из 12 слов или больше 30 % общих шестисловий (для текстовых оригиналов). `fetch` отказывает, если `--out` внутри репозитория, и сверяет sha256. Настройки — `EVAL_S3_BUCKET`, `EVAL_S3_ACCESS_KEY_ID`, `EVAL_S3_SECRET_ACCESS_KEY` (или `AWS_*`), `EVAL_S3_ENDPOINT` (по умолчанию Timeweb `https://s3.twcstorage.ru`), `EVAL_S3_REGION` (по умолчанию `ru-1`). Endpoint допускается только российский: https и домен `.ru` или `storage.yandexcloud.net`. Без настроек код выхода 3, печатаются только имена переменных. Запросы подписываются SigV4 на `node:crypto`, адресация path-style.

## Как читать результат для решения недели 0

Решение считает `week0.mjs` по правилу F2 (`product.yaml#decisions.D2_w0_fallback`):

```bash
node tools/eval/week0.mjs tools/eval/results/<timestamp>.json [ещё.json] [--zai-terms=unconfirmed]
```

Скрипт сравнивает GLM-5.3 с лучшей T0-моделью (по валидности с первой попытки, затем по скору) на общих брифах, пишет `tools/eval/results/week0.md` (единственный отчёт из `results/`, который попадает в git) и последней строкой печатает `WIZARD_BUILD_DEFAULT_TIER=T0|T1`.

- T1 остаётся по умолчанию, только если GLM-5.3 лучше лучшей T0-модели на ≥10 п. п. и по валидности с первой попытки, и по скору. Иначе — T0. T0 выбирается и тогда, когда Z.ai не подтвердил условия (`--zai-terms=unconfirmed`).
- Выбранное значение записывается в `WIZARD_BUILD_DEFAULT_TIER` (деплой), а в `specs/CHANGELOG.md` добавляется строка.
- Отдельно смотрите на `finish_reason: "length"` (ответ обрезан) и на долю ретраев: в агентном цикле это и есть скрытая стоимость.
