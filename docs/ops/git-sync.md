# Синхронизация репозиториев систем с GitHub и GitLab (V3-31)

Решение основателя — `specs/product.yaml#decisions.D77_v3` (3). Источник истины — внутренний git системы в РФ (V3-30).
Внешний репозиторий подключается по желанию владельца, синхронизация идёт через PR в обе стороны.

## Как это работает

- **Wizard → репозиторий.** Каждая новая ревизия (после окончания сборки или сразу после правки владельца) уходит в
  ветку `wizard/<slug>/<ревизия>`, и Wizard открывает PR в основную ветку. Коммит PR — файлы Wizard (`ui/`, `functions/`,
  `assets/`, `brief/`, `spec/`, `tests/`, `AGENTS.md`) поверх собственных файлов клиента из основной ветки (README, CI,
  `.gitignore` остаются как есть). Первая отправка в пустой репозиторий идёт прямо в основную ветку. Новый PR закрывает
  прежний открытый PR Wizard с комментарием и удаляет его ветку.
- **Гейты в PR.** G0, G1, G2 и техревью ревизии — check runs в GitHub и commit statuses в GitLab, сводка по-русски — в
  описании PR, там же постоянная ссылка на превью ревизии (`/api/v1/systems/<id>/repo-sync/preview/<ревизия>`).
- **Репозиторий → Wizard.** Мерж PR или push разработчиков в основную ветку приходит вебхуком (подпись GitHub
  `X-Hub-Signature-256`, токен хука GitLab), Wizard забирает ветку и сравнивает с ревизией последней синхронизации.
  Переносятся только `ui/**`, `functions/**`, `assets/**` и `spec/appspec.json`; правки брифа, тестов и `AGENTS.md` не
  переносятся (предупреждение). Конфликт с правками Wizard, символьные ссылки и подмодули, слишком большие файлы, не
  UTF-8, невалидная спека и непройденный G0–G2 — отказ с причиной по-русски на экране «Репозиторий» и проверкой
  «Wizard / Импорт в Wizard» на коммите. После отказа Wizard обновляет свой PR поверх новой головы: его мерж возвращает
  основную ветку к состоянию системы. Принятые изменения — новая ревизия, её превью строится сразу.
- **Публикация после мержа.** Пока репозиторий подключён, ревизию можно опубликовать, только когда она есть в основной
  ветке (её PR слит или она пришла из репозитория). Пауза синхронизации снимает это правило — выход, если провайдер долго
  недоступен.
- **Автомерж** (по желанию владельца): Wizard сливает PR сам, когда G0, G1 и G2 пройдены, а техревью не нашло блокеров.
  Способ — merge-коммит (коммиты Wizard остаются в истории ветки).
- **Сбои.** Очередь `platform.system_repo_jobs`: повтор через 30 с · 2^n до 1 ч, 10 попыток; новое событие не сокращает
  ожидание; работа в Wizard не ждёт провайдера. После 10 попыток или при ошибке доступа подключение получает статус
  «ошибка» с причиной, сверка раз в 15 минут возвращает его, когда провайдер снова отвечает; «Повторить» — сразу.
- **Транспорт.** Свой клиент git smart HTTP на TypeScript (`apps/platform-api/src/git/transport.ts`, `pack.ts`): ls-refs и
  fetch по протоколу v2 (v0 — если сервер не умеет v2), push через receive-pack, packfile с OFS_DELTA и REF_DELTA.
  Бинарник git и внешние сервисы не нужны; сборка и публикация от внешнего git не зависят.

## Что сделать основателю (E-ACCESS)

### 1. GitHub App платформы

В организации компании на GitHub: Settings → Developer settings → GitHub Apps → New GitHub App.

1. Имя — «Born to Build» (видно клиентам в PR), Homepage URL — `https://borntobuild.ru`.
2. **Callback URL** — `https://<домен платформы>/api/v1/git-sync/github/setup`; включить **Request user authorization
   (OAuth) during installation** (обязательно: так Wizard проверяет, что установка принадлежит пользователю) и **Redirect
   on update**. Setup URL при этом не используется.
3. **Webhook** — Active, URL `https://<домен платформы>/api/v1/webhooks/git/github`, Secret — случайная строка ≥ 32
   символов (`openssl rand -hex 32`).
4. **Repository permissions** — ровно четыре:
   - Contents — Read and write;
   - Pull requests — Read and write;
   - Checks — Read and write;
   - Metadata — Read-only (ставится сама).

   Workflows не нужен: Wizard не меняет файлы `.github/workflows` клиента.
