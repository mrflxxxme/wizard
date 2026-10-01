# Развёртывание Wizard: staging и prod

Runbook задачи M2-06. Спека — `specs/platform/deploy.yaml#cloud`. Решения основателя для беты:

- бюджет инфраструктуры — до 30 000 ₽/мес;
- без managed Kubernetes: свои ВМ с k3s, gVisor на своих узлах, managed PostgreSQL и S3;
- staging поднимается по требованию одной командой и так же удаляется;
- допустимый простой — 1–2 часа: одна БД с резервными копиями, серверы пересоздаются одной командой.

Первый провайдер — **Timeweb Cloud**. Cloud.ru остаётся провайдером LLM (Foundation Models). Модуль Cloud.ru с managed Kubernetes сохранён как альтернатива (`infra/tofu/cloudru`).

**Текущий путь — пилот** (решение основателя от 01.10.2026): одна ВМ, своя PostgreSQL с WAL-G, ≈ 3,5 тыс. ₽/мес. Он описан в первом разделе. Остальные разделы — общий механизм одной команды и форма беты: managed PostgreSQL и несколько ВМ. Это следующая ступень роста.

## Пилот (текущий путь)

Решение основателя от 01.10.2026: пилот на паре живых клиентов. Спека — `specs/platform/deploy.yaml#pilot`.

- Расходы на инфраструктуру — 5–10 тыс. ₽/мес.
- Функциональность полная: сборка в чате, гейты G0–G2 с живым runtime, превью, публикация, песочница с gVisor, файлы, оплата, коннекторы Telegram и SMTP, retention.
- Провайдер — Timeweb Cloud, только Москва. Без managed Kubernetes и без managed PostgreSQL.
- Допустимый простой — 1–2 ч. Потеря закоммиченных данных — не больше ≈ 1 минуты.

### Как устроено

Всё работает на **одной ВМ** с single-node k3s:

- platform-api, worker, runtime, platform-web, egress-proxy;
- PgBouncer и PostgreSQL 16;
- DNS-01-решатель, Traefik, cert-manager;
- RuntimeClass `gvisor` и пул песочницы: узел помечен `wizard.ru/sandbox-node=true`, пул `free`;
- VictoriaMetrics, VictoriaLogs и сборщик vlagent.

| Слой | Где |
|---|---|
| ВМ, firewall, плавающий IP, бакеты `files` и `backups`, записи DNS | `infra/tofu/timeweb` — тот же модуль, что у беты. Форма пилота: `settings.postgres = null`, пресет с потолком цены `max_price` |
| Профиль Helm | `infra/helm/profiles/pilot.yaml` поверх `k3s.yaml`, плюс `pilot-prod.yaml` и `pilot-staging.yaml` |
| PostgreSQL + WAL-G | `infra/helm/wizard/templates/postgres.yaml`, образ `infra/docker/postgres.Dockerfile`, сценарии `infra/postgres/pg-ops.mjs` |
| Аддоны | `infra/helm/addons/addons.json`: без реестра в кластере, плюс `logs-collector`. Оверлеи — `infra/helm/addons/pilot/*` |
| Образы | GHCR репозитория. Собирает `.github/workflows/images.yml` на GitHub-hosted раннерах |

Профиль выбирается сам: модуль OpenTofu отдаёт `env.cluster_profile = "pilot"`, его читает `tools/deploy/infra.mjs`.

**Образы — из GHCR, а не из реестра в кластере.**

- Так ВМ не тратит память на реестр, а раннеру не нужны Docker и insecure-registries.
- Образы собираются вне РФ: Docker Hub для сборки не нужен из РФ.
- Лицензия: GHCR — сервис GitHub. Образы не распространяются, приватные пакеты. Хранение и трафик Container registry, по документации GitHub, сейчас бесплатны [не проверено для тарифа репозитория].
- Доступность из РФ: GitHub и ghcr.io работают. Если доступ закроют, есть запасной путь — профиль `k3s` с реестром в кластере: `image_registry = "registry.wizard.local"` и `--build-images`.
- Docker Hub для образов аддонов ВМ тянет через зеркало Timeweb `dockerhub.timeweb.cloud` (cloud-init, `registries.yaml`).

### Пилот: замер

