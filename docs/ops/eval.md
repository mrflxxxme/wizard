# Eval в CI: fixture на каждом PR и live по расписанию

Нормативно: `specs/quality/eval.yaml` (`#modes.llm_mode`, `#live_cadence`, `#thresholds`, `#regression`), бюджет — `product.yaml#decisions.D20_eval_budget` (F6). Код: `tools/eval/`, workflow: `.github/workflows/eval.yml` и `.github/workflows/eval-live.yml`.

## Каждый PR: `eval.yml` (fixture, без сети и ключей)

| Шаг | Команда | Когда красный |
|---|---|---|
| Харнесс на фикстурах | `node tools/eval/run.mjs --harness --llm-mode=fixture` | `pii_leaks > 0`, `FIXTURE_MISS`, демо «форум» или «кондитерская» не дошли до G0+G1, доля `g0_pass` или `g0g1_pass` упала больше чем на 5 п. п. к `tools/eval/baseline.json` |
| Dry-run канареек | `node tools/eval/run.mjs --harness --llm-mode=fixture --dry-run` | `pii_leaks > 0` на любом брифе с канарейками |

Таблицы отчётов попадают в step summary, JSON и md — в артефакт `eval-fixture-report` (только fixture-прогоны, `eval.yaml#fixtures.rules`). Если PR меняет `packages/agents/src/**/prompts/**` или `specs/agents/models.yaml` без метки `eval:full`, CI выводит предупреждение (`eval.yaml#regression.pr_rule`).

## Ночью и по метке: `eval-live.yml`

| Прогон | Когда | Что |
|---|---|---|
| `nightly` | каждую ночь, 02:17 МСК | 5 брифов по ротации (≥ 1 ev, ≥ 1 gd, ≥ 1 hz, ≥ 1 с канарейками; `tools/eval/lib/rotation.mjs`) × модель сборки по умолчанию |
| `full` | метка PR `eval:full` (смена промптов, `models.yaml`, версии модели) или вручную (Actions → eval-live → Run workflow, `kind=full`) перед закрытием вехи | все брифы × 2 модели: `vars.EVAL_FULL_MODELS` или `glm-5.3,glm-5.1` |

Порядок работы:

1. **Ключи.** `run.mjs --harness --llm-mode=live --preflight` проверяет, что заданы ключи нужных провайдеров. Если их нет, прогон пропускается с пометкой в summary, workflow остаётся зелёным. Печатаются только имена переменных.
2. **Журнал бюджета.** Берётся последний неистёкший артефакт `eval-budget-ledger` (JSON: дата, вид прогона, число пар, ₽). Если GitHub API недоступен, шаг падает и прогон не стартует (fail-closed).
3. **План и бюджет** (`node tools/eval/ci.mjs plan`). Расход месяца (UTC) = записи журнала ∪ закоммиченные live-отчёты `tools/eval/results/*.json`. Прогноз прогона = число пар × цена пары. Цена пары — 150 ₽, пока в журнале меньше трёх реальных прогонов, затем 1,25 × среднее по последним десяти.
   - `nightly` стартует, если расход + прогноз ≤ 30 000 ₽.
   - `full` стартует, если расход + прогноз + резерв на оставшиеся ночные прогоны месяца ≤ 30 000 ₽. Иначе workflow красный с текстом для эскалации E-MONEY, а ночные прогоны продолжаются.
4. **Прогон** с `--max-cost-rub=<остаток>`: как только расход прогона достигает остатка, новые брифы не стартуют.
5. **Учёт.** `ci.mjs record` записывает в журнал `cost_rub` отчёта. Если отчёта нет (падение, таймаут), записывается прогноз. Новый журнал загружается артефактом `eval-budget-ledger` на 90 дней. Прогоны идут строго по одному (`concurrency: eval-live-budget`).
6. **Отчёт.** Таблица попадает в step summary, а JSON и md — в S3 eval в РФ, если он настроен. В GitHub-артефакты live-отчёты не загружаются (`eval.yaml#fixtures.rules`).
7. **Красный ночной прогон** (жёсткие пороги или регрессия к baseline) создаёт issue со ссылкой на прогон и списком нарушений.

**G1 в live не запускается** (`--gates=G0`): G1 исполняет сгенерированные функции, а по AGENTS.md сгенерированный код вне песочницы исполняется только локально. Поэтому в CI измеряется `g0_pass`, а `g0g1_pass` показан как «—». Когда появится песочница (M2-01), флаг `--gates=G0` из `eval-live.yml` нужно убрать. G0+G1 на live можно получить локально: `WIZARD_UNSAFE_LOCAL_EXEC=1 node tools/eval/run.mjs --harness --llm-mode=live …`.

## Что добавить основателю (E-ACCESS)

Settings → Secrets and variables → Actions. Секреты можно положить в environment `eval-live`: workflow ссылается на него, и GitHub создаёт его при первом запуске. Если включить у environment обязательное одобрение, ночные прогоны будут ждать нажатия кнопки. Метка `eval:full` на PR запускает код этого PR с ключами, поэтому ставить её стоит только на проверенные PR.

| Имя | Тип | Обязательно | Зачем |
|---|---|---|---|
| `CLOUDRU_API_KEY` | secret | да | Cloud.ru Foundation Models (T0, резерв каждой цепочки) |
| `ZAI_API_KEY` | secret | да, пока сборка по умолчанию на T1 | Z.ai (GLM-5.3). После решения недели 0 в пользу T0 не нужен |
| `YANDEX_API_KEY`, `YANDEX_FOLDER_ID` | secret | нет | Yandex AI Studio (T0, резерв) |
| `EVAL_S3_ACCESS_KEY_ID`, `EVAL_S3_SECRET_ACCESS_KEY` | secret | нет | запись live-отчётов в S3 eval в РФ |
| `EVAL_S3_BUCKET`, `EVAL_S3_ENDPOINT`, `EVAL_S3_REGION` | variable | нет | бакет, endpoint S3-совместимого хранилища (например `https://storage.yandexcloud.net`), регион (по умолчанию `ru-central1`) |
| `CLOUDRU_BASE_URL`, `ZAI_BASE_URL`, `YANDEX_BASE_URL` | variable | нет | другие base URL провайдеров |
| `WIZARD_BUILD_DEFAULT_TIER` | variable | нет | `T0` или `T1`, как в деплое (решение недели 0). Пусто — T1 |
| `EVAL_FULL_MODELS` | variable | нет | модели полного прогона по метке, по умолчанию `glm-5.3,glm-5.1` |

Метку `eval:full` нужно создать в репозитории, если её нет. Метка `eval` для ночных issue необязательна: без неё issue создаётся без метки.

## Baseline

`tools/eval/baseline.json` хранит записи `{mode, modelId, briefSetHash, metrics, per_brief, commit, date}`. Хеш набора считается по содержимому брифов, поэтому правка брифа снимает сравнение до нового baseline, и в отчёте появляется пометка «нет baseline». Ночное подмножество сравнивается с полным live-baseline по флагам тех же брифов из `per_brief`.

Как обновить (только PR-ом с live-отчётом и строкой в `specs/CHANGELOG.md`, `eval.yaml#regression.update`):

```bash
node tools/eval/ci.mjs baseline --result=tools/eval/results/<дата>-harness.json --commit=<sha>
```
