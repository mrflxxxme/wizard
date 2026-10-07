# Third-party notices

Сторонний код, который попадает в бандлы созданных систем или заимствован в исходники Wizard. Зависимости только для разработки и сборки здесь не перечисляются: их лицензии проверяются по `pnpm-lock.yaml`.

| Пакет | Версия | Лицензия | Где используется |
|---|---|---|---|
| qrcode-generator (Kazuhiko Arase) | 2.0.4 | MIT | `packages/ui-kit`: генерация QR-кодов в бандлах систем; `packages/connectors`: PNG QR во вложениях писем |
| jsQR (cozmo) | 1.4.0 | Apache-2.0 | `packages/ui-kit`: распознавание QR в сканере; `packages/e2e` (dev): декодирование QR-билета в e2e |
| fflate | см. pnpm-lock | MIT | `packages/pii/import`: распаковка xlsx при импорте таблиц (серверная сторона) |
| @faker-js/faker (локаль ru) | см. pnpm-lock | MIT | синтетические строки импорта и seed (серверная сторона, данные не распространяются) |
| @dbos-inc/dbos-sdk (DBOS Transact TS) и его зависимости pg, pg-pool, pg-protocol, pg-types (MIT), superjson, copy-anything, is-what (MIT), serialize-error (MIT), ws (MIT), commander (MIT), yaml (ISC) | см. pnpm-lock | MIT | `apps/worker`: durable-воркфлоу прогонов; `apps/platform-api`: постановка прогонов в очередь (DBOSClient). Серверная сторона, в бандлы систем не попадает |
| undici (Node.js) | см. pnpm-lock | MIT | `packages/llm`: HTTP вызовов моделей с таймаутом заголовков дольше 300 с по умолчанию (уже был в дереве через @ai-sdk/provider-utils). Серверная сторона, в бандлы систем не попадает |
| Словарь брендов `packages/gates/data/brands.ru.json` | собственная компиляция | CC0 | антифрод G2-AF-04: имена из `specs/security/abuse.yaml#patterns.brands`, домены — собственный список; внешних источников нет |

## Инструменты только для CI (не распространяются, не модифицируются)

Job `sandbox` (`.github/workflows/sandbox.yml`, M2-01) скачивает их на одноразовый раннер, в код и бандлы они не попадают.

| Инструмент | Версия | Лицензия | Где используется |
|---|---|---|---|
| amicontained (genuinetools) | v0.4.9, sha256 в workflow | MIT | аудит контейнера под gVisor: runtime, capabilities, seccomp |
| workerd (Cloudflare, npm-пакет `workerd`) | `WORKERD_VERSION` в workflow | Apache-2.0 | запуск конфига пода из `apps/runtime/src/sandbox/workerd-config.ts` |
| gVisor `runsc` (Google, apt-репозиторий gvisor.dev) | release | Apache-2.0 | runtime docker `--runtime=runsc` с настройками пода песочницы |
| BusyBox (образ `busybox`) | 1.36.1 | GPL-2.0 | оболочка для проверок внутри контейнера; образ не изменяется и не распространяется |

Заимствования из Chef (Apache-2.0) и bolt.diy (MIT) добавляются сюда вместе с сохранёнными заголовками (AGENTS.md).

## Развёртывание (M2-06): инфраструктура вне бандла

Инструменты и образы развёртывания. Они не модифицируются и не входят в бандлы систем (AGENTS.md: инфраструктура вне бандла допускает также AGPL/MPL). Версии закреплены в `infra/helm/addons/addons.json`, `infra/docker/*.Dockerfile`, `infra/tofu/*/**/main.tf` и workflow.

| Компонент | Лицензия | Где используется |
|---|---|---|
| OpenTofu | MPL-2.0 | `infra/tofu`: окружения staging и prod |
| Провайдер OpenTofu Timeweb Cloud (`timeweb-cloud/timeweb-cloud`) | лицензия в репозитории документации не указана; провайдер не распространяется | `infra/tofu/timeweb` |
| Провайдер OpenTofu Cloud.ru Evolution (`cloudru/cloud`) | MIT | `infra/tofu/cloudru` (альтернативный вариант) |
| Провайдер `hashicorp/random` | MPL-2.0 | токен k3s, пароль администратора PostgreSQL |
| k3s | Apache-2.0 | кластер на ВМ (`infra/k3s/*.tftpl`) |
| gVisor `runsc` | Apache-2.0 | RuntimeClass `gvisor` на узлах песочницы |
| Helm | Apache-2.0 | релиз `infra/helm/wizard`, аддоны |
| cert-manager (jetstack) | Apache-2.0 | wildcard TLS, ACME DNS-01 |
| Traefik и его чарт | MIT | ingress |
| VictoriaMetrics single, VictoriaLogs single и их чарты | Apache-2.0 | метрики и логи в кластере |
| Vector (агент логов из чарта VictoriaLogs) | MPL-2.0 | сбор stdout контейнеров |
| CNCF Distribution (`registry`), чарт twuni/docker-registry | Apache-2.0 | реестр образов в кластере |
| nginx (образ `nginxinc/nginx-unprivileged`) | BSD-2-Clause | раздача статики platform-web |
| PgBouncer (пакет Alpine) | ISC | пулер соединений, режим transaction |
| Node.js (официальный образ) | MIT | базовый образ сервисов |
| syft (`anchore/sbom-action`) | Apache-2.0 | SBOM образов в CI |
| kubeconform, actionlint | Apache-2.0, MIT | проверки CI |
| PostgreSQL 16 (официальный образ `postgres`, Debian) | PostgreSQL License | своя БД пилота (`infra/docker/postgres.Dockerfile`) |
| WAL-G v3.0.9 (релиз `wal-g-pg-22.04-amd64`, sha256 закреплён) | Apache-2.0 | непрерывная архивация WAL и базовые копии БД пилота в S3 |
| rclone v1.75.1 (`.deb` из релиза, sha256 закреплён) | MIT | зашифрованная копия тома `.data` пилота в S3 |
| vlagent (чарт `victoria-logs-collector`) | Apache-2.0 | сбор stdout контейнеров в пилоте вместо Vector |
| GitHub Container Registry (ghcr.io) | сервис GitHub, не распространяется | реестр образов пилота (приватные пакеты) |