Стенд разработки (`scripts/dev.mjs`) поднимался под замком e2e, затем выполнялся сценарий `forum.spec.ts`: промпт → сборка → G0/G1 → превью → билет. Сэмплер — `tools/deploy/rss-sample.mjs`, раз в 0,5 с. Он считает RSS того процесса Node, который выполняет `src/main.ts` через tsx. Так же сервис запускается в образе.

| Процесс | Покой, МиБ | Пик (сборка + G1), МиБ | CPU, пик ядер |
|---|---|---|---|
| platform-api | 300 | 356 (старт, компиляция tsx) | 1,7 на старте, 0,3 при сборке |
| worker (сборка и G1 идут в нём) | 312 | 565 | 2,7 |
| runtime (превью и опубликованная система) | 132 | 185 | 0,4 |
| workerd (2 пода песочницы с тестовыми системами, `workerd.sandbox.test.ts`) | — | 100 | 1,0 |

Сумма backend PostgreSQL на стенде (325 → 1 041 МиБ) не годится для оценки. Shared buffers считаются в RSS каждого backend, а на том же сервере работали базы соседних стендов. Поэтому память PostgreSQL рассчитана из настроек: `shared_buffers` 512 МБ, до 100 соединений.

Оценка пика на ВМ пилота (Москва, 8 ГБ ≈ 7,7 ГиБ доступно ОС):

| Компонент | МиБ | Основание |
|---|---|---|
| k3s: server, kubelet, containerd, coredns, metrics-server, local-path, svclb | 900 | [оценка] по профилированию k3s в документации; на этой машине k3s не запускался (запрет на root-операции) |
| Traefik + cert-manager (3 пода) | 200 | [оценка] |
| VictoriaMetrics + VictoriaLogs + vlagent | 250 | [оценка], лимиты в оверлеях |
| platform-api | 360 | замер |
| worker, две сборки одновременно | 820 | замер 565 + ≈ 250 на вторую |
| runtime | 190 | замер |
| egress-proxy, DNS-01-решатель, pg-ops, data-backup (Node) | 290 | [оценка] по базовому Node-процессу ≈ 60–100 МиБ |
| platform-web (nginx), PgBouncer | 30 | [оценка] |
| PostgreSQL | 800 | расчёт: 512 МБ buffers + backend'ы |
| Песочница: 2 пода gVisor + workerd | 500 | замер workerd 100 + gVisor ≈ 100 на под + системы клиентов |
| ОС: systemd, journald, sshd | 300 | [оценка] |
| **Итого** | **≈ 4 640 (4,5 ГиБ)** | запас **≈ 40 %** |

Еженедельное учение восстановления ночью добавляет ≈ 0,4 ГиБ (временный PostgreSQL, WAL-G, Node), запас — ≈ 35 %.

**Выбор: Cloud MSK 80 — 4 vCPU / 8 ГБ / 80 ГБ NVMe, ≈ 1 800 ₽/мес.**

- Это минимальный пресет с запасом памяти ≥ 30 %.
- 2 vCPU / 4 ГБ не вмещает даже пик (4,5 ГиБ при 3,8 доступных).
- 8 vCPU / 16 ГБ (4 300 ₽) даёт запас ≈ 70 %, сейчас это лишнее: это первая ступень роста.
- CPU: в покое весь стек занимает меньше 0,5 ядра. Сборка — всплеск до ≈ 2,7 ядра на секунды, так что 4 vCPU хватает с запасом более 30 % в среднем.
- Запросы памяти: чарт ≈ 5,1 ГиБ (из них 3 ГиБ — квота двух подов песочницы), аддоны и системные поды k3s ≈ 0,5 ГиБ, всего ≈ 5,7 ГиБ из ≈ 7,5 ГиБ на узле. Помещается ли чарт, проверяет тест `tools/deploy/test/helm.test.ts`.

Повторить замер:

```sh
node tools/deploy/rss-sample.mjs --out rss.json --phase-file phase
# в другом терминале: echo idle > phase; …; echo build > phase; сценарий; Ctrl-C сэмплеру
```

### Пилот: стоимость в месяц

Цены Timeweb Cloud с НДС на 01.10.2026 (`docs/founder/hosting-research.md`).

