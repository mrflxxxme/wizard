# pilot-admin — вкладка «Пилот» в консоли staff `/admin`: решения

Задача: основатель управляет пилотом из браузера, а не через `kubectl exec … pilot invite`. Адреса клиентов не должны попадать в логи GitHub Actions (pilot-bootstrap.md). Статусы `backlog.yaml` и `CHANGELOG.md` не менялись (impl.md п. 5).

## Решения

- 2026-10-01 · pilot-admin · **Одна логика на CLI и консоль.** Правила, которые раньше жили в `switch` CLI, вынесены в `src/pilot/service.ts`:
  - `listPilotInvites` — статусы sent / accepted / expired, отозванные не показываются, как в `pilot invites`;
  - `revokePilotInvite` — по email (CLI) или по id (консоль);
  - `setPilotPlan`, `grantPilotCredits`, `setFounderReviewRequired`;
  - `pilotOrgs` — опция `pilotOnly` для консоли;
  - `platformLlmSpend` — warn при ≥ 80 % (`LLM_CAP_WARN_SHARE`), reached при 100 %.

  `createPilotInvite` (вместе со шлюзом beta_readiness) и `get/setBetaReadiness` остались на своих местах. `src/pilot/cli.ts` теперь только разбирает аргументы и форматирует текст. Вывод CLI не изменился: тесты `pilot.test.ts` и `pilot-ops.test.ts` прошли без правок. Функции экспортированы из `src/index.ts`.
- 2026-10-01 · pilot-admin · **`PilotError.code`.** Это код api.yaml#Error, которым отвечает консоль. Отказ без beta_readiness — 403 `FORBIDDEN`, текст `BETA_READINESS_MISSING_RU` без изменений: тот же, что у CLI, включая подсказку `pilot readiness on`. Неверный ввод и «уже зарегистрирован» — 400 `VALIDATION_FAILED`, неизвестная org — 404. Новых кодов ошибок нет.
- 2026-10-01 · pilot-admin · **Маршруты** `src/routes/admin-pilot.ts` под `staffGuard` из M2-08: не staff — 404, без step-up — 403 `MFA_REQUIRED`.
  - `GET|PUT /admin/pilot/readiness`;
  - `GET|POST /admin/pilot/invites`;
  - `POST /admin/pilot/invites/{inviteId}/revoke`;
  - `GET /admin/pilot/orgs`;
  - `POST /admin/pilot/orgs/{orgId}/grants`;
  - `PUT /admin/pilot/orgs/{orgId}/founder-review`;
  - `GET /admin/pilot/spend`.

  Всё внесено в api.yaml: операции `adminPilot*`, `adminSetPilot*`, `adminListPilot*`, `adminCreatePilotInvite`, `adminRevokePilotInvite`, `adminGrantPilotCredits`; схемы `PilotReadiness`, `PilotInvite`, `PilotOrg`, `LlmSpend`. Время для `now` берётся из `opts.now` приложения (`pilotNow`). Staff MFA этот параметр не получает, чтобы TOTP шёл по реальным часам.
- 2026-10-01 · pilot-admin · **beta_readiness.**
  - Включение требует `confirm: true` и note ≥ 3 символов, иначе 400. Выключение — одним нажатием, note по желанию.
  - «Кто» — email staff (`platform_settings.updated_by`). CLI по-прежнему пишет `--by` или пользователя ОС.
  - Чек-лист `BETA_READINESS_CHECKLIST_RU` (`rkn`, `lawyer`, `dpa`, `zai`, `security`) лежит рядом с `BETA_READINESS_MISSING_RU` в readiness.ts. API отдаёт его вместе с флагом, поэтому текста в вебе нет. Это те же пять пунктов. Сам текст отказа не менялся: его проверяют тесты и e2e.
  - В UI включение работает в два шага: сначала заметка, затем второе нажатие с перечнем последствий (`admin-pilot-readiness-confirm-text`), по образцу снятия публикации в M2-08.
