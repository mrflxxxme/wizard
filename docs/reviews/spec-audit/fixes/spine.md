# Исправления аудита — группа spine

Файлы: `specs/product.yaml`, `specs/architecture.yaml`, `specs/milestones.yaml`, `specs/backlog.yaml`, `specs/escalation.yaml`, `specs/README.md`, `AGENTS.md`, `tools/specs/validate.mjs`.
Решения основателя F1–F8 записаны в `product.yaml#decisions` (D17_agent_merge, D2_w0_fallback, D18_western_models, D19_end_user_phone_login, D10_interpretations, D20_eval_budget, D21_beta_moderation, D22_domains), в `escalation.yaml` (merge_policy, E-MONEY.preapproved, calendar) и в `AGENTS.md`.
Статусы задач: M0-01…M0-04 done, M0-05 и M0-07 in_progress (claimed_by pii-agent / sdk-agent). `node tools/specs/validate.mjs`: 0 ошибок, 1 предупреждение (неподдерживаемые ключевые слова JSON Schema — было и до правки).

| id | status | note |
|---|---|---|
| L1-06 | fixed | M0-13: needs_input с кнопками builder.yaml#escalation вместо needs_user |
| L1-12 | fixed | M0-10: «отчёт = GateReport (gates.yaml#report)» |
| L1-17 | fixed | M0-06, interfaces.llm_call: orgPolicy.t1Restricted, routeReason policy_region_restricted (имена по L3-02, не t1Blocked/policy_region) |
| L1-23 | fixed | milestones M0 out_of_scope уточнён; новая M0-28 (connectors: configSchema/validateSpec, QR sign/verify, mock-оплата) |
| L1-24 | fixed | QR online — M0-24 (specs qr.yaml#token/#endpoints/#checkin_algorithm); M2-03 → «QR: офлайн-сканер и синхронизация» |
| L1-33 | fixed | M3-01 specs += platform/api.yaml |
| L1-37 | fixed | depends_on: gates += connectors, pii, ui-kit, build; connectors += pii, appspec; runtime += pii, ui-kit; agents += pii |
| L1-38 | fixed | Сборка — один владелец packages/build (interfaces.build_system, L2-06) вместо gates.buildBundle; плагин wz-id убран из M0-09 |
| L1-39 | fixed | specs задач дополнены; validate.mjs: файл#якорь из acceptance обязан быть в specs задачи |
| L1-40 | fixed | M0-05: заглушки [ТЕЛЕФОН_1], [EMAIL_1], [ФИО_1] |
| L1-52 | fixed | M0-18: tools/eval валидирует по appspec.schema.json; брифы cg-* → gd-* |
| L1-53 | fixed | interfaces.appspec_ops/migration_plan/ddl — по фактическому API packages/appspec |
| L1-55 | fixed | M1-06: validateSpec (G0) в M1, G2-TG-01 в M2 |
| L1-58 | fixed | interfaces.preview_bridge: wz-id проставляет packages/build в M0 |
| L2-01 | fixed | M0-21 (золотые фикстуры), deps M0-12/M0-13, eval.yaml#fixtures в specs M0-06 |
| L2-02 | fixed | escalation merge_policy + E-EXTERNAL.not; AGENTS п.6 |
| L2-03 | fixed | status/claimed_by во всех задачах; проверка в validate.mjs |
| L2-04 | fixed | M0-26 acceptance (seed, dev-пользователи); шаги migrate_draft/seed_draft — needs-other |
| L2-05 | fixed | interfaces: gate_context, runtime_handle, build_system, agent_host, usage_sink, data_access, connectors, types |
| L2-06 | fixed | packages/build + M0-20; tsconfig.system в sdk.md — needs-other |
| L2-07 | fixed | M0-11 acceptance (AC5/AC6 skip), milestones out_of_scope; forum.json/gates/runtime — needs-other |
| L2-08 | fixed | M0-27; stack.dev_exec (tsx); packages/e2e |
| L2-09 | fixed | M0-09 разделена на M0-09/M0-23/M0-24 с точками монтирования |
| L2-10 | fixed | M0-15 автономно (deps M0-03, M0-20); интеграция — M0-26 |
| L2-11 | fixed | M0-16 deps [M0-08], приёмка по test_ids на мок-API |
| L2-12 | fixed | M0-08 (основа) + M0-25 (компоненты) |
| L2-13 | fixed | M0-10 deps + мягкий порог времени (жёсткий 60 с) |
| L2-14 | fixed | interfaces.agent_host (цикл в runBuild); workflows.yaml#build — needs-other |
| L2-15 | fixed | generateSeed в packages/gates (interfaces.gates), M0-11 deps |
| L2-16 | fixed | M0-14 acceptance по SC на каждый AC |
| L2-17 | fixed | interfaces.types: реализация в appspec, sdk реэкспортирует; sdk.md#4 — needs-other |
| L2-18 | fixed | M0-18 fixture в CI, live вручную; E-ACCESS в день 0 (calendar, milestones M0) |
| L2-19 | fixed | sub-path exports agents, AGENTS п.7, .gitattributes — в M0-19 |
| L2-20 | fixed | M0-27: e2e-джоб с playwright install |
| L2-21 | fixed | estimate_days по L2 §5 |
| L2-22 | fixed | M0-06 acceptance, usage_sink; eval.yaml#fixtures.lookup — needs-other |
| L2-23 | fixed | M0-19 (slice.mjs), якоря в specs, AGENTS п.2, проверка якорей в validate.mjs уже сделана |
| L2-24 | fixed | M0-15: тест колонок по db.yaml |
| L2-25 | fixed | M0-15: ajv + свой сопоставитель путей |
| L2-26 | fixed | кондитерская до G0 в M0, e2e S9 — M1 (milestones out_of_scope, M0-17) |
| L2-27 | needs-other | gates.yaml: warning-проверки since: M1 (в M0-10 уже так) |
| L2-28 | needs-other | runtime.yaml: rate limits/CSP/PWA/OTP since: M1 (milestones out_of_scope уже так) |
| L2-29 | needs-other | platform-screens#preview_contract: «M0 — dev-login без токена; HMAC — M2» |
| L2-30 | fixed | M0-05: ≥50 жёстких негативов, встроенный словарь ≥300+300 |
| L2-31 | fixed | M0-25: tsc на examples/ui |
| L3-01 | fixed | M0-29 (literal, fuzz, роль мигратора), data_stores.db_roles, M0-26/M0-11 deps; ops.yaml#migrations — needs-other |
| L3-02 | fixed | M0-06 (fail-safe T0), M1-02 (region_code, t1_restricted), E-LEGAL список регионов |
| L3-03 | fixed | M2-13 + escalation E-LEGAL; compliance.yaml#platform.rules — needs-other |
| L3-04 | fixed | M0-18 канарейки; eval.yaml#metrics.pii_leaks — needs-other |
| L3-05 | fixed | M1-07 acceptance; data-boundary kinds — needs-other |
| L3-06 | fixed | M0-13 (маскирование spec.json), M0-29 (OWNER_ONLY_FIELD) |
| L3-07 | fixed | M0-06 (record), M0-27 (артефакты CI), M2-12 (брифы партнёров в РФ) |
| L3-08 | fixed | M1-01 acceptance; deploy.yaml — needs-other |
| L3-09 | fixed | M1-01 acceptance; workflows/db — needs-other |
| L3-10 | fixed | M0-09, M0-15 acceptance; deploy.yaml#local — needs-other |
| L3-11 | fixed | M0-09 (гарды dev-login), M2-06 (preview-login HMAC+nonce) |
| L3-12 | fixed | M0-23 acceptance; isolation.yaml — needs-other |
| L3-13 | fixed | M0-20 (onResolve, escape-тест), M0-10 (G0-IMP до сборки) |
| L3-14 | fixed | M0-09 (Origin на все не-GET), M1-05 (__Host-wz_sess), M2-06 (PSL, HSTS), M0-10 (G0-SEC-01) |
| L3-15 | fixed | M2-06 acceptance |
| L3-16 | fixed | M0-16, M0-10, M3-01 |
| L3-17 | fixed | M1-02 (IDOR, cookie), M1-11 (CSP) |
| L3-18 | fixed | новая M2-14 (файлы) |
| L3-19 | fixed | M2-06 |
| L3-20 | fixed | M0-29 ($user.<attr>), M2-01 (системная роль) |
| L3-21 | fixed | AGENTS.md, M0-27 (CI), M2-06 (тест PgBouncer) |
| L3-22 | fixed | M2-04 |
| L3-23 | fixed | M2-01 |
| L3-24 | fixed | M1-06, M2-01; schema egress pattern — needs-other |
| L3-25 | fixed | M1-05 |
| L3-26 | fixed | M1-05 |
| L3-27 | fixed | M2-06 |
| L3-28 | fixed | M2-02, M2-07; E-LEGAL в escalation |
| L3-29 | fixed | M1-06 |
| L3-30 | fixed | M0-24 (readonly), M2-03 (скрытие, scannerRoles) |
| L3-31 | fixed | M2-04 allow-фикстуры; abuse.yaml правила — needs-other |
| L3-32 | fixed | M2-04; E-LEGAL |
| L3-33 | fixed | M2-05 (deps += M1-05) |
| L3-34 | fixed | M2-05; E-LEGAL |
| L3-35 | fixed | milestones M2 exit, новая M2-13 beta_readiness (owner founder), M2-09 deps += M2-13; отдельно от блока ПДн S10 (M2-11) |
| L3-36 | fixed | M2-05 (delete_system) |
| L3-37 | fixed | M2-10 (formula injection, ссылка ≤15 мин), M1-07 (лимиты xlsx) |
| L3-38 | fixed | M2-06 |
| L3-39 | fixed | F3: non_goals, D18_western_models, AGENTS.md; gpt-oss-120b остаётся; линтер реестра по провайдеру — needs-other |
| L3-40 | fixed | AGENTS.md (инфраструктура, данные, Chef NOTICE), M0-27 (FSL-проверка) |
| L3-41 | fixed | M3-02 |
| L3-42 | fixed | M1-07 |
| L3-43 | fixed | M2-08 |
| L4-01 | fixed | M2-04 allow-фикстуры по макетам; abuse.yaml#brands — needs-other |
| L4-02 | fixed | новые M1-11 (S10 и M1-части S1/S3/S4/S6/S7, вход) и M2-11 (деньги, выгрузка, ПДн) |
| L4-03 | fixed | M2 exit: партнёры подключены; реальное событие — в M3 exit |
| L4-04 | fixed | F2: D2_w0_fallback, M0-30, not_escalations |
| L4-05 | fixed | F3 (см. L3-39) |
| L4-06 | fixed | F4: D19, differentiators.independence, M1-05; умолчание входа в orchestrator и раздел sms в billing — needs-other |
| L4-07 | fixed | M3-02 specs и acceptance; runtime.yaml#ai_actions — needs-other |
| L4-08 | fixed | M2-10 (spec.json), M2-11; api.yaml эндпоинт — needs-other |
| L4-09 | fixed | M2-11; блок в S10 — needs-other |
| L4-10 | fixed | M1-11 (вход, приглашение), M2-11 (тариф, карта); экраны в platform-screens — needs-other |
| L4-11 | fixed | M1-04 draft_snapshot (вариант а); шаг в workflows — needs-other |
| L4-12 | fixed | M2-14 |
| L4-13 | fixed | M1-06 (общий бот платформы по умолчанию, свой — только для входа), E-ACCESS calendar; telegram.yaml — needs-other |
| L4-14 | needs-other | telegram.yaml: убрать allowPii |
| L4-15 | fixed | F6: D20_eval_budget, E-MONEY.preapproved, M1-10; режимы в eval.yaml — needs-other |
| L4-16 | fixed | escalation.calendar, E-ACCESS дополнен, E-DOMAIN убран (architecture.domains) |
| L4-17 | fixed | F5: D10_interpretations; deploy.yaml (удалять только draft-схему Free) — needs-other |
| L4-18 | fixed | M2-06 на нейтральном домене (F8), M4-01 без «домены» |
| L4-19 | needs-other | orchestrator/compliance срок 30 дней; вопрос в E-LEGAL.open_items |
| L4-20 | fixed | M1-11: общая строка «Часть шагов выполнена на моделях в РФ»; platform-screens — needs-other |
| L4-21 | needs-other | orchestrator: тексты кнопок по макетам |
| L4-22 | needs-other | platform-screens.stack: список латинских меток |
| L4-23 | needs-other | abuse.yaml#messages_ru |
| L4-24 | needs-other | builder/ops: шаблоны human_diff |
| L4-25 | needs-other | appspec.schema: monthlyLimit обязателен |
| L4-26 | needs-other | api.yaml: analysis, логотип |
| L4-27 | fixed | M2-12 (p80 времени); ширины превью в S4 — needs-other |
| L4-28 | fixed | M0-18 (≥4 из 12), M2-12 (≥10 из 30) |
| L4-29 | fixed | = L3-02 |
| L4-30 | fixed | M1-12, M2-12, M3-03 |
| L4-31 | needs-other | gates: warning на выдуманные данные |

## Needs other owner

- `specs/platform/workflows.yaml`: шаги `migrate_draft`, `seed_draft`, `bundle_and_reload` (L2-04); #build описывает только имена шагов, цикл — в runBuild (interfaces.agent_host, L2-14); шаг `draft_snapshot` в publish/M1-04 (L4-11); DBOS: секреты только ссылками, очистка dbos.* 30 дней (L3-09); `delete_system` (L3-36).
- `specs/quality/gates.yaml`: G0-BUILD-01 вызывает `packages/build: buildSystem` (L1-38/L2-06), warning-проверки `since: M1` (L2-27), G1-AC-COVER по check.milestone (L2-07), G0-IMP до сборки и G0-SEC-01 computed member/parent/top/opener (L3-13, L3-14, L3-16).
- `specs/ui/ui-kit.yaml#wz_id.injection` и `tasks`: плагин живёт в packages/build; tasks += M0-25. `specs/runtime/runtime.yaml`: заголовок tasks += M0-23, M0-24; artifact_layout += wz-map.json (draft); since: M1 для rate limits/CSP/PWA/OTP (L2-28); workflows.execution M0 = outbox (L2-07); гарды dev-login, Origin для всех не-GET, qr_token readonly (L3-11, L3-14, L3-30); `#ai_actions` (L4-07).
- `specs/runtime/sdk.md`: §1.1 tsconfig.system и jsx-runtime (L2-06); §4 generateTypes реэкспорт из appspec (L2-17).
- `specs/quality/eval.yaml`: `#fixtures.lookup` для suite=demo, `golden`, имя `demo/bakery.jsonl` (L2-01, L2-22); record только для известных брифов и scrub T0 (L3-07); pii_leaks по канарейкам (L3-04); режимы nightly_smoke/full и потолок 30 000 ₽ (F6, L4-15); формат брифов gd-* (L1-52).
- `specs/agents/models.yaml`: параметр уровня сборки по умолчанию T1|T0 (F2, M0-06/M0-30); шаг routing_algorithm «orgPolicy.t1Restricted ≠ false → T0, policy_region_restricted» (L3-02; L1-17 предлагал t1Blocked/policy_region — выбрано имя L3-02); gpt-oss-120b остаётся (F3). `specs/platform/db.yaml`: orgs.region_code, orgs.t1_restricted, route_reason += policy_region_restricted, pii_hint. `specs/security/data-boundary.yaml`: routing.constraints ссылкой на этот шаг, model_registry-линтер по провайдеру (F3), новые kinds (L3-05).
- `specs/appspec/ops.yaml`: #migrations — literal(value, fieldType), роль мигратора (L3-01); $user.<attr> только readonly-атрибуты (L3-20); set_compliance от агента → OWNER_ONLY_FIELD (L3-06). `appspec.schema.json`: egress pattern (L3-24), operatorAddress (L3-34), aiAction.monthlyLimit обязателен (L4-25). `examples/forum.json`: AC5 milestone M2, AC6 M1; `bakery.json` AC7 M1 (L2-07).
- `specs/platform/deploy.yaml`: Host allowlist 421 / forwarded 403 (L3-10); логгер allowlist (L3-08); доверенный ingress для IP (L3-27); self-hosted runner, SBOM (L3-38); Free-черновики: удалять только draft-схему (F5); домены по F8; `__Host-wizard_session` без Domain (L3-17).
- `specs/ui/platform-screens.yaml`: `tasks` += M0-30, M1-11, M1-12, M2-11; экраны S-auth, S-invite, S-billing, блок «Персональные данные» в S10 (L4-09, L4-10); preview_contract M0 без токена (L2-29); zod-валидация сообщений превью (L3-16); CSP платформы (L3-17); фолбэк-строка и «Сборка: модели в РФ» (L4-20, F2); латинские метки (L4-22); ширины 390/768/1280 (L4-27).
- `specs/platform/api.yaml`: выгрузка (exports, spec.json, ссылка ≤15 мин), логотип, analysis (L4-08, L4-26, L3-37). `specs/connectors/telegram.yaml`: общий бот, без allowPii (L4-13, L4-14). `specs/security/abuse.yaml`: brands/patterns (L4-01, L3-31), messages_ru (L4-23), PSL в M2-06 (L3-14). `specs/security/compliance.yaml`: правило T1 до позиции юриста (L3-03), согласие при входе и отзыв (L3-33), staff-доступ (L3-43). `specs/agents/orchestrator.yaml`: умолчание входа — почта и Telegram (F4), срок хранения 30 дней (L4-19), тексты кнопок (L4-21). `specs/platform/billing.yaml`: phone OTP только Старт/Бизнес и бюджет SMS (F4, L3-25), лимиты привязки карты (L3-28).
- Корень репозитория: `.gitattributes` (`specs/CHANGELOG.md merge=union`) — поручено задаче M0-19.

## CHANGELOG

- 2026-09-30 · spine · Записаны решения основателя F1–F8: product.yaml#decisions D17–D22, D2_w0_fallback, D10_interpretations; F5–F8 приняты по рекомендации аудита L4, основатель может пересмотреть.
- 2026-09-30 · spine · F1: PR агентов мержатся auto-merge при зелёном CI; исключения — escalation.yaml#merge_policy (метка founder-review). AGENTS.md «Порядок работы» переписан под захват задач и PR.
- 2026-09-30 · spine · F3: запрет касается API и сервисов Anthropic/OpenAI/Google/xAI; открытые веса с инференсом в РФ (gpt-oss-120b в Cloud.ru) допустимы — non_goals и AGENTS.md (закрывает L3-39, L4-05).
- 2026-09-30 · spine · В backlog добавлены status/claimed_by (M0-01…04 done; M0-05, M0-07 in_progress); validate.mjs проверяет статусы, владельцев, якоря specs, якоря из acceptance, волны M0 и циклы depends_on.
- 2026-09-30 · spine · Граф M0 по L2 §3–5: разделены M0-08 (+M0-25) и M0-09 (+M0-23, M0-24); новые M0-19…M0-27; волны m0-w0…m0-w6, критический путь ≈12 агенто-дней (milestones M0.plan).
- 2026-09-30 · spine · Новые M0-28 (ядро connectors, L1-23), M0-29 (усиление литералов и ролей миграций, L3-01/L3-20/L3-06), M0-30 (применение итога eval недели 0 по F2).
- 2026-09-30 · spine · architecture.yaml#interfaces приведены к фактическому API packages/appspec (applyOps → {ok, spec, version, revision} | {ok:false, errors}; toDDL включает RLS и GRANT и бросает при plan.errors); добавлены gate_context, runtime_handle, build_system, agent_host, usage_sink, data_access, connectors, types.
- 2026-09-30 · spine · Новые пакеты packages/build (единственный владелец сборки и wz-id, вместо gates.buildBundle из L1-38) и packages/e2e; stack.dev_exec = tsx; depends_on дополнены по L1-37.
- 2026-09-30 · spine · Регион организации: имена orgPolicy.t1Restricted и routeReason policy_region_restricted (L3-02), fail-safe в T0; L1-17 (t1Blocked/policy_region) приведён к этим именам.
- 2026-09-30 · spine · M2 exit: «партнёры подключены» вместо «провели событие» (перенесено в M3); добавлена комплаенс-готовность до первого реального пользователя (M2-13, owner founder, E-LEGAL).
- 2026-09-30 · spine · Новые задачи по L4: M1-11 (UI S10 и M1-части экранов), M1-12 (UI импорта), M2-11 (UI денег, выгрузки, ПДн), M2-12 (30 брифов), M3-03 (резерв на обратную связь); файлы — M2-14 (L3-18).
- 2026-09-30 · spine · escalation.yaml: календарь действий основателя, E-ACCESS += SMS, DNS API, Artifact Registry; E-DOMAIN упразднён (домены — D22_domains + E-NAME); E-LEGAL.open_items по L3.
- 2026-09-30 · spine · F4: вход по телефону в системах — только Старт/Бизнес, проверка тарифа при публикации (billing/runtime), не в схеме; M1-05 зависит от M1-02. Telegram: общий бот уведомлений платформы по умолчанию, свой бот — только для входа.
