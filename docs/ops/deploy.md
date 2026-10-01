# Развёртывание Wizard: staging и prod

Runbook задачи M2-06. Спека — `specs/platform/deploy.yaml#cloud`. Решения основателя для беты:

- бюджет инфраструктуры — до 30 000 ₽/мес;
- без managed Kubernetes: свои ВМ с k3s, gVisor на своих узлах, managed PostgreSQL и S3;
- staging поднимается по требованию одной командой и так же удаляется;
- допустимый простой — 1–2 часа: одна БД с резервными копиями, серверы пересоздаются одной командой.

Первый провайдер — **Timeweb Cloud**. Cloud.ru остаётся провайдером LLM (Foundation Models). Модуль Cloud.ru с managed Kubernetes сохранён как альтернатива (`infra/tofu/cloudru`).

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