- 2026-10-01 · pilot-admin · **Флаг ревью в приглашении.**
  - Новая колонка `platform.pilot_invites.require_founder_review boolean not null default true`, миграция `0017_m2_pilot_admin`, db.yaml дополнен.
  - `acceptPilotInvite` переносит значение в `orgs.require_founder_review`. Раньше там всегда было true; по умолчанию ничего не изменилось.
  - CLI: `pilot invite … --review on|off`.
  - Если ревью выключено, письмо не обещает «посмотрит модератор». S-welcome по-прежнему показывает строку о ревью, независимо от флага org: это ОСТАТОК, см. ниже.
- 2026-10-01 · pilot-admin · **Журнал** `staff_audit_log`. Действия и их target:
  - `pilot_readiness_on|off` — `platform_settings:beta_readiness`, note — заметка;
  - `pilot_invite` — `pilot_invite:<id>`, note «кредиты N, ревью вкл|выкл»;
  - `pilot_invite_revoke` — `pilot_invite:<id>`;
  - `pilot_grant` — `org:<id>`, note «N кр., reference X» с пометкой повтора;
  - `pilot_review_required` — `org:<id>`.

  Email клиента в журнал и логи не пишется, только id приглашения. Сам адрес хранится в `pilot_invites`, как и раньше. Чтение списков в журнал не пишется. Список приглашений содержит адреса, но это данные, которые staff заводит сам. Если журналировать просмотр (как `abuse_view`), нужна правка — см. «Правки спек».
- 2026-10-01 · pilot-admin · **Начисление из консоли.** reference обязателен, 3–200 символов. В CLI он по-прежнему необязателен (случайный uuid). Без основания повторное нажатие начислило бы кредиты дважды; с ним `pilot_grant:<reference>` начисляет один раз, а повтор отвечает `granted: false`. В ledger `created_by` — id staff.
- 2026-10-01 · pilot-admin · **Таблица организаций** (`pilotOnly`) показывает org с `plan = pilot` и org, созданные принятым приглашением основателя, даже если их потом перевели на free. CLI `pilot orgs` по-прежнему выводит все org. «Списано за месяц» — charge минус refund в кредитах; «Модели ₽» — `llmSpentRub` org за месяц по Москве. Рядом стоит лимит платформы `WIZARD_LLM_MONTHLY_CAP_RUB` (`capRub` в ответе).
- 2026-10-01 · pilot-admin · **platform-web.** Вкладка `admin-tab-pilot` в `AdminConsole`, компонент `screens/admin/Pilot.tsx`. Строки лежат в `ru.admin.pilot`, тариф — `ru.billing.planName`. Блоки:
  - готовность беты: состояние, кто и когда, чек-лист, заметка, переключатель;
  - расход платформы на модели: предупреждение с 80 %, отдельный текст при 100 %;
  - форма приглашения: почта, название org, кредиты, «Ревью основателя» (по умолчанию включено); после отправки — ссылка из письма, её можно переслать самому;
  - список приглашений: статус, «Отозвать» только у «ждёт входа»;
  - таблица организаций: флаг ревью, начисление кредитов и основание.

  Любой `MFA_REQUIRED` возвращает на экран кода. Новых маршрутов нет, лимит 12 из platform-screens.yaml#stack соблюдён. platform-screens.yaml S-admin дополнен: region `pilot`, data, test_ids и acceptance.
- 2026-10-01 · pilot-admin · docs/ops/deploy.md, раздел «Пилот»: основной путь теперь консоль, CLI — запасной; добавлен `--review`.

## Тесты

