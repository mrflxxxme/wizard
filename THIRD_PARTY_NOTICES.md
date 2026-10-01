# Third-party notices

Сторонний код, который попадает в бандлы созданных систем или заимствован в исходники Wizard. Зависимости только для разработки и сборки здесь не перечисляются: их лицензии проверяются по `pnpm-lock.yaml`.

| Пакет | Версия | Лицензия | Где используется |
|---|---|---|---|
| qrcode-generator (Kazuhiko Arase) | 2.0.4 | MIT | `packages/ui-kit`: генерация QR-кодов в бандлах систем; `packages/connectors`: PNG QR во вложениях писем |
| jsQR (cozmo) | 1.4.0 | Apache-2.0 | `packages/ui-kit`: распознавание QR в сканере; `packages/e2e` (dev): декодирование QR-билета в e2e |
| fflate | см. pnpm-lock | MIT | `packages/pii/import`: распаковка xlsx при импорте таблиц (серверная сторона) |
| @faker-js/faker (локаль ru) | см. pnpm-lock | MIT | синтетические строки импорта и seed (серверная сторона, данные не распространяются) |
| Словарь брендов `packages/gates/data/brands.ru.json` | собственная компиляция | CC0 | антифрод G2-AF-04: имена из `specs/security/abuse.yaml#patterns.brands`, домены — собственный список; внешних источников нет |

Заимствования из Chef (Apache-2.0) и bolt.diy (MIT) добавляются сюда вместе с сохранёнными заголовками (AGENTS.md).