5. **Subscribe to events** — Pull request, Push.
6. Where can this GitHub App be installed — Any account.
7. После создания: App ID, публичное имя (slug из ссылки `https://github.com/apps/<slug>`), Client ID, кнопка «Generate a
   new client secret», «Generate a private key» (скачается .pem).

Переменные (Secret `wizard-platform-env` и GitHub Secrets выката, никогда не в чат):

| Переменная | Значение |
|---|---|
| `WIZARD_GITHUB_APP_ID` | App ID |
| `WIZARD_GITHUB_APP_SLUG` | slug приложения |
| `WIZARD_GITHUB_APP_PRIVATE_KEY` | содержимое .pem (переводы строк можно заменить на `\n`) |
| `WIZARD_GITHUB_APP_WEBHOOK_SECRET` | секрет вебхука из п. 3 |
| `WIZARD_GITHUB_APP_CLIENT_ID`, `WIZARD_GITHUB_APP_CLIENT_SECRET` | Client ID и client secret |

Без любой из них кнопка «Подключить GitHub» не показывается.

### 2. Приложение OAuth на gitlab.com

gitlab.com → аватар → Edit profile → Applications (или группа компании → Settings → Applications) → Add new application:

- Name — «Born to Build»;
- Redirect URI — `https://<домен платформы>/api/v1/git-sync/gitlab/callback`;
- Confidential — да;
- Scopes — только `api` (merge requests, статусы, хук проекта и git по HTTP).

Application ID → `WIZARD_GITLAB_CLIENT_ID`, Secret → `WIZARD_GITLAB_CLIENT_SECRET`.

### 3. Свой GitLab клиента (self-managed)

От платформы ничего не нужно. Владелец создаёт на своём сервере такое же приложение OAuth (Redirect URI и scope `api`
как в п. 2) и вводит в Wizard адрес сервера, Application ID и Secret. Адрес — https без пути и доступный из интернета.
Wizard сам создаёт хук проекта с секретным токеном и удаляет его при отключении.

### 4. Ключ шифрования токенов (OpenBao Transit)

Токены GitLab, Application Secret своих GitLab и секреты хуков хранятся запечатанными, как ключи BYOK:

```
bao write -f transit/keys/wizard-repo type=aes256-gcm96
```

В политику токена platform-api (та же, что у BYOK) добавить `transit/datakey/plaintext/wizard-repo` и
`transit/decrypt/wizard-repo`. Другое имя ключа — `WIZARD_GIT_SYNC_TRANSIT_KEY`. Локально и в тестах — `WIZARD_GIT_SYNC_KMS=local`.

### 5. Сеть

platform-api ходит наружу на 443: `api.github.com`, `github.com`, `gitlab.com` и серверы GitLab клиентов (правило
«443 наружу, кроме частных адресов» — как у провайдеров моделей). Частные адреса отклоняются при каждом подключении
(защита от SSRF), перенаправления запрещены.

### 6. Проверка после выката

1. Создать пустой приватный репозиторий в организации компании, установить в него приложение из «Настройки» →
   «Репозиторий» → «Подключить GitHub» тестовой системы.
2. Выбрать репозиторий: в основной ветке появится исходник системы.
3. Сделать правку в Wizard: появится PR `wizard/<slug>/<ревизия>` с проверками «Wizard / G0…G2», «Wizard / Техревью».
4. Слить PR, затем закоммитить правку `ui/…` прямо в основную ветку: в Wizard появится ревизия «Импорт из GitHub: …».
5. То же для gitlab.com.

## Где что лежит

- Код: `apps/platform-api/src/git-sync/**` (провайдеры, очередь, потоки, вебхуки), транспорт — `apps/platform-api/src/git/{pktline,pack,transport,walk}.ts`.
- Таблицы: `specs/platform/db.yaml` блок V3-31 (миграция 0043), API: `specs/platform/api.yaml` блок V3-31.
- Экран: «Настройки» системы → «Репозиторий» (`apps/platform-web/src/screens/settings/repo/`).
- Переменные окружения: `specs/platform/deploy.yaml#local.env_vars.V3`.

## Дальше

- V3-32: агент для совместимых репозиториев (проверка совместимости, правила репозитория, черновой PR).
- GitVerse — следующий провайдер (интерфейс `RepoApi` в `git-sync/providers/types.ts`).
- Превью открытых PR разработчиков клиента (до мержа) и построчное слияние конфликтов — не сделаны.