| Статья | ₽/мес | Основание |
|---|---|---|
| ВМ prod: Cloud MSK 80 — 4 vCPU / 8 ГБ / 80 ГБ NVMe, Москва; первый IPv4 входит | 1 800 | пресет |
| Плавающий IPv4 (не меняется при пересоздании ВМ) | ≈ 150 | [не проверено]: цена из анонса Timeweb 2023 г. |
| S3 `backups`, 100 ГБ: WAL-G (14 дней) и копия `.data` | 349 | тариф S3 |
| S3 `files`, 10 ГБ, поля type=file, пресет растёт сам | 79 | тариф S3 |
| Исходящий трафик S3 | 0 | 100 ГБ/мес бесплатно; учение раз в неделю скачивает ≈ размер БД |
| Два домена .ru (платформа и системы), ≈ 900 ₽/год каждый | ≈ 150 | [оценка] |
| ВМ раннера GitHub (1 vCPU / 1–2 ГБ, Москва) | ≈ 500 | [оценка]. Можно 0, если раннер работает на ВМ пилота, но тогда восстановление после потери ВМ — с ноутбука |
| Staging по требованию: MSK 50, ≈ 1,4 ₽/ч + IP и бакеты на время жизни | ≈ 50–150 | 20–40 ч в месяц |
| Запас 10 % (рост S3, трафик) | ≈ 300 | |
| **Итого** | **≈ 3 400–3 500** | цель ≤ 6–8 тыс. выполнена |

Не входят: токены LLM и юрист. Скидка за оплату на 12 месяцев (−10 %) не учтена.

### Пилот: PostgreSQL, RPO и RTO

- **Сервер.** StatefulSet `wizard-postgres`: PostgreSQL 16 на томе local-path, `--data-checksums`. PgBouncer ходит к нему внутри узла, без TLS, под NetworkPolicy. DBOS и миграции подключаются напрямую.
- **Архив.** WAL-G отправляет каждый сегмент WAL в `s3://<backups>/pg`.
  - `archive_timeout = 60 s`, шифрование libsodium (ключ `WALG_LIBSODIUM_KEY`), zstd.
  - `WALG_PREVENT_WAL_OVERWRITE=true`: свежий кластер рядом со старым архивом не затрёт его.
- **Базовая копия** — CronJob `wizard-pg-basebackup`, ежедневно в 02:17 МСК. После копии удаляется всё, что старше 14 дней: `wal-g delete before FIND_FULL <сейчас − 14 дней>`. Восстановить можно любую точку последних 14 дней.
- **RPO ≈ 1 минута.** Закоммиченная транзакция попадает в архив не позже чем через `archive_timeout` плюс время отправки. Если очередь растёт, срабатывает алерт.
- **RTO ≤ 2 часа.** Порядок:
  1. Пересоздать ВМ одной командой (≈ 15–25 мин).
  2. Init-контейнер `bootstrap` видит пустой том и восстанавливает БД из архива: последняя базовая копия плюс весь WAL. Это минуты на объёмах пилота.
  3. Том `.data` восстанавливается Job'ом из копии, которая обновляется раз в минуту.
- Пустой архив означает первый запуск: тогда initdb. Если архив недоступен, под не стартует, и пустая БД рядом с данными клиентов не поднимется.

### Алерты пилота

Сайдкар `pg-ops monitor` раз в минуту пишет события в лог в формате логгера платформы (`{ts, level, svc, msg, …}`). События с `level: error` — путь алерта: они видны в VictoriaLogs (`svc:pg-ops AND level:error`). Если в Secret `wizard-postgres` задан `WIZARD_OPS_ALERT_URL`, событие уходит и туда, не чаще раза в час на вид. Например, Bot API Telegram: `https://api.telegram.org/bot<токен>/sendMessage`, плюс `WIZARD_OPS_ALERT_CHAT_ID`.

| Событие | Когда |
|---|---|
| `walg_archive_lag` | самый старый готовый, но не отправленный сегмент WAL ждёт дольше 5 минут |
| `walg_archive_failing` | `archive_command` падает или `archive_mode` выключен |
| `walg_backup_stale` / `walg_backup_failed` | нет успешной базовой копии больше 26 ч / копия упала |
| `pg_restore_drill_failed` / `pg_restore_drill_stale` | учение не прошло / не проходило больше 8 суток |
| `pg_restored_from_archive` | БД поднята из архива после потери тома: проверьте данные |
| `data_backup_failing` | копия `.data` не обновляется (3 неудачи подряд) |

Метрики для VictoriaMetrics — `wizard_pg_archive_lag_seconds`, `wizard_pg_last_basebackup_timestamp_seconds`, `wizard_pg_last_restore_drill_timestamp_seconds` и другие. Их отдаёт `/metrics` на порту 9187 пода БД. `/healthz` отвечает 503, если есть проблема.

