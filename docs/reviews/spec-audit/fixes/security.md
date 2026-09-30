# Fixes — group security (specs/security/**, specs/connectors/**)

| id | status | note |
|---|---|---|
| L3-02 | fixed | data-boundary `region_restriction` (коды 90–95, orgs.region_code/t1_restricted, ИНН + регистрация + офлайн-GeoIP, NULL → T0), constraint `policy_region_restricted`, тесты; список регионов — E-LEGAL |
| L3-03 | fixed | compliance: правило ст. 12/18 ч. 5 до live-T1, уведомление-страховка, Z.ai в политике/согласии; порог инцидента для пропуска на T1; Z.ai `pii` — остаточный риск |
| L3-04 | needs-other | требование записано в data-boundary `detectors.quality.independent_check`; метрику менять в quality/eval.yaml |
| L3-05 | fixed | kinds phone_intl, social_handle, ogrnip (strong), car_plate_ru, person_name_latin; словарь имён народов РФ/СНГ; holdout-корпус ≥ 300 в РФ |
| L3-07 | fixed | compliance: линтер detect() всех видов, брифы партнёров в S3 РФ, CI-артефакты только fixture; data-boundary: условия `record`; eval.yaml — needs-other |
| L3-08 | fixed | connector-interface: allowlist-логгер, `{status, code}`, маски hookToken и `/bot<token>/`; isolation: proxy без path/query; deploy/runtime — needs-other |
| L3-09 | fixed | data-boundary storage_of_content (DBOS без секретов и LLM-контента), compliance `platform.retention` (dbos 30 дн, messages 180 дн); workflows/db/api — needs-other |
| L3-10 | fixed | isolation M0_M1.guards: 421 по Host, 403 на заголовки туннеля; deploy.yaml#local — needs-other |
| L3-11 | fixed | isolation: стартовые гарды для WIZARD_DEV_LOGIN и WIZARD_AUTH_MODE=dev; HMAC/nonce/next — runtime.yaml (needs-other) |
| L3-12 | fixed | isolation: дочерний процесс Node с --permission, только значения контекста через IPC, escape-тест vm_constructor_escape |
| L3-13 | fixed | isolation static_checks_G0.build: G0 до tsc/esbuild, копия ревизии, onResolve, loaders ts/tsx, без define/env; escape-тесты import_env_raw, build_path_escape |
| L3-14 | fixed | abuse#domain: PSL MUST в M2-06, HSTS preload, tenant_separation (cookie по конфигу, CSRF на все не-GET вкл. QR, без CORS); qr csrf; запрет computed `document[...]` в isolation; runtime.yaml и gates G0-SEC-01 — needs-other |
| L3-18 | fixed | isolation `user_files` (POST /api/files, allowlist по сигнатуре, без SVG/HTML, attachment + CSP sandbox, подписанные ссылки, логотип PNG/WebP), compliance (pii basic, retention/anonymize), abuse gov_ids.file_fields; runtime/schema/api — needs-other |
| L3-20 | fixed | isolation db_access: роль `sys_<key>_<env>_system` в M2 вместо GUC; правило `$user.<attr>` в ops.yaml — needs-other |
| L3-21 | fixed | isolation db_access: lint-правило для PgBouncer + интеграционный тест |
| L3-23 | fixed | isolation M2: токен-возможность RPC, без секретов в поде, ≤ 10 систем на под (Free и платные), Spectre-флаги, ротация ≤ 72 ч; escape-тест просроченного токена |
| L3-24 | fixed | isolation proxy: CONNECT только :443 (SMTP 465/587), SNI = CONNECT-хост; email: SSRF-проверка хоста; schema egress pattern — needs-other |
| L3-27 | fixed | yookassa/connector-interface/abuse.report: IP только от доверенного ingress, IPv6 /64; deploy.yaml — needs-other |
| L3-28 | fixed | yookassa: сверка суммы/валюты/recordId, needs_review, переиспользование pending только при той же сумме; лимиты привязки карты — billing.yaml (needs-other), E-LEGAL |
| L3-29 | fixed | email: очистка CR/LF/NUL, RFC 2047, from.name; abuse: reserved_slugs, DMARC p=reject; лимит приглашений и routing — runtime.yaml (needs-other) |
| L3-30 | fixed | qr: генерация только на сервере (FIELD_READONLY), qr_token скрыт от не-владельцев и выгрузки, scannerRoles не public/не саморегистрируемые |
| L3-31 | fixed | abuse: зоны identity/forms/text, ambiguous-имена, connector_allowlist, `срок действия … карт`, `\b(pin|otp)\b`, Unicode-границы, субъект-сущности, `\bрас[аы]\b`, `отпечат(ок|ки|ков)`, allow_required/block_required |
| L3-32 | fixed | abuse: operatorName в зоне identity, `ori_signal` (G2-AF-09 warning); id в gates.yaml — needs-other; ОРИ и регламент — E-LEGAL |
| L3-33 | fixed | compliance consent.login (OTP/Telegram), consent.withdrawal (≤ 30 дней), retention users 3 года, subject_requests MUST; runtime/api — needs-other; тексты — E-LEGAL |
| L3-34 | fixed | compliance: operatorAddress, проверка ИНН, consentTemplateId, единый срок 30 дн (E-LEGAL), subprocessors_of_system; schema/api/gates — needs-other |
| L3-35 | fixed | compliance `platform.beta_readiness` (6 пунктов); milestones M2.exit_criteria и задача backlog — needs-other |
| L3-36 | fixed | compliance platform.retention/документ privacy: удаление систем, бэкапы 14 дн, логи 30 дн; workflows delete_system и DELETE /me — needs-other |
| L3-39 | fixed | data-boundary model_registry по F3: open-weights в РФ допустимы, линтер проверяет provider/baseUrl |
| L3-40 | fixed | лицензии: словарь имён (MIT/CC0/CC-BY + атрибуция), brands (CC0), GeoIP-база; AGENTS.md — needs-other |
| L3-42 | fixed | data-boundary: инвалидация кэша политики и AbortSignal; model_switched только во внутреннем журнале |
| L3-43 | fixed | compliance security_org staff_access (тикет, TTL 24 ч, журнал, уведомление owner); ссылка из abuse takedown |
| L1-03 | fixed | compliance consent: `_consent: {policyVersion, textHash}`, ConsentCheckbox {checked,onChange,testId?}, collectsPii для /api/fn, вехи M0/M2; остальные файлы — needs-other |
| L1-15 | needs-other | data-boundary — сторона-источник; менять models.yaml |
| L1-17 | fixed | data-boundary: constraint `pii_hint` и шаг региона; имена региона — по L3-02 (`t1_restricted`, `policy_region_restricted`), не `t1_blocked`/`policy_region` из L1-17 |
| L1-20 | fixed | qr token.value: генерирует qr-коннектор при insert; runtime.yaml:64 — needs-other |
| L1-23 | fixed | connector-interface §2 «M0» и yookassa m0_stub (pay-mock) |
| L1-26 | fixed | compliance operator: OPERATOR_CONTACT_REQUIRED (+ OPERATOR_ADDRESS_REQUIRED с M2); api/gates — needs-other |
| L1-30 | fixed | isolation ссылается на gates.yaml#G0.forbidden_api как канон; logs → ctx.log.* |
| L1-36 | fixed | telegram: scope `openid telegram:bot_access`; ui-kit/runtime — needs-other |
| L1-46 | fixed | data-boundary: placement=internal, termsCheckedAt у провайдеров |
| L1-47 | fixed | data-boundary `detectors.piiKind_map` |
| L1-48 | fixed | connector-interface: `/_wizard/qr/*` |
| L1-49 | fixed | isolation: 504 TIMEOUT / 422 LIMIT_EXCEEDED |
| L1-50 | fixed | compliance retention: ссылка на compliance.retentionWaiver без оговорки |
| L1-55 | fixed | telegram notify_step: в M1 — validateSpec (G0) |
| L1-57 | fixed | email config: port, secure |
| L1-21, L1-24, L1-32, L1-34, L1-39, L1-40 | needs-other | сторона изменения — examples/backlog/db/runtime/api; в моих файлах правки не нужны (L1-34: логотип — только PNG/WebP по L3-18, а не png/svg) |
| L4-01 | fixed | см. L3-31; тексты макетов 1–10 — в allow_required |
| L4-04 | fixed | data-boundary principles: ветка F2 (T1 по умолчанию только при выигрыше ≥ 10 п. п.) |
| L4-05 | fixed | см. L3-39 (F3) |
| L4-06 | fixed | F4 отражено: compliance consent.login, abuse credentials.rationale, email/telegram заголовки; billing/orchestrator — needs-other |
| L4-13 | fixed | telegram: общий бот платформы по умолчанию (`bot: platform`), свой бот — опция, обязателен для входа |
| L4-14 | fixed | telegram: allowPii удалён; PII-проверка текста всегда |
| L4-19 | fixed | compliance: 30 дней — единый источник (E-LEGAL); orchestrator.yaml#defaults — needs-other |
| L4-23 | fixed | abuse `messages_ru` для G2-AF-*, ORG_SUSPENDED, 451, «Оспорить» |
| L4-29 | fixed | см. L3-02 |
| L4-09, L4-16 | needs-other | UI S10 и escalation.yaml |

