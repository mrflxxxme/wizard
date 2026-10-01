# Пилот: одна кнопка (bootstrap-pilot, deploy-pilot)

Задача: участие основателя в развёртывании пилота должно свестись к одной раздаче доступов. Раньше он сам создавал ВМ раннера и ставил на неё утилиты, раскладывал файлы с правами 600, создавал бакет состояния и ключи, копировал значения из `tofu output` и собирал env-файлы для Secrets. Теперь он задаёт секреты и переменные GitHub и нажимает `bootstrap-pilot`. Всё остальное делают GitHub-hosted раннеры.

Runbook — `docs/ops/deploy.md`, разделы «Пилот: одна кнопка», «Восстановление после потери ВМ (пилот)», «Что нужно от основателя». Ни один облачный API не вызывался, ничего не развёртывалось: проверки офлайн (ниже).

## Что задаёт основатель

GitHub → Settings → Secrets and variables → Actions. Уровень — репозиторий или окружения `prod` / `staging`.

**Secrets:**

| Имя | Обязателен | Назначение |
|---|---|---|
| `TWC_TOKEN` | да | API Timeweb Cloud: бакет состояния, OpenTofu, firewall, DNS-01 (Secret `wizard-dns-solver`) |
| `WIZARD_STATE_PASSPHRASE` | да, ≥ 16 символов | шифрует состояние OpenTofu (pbkdf2 → aes_gcm, как раньше) и файл ключей окружения (scrypt → AES-256-GCM). Хранится в менеджере паролей |
| `CLOUDRU_API_KEY` | да | модели (T0) |
| `ZAI_API_KEY` | нет | модели (T1) |
| `WIZARD_SMTP_HOST`, `WIZARD_SMTP_FROM` | да | почта платформы: без неё код входа не дойдёт |
| `WIZARD_SMTP_PORT`, `WIZARD_SMTP_USER`, `WIZARD_SMTP_PASSWORD` | нет | порт по умолчанию 465. `HOST`, `PORT`, `USER`, `FROM` можно задать и переменными |
| `WIZARD_OPS_ALERT_TELEGRAM_TOKEN` + `WIZARD_OPS_ALERT_CHAT_ID` | нет | алерты в Telegram. Можно вместо них задать `WIZARD_OPS_ALERT_URL` |
| `WIZARD_PLATFORM_YOOKASSA_SHOP_ID`, `WIZARD_PLATFORM_YOOKASSA_SECRET_KEY` (+ variable `WIZARD_RECEIPT_VAT_CODE`) | нет | после пилота, когда включится оплата |
| `WIZARD_GHCR_TOKEN` | нет | постоянный токен `read:packages` вместо токена задания |

**Variables:**

| Имя | Обязательна | Назначение |
|---|---|---|
| `WIZARD_PLATFORM_DOMAIN` | да | домен платформы, есть в «Доменах» Timeweb |
| `WIZARD_SYSTEMS_DOMAIN` | да | отдельный домен систем: не совпадает с доменом платформы и не вложен в него |
| `WIZARD_ACME_EMAIL` | нет | Let's Encrypt. По умолчанию — `WIZARD_FOUNDER_EMAIL` |
| `WIZARD_FOUNDER_EMAIL` | да | приглашение и права staff, адрес алертов письмом |
| `WIZARD_PLATFORM_MAIL_SPF` | нет | include SPF почтового провайдера |

Проверка входов (`checkInputs`) выдаёт только имена и причины, без значений. Сводка задания и код выхода 2 перечисляют, чего не хватает.

В панели Timeweb основатель делает только то, чего не умеет API: пополняет баланс, создаёт токен (без подтверждения удаления в Telegram), покупает домены или делегирует их на NS Timeweb.

## Первый запуск по минутам [оценка; облако не вызывалось]

`bootstrap-pilot`, `prod`, `apply`, `PROD`:

