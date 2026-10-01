# llm-deepseek — провайдер `deepseek` (T1, претендент eval)

Основание: `docs/founder/models-research.md` §2, §5, «Рекомендация для пилота» п. 4б.

## Что сделано

- `packages/llm/src/registry.ts`: `ProviderId` += `deepseek`. Провайдер T1, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` (по умолчанию `https://api.deepseek.com`), `termsCheckedAt: 2026-10-01`. Модели:
  - `deepseek-v4.1-flash` → API id `deepseek-flash`, 1M контекст, 34,77 / 0,7 / 139,08 ₽ за 1M;
  - `deepseek-v4-pro-0813` → API id `deepseek-v4-pro`, 1M контекст, 152,99 / 5,1 / 458,96 ₽ за 1M.
  Цены — часы пик из §2 ($0,3/$0,006/$1,2 и $1,32/$0,044/$3,96) × 95 ₽/$ × 1,22, по правилу `models.yaml` (как у Z.ai). Вне пика вдвое дешевле, поэтому оценка с запасом.
- `packages/llm/src/providers.ts` `transformBody`: для `deepseek` в **каждом** запросе (с tools и без) уходит `thinking: {type: "disabled"}`. Удаляются `reasoning_effort`, `enable_thinking`, `chat_template_kwargs`, `response_format`; `reasoning_content` вырезается из сообщений, как раньше. Ветки остальных провайдеров не менялись.
- Спеки: `models.yaml#providers.deepseek` (роль `eval_challenger`, rule и thinking), две строки в `#models`, deepseek в `#call_policy.thinking`. `data-boundary.yaml#routing.model_registry`: правило для DeepSeek (те же условия, что у Z.ai; включение в маршрутизацию по умолчанию — E-LEGAL). `deploy.yaml#local.env_vars.llm` += `DEEPSEEK_BASE_URL`, `DEEPSEEK_API_KEY`.
- `.env.example`: две пустые переменные с комментарием.
- `tools/eval/models.json`: провайдер `deepseek` и две модели с `enabled: false` и `extra_body.thinking: disabled`. `tools/eval/README.md` и `docs/ops/eval.md` дополнены.
- `.github/workflows/eval-live.yml`: в шаги «Provider keys present?» и «Live harness» пробрасываются `DEEPSEEK_API_KEY` (secret, необязательный) и `DEEPSEEK_BASE_URL` (variable). `pilot-reusable.yml` не тронут: в деплое DeepSeek не нужен.

## Как устроено «выключено по умолчанию»

Провайдер в реестре `enabled: true`, а обе модели `enabled: false` и не стоят ни в одной цепочке `routes`. Роутер их не выбирает (`catalog_rules`: модель с `enabled=false` не выбирается). Eval-харнесс включает модель только через `--models=deepseek-v4.1-flash` (`registryFor`, как и для любой модели). Если бы провайдер был `enabled: false`, как `moonshot`, харнесс не смог бы гонять претендента без правки `registryFor`. Правка `registryFor` заодно открыла бы eval-путь к Kimi K3, а он выключен по юридической причине. Поэтому выключение сделано на уровне моделей.

В `routes.*.chain.T1` DeepSeek не добавлен, хотя §5 исследования это предлагает: задача требует не трогать маршрутизацию по умолчанию, а харнесс и так ставит выбранную модель первой. Строитель по умолчанию — GLM-5.3 через Z.ai, ИИ-действия — T0. Оба факта закреплены тестами.

Без ключа роутер получает `NO_API_KEY` и идёт к следующей модели цепочки (GLM-5.3, затем T0). Попытка не журналируется и не тарифицируется — это поведение роутера, оно уже было. Харнесс с `--models=deepseek-*` без ключа называет `DEEPSEEK_API_KEY` в `missingKeys`, и CI пропускает live-прогон (exit 3).

## Тесты

- `packages/llm/test/deepseek.test.ts` (новый, 17 тестов). Реестр и env. Модели выключены и не стоят в цепочках; с ключом DeepSeek реестр по умолчанию не шлёт на его хост ни один callType. `transformBody`: thinking выключен с tools и без. Второй ход с tool-calling против заглушки, которая, как DeepSeek, отвечает 400 на thinking-mode без `reasoning_content`, проходит. Scrub: канарейки не доходят до хоста, журнал `scrubbed=true`. `pii_forbidden_for_T1.always`, вложения, strong-идентификаторы, интервью с ПДн, `import_mapping`, `ruOnly` и `t1Restricted` не доходят до DeepSeek, даже если он первый в T1-цепочке каждого callType. `tok_*` отклоняется до отправки. Без ключа — фолбэк на GLM-5.3, без двух ключей — T0 с `ruFallback`. 5xx: 3 попытки, затем GLM-5.3. Fixture-режим без сети (fetch бросает).
- `packages/llm/test/registry.test.ts`: в список разрешённых провайдеров добавлен `deepseek`. Сверка с `models.yaml` (модели, провайдеры, env) проходит.
- `tools/eval/test/harness.test.ts`: +1 тест. Претендент необязателен; с `--models` требует `DEEPSEEK_API_KEY`; `registryFor` ставит его первым; в `models.json` он выключен и с `thinking: disabled`.
- Полный прогон: `pnpm lint`, `pnpm typecheck`, `pnpm test` (3333 passed, 77 skipped), `node tools/specs/validate.mjs` — зелёные.

## Отклонения и допущения

- API id моделей взяты из §2 исследования (`deepseek-flash` = V4.1-Flash, `deepseek-v4-pro` = V4-Pro-0813). По первоисточнику не проверены. Перед первым live-прогоном их нужно сверить со списком `GET /models` у DeepSeek.
- Spec-only режим `tools/eval/run.mjs` для T1 проверяет канарейки, но scrub не делает: это его существующее поведение и для Z.ai. Претендента осмысленно гонять в `--harness` (роутер со scrub).
- `ci.mjs FULL_MODELS` не менялся: претендент включается входом `models` в workflow_dispatch или переменной `EVAL_FULL_MODELS`.

## Для CHANGELOG (вписать при мерже)

- `llm-deepseek`: провайдер `deepseek` (T1) как необязательный претендент недельного eval. Модели `deepseek-v4.1-flash`, `deepseek-v4-pro-0813` выключены и не стоят в маршрутизации; thinking выключен в каждом запросе; граница ПДн — как у Z.ai.