## Needs other owner

- **agents/models.yaml**: шаг `orgPolicy.t1Restricted → T0 (reason=policy_region_restricted)` сразу после ruOnly; шаг `containsPiiHint=true → T0 (reason=pii_hint)`; шаг 4 → «strong-виды data-boundary.yaml#detectors + special/biometric»; `providers.<id>.termsCheckedAt`; `model_switched` не в SSE.
- **platform/db.yaml**: `orgs.region_code text`, `orgs.t1_restricted boolean not null default false`; `route_reason` += `policy_region_restricted`, `pii_hint`; `messages` retention (180 дн); deletion_log.mode += `consent_revoked`, `system_deleted`.
- **platform/workflows.yaml**: секреты в воркфлоу только `secret://`, выход LLM-шага — ссылки; очистка `dbos.*` через 30 дней; воркфлоу `delete_system` (L3-09, L3-36).
- **platform/api.yaml**: `provideRunInput` пишет секрет в хранилище в HTTP-обработчике; setCompliance += operatorContact, operatorInn, operatorAddress, consentTemplateId, policyPage; OWNER_ONLY_FIELD; `DELETE /me`; логотип — PNG/WebP (не SVG), растеризация.
- **platform/deploy.yaml**: #local 421/403 (L3-10); логгер allowlist (L3-08); IP клиента из доверенного ingress, IPv6 /64 (L3-27); секрет общего Telegram-бота платформы.
- **platform/billing.yaml**: лимиты привязки карты (≤ 3/сут на org, ≤ 10 на IP, карта ≤ 3 org, 3-DS) (L3-28); SMS только на Старт/Бизнес (F4).
- **runtime/runtime.yaml**: cookie по WIZARD_PUBLIC_SCHEME и дубли → 401, CSRF на все не-GET кроме hooks, без CORS (L3-14); dev-login HMAC+nonce+`next` (L3-11); Telegram OIDC state/nonce/redirect_uri (L3-26); consent на `/api/auth/otp/verify` и callback, `/_wizard/privacy`, `POST /api/auth/consent/revoke` (L3-33); `POST /api/files` (L3-18); qr_token → 422 FIELD_READONLY и генерация коннектором (L3-30, L1-20); reserved slugs, лимит приглашений (L3-29); SMS-лимиты (L3-25); role_spec += compliance.policyVersion, consentTextHash (L1-03); phone_otp только на Старт/Бизнес (F4).
- **quality/gates.yaml**: G0.forbidden_api += computed member на document/navigator/location/window/Reflect/getOwnPropertyDescriptor, `?raw`-импорты, порядок G0 до сборки (L3-13, L3-14); G2-AF-09 (warning, abuse.yaml#patterns.ori_signal); G2-PII-06 (operatorName/Contact/Address); G2-AF-03 на поля file.
- **quality/eval.yaml**: `metrics.pii_leaks` по data-boundary `independent_check` (L3-04); `record` отказывает для брифов вне tools/eval/briefs и demo (L3-07).
- **appspec/appspec.schema.json + ops.yaml**: `compliance.operatorAddress`, `consentTemplateId`; `function.collectsPii`; `egress.items.pattern`; поле file — pii basic по умолчанию; set_compliance от агента — только consentTemplateId/policyPage; `$user.<attr>` в rowFilter (L3-20).
- **appspec/examples/forum.json, bakery.json**: убрать `allowPii` из telegram config (опционально `"bot": "own"`); роли с `phone_otp` на Free не публикуются по F4.
- **milestones.yaml / backlog.yaml**: M2.exit_criteria ← compliance `platform.beta_readiness`; задача «Комплаенс-готовность беты» (owner founder, E-LEGAL). Номер M2-11 одновременно предлагают L3-35 и L4-09 — развести.
- **agents/orchestrator.yaml**: срок по умолчанию для регистрации — 30 дней (L4-19); вход по умолчанию — email OTP и Telegram (F4).
- **ui/ui-kit.yaml**: ConsentCheckbox (L1-03), AppShell.Login с согласием и ссылкой на /_wizard/privacy (L3-33).
- **AGENTS.md / product.yaml#non_goals**: формулировка F3 (API/сервисы вендоров запрещены, open-weights в РФ — допустимы), лицензии инфраструктуры и данных (L3-40).
- **escalation.yaml**: E-ACCESS += общий Telegram-бот платформы, SMS-провайдер.

## CHANGELOG

- security: Z.ai-регионы — orgs.region_code/t1_restricted, route_reason policy_region_restricted, неизвестный регион → T0; список 90–95 до позиции юриста (E-LEGAL).
- security: новые детекторы phone_intl, social_handle, ogrnip (strong), car_plate_ru, person_name_latin; holdout-корпус в РФ; независимая метрика утечек.
- security: F3 — линтер реестра моделей проверяет provider/baseUrl; open-weights в РФ (gpt-oss-120b) допустимы.
- security: DBOS не хранит секреты и LLM-контент; dbos.* — 30 дней, messages (сырые брифы) — scrub через 180 дней.
- security: исполнитель функций M0–M1 — отдельный процесс Node с --permission; G0 до tsc/esbuild, сборка в копии ревизии.
- security: M2 — RPC по токену-возможности, ≤ 10 систем на под workerd, системный доступ через роль sys_*_system вместо GUC.
- security: PSL обязателен в M2-06; CSRF на все не-GET (вкл. QR), cookie по конфигу; зарезервированные slug.
- security: загрузка файлов — allowlist по сигнатуре без SVG/HTML, attachment + CSP sandbox, pii basic по умолчанию; логотип PNG/WebP.
- security: G2-AF переписан против ложных блокировок (зоны, ambiguous, allowlist коннекторов, Unicode-границы), обязательные allow/block-фикстуры, нейтральные messages_ru.
- security: согласие — канон `_consent: {policyVersion, textHash}` (проверка с M0), согласие при первом входе и отзыв (M2); phone OTP только на Старт/Бизнес (F4).
- security: оператор ПДн — operatorContact (M1) и operatorAddress (M2), текст согласия только из шаблона юриста; subprocessors системы выводятся из интеграций.
- security: гейт beta_readiness (РКН ст. 22, хостинг/ОРИ, поручения облаков, письмо Z.ai, ОРД, тексты юриста).
- connectors: Telegram — общий бот платформы по умолчанию, свой бот нужен только для входа; allowPii удалён.
- connectors: ЮKassa — сверка суммы в payment.succeeded (needs_review), IP только от доверенного ingress; M0 pay-mock.
- connectors: email — защита заголовков (CR/LF, RFC 2047) и SSRF для SMTP; QR — qr_token только на сервере и скрыт от не-владельцев.
