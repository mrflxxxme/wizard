# Исправления аудита — группа appspec

Файлы: `specs/appspec/**`, `packages/appspec/**`. Проверки: `pnpm --filter @wizard/appspec test` (378 тестов, включая реальный Postgres), `tsc` для appspec/sdk/gates/connectors, `biome check packages/appspec`, `node tools/specs/validate.mjs` — 0 ошибок.

| id | status | note |
|---|---|---|
| L1-01 | fixed | forum/bakery: `actors` перенесены из `steps[0]` в `check.actors`. Схема: шаг — `minProperties 1, maxProperties 2, propertyNames {as…expect, consent}`, `consent: const true` только рядом с create/callFn; `steps` 1..40; alias `^[a-z][a-z0-9_]*$`. Зеркало в zod |
| L1-03 | fixed | часть appspec: `function.collectsPii` (схема, zod, ops.yaml add_function); `consent: true` — ключ шага рядом с `create`/`callFn` (форма из L1-01); проставлен в AC форума (AC1, AC3–AC6) и кондитерской (AC2–AC4, AC6, AC7); registerTicket/placeOrder `collectsPii: true`. Остальное — needs-other |
| L1-04 | fixed | правка appspec не нужна: `ui/Landing.tsx` соответствует sdk.md (`ui/**/<Page>.tsx`); к `page.file` добавлено описание (рекомендуемо `ui/pages/`). builder/gates — needs-other |
| L1-21 | fixed | forum: organizer × checkin → `["read", "create"]` |
| L1-22 | fixed | forum AC5 `check.milestone: "M2"`; правило skip в G1 — needs-other (gates) |
| L1-23 | needs-other | в appspec правок нет (connector-interface.md, platform-screens) |
| L1-26 | needs-other | ops.yaml — источник; api.yaml/gates.yaml правят другие |
| L1-31 | fixed | ops.yaml add_role/update_role `+ selfSignup?`; forum participant, speaker и bakery customer → `selfSignup: true` |
| L1-47 | needs-other | piiKind — источник, правок в appspec нет |
| L1-52 | needs-other | eval (tools/eval, eval.yaml) |
| L1-53 | needs-other | ops.yaml уже в нужной форме; правит architecture.yaml |
| L1-57 | needs-other | email.yaml#config_schema (`port`, `secure`) |
| L2-07 | fixed | forum AC6 `milestone: "M1"`, bakery AC7 `milestone: "M1"`; G1/runtime — needs-other |
| L2-17 | needs-other | generateTypes остаётся в appspec; sdk/codegen реэкспортирует (sdk.md, packages/sdk) |
| L3-01 | fixed | единственная точка SQL-значений `src/sql.ts`: `sqlLiteral(value, type)` (проверка типа и формата, `'`→`''`, запрет NUL и одиночных суррогатов, без E'' и $$), `quoteIdent` (≤63 байт, без NUL), `dollarQuote`; скрипты начинаются с `SET LOCAL standard_conforming_strings = on`; семантика отклоняет default/min/max/литералы rowFilter, которые не кодируются; `toDDL(..., {migrationRole})` — `CREATE SCHEMA … AUTHORIZATION` + `SET LOCAL ROLE`. Fuzz-тест `test/sql-injection.test.ts`: 300 враждебных строк, simple protocol, `standard_conforming_strings=off` перед скриптом, проверка по владельцу объектов и canary-схеме; мутационная проверка (без экранирования) роняет 8 тестов. Роли в deploy/isolation — needs-other |
| L3-06 | fixed | ops.yaml + applyOps: `set_compliance` от `author=agent` (по умолчанию) — только `consentTemplateId`, `policyPage`; остальное → `OWNER_ONLY_FIELD`. Новое поле `compliance.consentTemplateId`. builder.yaml (маскирование spec.json, set_compliance(consentTemplateId)) и шаблоны в compliance.yaml — needs-other |
| L3-18 | deferred | схема/ops.yaml: `file` хранит только ключ, загрузка — с M2-01; `theme.logoFile` только `.png`/`.webp`. `pii: basic` по умолчанию для file — к M2-01 (иначе ломается bakery `product.photo`) |
| L3-20 | fixed | `$user.<attr>` в rowFilter: только id, role, phone, email, telegram_id; `display_name` → INVALID_ROW_FILTER (ops.yaml + semantic). Роль `sys_<key>_<env>_system` (M2) — needs-other (isolation.yaml) |
| L3-24 | fixed | `function.egress.items.pattern` (FQDN без IP/порта/wildcard) в схеме и zod; прокси/SMTP — needs-other |
| L3-30 | needs-other | runtime/qr.yaml; эталоны уже соответствуют (scannerRoles не public и не selfSignup) |
| L3-34 | fixed | `compliance.operatorAddress` (≤300) в схеме, zod, set_compliance и эталонах; правило «до prod» — с M1. Контрольная сумма ИНН (G2) и срок хранения по умолчанию — E-LEGAL, needs-other |
| L3-41 | deferred | M3 (runtime_ai лимиты для public-роли) — runtime/models |
| L4-12 | deferred | то же, что L3-18 (хранение файлов — M2-01) |
| L4-24 | needs-other | шаблоны diff живут в builder.yaml#human_diff |
| L4-25 | fixed | `aiAction.monthlyLimit` обязателен (схема, zod); по умолчанию строитель ставит 50 |
| rowFilterOps | fixed | zod + ops (set_permission), семантика (⊆ ops, только с rowFilter, public update/delete должны быть покрыты), toRLS (rowFilter только для перечисленных ops); тесты unit + Postgres |
| extra: имена индексов | fixed | `ix_<table>$<col>…` вместо `_`: `ticket`+`type_x` и `ticket_type`+`x` давали одно имя, и `CREATE INDEX IF NOT EXISTS` молча пропускал второй (в т.ч. UNIQUE) |
| orchestrator: L4-14 | fixed | `allowPii` удалён из telegram-интеграций эталонов |
| orchestrator: F4 | fixed | эталоны работают на Free: participant, volunteer, customer, staff → `email_otp, telegram`; в ops.yaml — «phone_otp допустим схемой, тариф проверяют billing/runtime» |