platform-api шлёт в тот же вебхук алерты платформенного лимита токенов (M2-15, `WIZARD_LLM_MONTHLY_CAP_RUB`, по умолчанию 6 000 ₽ за календарный месяц по Москве). Каждый алерт уходит один раз в месяц: `llm_monthly_cap_warning` (`level: warn`) — при 80 %, `llm_monthly_cap_reached` (`level: error`) — когда лимит исчерпан. После этого новые сборки, ходы интервью и импорты отклоняются с кодом `LLM_BUDGET_EXHAUSTED` до 1-го числа или до повышения лимита в `config.llmMonthlyCapRub`.

### Пилот: приглашения, тариф и кредиты (M2-15)

Профиль `pilot` задаёт `WIZARD_REGISTRATION=invite` и `WIZARD_PAYMENTS=off`. Новый email входит только по приглашению основателя: без него вход отклоняется с текстом «Регистрация в Wizard пока только по приглашению». Оплата, подписки и привязка карты скрыты, операции оплаты отвечают 403 `PAYMENTS_DISABLED`, вебхук ЮKassa выключен. Организации пилота публикуются в prod без карты.

Локально команды запускаются через `pnpm --filter @wizard/platform-api pilot …`. В кластере в образе нет pnpm, поэтому так: `kubectl -n <namespace> exec deploy/wizard-platform-api -- node --import tsx src/pilot/main.ts …`. У платформы пока нет SMTP для своих писем: письмо ложится в outbox на томе `.data`, поэтому ссылку из вывода `invite` основатель пересылает сам.

| Команда | Что делает |
|---|---|
| `pilot invite <email> [--org-name <название>] [--credits <N>]` | приглашение на 30 дней и письмо со ссылкой `/login?email=…`; ссылка печатается и в консоль. При первом входе организация получает тариф «Пилот», название и кредиты |
| `pilot invites`, `pilot revoke <email>` | список приглашений, отзыв активного |
| `pilot plan <orgId> pilot\|free` | назначить тариф уже зарегистрированной организации |
| `pilot grant <orgId> <кредиты> [reference]` | начислить кредиты: ledger, корзина topup, `pilot_grant:<reference>`, срок 365 дней. Повтор с тем же reference не начисляет второй раз |
| `pilot orgs` | организации: тариф, участники, доступно, списано за месяц, расход на модели в ₽ |
| `pilot spend` | расход платформы на модели за месяц и доля лимита |

### Учение восстановления (автоматически, еженедельно)

CronJob `wizard-pg-restore-drill` запускается по воскресеньям в 04:37 МСК.

1. В одной транзакции берёт блокировки SHARE на все таблицы схемы `platform`. Писатели ждут, а не падают; `lock_timeout` — 10 с.
2. Считает строки и ставит именованную точку восстановления, пока блокировки держатся.
3. Переключает WAL и ждёт, пока сегмент окажется в архиве.
4. `wal-g backup-fetch LATEST` во временный каталог. Затем временный PostgreSQL проигрывает WAL ровно до точки и промоутится. Он работает только на сокете и с `archive_mode=off`.
5. Сверяет счётчики по каждой таблице: должно быть точное равенство. Пишет `pg_restore_drill_ok` или `pg_restore_drill_failed`, а также строку в `wizard_ops.ops_runs`. Сайдкар следит за давностью этой строки.

Запуск вручную: `kubectl -n wizard-platform create job --from=cronjob/wizard-pg-restore-drill drill-$(date +%s)`.

Логику учения проверяет `tools/deploy/test/pg-ops.test.mjs` с настоящими PostgreSQL 16 и WAL-G, хранилище — каталог:

- строки, записанные после базовой копии, возвращаются через WAL;
- строки, записанные после точки, в восстановленной БД отсутствуют;
- сломанный архив даёт алерт;
- потерянный том поднимается из архива.

Ежемесячное ручное учение (`#cloud.postgres.restore_drill`) для пилота заменено этим.

### Восстановление после потери ВМ (пилот)