Клиенты DNS API в `infra/acme-dns01/src/backends/` написаны с нуля. Бэкенд Cloud.ru следует схеме API из провайдера `cloudruevolution` проекта lego (MIT, © Ludovic Fernandez, Sebastian Erhart и участники): обмен ключа на токен IAM, слияние значений TXT, ожидание операций. Бэкенд Timeweb Cloud следует моделям официального SDK (`timeweb-cloud/sdk-python`) и клиенту `libdns-timeweb` (MIT). Код из них не копировался.

## Изображения и шрифты систем (M2-42, M2-47)

Кодеки изображений работают на сервере runtime (WASM, без нативных сборок и без LGPL). Шрифты раздаются системам с `/_wizard/fonts` их собственного домена, запросов к Google Fonts нет. Файлы шрифтов взяты из дистрибутива Google Fonts без изменений (подмножества cyrillic и latin в том виде, в каком их публикует Google Fonts) через npm-пакеты `@fontsource/*` (обвязка — MIT, только для разработки). Копирует их `packages/ui-kit/scripts/sync-fonts.mjs`; каталог с лицензией и источником каждого шрифта — `packages/ui-kit/src/tokens/font-catalog.ts`, тексты лицензий — `packages/ui-kit/fonts/LICENSE-*.txt`. Шрифты платформы v2 (B2-32) копирует тот же скрипт в `packages/ui-kit/fonts-platform` (каталог — `packages/ui-kit/src/v2/font-catalog.ts`); platform-web собирает их в свой бандл и раздаёт со своего домена, без CDN.

| Пакет | Версия | Лицензия | Где используется |
|---|---|---|---|
| @jsquash/jpeg (Jamie Sinclair; кодек MozJPEG/libjpeg-turbo — IJG, BSD-3-Clause, zlib) | 1.6.0 | Apache-2.0 | `apps/runtime/src/media`: чтение JPEG при загрузке в поле image |
| @jsquash/png (кодек на Rust-крейте png — MIT/Apache-2.0) | 3.1.1 | Apache-2.0 | `apps/runtime/src/media`: чтение PNG при загрузке в поле image |
| @jsquash/webp (кодек libwebp — BSD-3-Clause) и wasm-feature-detect (Apache-2.0) | 1.5.0 | Apache-2.0 | `apps/runtime/src/media`: чтение WebP и сжатие вариантов WebP |
| Onest | @fontsource/onest 5.3.1 | OFL-1.1 | шрифт тем; © 2021 The Onest Project Authors; Google Fonts, npm @fontsource/onest |
| Inter Tight | @fontsource/inter-tight 5.3.0 | OFL-1.1 | шрифт тем; © 2022 The Inter Project Authors; Google Fonts, npm @fontsource/inter-tight |
| Manrope | @fontsource/manrope 5.3.0 | OFL-1.1 | шрифт тем (заголовки «Строгой деловой»); © 2019 The Manrope Project Authors; Google Fonts, npm @fontsource/manrope |
| PT Sans | @fontsource/pt-sans 5.3.0 | OFL-1.1 | шрифт тем (текст «Спокойной»); © 2009 ParaType Ltd.; Google Fonts, npm @fontsource/pt-sans |
| IBM Plex Sans | @fontsource/ibm-plex-sans 5.3.0 | OFL-1.1 | шрифт тем (текст «Строгой деловой»); © 2019 IBM Corp.; Google Fonts, npm @fontsource/ibm-plex-sans |
| Golos Text | @fontsource/golos-text 5.3.0 | OFL-1.1 | шрифт тем (текст «Тёплой»); © 2019 The Golos Text Project Authors; Google Fonts, npm @fontsource/golos-text |
| PT Serif | @fontsource/pt-serif 5.3.0 | OFL-1.1 | шрифт тем (заголовки «Спокойной»); © 2010 ParaType Ltd.; Google Fonts, npm @fontsource/pt-serif |
| Lora | @fontsource/lora 5.3.0 | OFL-1.1 | шрифт тем (заголовки «Тёплой»); © 2011 The Lora Project Authors, Reserved Font Name «Lora» (файлы не изменяются, имя сохранено); Google Fonts, npm @fontsource/lora |
| Unbounded | @fontsource/unbounded 5.3.0 | OFL-1.1 | шрифт тем (заголовки «Яркой»); © 2022 The Unbounded Project Authors; Google Fonts, npm @fontsource/unbounded |
| Inter | @fontsource/inter 5.3.0 | OFL-1.1 | шрифт платформы v2 (B2-32, интерфейс; 400, 500, 600); © 2016 The Inter Project Authors (https://github.com/rsms/inter); Google Fonts, npm @fontsource/inter; файлы в `packages/ui-kit/fonts-platform`, платформа раздаёт их со своего домена |
| Source Serif 4 | @fontsource/source-serif-4 5.3.0 | OFL-1.1 | шрифт платформы v2 (B2-32, антиква «человеческих» моментов; 400, 500); © 2014–2023 Adobe (http://www.adobe.com/), Reserved Font Name «Source» (файлы не изменяются, имя сохранено); Google Fonts, npm @fontsource/source-serif-4; файлы в `packages/ui-kit/fonts-platform` |