| Время | Что происходит |
|---|---|
| 0:00 | `authorize` (ubuntu-latest, ≈ 10 с): владелец, main, prod → `PROD`, SHA из 40 символов. Секреты до этого не читаются |
| 0:01–0:12 | `images` (`images.yml` через `workflow_call`, 8 параллельных заданий): если образа `ghcr.io/<owner>/<image>:<sha>` нет, он собирается, получает SBOM и уходит в GHCR с `GITHUB_TOKEN` (`packages: write`). Уже опубликованные образы пропускаются |
| 0:12 | `pilot` (ubuntu-24.04, окружение `prod`): checkout, проверка, что SHA в main, Node 22, OpenTofu 1.10.6, Helm 3.19 (≈ 1 мин) |
| 0:13 | `pilot.mjs bootstrap`: проверка входов, API Timeweb. Бакета `wizard-tfstate` нет → он создаётся на самом дешёвом hot-пресете ru-1, скрипт ждёт статус `created`. Ключи S3 берутся из ответа API |
| 0:14 | Файла `wizard/prod.secrets.enc.json` нет → генерируются пароль PG, `WIZARD_SECRETS_KEY`, `WIZARD_PREVIEW_SECRET`, `WIZARD_INTERNAL_TOKEN`, `WALG_LIBSODIUM_KEY`, `WIZARD_DATA_BACKUP_KEY` и SSH ed25519. Файл шифруется, записывается и читается обратно для сверки. Все значения маскируются в логе |
| 0:14–0:20 | `tofu init` (состояние в бакете, шифруется паролем) и `tofu apply` с JSON-tfvars: VPC, SSH-ключ, плавающий IP, ВМ MSK 80 (пресет ≤ 2 000 ₽), firewall (80/443 и VPC, `admin_cidrs = []`), бакеты `files` и `backups`, записи DNS |
| 0:20 | `tofu output`. Из ключей и выходов пишутся env-файлы Secrets в `$RUNNER_TEMP` (0600). Узнаётся внешний IPv4 раннера, в firewall добавляется правило tcp/22 для `IP/32` с описанием `wizard-ci-temp` |
| 0:20–0:27 | Скрипт ждёт cloud-init (k3s, gVisor) и каждые 15 с пытается забрать kubeconfig по SSH. Затем открывает SSH-туннель `127.0.0.1:16443 → 127.0.0.1:6443` |
| 0:27 | Список пространств имён: `wizard-platform` нет, ключи только что созданы → первый выкат, а не восстановление |
| 0:27–0:33 | `namespaces.yaml`, аддоны пилота: cert-manager, Traefik, VictoriaMetrics, VictoriaLogs, vlagent |
| 0:33 | Secrets: `wizard-platform-env`, `wizard-pgbouncer`, `wizard-dns-solver`, `wizard-postgres`. Pull-секрет `wizard-ghcr` с токеном задания. Проверка, что образы тега есть в GHCR |
| 0:33–0:40 | `helm upgrade --install wizard --atomic --wait`: узел тянет образы из GHCR. PostgreSQL видит пустой архив и делает initdb, platform-api применяет миграции |
| 0:40 | Job `wizard-founder-staff`: приглашение на почту основателя (без письма), затем ожидание первого входа. В файл ключей пишется `deployedAt` |
| 0:40–0:45 | HTTPS-smoke раз в 30 с, пока cert-manager получает сертификаты через DNS-01 (до 10 мин) |
| 0:45 | Сводка. В `finally` закрывается туннель и удаляется правило SSH. Шаги `Close SSH access` (`always()`) и очистка `$RUNNER_TEMP` |

Дальше основатель:

1. Открывает `https://<платформа>/login` и вводит свою почту. Код приходит по SMTP.
2. Job в течение 30 с видит учётку и ставит `is_staff`.
3. Основатель открывает `/admin` и подключает MFA.

Следующий `bootstrap-pilot` или `deploy-pilot` увидит, что Job завершился. Он запомнит это в файле ключей и больше не создаёт Job.

## Решения

