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
| unpdf (Johann Schopplich, unjs) со встроенной serverless-сборкой PDF.js (Mozilla Foundation) | см. pnpm-lock | MIT; PDF.js — Apache-2.0 | `packages/agents/src/brief-extract` (V3-04): текст ТЗ из pdf на сервере платформы. Без нативных модулей: `@napi-rs/canvas` — необязательный peer, не устанавливается. Серверная сторона, в бандлы систем не попадает |
| fflate | см. pnpm-lock | MIT | `packages/agents/src/brief-extract` (V3-04): распаковка docx ТЗ с потоковым подсчётом распакованного размера (защита от zip-бомб). Серверная сторона |

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
| Cormorant Garamond | @fontsource/cormorant-garamond 5.3.0 | OFL-1.1 | шрифт тем v2 (B2-36, заголовки «Изысканной»); © 2015 The Cormorant Project Authors (github.com/CatharsisFonts/Cormorant); Google Fonts, npm @fontsource/cormorant-garamond |
| Commissioner | @fontsource/commissioner 5.3.0 | OFL-1.1 | шрифт тем v2 (B2-36, текст «Изысканной»); © 2019 The Commissioner Project Authors (github.com/kosbarts/Commissioner); Google Fonts, npm @fontsource/commissioner |
| Piazzolla | @fontsource/piazzolla 5.3.0 | OFL-1.1 | шрифт тем v2 (B2-36, заголовки «Аппетитной»); © 2018 The Piazzolla Project Authors (https://github.com/huertatipografica/piazzolla); Google Fonts, npm @fontsource/piazzolla |
| Source Sans 3 | @fontsource/source-sans-3 5.3.0 | OFL-1.1 | шрифт тем v2 (B2-36, текст «Аппетитной»); © 2010–2020 Adobe (http://www.adobe.com/), Reserved Font Name «Source» (файлы не изменяются, имя сохранено); Google Fonts, npm @fontsource/source-sans-3 |

## Фото со свободных стоков (B2-38, решение основателя D61)

Фото для лендингов систем сборщик берёт из двух стоков с собственными свободными лицензиями (не CC; кода и данных в репозитории от них нет — только ответы-фикстуры в формате их API `tools/fixtures/stock/*.json`, без настоящих фото: синтетические для обоих стоков и, после действия `record` воркфлоу `stock` (B2-38), записанные ответы поиска Pexels `pexels.recorded.json` — только метаданные: id, размеры, имя автора и ссылки на него и на страницу фото, адреса файлов; ответы Pixabay не хранятся по его правилам API, docs/ops/eval-d76.md «Стоки из CI»). Выбранное фото скачивается один раз, перекодируется в WebP без EXIF и хранится в библиотеке фото платформы (`wz_photos/` хранилища файлов систем); посетитель получает его с домена системы (`/_wizard/photos`), к стокам из браузера запросов нет. По каждой картинке в плане системы (`design.photos`) записаны сток, id фото, автор, ссылка на автора и страницу фото, лицензия со ссылкой и дата выбора; сайт показывает их на странице «Источники фото» (`/photos`, ссылка в подвале). Unsplash не используется (D61). Условия ниже — по страницам лицензий и правилам API на 07.10.2026; перед подключением ключей (M2-20) их нужно перечитать.

| Сток | Лицензия | Можно | Нельзя | Атрибуция и правила API |
|---|---|---|---|---|
| Pexels (api.pexels.com, images.pexels.com) | Pexels License, https://www.pexels.com/license/ | бесплатно, в том числе в коммерческих сайтах; изменять | продавать неизменённые копии (постеры, принты, на товарах); раздавать на других стоках и в приложениях обоев; намекать, что люди или бренды на фото одобряют бизнес; использовать в товарном знаке или логотипе | по лицензии не обязательна; правила API: заметная ссылка на Pexels и, где можно, «Photo by <автор> on Pexels» со ссылкой — у нас «Источники фото»; 200 запросов в час, 20 000 в месяц |
| Pixabay (pixabay.com/api, pixabay.com/get, cdn.pixabay.com) | Pixabay Content License, https://pixabay.com/service/license-summary/ | бесплатно, в том числе в коммерческих сайтах; изменять | продавать или раздавать контент как есть (отдельно, на стоках и обоях); печатать неизменённые копии на товарах для продажи; незаконное и вводящее в заблуждение использование; товарные знаки и узнаваемые люди — с учётом их прав | по лицензии не обязательна; правила API: показывать, откуда фото, не делать постоянных хотлинков (скачивать к себе — так и делаем), кешировать ответы поиска 24 ч (кеш клиента стоков — сутки) |
| Sofia Sans Extra Condensed | @fontsource/sofia-sans-extra-condensed 5.3.0 | OFL-1.1 | шрифт тем v2 (B2-36, заголовки «Мастерской»); © 2019 The Sofia Sans Project Authors (https://github.com/lettersoup/Sofia-Sans); Google Fonts, npm @fontsource/sofia-sans-extra-condensed |
| Sofia Sans | @fontsource/sofia-sans 5.3.0 | OFL-1.1 | шрифт тем v2 (B2-36, текст «Мастерской»); © 2019 The Sofia Sans Project Authors (https://github.com/lettersoup/Sofia-Sans); Google Fonts, npm @fontsource/sofia-sans |
| Alegreya Sans | @fontsource/alegreya-sans 5.3.0 | OFL-1.1 | шрифт тем v2 (B2-36, заголовки «Дружелюбной»); © 2013 The Alegreya Sans Project Authors (https://github.com/huertatipografica/Alegreya-Sans); Google Fonts, npm @fontsource/alegreya-sans |
| Alegreya | @fontsource/alegreya 5.3.0 | OFL-1.1 | шрифт тем v2 (B2-36, текст «Дружелюбной»); © 2011 The Alegreya Project Authors (https://github.com/huertatipografica/Alegreya); Google Fonts, npm @fontsource/alegreya |
| Alumni Sans | @fontsource/alumni-sans 5.3.0 | OFL-1.1 | шрифт тем v2 (B2-36, заголовки «Афиши»); © 2015 The Alumni Sans Project Authors (https://github.com/googlefonts/alumni); Google Fonts, npm @fontsource/alumni-sans |
| Literata | @fontsource/literata 5.3.0 | OFL-1.1 | шрифт тем v2 (B2-36, текст «Афиши»); © 2017 The Literata Project Authors (https://github.com/googlefonts/literata); Google Fonts, npm @fontsource/literata |
| Wix Madefor Display | @fontsource/wix-madefor-display 5.3.0 | OFL-1.1 | шрифт тем v2 (B2-36, заголовки «Заботливой»); © 2021 The Wix Madefor Project Authors (https://github.com/wix/wixmadefor/); Google Fonts, npm @fontsource/wix-madefor-display |
| Wix Madefor Text | @fontsource/wix-madefor-text 5.3.0 | OFL-1.1 | шрифт тем v2 (B2-36, текст «Заботливой»); © 2021 The Wix Madefor Project Authors (https://github.com/wix/wixmadefor/); Google Fonts, npm @fontsource/wix-madefor-text |
| Inter | @fontsource/inter 5.3.0 | OFL-1.1 | шрифт платформы v2 (B2-32, интерфейс; 400, 500, 600); © 2016 The Inter Project Authors (https://github.com/rsms/inter); Google Fonts, npm @fontsource/inter; файлы в `packages/ui-kit/fonts-platform`, платформа раздаёт их со своего домена |
| Source Serif 4 | @fontsource/source-serif-4 5.3.0 | OFL-1.1 | шрифт платформы v2 (B2-32, антиква «человеческих» моментов; 400, 500); © 2014–2023 Adobe (http://www.adobe.com/), Reserved Font Name «Source» (файлы не изменяются, имя сохранено); Google Fonts, npm @fontsource/source-serif-4; файлы в `packages/ui-kit/fonts-platform` |

## Исследование агентов (V3-05): чтение страниц

Инструменты `read_page` и `discover_docs` (`packages/agents/src/research`) превращают открытые страницы в markdown на сервере платформы (D46, `specs/agents/builder-v3.md` §1). Пакеты загружаются лениво при первом чтении страницы, скрипты страниц не выполняются, в бандлы систем ничего не попадает. У @mozilla/readability нет файла NOTICE, авторские права указаны в его LICENSE.md.

| Пакет | Версия | Лицензия | Где используется |
|---|---|---|---|
| @mozilla/readability (© 2010 Arc90 Inc, Mozilla) | 0.6.0 | Apache-2.0 | `packages/agents/src/research/page.ts`: основное содержимое страницы без меню, рекламы и подвала |
| linkedom (Andrea Giammarchi) и его зависимости htmlparser2, cssom, html-escaper, dom-serializer (MIT), uhyphen, boolbase (ISC), css-select, css-what, nth-check, domhandler, domutils, domelementtype, entities (BSD-2-Clause) | 0.18.13 | ISC | `packages/agents/src/research/page.ts`: DOM страницы на сервере для Readability, без браузера |
| turndown (Dom Christie) и его зависимость @mixmark-io/domino (BSD-2-Clause) | 7.2.4 | MIT | `packages/agents/src/research/page.ts`: HTML основного содержимого → markdown |

## Публичные страницы систем v3 (V3-08)

Публичные страницы систем v3 собираются на Tailwind CSS v4 и Motion (`specs/agents/builder-v3.md` §1). Паттерны секций (`packages/ui-kit/src/v3/patterns/**`) копируются в код систем как `ui/patterns/<id>.tsx` (модель shadcn). Все паттерны написаны своим кодом на токенах дизайн-системы. Часть композиций повторяет раскладки MIT-библиотек: источник указан ниже и в поле `origin` паттерна. Код Tailwind Plus, Aceternity, Magic UI Pro, React Bits Pro и GSAP не используется даже как образец; это проверяет `packages/ui-kit/test/v3-patterns.test.ts`.

| Пакет | Версия | Лицензия | Где используется |
|---|---|---|---|
| tailwindcss (Tailwind Labs) | 4.3.3 | MIT, Copyright (c) Tailwind Labs, Inc. | `packages/build/src/tailwind.ts`: компиляция CSS публичных страниц v3 при сборке (JS API, без нативного oxide). В CSS систем попадают preflight и утилиты с заголовком лицензии |
| motion, framer-motion, motion-dom, motion-utils (Motion) | 13.x, см. pnpm-lock | MIT, Copyright (c) 2024 Motion B.V. (https://github.com/motiondivision/motion) | `motion/react` в паттернах v3: вход первого экрана, меню шапки и раскрытие ответа в FAQ, с учётом prefers-reduced-motion; попадает в бандлы систем v3 |
| tslib (Microsoft) | 2.8.1 | 0BSD | зависимость motion; ES-сборки motion его не импортируют, в бандлы систем не попадает |

| Источник композиции | Лицензия | Паттерны |
|---|---|---|
| HyperUI, https://github.com/markmead/hyperui | MIT, Copyright (c) Mark Mead | раскладки header-classic, header-centered, hero-split, hero-centered, cta-band, cta-centered, cta-split-image, footer-columns, footer-centered: композиция по мотивам, код свой |
| shadcn/ui, https://github.com/shadcn-ui/ui | MIT, Copyright (c) 2023 shadcn | имена токенов темы (background и foreground, primary, muted, card, border, ring), стиль кнопок и карточек в header-floating и cta-card |