1. `pnpm infra:apply --env prod --yes --tag <sha последнего выката>`. Можно с раннера или с ноутбука владельца: нужны tofu, helm, kubectl, SSH-ключ и tfvars. Если ВМ удалена в панели, OpenTofu создаст её заново. Плавающий IP и DNS сохраняются.
2. Секреты кластера создаются заново из файлов: `WIZARD_PLATFORM_ENV_FILE`, `WIZARD_PGBOUNCER_SECRET_DIR`, `WIZARD_DNS_SOLVER_ENV_FILE`, `WIZARD_POSTGRES_ENV_FILE`, `WIZARD_GHCR_USER` и `WIZARD_GHCR_TOKEN`.
   - **Ключ `WALG_LIBSODIUM_KEY` и `WIZARD_DATA_BACKUP_KEY` хранятся вне ВМ**: OpenBao или сейф основателя. Без них архив не расшифровать.
3. Под `wizard-postgres` восстановит БД сам: событие `pg_restored_from_archive`.
4. Верните `.data`: `kubectl -n wizard-platform create job --from=cronjob/wizard-data-restore data-restore-1`. Затем перезапустите platform-api, worker и runtime: `kubectl -n wizard-platform rollout restart deploy`.
5. Проверьте: smoke прошёл; учение, запущенное вручную, зелёное.

### Одна команда (пилот)

```sh
pnpm infra:apply --env prod --yes --tag <sha>       # ВМ, аддоны, секреты, релиз; образы ждёт в GHCR
pnpm infra:apply --env staging --tag <sha>          # staging по требованию (MSK 50)
node tools/deploy/infra.mjs destroy --env staging --yes
```

### Что нужно от основателя (дополнительно к разделу ниже)

1. tfvars пилота: `infra/tofu/timeweb/envs/*/terraform.tfvars.example`. Форма беты лежит в `terraform.tfvars.beta.example`.
2. GHCR:
   - variable `WIZARD_IMAGES_GHCR=enabled` — образы публикуются из main;
   - variable `WIZARD_GHCR_USER`;
   - secret `WIZARD_GHCR_TOKEN` — fine-grained или classic токен только с `read:packages`.
3. Файл `/etc/wizard/postgres-<env>.env` на раннере (права 600) для первого `apply`:
   - `POSTGRES_PASSWORD`;
   - `WALG_LIBSODIUM_KEY` (`openssl rand -hex 32`);
   - `AWS_ACCESS_KEY_ID` и `AWS_SECRET_ACCESS_KEY` из `tofu output -json s3_keys`, бакет `backups`;
   - `WIZARD_DATA_BACKUP_KEY` (`openssl rand -hex 32`);
   - по желанию `WIZARD_OPS_ALERT_URL` и `WIZARD_OPS_ALERT_CHAT_ID`.

   Копию ключей положите в OpenBao или сейф.
4. В `wizard-platform-env`:
   - `WIZARD_DB_URL=postgres://wizard:<POSTGRES_PASSWORD>@wizard-pgbouncer:6432/wizard`;
   - для DBOS — прямой адрес `wizard-postgres:5432`, если понадобится сессионное соединение.

   В каталоге `wizard-pgbouncer` достаточно `userlist.txt`: `server-ca.crt` не нужен.

### Пилот: когда расти

Сигналы берутся из VictoriaMetrics (vmui, p95 за 7 дней), действия выполняются правкой tfvars и `pnpm infra:apply`.

| Триггер | Действие | +₽/мес |
|---|---|---|
| CPU ВМ > 60 % или RAM > 75 % устойчиво | пресет MSK 160 — 8 vCPU / 16 ГБ (`server`, `max_price = 4500`) | +2 500 |
| Сборки или песочница мешают платформе, песочнице не хватает памяти | вторая ВМ — агент k3s с пулом песочницы (`sandbox_nodes = { free = {…} }`) | +1 000–1 800 |
| Клиенту нужен SLA, или простой 1–2 ч стал неприемлем | managed PostgreSQL (форма беты: `settings.postgres`). PITR у Timeweb DBaaS нет — тогда HA-реплика своего PG или другой провайдер БД. Решение основателя | +1 600–5 000 |
| Сумма превышает 20 000 ₽/мес | **стоп**: эскалация E-MONEY (`specs/escalation.yaml`). Агенты сами дальше не растут | — |

Потолок самостоятельного роста — **20 000 ₽/мес**. `max_price` в tfvars не даёт плану молча взять пресет дороже заданного.

Запросы для vmui:

- CPU: `1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))`. Если node-exporter не установлен — `sum(rate(container_cpu_usage_seconds_total{container!=""}[5m])) / 4`.
- RAM: `sum(container_memory_working_set_bytes{container!=""}) / 8e9`.


## Как устроено

