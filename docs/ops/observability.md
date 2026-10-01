# Наблюдаемость прогонов (M2-09)

Метрики платформы снимает VictoriaMetrics пилота: дашбордов и Grafana нет, только vmui и список сохранённых запросов ниже. Спека — `specs/platform/deploy.yaml#pilot.observability`, `#cloud.observability.alerts`.

## Откуда берутся метрики

| Процесс | Где слушает | Что отдаёт |
|---|---|---|
| platform-api | `WIZARD_METRICS_PORT` (в Helm `metrics.port: 9464`) | прогоны, исполненные в процессе, и метрики из БД: очередь, ₽ моделей за месяц и лимит, ревью основателя, доля упавших прогонов за час |
| worker | тот же порт в своём поде | прогоны (DBOS), гейты, проходы retention_cron |
| runtime | тот же порт в своём поде | запросы публичного порта по классам статусов, задержка, проходы retention систем |
| PostgreSQL (pg-ops) | 9187 | архив WAL, базовые копии, учения восстановления (`wizard_pg_*`) |

Поды несут аннотации `prometheus.io/scrape|port|path`, и VictoriaMetrics снимает их сам (`infra/helm/addons/victoria-metrics-values.yaml`). NetworkPolicy открывает порт метрик только для namespace `wizard-observability`. Публичный порт и внутренний порт runtime для наблюдаемости закрыты.

В метках нет slug системы, путей, адресов и текстов: только вид прогона, итог, код ошибки и id проверки. Значение, которое не похоже на такой токен, превращается в `other` (`@wizard/pii/metrics`). Счётчики процесса обнуляются при рестарте, поэтому в запросах используйте `increase()` и `rate()`.

Локально метрики выключены. Включить их можно так: `WIZARD_METRICS_PORT=9464 pnpm dev`, затем `curl -s 127.0.0.1:9464/metrics`. У platform-api, воркера и runtime порты должны быть разными: задайте их через env каждого процесса.

## Как открыть vmui

```
kubectl -n wizard-observability port-forward svc/metrics-victoria-metrics-single-server 8428
# http://127.0.0.1:8428/vmui
```

## Сохранённые запросы

Скопируйте запрос в vmui. Ссылки с запросом удобно держать в закладках.

| Что смотрим | Запрос |
|---|---|
| Прогоны за час по видам и итогам | `sum by (kind, status) (increase(wizard_runs_finished_total[1h]))` |
| Доля упавших за час (как у алерта) | `wizard_runs_failed_ratio_1h` и `wizard_runs_finished_1h` |
| Доля упавших по видам за сутки | `sum by (kind) (increase(wizard_runs_finished_total{status="failed"}[1d])) / sum by (kind) (increase(wizard_runs_finished_total[1d]))` |
| Почему падают прогоны | `topk(10, sum by (kind, code) (increase(wizard_run_failures_total[1d])))` |
| Длительность сборки, p50 и p95 | `histogram_quantile(0.95, sum by (le) (rate(wizard_run_duration_seconds_bucket{kind="build",status="succeeded"}[1d])))` (для p50 — `0.5`) |
| Длительность публикации, p95 | `histogram_quantile(0.95, sum by (le) (rate(wizard_run_duration_seconds_bucket{kind="publish"}[1d])))` |
| Какие проверки гейтов валятся чаще всего | `topk(15, sum by (level, check) (increase(wizard_gate_check_failures_total[7d])))` |
| Гейты: прошло и не прошло | `sum by (level, passed) (increase(wizard_gate_runs_total[1d]))` |
| Очередь сейчас | `max by (kind, status) (wizard_runs_active)` |
| Расход на модели за месяц и лимит, ₽ | `max(wizard_llm_cost_rub)` и `max(wizard_llm_monthly_cap_rub)` |
| Доля лимита на модели | `max(wizard_llm_cost_rub) / max(wizard_llm_monthly_cap_rub)` |
| Ждут ревью основателя | `max(wizard_founder_reviews_pending)` |
| Проходы retention платформы за сутки | `sum by (result) (increase(wizard_retention_passes_total[1d]))` |
| Проходы retention систем в runtime за сутки | `sum by (result) (increase(wizard_runtime_retention_passes_total[1d]))` |
| Ошибки runtime (5xx) в минуту | `sum(rate(wizard_runtime_http_requests_total{class="5xx"}[5m])) * 60` |
| Задержка runtime, p95 | `histogram_quantile(0.95, sum by (le) (rate(wizard_runtime_http_request_duration_seconds_bucket[5m])))` |
| Отставание архива WAL, с | `max(wizard_pg_archive_lag_seconds)` |
| Возраст базовой копии, ч | `(time() - max(wizard_pg_last_basebackup_timestamp_seconds)) / 3600` |
| Сбои сборщиков метрик | `sum(increase(wizard_metrics_collect_errors_total[1h]))` |

Запросы для решений о росте сервера (CPU и RAM) — в `docs/ops/deploy.md`, раздел «Пилот: когда расти».

## Алерты основателю

Канал один и тот же: строка лога `level: error|warn` (VictoriaLogs), необязательный вебхук `WIZARD_OPS_ALERT_URL` (например, Bot API Telegram) и необязательное письмо на `WIZARD_OPS_ALERT_EMAIL` через почту платформы. В тексты алертов не попадают ПДн и пользовательские тексты, только id.

| Событие | Когда | Как часто |
|---|---|---|
| `run_failure_rate_high` | за последний час упало больше 20 % завершённых прогонов, а завершённых не меньше 5 | не чаще раза в час (`platform.ops_alerts`, ключ `run_fail_rate:<час UTC>`); проверка каждые 10 минут — DBOS-расписание `wizard.ops_checks` воркера |
| `llm_monthly_cap_warning` / `llm_monthly_cap_reached` | расход на модели за месяц ≥ 80 % / 100 % `WIZARD_LLM_MONTHLY_CAP_RUB` | раз в месяц (M2-15) |
| `founder_review_requested` | ревизия ждёт ревью перед prod; в тексте — команда одобрения | один раз на ревизию |
| `walg_archive_lag` и другие `pg_*` | см. `docs/ops/deploy.md` (pg-ops) | раз в час на вид |
