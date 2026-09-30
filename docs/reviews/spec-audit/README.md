# Мультилинзовый аудит спек — итоги (2026-09-30)

Четыре линзы проверили `specs/` и `AGENTS.md`. Пять групп исправили находки параллельно, затем прошла сверка. Итог сверки: `node tools/specs/validate.mjs` — 0 ошибок, 0 предупреждений. Решения записаны в `specs/CHANGELOG.md`, раздел «2026-09-30 — исправления по мультилинзовому аудиту».

## Сводка по линзам

| Линза | Отчёт | Находок | Исправлено в спеках | Реализация перенесена в задачи | Нужен юрист (E-LEGAL) |
|---|---|---:|---:|---|---:|
| L1 — согласованность | [L1-consistency.md](L1-consistency.md) | 58 | 58 | L1-52: переименование брифов cg-* → gd-* (M0-18) | 0 |
| L2 — исполнимость | [L2-executability.md](L2-executability.md) | 31 | 31 | L2-17: генератор типов переезжает в appspec (M0-29); L2-18 (M0-18) | 0 |
| L3 — безопасность и 152-ФЗ | [L3-security.md](L3-security.md) | 43 | 43 | L3-18: файлы (M2-14); L3-41: ИИ-действия (M3-02) | 8 (L3-02, 03, 06, 28, 32, 33, 34, 35) |
| L4 — соответствие концепции | [L4-fidelity.md](L4-fidelity.md) | 31 | 31 | L4-12: файлы (M2-14) | 1 (L4-19) |
| Известные расхождения | [known-issues.md](known-issues.md) | 11 | 11 (статус — L1, раздел «Статус известных расхождений») | — | — |

«Исправлено в спеках» значит, что нормативный текст поправлен. Код появится в задачах `specs/backlog.yaml`, а их критерии приёмки ссылаются на номера находок. Для пунктов, которые ждут юриста, в спеках записано безопасное поведение по умолчанию: до ответа юриста — T0 и строгий вариант.

## Журналы исправлений

| Группа | Журнал | Файлы |
|---|---|---|
| spine | [fixes/spine.md](fixes/spine.md) | product, architecture, milestones, backlog, escalation, README, AGENTS.md |
| appspec | [fixes/appspec.md](fixes/appspec.md) | appspec.schema.json, ops.yaml, examples |
| security | [fixes/security.md](fixes/security.md) | security/*, connectors/* |
| agents-quality | [fixes/agents-quality.md](fixes/agents-quality.md) | agents/*, quality/* |
| platform-runtime-ui | [fixes/platform-runtime-ui.md](fixes/platform-runtime-ui.md) | platform/*, runtime/*, ui/* |
| M0-05 (pii) | [fixes/pii-M0-05.md](fixes/pii-M0-05.md) | заметки реализации packages/pii |
| M0-07 (sdk) | [fixes/sdk-M0-07.md](fixes/sdk-M0-07.md) | заметки реализации packages/sdk |

На сверке закрыты все пункты «Needs other owner» из журналов. Главные правки:
- в гейтах: `consent`, пропуск вех, правила G0-SPEC-05/06, G2-PII-06;
- фолбэк: общая строка для пользователя;
- retention: с M1, режим `deletion_log.mode=retention`;
- оркестратор: `text`, `summary`, `payload.analysis`;
- `.env.example` синхронизирован с `deploy.yaml`;
- эндпоинты runtime в `architecture.yaml`;
- единые имена `region_code` / `t1_restricted` / `policy_region_restricted`;
- единый формат `_consent {policyVersion, textHash}`;
- логотип — только PNG/WebP;
- вход по телефону — только на платных тарифах (F4).

## Решения основателя

- F1–F4 приняты основателем.
- F5–F8 приняты по рекомендации аудита, основатель может их пересмотреть.
- Суточный бюджет SMS (100 на Старте, 300 на Бизнесе) выбран агентами и тоже может быть пересмотрен.

Подробности — в `specs/product.yaml#decisions` и `specs/CHANGELOG.md`.

## Открытые вопросы E-LEGAL (`specs/escalation.yaml#escalations`, E-LEGAL.open_items; бриф — `docs/week0/lawyer-brief.md`)

1. Регионы, запрещённые Z.ai, и источники региона организации (L3-02). До ответа неизвестный регион → T0.
2. Ст. 12 и ст. 18 ч. 5 152-ФЗ для T1 в Сингапуре с учётом 265-ФЗ. Порог «инцидента» при пропуске детектором (L3-03). Ответ нужен до первого live-вызова T1 с данными не-основателя.
3. Привязка карты как идентификация по ПП 2011 (L3-28, M2-07).
4. ОРИ по 149-ФЗ ст. 10.1, статус провайдера хостинга, регламент запросов госорганов (L3-32, L3-35).
5. Тексты согласия и отзыва, адрес оператора, срок хранения ПДн по умолчанию — 30 или 90 дней, пока 30 (L3-33, L3-34, L4-19).
6. Уведомление РКН по ст. 22, поручения Cloud.ru и Yandex, письмо Z.ai (L3-35, M2-13).
7. Чек 54-ФЗ на частичную предоплату — вопрос из CHANGELOG runtime-agent.

## Действия основателя (`specs/escalation.yaml#calendar`)

- **Неделя 0:**
  - реквизиты юрлица;
  - `CLOUDRU_API_KEY` и `ZAI_API_KEY` в GitHub Secrets для eval недели 0 (F2);
  - покупка нейтрального домена систем (F8);
  - нанять юриста и передать ему бриф;
  - заявка в Cloud.ru, включая вопрос про gVisor;
  - 6–8 дизайн-партнёров.
- **К M1:**
  - законный способ оплаты Z.ai;
  - ключ Yandex AI Studio;
  - SMS-провайдер (ключ; имя отправителя — к неделе 13);
  - SMTP с SPF/DKIM/DMARC;
  - токен общего Telegram-бота платформы.
- **К неделе 8–10:**
  - GitHub-окружения staging и prod;
  - магазин ЮKassa платформы и тестовый магазин.
- **Неделя 12:** финальное имя и домен платформы (E-NAME, F8).
- **К бете (≈ неделя 15):**
  - staff-учётка с MFA (F7);
  - уведомление РКН и остальные пункты M2-13.

## Хвосты для реализации (не спеки)

- Тесты `packages/appspec` читают `DATABASE_URL` — нужно перейти на `WIZARD_DB_URL` (`deploy.yaml#local.env_vars`).
- Корневой `.gitattributes` (`specs/CHANGELOG.md merge=union`) — в задаче M0-19.