## Needs other owner

- **quality/gates.yaml#scenario_dsl.Step**: добавить модификатор `consent: true` — ключ шага рядом с `create`/`callFn` (не внутри объекта действия), максимум 2 ключа; так в схеме и эталонах. G1: AC с `check.milestone` позже текущей вехи → skip (L1-22, L2-07). G0-SPEC-05: правило selfSignup (L1-31). G2-PII-06: operatorName, operatorContact, с M1 — operatorAddress; operatorInn — контрольная сумма (L3-34).
- **tools/specs/validate.mjs**: встроенный валидатор не знает `propertyNames, minProperties, maxProperties, dependentSchemas, if, then` (WARN, проверка шагов неполная) — перейти на ajv 2020.
- **packages/sdk** (типы из `@wizard/appspec` изменились): `Permission.rowFilterOps` теперь в типе (расширение `PermissionWithOps` можно убрать); `AppFunction.collectsPii` — host требует `_consent` для таких функций от ролей без isAdmin; `Compliance.consentTemplateId/operatorAddress`; `AiAction.monthlyLimit` обязателен; `theme.logoFile` только png/webp; экспорт `ROW_FILTER_USER_ATTRS` для $user.<attr>; реэкспорт generateTypes (L2-17). sdk/gates/connectors typecheck зелёный.
- **runtime/runtime.yaml**: permissions.algorithm и rls_policy_shape — учитывать rowFilterOps; :122 — саморегистрация только при `selfSignup=true` (L1-31); `/api/fn` функций с `collectsPii` требует `_consent` (L1-03); $user.<attr> — список из ops.yaml (L3-20); файлы — M2-01 (L3-18).
- **platform/deploy.yaml, security/isolation.yaml** (L3-01): wizard_owner — не владелец схемы platform и не superuser; M2 — мигратор `sys_owner_<key>_<env>` (`toDDL({migrationRole})`); мигратор шлёт каждый оператор отдельным вызовом extended protocol (иначе внедрённый COMMIT сбросил бы `SET LOCAL ROLE`).
- **agents/builder.yaml**: set_compliance агента — только `consentTemplateId`, `policyPage`; `read_file('spec.json')` маскирует operator*, consentText, retentionWaiver.reason (L3-06); шаблоны diff для всех ops (L4-24).
- **security/compliance.yaml**: реестр шаблонов согласия (`consentTemplateId`, подстановка consentText платформой, author=system); адрес оператора в политике (L3-34).
- **platform/api.yaml**: setCompliance — `operatorAddress`, `consentTemplateId`; код ошибки `OWNER_ONLY_FIELD` (L3-06, L1-26).
- **connectors/telegram.yaml**: удалить `allowPii` (L4-14; эталоны уже без него). **connectors/email.yaml**: `port`, `secure` (L1-57).

## CHANGELOG

- 2026-09-30 · audit-fix · appspec: `actors` сценариев — поле `check.actors`; шаг DSL — одно действие + `consent: true` для create/callFn; steps 1..40 (L1-01, L1-03).
- 2026-09-30 · audit-fix · appspec: `function.collectsPii`; registerTicket и placeOrder помечены, AC эталонов передают согласие (L1-03).
- 2026-09-30 · audit-fix · appspec: эталоны — organizer×checkin +create (L1-21); milestone AC5=M2, AC6=M1 форума, AC7=M1 кондитерской (L1-22, L2-07); selfSignup у participant, speaker, customer (L1-31).
- 2026-09-30 · audit-fix · appspec: ops add_role/update_role принимают selfSignup (L1-31).
- 2026-09-30 · audit-fix · appspec: значения спеки попадают в SQL только через sqlLiteral/quoteIdent (src/sql.ts), standard_conforming_strings=on в каждом скрипте, fuzz-тест на Postgres (L3-01).
- 2026-09-30 · audit-fix · appspec: toDDL({migrationRole}) — схема AUTHORIZATION роли системы и SET LOCAL ROLE (L3-01, M2 sys_owner_<key>_<env>).
- 2026-09-30 · audit-fix · appspec: set_compliance от агента — только consentTemplateId и policyPage, иначе OWNER_ONLY_FIELD; поля compliance.consentTemplateId, operatorAddress (L3-06, L3-34).
- 2026-09-30 · audit-fix · appspec: $user.<attr> в rowFilter — только id, role, phone, email, telegram_id (L3-20).
- 2026-09-30 · audit-fix · appspec: egress — FQDN без IP/порта/wildcard (L3-24); logoFile — только PNG/WebP; file — только ключ до M2-01 (L3-18).
- 2026-09-30 · audit-fix · appspec: aiAction.monthlyLimit обязателен, по умолчанию 50 (L4-25).
- 2026-09-30 · spine-decision · rowFilterOps реализован в packages/appspec: ⊆ ops, только с rowFilter; RLS применяет rowFilter только к перечисленным ops.
- 2026-09-30 · self-decision · имена индексов и UNIQUE: `<prefix>_<table>$<col>…` — устранена коллизия имён между таблицами (ticket+type_x / ticket_type+x).
- 2026-09-30 · audit-fix · эталоны: без telegram.allowPii (L4-14); вход конечных ролей — email_otp и telegram, чтобы работать на Free (F4).