| Слой | Где | Зависит от провайдера |
|---|---|---|
| ВМ, сеть, firewall, плавающий IP, managed PostgreSQL, бакеты S3, записи DNS | `infra/tofu/<провайдер>/` (OpenTofu) | да |
| k3s на ВМ: сервер и агенты песочницы с gVisor, зеркало реестра | `infra/k3s/*.tftpl` (cloud-init) | нет |
| Пространства имён | `infra/k8s/namespaces.yaml` | нет |
| Аддоны: cert-manager, Traefik, реестр образов, VictoriaMetrics, VictoriaLogs | `infra/helm/addons/` | нет |
| Приложение: platform-api, worker, runtime, platform-web, egress-proxy, PgBouncer, DNS-01-решатель, NetworkPolicy, TLS | `infra/helm/wizard/` | нет |
| S3-эндпоинт, бэкенд DNS-01, класс хранилища | `infra/helm/providers/<провайдер>.yaml` | да |
| Профиль кластера (k3s: local-path, одна реплика, RuntimeClass) | `infra/helm/profiles/k3s.yaml` | нет |
| Образы | `infra/docker/` | нет |

Всё собирает одна команда `pnpm infra:apply --env staging|prod` (`tools/deploy/infra.mjs`):

1. OpenTofu создаёт ВМ, сеть, БД, бакеты и DNS.
2. Скрипт ждёт, пока cloud-init поставит k3s, и забирает kubeconfig по SSH.
3. Ставит пространства имён и аддоны.
4. Проверяет секреты в кластере.
5. Собирает образы и кладёт их в реестр кластера.
6. Выполняет `helm upgrade --atomic`.
7. Делает HTTPS-smoke: HSTS и 404 на `/_wizard/internal/*` снаружи.

Флаг `--dry-run` печатает все команды и ничего не выполняет. Секреты в выводе маскируются.

### Состав окружений

| | staging (по требованию) | prod |
|---|---|---|
| ВМ k3s | одна: 4 vCPU / 8 ГБ, на ней же пул песочницы | сервер 4/8 и агент песочницы 4/8 |
| PostgreSQL | managed: 1 vCPU / 2 ГБ, копий 3 | managed: 2 vCPU / 4 ГБ, ежедневные копии, хранить 14 |
| S3 | бакеты artifacts, files, imports, eval, backups | то же |
| Плавающий IP | 1 | 1 |
| ВМ раннера GitHub | одна общая, живёт в VPC prod | — |

Оценка стоимости [оценка, сверить с калькулятором Timeweb Cloud]:

- prod — примерно 6–9 тыс. ₽/мес;
- раннер — около 0,5 тыс. ₽;
- staging — платится только пока он поднят (почасовая тарификация ВМ и БД).

Это укладывается в 30 тыс. ₽ с запасом.

## Что нужно от основателя

Это разовые клики. Секреты не присылайте в чат: только в GitHub или OpenBao.

1. **Timeweb Cloud.**
   - Создайте API-токен: панель → API и Terraform. **Отключите подтверждение удаления через Telegram**, иначе `destroy` зависнет (так требует документация провайдера).
   - Положите токен в GitHub: Settings → Environments → `staging` и `prod` → secret `TWC_TOKEN`.
   - Пополните баланс.
2. **Домены.**
   - Добавьте домен систем (и, когда будет, домен платформы) в раздел «Домены» Timeweb Cloud.
   - Делегируйте их у регистратора на NS Timeweb.
   - Для staging нужен отдельный домен систем (`docs/founder/access-checklist.md` §2).
3. **Бакет состояния OpenTofu.**
   - В S3 Timeweb создайте приватный бакет `wizard-tfstate` и ключ к нему.
   - В GitHub (environments `staging` и `prod`) положите:
     - variable `WIZARD_TF_STATE_BUCKET`;
     - secrets `WIZARD_TF_STATE_ACCESS_KEY_ID` и `WIZARD_TF_STATE_SECRET_ACCESS_KEY`;
     - secret `WIZARD_TF_STATE_PASSPHRASE` — 16+ символов, шифрует состояние на клиенте.