- **Без self-hosted раннера.** Все операции идут с раннеров GitHub: API Timeweb, S3 состояния, SSH к ВМ. Отдельная ВМ раннера (≈ 500 ₽/мес) и ручная установка утилит больше не нужны. Путь беты (`deploy-reusable.yml` на self-hosted раннере) не тронут.
- **Шифрование ключей — `node:crypto`, без age и openssl.**
  - Схема: scrypt (N = 2¹⁷, r = 8, p = 1, 128 МиБ) → AES-256-GCM. Окружение входит в AAD: файл staging не откроется как prod, подмена поля `env` ломает тег.
  - Причины выбора: AEAD (у `openssl enc` его нет), не нужен лишний бинарь на раннере и лишняя лицензия, код покрыт тестами. Расшифровать на ноутбуке: `node tools/deploy/pilot.mjs show-secrets --env prod`; в CI команда отказывается работать.
  - Неверный пароль останавливает запуск. Файл никогда не пересоздаётся: архив WAL-G и копия `.data` зависят от этих ключей.
- **SSH-ключ** создаётся в формате OpenSSH прямо в Node (`sshKeyPair`), без ssh-keygen. Проверено: `golang.org/x/crypto/ssh` разбирает 20 ключей с разной длиной паддинга и выводит тот же открытый ключ. В CI есть тест через `ssh-keygen -y`: на раннере GitHub ssh-keygen есть, локально его нет, там тест пропускается.
- **Доступ администратора — временное правило и туннель.**
  - В состоянии tofu `admin_cidrs = []`: между запусками открыты только 80 и 443. Это проверяет новый прогон `tofu test`.
  - На время задания API добавляет tcp/22 только для `/32` раннера. Порт 6443 наружу не открывается: kubectl и helm ходят через SSH-туннель. Сертификат k3s покрывает 127.0.0.1.
  - Правило снимается дважды: в `finally` и шагом с `always()`. Перед открытием удаляются старые временные правила, если прошлое задание было убито.
  - Правила не принадлежат tofu, поэтому план их не трогает. Группа firewall ищется по имени `wizard-<env>-nodes`.
  - IP раннера берётся из `api.ipify.org`, запасной источник — `ipv4.icanhazip.com`. Если ответ неверный, задание просто не подключится. Порт 22 принимает только ключ.
- **GHCR без PAT основателя.** Pull-секрет — `GITHUB_TOKEN` задания выката (`packages: read`); пакеты, опубликованные `GITHUB_TOKEN` этого репозитория, связаны с ним. Все образы скачиваются во время выката и живут в кэше containerd: CronJob используют тот же образ `wizard-postgres`, что и работающий под. `WIZARD_GHCR_TOKEN` (`read:packages`) — необязательная замена на случай вычищенного кэша. Образы пакетов публичными не делаются: это код платформы.
- **Образы для SHA строятся сами.** `images.yml` получил `workflow_call` (`sha`, `ghcr`) и пропускает образ, уже лежащий в GHCR (`imagetools inspect`). Группа concurrency включает имя вызывающего workflow, поэтому пуш в main не отменяет сборку для пилота. Пуш в main публикует в GHCR и при заданной переменной уровня репозитория `WIZARD_PLATFORM_DOMAIN`, без отдельного `WIZARD_IMAGES_GHCR`.
- **Права staff для основателя без правки кода приложения.**
  - Есть две трудности. Регистрация пилота идёт только по приглашению, а приглашения CLI закрыты флагом `beta_readiness` (M2-09). `setStaff` требует существующего пользователя.
  - Решение — Job `wizard-founder-staff` (pod `pg-job`, образ `wizard-postgres`, psql). Он создаёт одно приглашение основателю, если у адреса нет учётки и активного приглашения. После входа он ставит `is_staff`.
  - SQL берёт адрес только через psql-переменную `:'email'`, все имена квалифицированы. Pod проходит PSS restricted, NetworkPolicy `wizard-pg-job` пускает его только к БД.
  - Шлюз `beta_readiness` относится к приглашениям партнёров (152-ФЗ, юрист, РКН), а не к учётке оператора. Поэтому приглашение основателю создаётся в обход CLI. Это отступление записано ниже.
