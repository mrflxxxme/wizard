# Eval-стенд: бриф → AppSpec и бриф → система

Нормативно: `specs/quality/eval.yaml`. Два режима:

- **spec_only** (по умолчанию) — по брифу на русском один вызов модели собирает черновик AppSpec. Ответ проверяется по `specs/appspec/appspec.schema.json`, своей схемы у стенда нет. Так сравниваются модели между собой. Первый вопрос недели 0: **GLM-5.1 в контуре Cloud.ru (T0) против GLM-5.3 от Z.ai (T1)**. Node 22, без зависимостей и без сборки.
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

Результаты: `results/<YYYY-MM-DD>-harness.{json,md}` для live (коммитятся, это отчёт для вехи и baseline) и `results/<stamp>-harness-fixture|-record|-dry.{json,md}` для остальных режимов (в git не попадают). В таблице по брифам есть `g0_pass`, `g0g1_pass`, `tokens`, `₽`, `мин`, в сводной по моделям ещё `coverage`, `credits`, вопросы и `pii_leaks`. Метрики — `eval.yaml#metrics`. JSON читает `week0.mjs`: `valid` = `g0_pass`, `attempts` = номер прогона G0, на котором он впервые прошёл, `score` = покрытие ожиданий по финальной спеке.

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

Каждая модель: `id` (те же id, что в каталоге `specs/agents/models.yaml`; `ext-glm-5.2` — только для eval), `tier` (T0/T1), `provider` (`cloudru` или `zai`), `model` (id у провайдера), `price` (₽ за 1M токенов с НДС: `input`, `cached_input`, `output`), `extra_body` (добавляется в тело запроса). Можно переопределить `mode`, `response_format`, `tool_choice` (`auto`, `required`, `force`), `temperature`, `max_tokens`, `timeout_ms`.

- id моделей Cloud.ru взяты из [списка моделей](https://cloud.ru/docs/foundation-models/ug/topics/overview__available__models) (30.09.2026): `zai-org/GLM-5.1`, `moonshotai/Kimi-K2.6`, `deepseek-ai/DeepSeek-V4-Pro`, `Qwen/Qwen3-Coder-Next`. Все они внутренние, то есть работают в РФ.
- Z.ai: `glm-5.3`, base URL из [quick start](https://docs.z.ai/guides/overview/quick-start). Thinking выключен через `extra_body.thinking`.
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

Набор M0: 6 по B2B-ивентам (`ev-*`), 4 по товарам на заказ (`gd-*`), 4 горизонтальных (`hz-*`). В 4 брифах есть канарейки. Формат задаёт `eval.yaml#briefs.format`, проверку делают `lib/briefs.mjs` и `test/briefs.test.ts`:

```json
{ "id": "gd-01-...", "segment": "events|made_to_order|horizontal", "title": "...", "text": "бриф как от пользователя, 300–1500 символов",
  "answers": { "F-LOGIN": "email_or_telegram" },
  "canaries": ["Hiroshi Tanaka-Weller", "@procure_desk_ht"],
  "expected": { "roles": [], "entities": [], "must_have_features": [], "acceptance_criteria": [] } }
```

`canaries` — синтетические ПДн, вставленные в `text`: ФИО латиницей, @handle, телефон не РФ. Другие ПДн в брифах запрещены: `packages/pii` не должен найти в `text` ничего, кроме канареек и значений из `pii-allowlist.txt` (тест). `expected` не меняется в одном PR с промптами.

По концепции к M2 нужно 30 брифов. Остальные добавим из брифов дизайн-партнёров, по 3 от каждого, в виде синтетических пересказов. Перед добавлением уберите из них ФИО, телефоны, почты, адреса и названия реальных клиентов.

## Как читать результат для решения недели 0

Решение считает `week0.mjs` по правилу F2 (`product.yaml#decisions.D2_w0_fallback`):

```bash
node tools/eval/week0.mjs tools/eval/results/<timestamp>.json [ещё.json] [--zai-terms=unconfirmed]
```

Скрипт сравнивает GLM-5.3 с лучшей T0-моделью (по валидности с первой попытки, затем по скору) на общих брифах, пишет `tools/eval/results/week0.md` (единственный отчёт из `results/`, который попадает в git) и последней строкой печатает `WIZARD_BUILD_DEFAULT_TIER=T0|T1`.

- T1 остаётся по умолчанию, только если GLM-5.3 лучше лучшей T0-модели на ≥10 п. п. и по валидности с первой попытки, и по скору. Иначе — T0. T0 выбирается и тогда, когда Z.ai не подтвердил условия (`--zai-terms=unconfirmed`).
- Выбранное значение записывается в `WIZARD_BUILD_DEFAULT_TIER` (деплой), а в `specs/CHANGELOG.md` добавляется строка.
- Отдельно смотрите на `finish_reason: "length"` (ответ обрезан) и на долю ретраев: в агентном цикле это и есть скрытая стоимость.