4. **ВМ раннера.**
   - Создайте небольшую ВМ (1–2 vCPU / 2 ГБ, Ubuntu 24.04) в той же локации и в VPC prod. Её можно создать после первого `apply` prod или сразу, вручную.
   - Установите на неё: Docker (в `insecure-registries` впишите `<приватный IP сервера k3s>:30500` и, для staging, `<публичный IP staging>:30500`), OpenTofu ≥ 1.8, Helm 3, kubectl, Node 22 с pnpm, psql.
   - Зарегистрируйте runner GitHub: Settings → Actions → Runners → New self-hosted runner. Метки — `wizard-prod` и `wizard-staging`.
   - Положите на раннер файлы:
     - SSH-ключ `/etc/wizard/id_ed25519`, его публичная часть идёт в tfvars;
     - `/etc/wizard/terraform-staging.tfvars` и `/etc/wizard/terraform-prod.tfvars` по образцам `infra/tofu/timeweb/envs/*/terraform.tfvars.example`.
   - В `admin_cidrs` tfvars укажите публичный IP раннера.
5. **GitHub variables** уровня репозитория:
   - `WIZARD_PROVIDER=timeweb`;
   - `WIZARD_ACME_EMAIL` — контакт для Let's Encrypt;
   - когда всё готово — `WIZARD_DEPLOY_STAGING=enabled` и `WIZARD_DEPLOY_PROD=enabled`.

   До этого оба workflow выходят с уведомлением «Пропущено: облако не подключено».
6. **Секреты приложения** (OpenBao, а до него файлы на раннере с правами 600). Это файл env для Secret `wizard-platform-env`:
   - `WIZARD_DB_URL` — строка на PgBouncer: `postgres://wizard:<пароль>@wizard-pgbouncer:6432/wizard`. Пароль — из `tofu output -json postgres`;
   - `WIZARD_SECRETS_KEY`, `WIZARD_PREVIEW_SECRET` (32+ байт), `WIZARD_INTERNAL_TOKEN`;
   - `WIZARD_S3_*` — ключи из `tofu output -json s3_keys`;
   - SMTP, Telegram, ЮKassa, LLM (`CLOUDRU_API_KEY`, `ZAI_API_KEY`).

   Ещё нужны:
   - каталог для Secret `wizard-pgbouncer`: `userlist.txt` и `server-ca.crt`;
   - env-файл для Secret `wizard-dns-solver` (cert-manager): `TWC_TOKEN=…`.

   Пути к ним передайте в `WIZARD_PLATFORM_ENV_FILE`, `WIZARD_PGBOUNCER_SECRET_DIR`, `WIZARD_DNS_SOLVER_ENV_FILE` при первом `apply`. Дальше секреты живут в кластере.

Prod запускает только владелец репозитория: Actions → deploy-prod → Run workflow, полный SHA, слово `PROD`. Это вариант «а» из чек-листа §8.

## Одна команда

```sh
# staging по требованию
pnpm infra:apply --env staging                    # создать / обновить всё (≈ 15–25 мин в первый раз)
node tools/deploy/infra.mjs destroy --env staging --yes   # удалить всё, включая БД и бакеты staging
# из GitHub: Actions → deploy-staging → mode apply | deploy | destroy

# prod (только из deploy-prod.yml или вручную владельцем с раннера)
pnpm infra:apply --env prod --yes --build-images --tag <sha>
node tools/deploy/infra.mjs deploy --env prod --yes --build-images --tag <sha>   # только образы + Helm

# посмотреть план или все шаги без выполнения
pnpm infra:plan --env prod
node tools/deploy/infra.mjs apply --env staging --dry-run --build-images
```

Staging живёт в своём VPC, который удаляется вместе с ним. Поэтому раннер ходит к нему по публичному IP: `WIZARD_K3S_ACCESS=public`, а firewall пускает на порты 22/6443/30500 только `admin_cidrs`. К prod раннер ходит по приватной сети.

## Восстановление после потери сервера (простой 1–2 ч)

1. `tofu -chdir=infra/tofu/timeweb/envs/prod apply -replace=module.env.twc_server.k3s …` — либо удалите ВМ в панели и выполните `pnpm infra:apply --env prod --yes --build-images --tag <sha>`. Плавающий IP и DNS не меняются.
2. Данные не теряются: PostgreSQL и S3 managed, артефакты в томе `.data`. **Остаток:** артефакты пока на локальном томе сервера (local-path). Пока они не переедут в S3, после пересоздания сервера нужна пересборка draft и повторная публикация. См. impl-notes.

## Учение по восстановлению БД (PITR)

`deploy.yaml#cloud.postgres.restore_drill`. Порядок такой:

1. Отметьте контрольную строку **до** точки T:
   ```sh
   node tools/deploy/pitr-drill.mjs mark --db "$STAGING_DB_URL" --note "до T"
   ```
2. Подождите не меньше часа и зафиксируйте T (UTC).
3. Отметьте строку **после** T: `mark … --note "после T"`.
4. Восстановите БД на момент T в **новый** кластер:
   - **Timeweb Cloud.** Провайдер OpenTofu PITR не умеет, у DBaaS есть ежедневные копии (`twc_database_backup_schedule`). Если в панели или API есть восстановление на момент времени (вопрос недели 0 к Timeweb), восстановите в новый кластер в панели. Иначе восстановите копию за ближайшие сутки: RPO — до 24 ч, и это **расхождение со спекой** (PITR), см. impl-notes.
   - **Cloud.ru** (альтернатива):
     ```sh
     node tools/deploy/pitr-drill.mjs restore --env staging --at "Thu, 01 Oct 2026 11:00:00 UTC" --source <id> --spec <id> --subnet <id>
     ```
     Используется `recovery_spec` провайдера.
5. Проверьте восстановленную БД:
   ```sh
   node tools/deploy/pitr-drill.mjs verify --db "$RESTORED_DB_URL" --present <id до T> --absent <id после T>
   ```
   Код выхода 0 — учение пройдено.
6. Удалите восстановленный кластер. Запишите дату учения. Учение повторяется раз в месяц.

## Public Suffix List и HSTS preload для домена систем (L3-14)

Делать после первого успешного выката prod, когда домен систем отдаёт HTTPS:

1. **HSTS.**
   - Ingress отдаёт `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` на всех хостах домена систем, включая сам домен: Middleware `wizard-hsts`, правило apex в Ingress.
   - HTTP всегда перенаправляется на HTTPS: Traefik, entrypoint `web`.
   - Проверка: `curl -sI https://<домен-систем>/ | grep -i strict` и `curl -sI http://<домен-систем>/` (ожидается 301/308 на https).
2. **Preload.** Откройте https://hstspreload.org, введите домен систем, проверьте условия и отправьте форму.
   - После включения в списки браузеров откат занимает месяцы, поэтому staging с preload не выкатывается: в `values-staging.yaml` выставлено `preload: false`.
3. **PSL** (private section). Правила — https://github.com/publicsuffix/list/wiki/Guidelines.
   - Домен должен быть зарегистрирован так, чтобы на момент заявки до окончания оставалось **больше 2 лет**. Продлите заранее.
   - Сделайте fork `publicsuffix/list` и добавьте в `public_suffix_list.dat`, в секцию `===BEGIN PRIVATE DOMAINS===`, блок по алфавиту:
     ```
     // <Название организации> : https://<домен платформы>
     // Submitted by <имя> <security@<домен платформы>>
     <домен-систем>
     ```
   - Создайте TXT-запись `_psl.<домен-систем>` со значением `https://github.com/publicsuffix/list/pull/<номер PR>`. В Timeweb: `twc_dns_rr` или панель.
   - В описании PR объясните, почему нужен PSL: поддомены — отдельные системы разных клиентов, cookie и storage должны быть изолированы. Укажите контакт.
   - Дождитесь мержа; это недели. До включения изоляцию держат `__Host-` cookie и CSRF runtime (`abuse.yaml#domain.tenant_separation`).
   - Запишите номер PR в `docs/reviews/impl-notes/M2-06.md`.

## Мониторинг и логи

Всё в кластере и в РФ (`deploy.yaml#cloud.observability`):

- метрики — VictoriaMetrics, 90 дней: `kubectl -n wizard-observability port-forward svc/metrics-victoria-metrics-single-server 8428`, затем http://127.0.0.1:8428/vmui;
- логи — VictoriaLogs, 30 дней: `kubectl -n wizard-observability port-forward svc/logs-victoria-logs-single-server 9428`, затем http://127.0.0.1:9428/select/vmui.

Алерты из `deploy.yaml#cloud.observability.alerts` пока не настроены (остаток).

## Смена провайдера

Какие файлы меняются при смене провайдера, перечислено в `docs/reviews/impl-notes/M2-06.md`, раздел «Смена провайдера». Коротко: новый каталог `infra/tofu/<провайдер>/` с тем же контрактом выходов, файл `infra/helm/providers/<провайдер>.yaml` и, если DNS у нового провайдера, бэкенд в `infra/acme-dns01/src/backends/`.