- **Восстановление после потери ВМ** — тот же `bootstrap-pilot`.
  - Пустой кластер (нет `wizard-platform`) при файле ключей с `deployedAt` значит, что ВМ пересоздана. Тогда после релиза запускается Job `wizard-data-restore` из CronJob, скрипт ждёт его и перезапускает Deployment.
  - PostgreSQL восстанавливается из WAL-G сам (init-контейнер, M2-06).
  - Пространства имён читаются списком, а не `get` одного имени: недоступный API — ошибка, а не «пустой кластер». Иначе rclone мог бы записать старую копию поверх живых файлов.
- **Smoke повторяется** (`WIZARD_SMOKE_ATTEMPTS`, у пилота 20 × 30 с). На новом окружении сертификаты появляются через минуты после релиза. Путь беты не меняется: по умолчанию одна попытка.
- **`infra.mjs`** изменён минимально:
  - `deps.hooks`: `beforeCluster` (файлы Secrets и временный SSH), `afterKubeconfig`, `afterRelease`; секция кластера обёрнута в `try/finally`;
  - `WIZARD_K3S_ACCESS=tunnel`, `openTunnel`, `sshBaseArgs`;
  - `smokeWithRetry`;
  - опция `stdio` у раннера команд.

  Существующие тесты беты и Cloud.ru не менялись и зелёные.
- **Форма пилота** — таблица `SHAPES` в `pilot.mjs`: MSK 80 и `max_price` 2000 для prod, MSK 50 и 1100 для staging. Рост — правка таблицы через PR, потолок прежний: `max_price` и 20 000 ₽/мес.
- **Кэш провайдеров OpenTofu** в `pilot-reusable.yml` тот же, что в `deploy-lint` (`actions/cache`, `~/.tofu-plugin-cache`, `TF_PLUGIN_CACHE_DIR`).
- **actionlint в CI.** В `deploy-lint` добавлен actionlint v1.7.7 с закреплённым sha256. Хэш сверен со скачанным архивом. На раннере GitHub actionlint проверит и shellcheck.

## Дополнительно: сеть для шлюза ИИ (M3-02)

Runtime вызывает `POST /internal/v1/ai/run` на platform-api с внутренним токеном (`docs/reviews/impl-notes/M3-02.md`). Изменения в чарте `infra/helm/wizard`, они действуют для пилота, беты на k3s и Cloud.ru:

- runtime получил `WIZARD_PLATFORM_INTERNAL_URL=http://wizard-platform-api.<ns>.svc:<platformApi.port>` (ClusterIP-сервис);
- в NetworkPolicy `wizard-platform-api` добавлен ingress от подов `wizard.ru/role: runtime`, только на порт platform-api;
- в NetworkPolicy `wizard-runtime` добавлен egress к platform-api, только на этот же порт;
- `WIZARD_INTERNAL_TOKEN` платформа и runtime уже берут из `wizard-platform-env`; в пилоте его генерирует файл ключей.

Снаружи `/internal/*` по-прежнему недоступен: ingress пускает на platform-api только `/api`. Тест — `helm.test.ts`, «M3-02», для всех 6 вариантов (пилот, k3s, Cloud.ru × staging/prod).

## Проверки (офлайн)

- `tools/deploy/test/pilot.test.mjs` — 19 тестов, 1 пропущен локально (ssh-keygen). Один тест идёт против настоящего PostgreSQL 16: SQL доступа основателя во временной базе, с попыткой инъекции в адресе. В остальных фальшивые API Timeweb и S3 проверяют подпись SigV4 ключом бакета состояния; tofu, ssh, kubectl и helm тоже фальшивые. Покрыто:
  - входы основателя;
  - tfvars;
  - идемпотентность файла ключей, шифрование, привязка к окружению, порча файла, неверный пароль (без записи);
  - формат SSH;
  - содержимое Secrets;
  - создание и повторный поиск бакета, неоплаченный бакет;
  - полный первый запуск: порядок шагов, одно временное правило и его снятие, отсутствие секретов в логе и сводке;
  - повторный запуск: те же значения, бакет не создаётся;
  - отметка staff;
  - восстановление после потери ВМ;
  - недоступный кластер;
  - сбой helm, после которого SSH всё равно закрыт;
  - удаление staging;
  - `close-access`;
  - манифест Job.
