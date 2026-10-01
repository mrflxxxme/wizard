# Third-party notices

Сторонний код, который попадает в бандлы созданных систем или заимствован в исходники Wizard. Зависимости только для разработки и сборки здесь не перечисляются: их лицензии проверяются по `pnpm-lock.yaml`.

| Пакет | Версия | Лицензия | Где используется |
|---|---|---|---|
| qrcode-generator (Kazuhiko Arase) | 2.0.4 | MIT | `packages/ui-kit`: генерация QR-кодов в бандлах систем; `packages/connectors`: PNG QR во вложениях писем |
| jsQR (cozmo) | 1.4.0 | Apache-2.0 | `packages/ui-kit`: распознавание QR в сканере; `packages/e2e` (dev): декодирование QR-билета в e2e |
| fflate | см. pnpm-lock | MIT | `packages/pii/import`: распаковка xlsx при импорте таблиц (серверная сторона) |
| @faker-js/faker (локаль ru) | см. pnpm-lock | MIT | синтетические строки импорта и seed (серверная сторона, данные не распространяются) |
| @dbos-inc/dbos-sdk (DBOS Transact TS) и его зависимости pg, pg-pool, pg-protocol, pg-types (MIT), superjson, copy-anything, is-what (MIT), serialize-error (MIT), ws (MIT), commander (MIT), yaml (ISC) | см. pnpm-lock | MIT | `apps/worker`: durable-воркфлоу прогонов; `apps/platform-api`: постановка прогонов в очередь (DBOSClient). Серверная сторона, в бандлы систем не попадает |
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