- `apps/platform-api/test/admin-pilot.test.ts` — 13 тестов:
  - не staff и заголовок разработки получают 404 на всех 9 операциях, а staff без MFA — 403 `MFA_REQUIRED`, без изменений в БД;
  - `cache-control: no-store`;
  - чек-лист;
  - приглашение без готовности: 403 с текстом CLI, без письма и без строки журнала;
  - включение без confirm или note — 400; кто, когда и заметка; строка журнала; CLI `readiness` видит то же;
  - выключение закрывает шлюз;
  - приглашение: 201, ссылка, письмо без «модератора» при выключенном ревью, журнал без email;
  - статусы sent / accepted / expired;
  - вход клиента по OTP: org pilot с названием, кредитами и флагом ревью из приглашения;
  - отзыв: журнал, 404 для повтора и для принятого;
  - CLI `--review off|maybe`;
  - таблица org — только пилотные, с расходом в ₽;
  - начисление: 400 без reference, повтор не начисляет, журнал, `created_by`, 404;
  - флаг ревью;
  - расход 12 % → 80 % warn → 100 % reached совпадает с `pilot spend`.

  Колонка `require_founder_review` проверяется существующим тестом `migrations.test.ts` по db.yaml.
- `apps/platform-web/test/admin-pilot.dom.test.ts` — 7 тестов:
  - готовность: чек-лист; отказ приглашения текстом API; заметка обязательна; второе нажатие; кто и когда; выключение одним нажатием;
  - приглашение с выключенным ревью, ссылка, сброс формы, три статуса, «Отозвать» только у sent;
  - строка org, проверка начисления, начисление, переключение ревью;
  - расход без предупреждения, с 80 % и со 100 %;
  - `MFA_REQUIRED` из вкладки возвращает на экран кода.
- Playwright `packages/e2e/specs/pilot/pilot.spec.ts`, новый сценарий в конце файла (стенд pilot):
  - учётка основателя заводится как в bootstrap Job: приглашение в БД, dev-login, `setStaff`; затем TOTP;
  - «Пилот»: готовность, отмеченная CLI («Переключил e2e»), выключается;
  - приглашение без готовности получает отказ, письма нет;
  - заметка и второе нажатие включают готовность (кто — основатель);
  - приглашение «Пекарня «Колос»», 40 кр. → письмо, ссылка совпадает с показанной в консоли;
  - клиент входит по ссылке: OTP, согласия, `/welcome` с org и 40 кредитами;
  - в консоли: «принято», org в таблице, начисление 10 кр. по основанию → 50;
  - журнал `pilot_readiness_off`, `pilot_readiness_on`, `pilot_invite`, `pilot_grant`.

## Остатки

- S-welcome показывает «посмотрит модератор» и тогда, когда ревью для org выключено (`/welcome` не читает `require_founder_review`). Флаг не отдаётся в `Org` api.yaml; нужна правка S-welcome и схемы Org.
- Смена тарифа (`pilot plan`) в консоль не вынесена: задача её не требовала. Функция `setPilotPlan` общая, так что маршрут добавляется в одну строку.
- Письмо пилоту по-прежнему уходит через почту платформы (SMTP по M2-09). Если почта не настроена, ссылка из ответа консоли — запасной путь, как раньше в выводе CLI.

## Правки спек, которые нужно внести

- `compliance.yaml#beta_readiness`: переключатель есть и в консоли staff (`PUT /admin/pilot/readiness`): включение — с подтверждением и заметкой, кто — email staff, плюс строка `staff_audit_log`.
- `billing.yaml#plans.pilot`: кредиты и флаг ревью назначаются и из консоли staff (`/admin` → «Пилот»), не только CLI.
- `deploy.yaml#pilot` / `docs/founder/access-checklist.md`: приглашения клиентов — из `/admin`, `kubectl exec` не нужен.
- Если просмотр списка приглашений тоже нужно журналировать (адреса клиентов — ПДн), это решение `compliance.yaml#platform.security_org`. Сейчас пишутся только изменения.
- Уже внесено: `api.yaml` (операции и схемы `/admin/pilot/*`), `db.yaml` (`pilot_invites.require_founder_review`), `platform-screens.yaml` (S-admin pilot).