- `infra.test.mjs` +2: туннель и повтор smoke, плюс kubeconfig через туннель.
- `workflows.test.mjs` +3: проверки владельца и PROD до чтения секретов, GitHub-hosted раннер, `close-access` с `always()`, вызов `images.yml`.
- `tofu test` модуля Timeweb — 5/5, новый прогон без `admin_cidrs`. `tofu fmt -check` и `tofu validate` (prod) зелёные.
- JSON-tfvars из `pilot.mjs` проверены `tofu console` на копии корня prod без бэкенда: `settings.postgres == null`, форма, пустые `admin_cidrs`.
- actionlint 1.7.7 с shellcheck 0.10.0 — чисто.
- `pnpm lint`, `pnpm typecheck`, `node tools/specs/validate.mjs` — зелёные; `pnpm test` — см. отчёт.

## Отступления и правки спек

1. `deploy.yaml#pilot.images`: «ВМ тянет образы с токеном read:packages (Secret wizard-ghcr)» → «с токеном задания выката (`GITHUB_TOKEN`, `packages: read`), необязательно — постоянный `WIZARD_GHCR_TOKEN`; образы строит и `pilot-reusable.yml` для своего SHA».
2. `deploy.yaml#pilot.environments.staging`: команда создания и удаления — `bootstrap-pilot` (`staging`, `apply` / `destroy`); `infra.mjs` остаётся для ручного пути.
3. `deploy.yaml#pilot.budget.expected_rub_month`: без ВМ раннера ≈ 2 900–3 000 ₽ (prod) вместо 3 300–3 700.
4. `deploy.yaml#cloud.secrets`: в пилоте ключи окружения хранятся в зашифрованном файле в бакете состояния, ключ — пароль основателя. OpenBao в пилоте по-прежнему нет.
5. Приглашение основателю создаёт Job без проверки `beta_readiness` (M2-09): шлюз касается партнёров. Если нужно строже, приложение может завести явный список адресов операторов. Это правка `apps/platform-api`, в эту задачу она не входила.
6. `docs/founder/access-checklist.md` по-прежнему описывает ручной путь (ВМ раннера, файлы). Нужна правка по разделу «Что нужно от основателя» в `docs/ops/deploy.md`: это вне каталогов задачи.

## Остатки и что не проверялось

- **Облако не вызывалось.** Не проверены:
  - поле `name` бакета в API — полное имя с префиксом (так в документации data source провайдера);
  - статусы бакета;
  - политика `DROP` у групп firewall, созданных провайдером (при иной политике скрипт пишет `::warning::`);
  - скорость применения нового правила (kubeconfig всё равно ретраится);
  - вход `root` по ключу на образе Ubuntu Timeweb;
  - pull из ghcr.io с ВМ в Москве с `GITHUB_TOKEN`;
  - `imagetools inspect` с `GITHUB_TOKEN`.
- **Смена `WIZARD_STATE_PASSPHRASE`** не автоматизирована. Нужно перешифровать файл ключей (`show-secrets` → `encryptBundle`) и выполнить `tofu init -migrate-state` с новым паролем. Пока это ручная процедура агента с участием основателя.
- **Изменение секретов GitHub** (например, пароля SMTP) попадает в Secrets при каждом выкате. Поды перечитывают env только при перезапуске: новый SHA или `rollout restart`.
- **Команды `pilot invite/grant` по-прежнему выполняются через `kubectl exec`.** Для этого нужен доступ к кластеру. Готовой команды «открыть SSH для моего IP и дать kubeconfig» для ноутбука нет: `pilot.mjs` открывает доступ только внутри своего запуска. Удобнее был бы workflow `pilot-cli` с тем же owner-only guard. Но вывод (почты клиентов, ссылки) попал бы в логи GitHub за пределами РФ. Нужна либо консоль `/admin` для приглашений, либо вывод только в кластер. Это следующий шаг.
- **Тариф GitHub.** Окружения с секретами в приватном репозитории доступны на Pro и Team. На Free секреты задаются на уровне репозитория, workflow их читает так же. Минуты Actions: ≈ 40–80 мин раннера на сборку образов нового SHA [оценка].
