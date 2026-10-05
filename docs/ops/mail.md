# Почта платформы (M2-09)

Через почту платформы уходят коды входа, приглашения в организацию, приглашения в пилот, уведомления владельцам, письма по оплате и алерты основателю. Отправку делает SMTP-клиент коннекторов (`@wizard/connectors`, `sendSmtp`) или HTTP API Unisender Go (`sendUnisenderApi`), новой зависимости нет. Код — `apps/platform-api/src/auth/smtp-mailer.ts`.

## Отправка через HTTP API (Unisender Go)

На сервере пилота в Timeweb закрыты исходящие почтовые порты 25, 465, 587 и 2525, поэтому SMTP оттуда не работает. Если `WIZARD_SMTP_HOST` — адрес Unisender Go (`smtp.go1.unisender.ru`, `smtp.go2.unisender.ru`), письма уходят через HTTP API Unisender Go на порт 443. Новых секретов не нужно: пароль SMTP у Unisender Go и есть API-ключ, он берётся из `WIZARD_SMTP_PASSWORD`. Адрес API выводится из хоста: `smtp.go1.unisender.ru` → `https://go1.unisender.ru`, `smtp.go2…` → `go2`, иначе `https://goapi.unisender.ru`.

| Переменная | Значение |
|---|---|
| `WIZARD_MAIL_TRANSPORT` | необязательная: `unisender-api` или `smtp`. По умолчанию `unisender-api` для хоста `*.unisender.ru`, иначе `smtp` |
| `WIZARD_MAIL_API_BASE` | необязательная: адрес API, если он отличается от выведенного из хоста |

Через API идут письма платформы (platform-api, worker) и письма систем от адреса платформы (коннектор email с `provider: platform` в runtime). Свой SMTP клиента (`provider: smtp`) остаётся SMTP. Ошибки разбираются так же, как у SMTP: ответ 4xx (кроме 429) — окончательная ошибка, 429, 5xx и обрыв сети — временная, клиент повторяет её один раз. Ключ, адрес и текст письма в логи не попадают.

Отслеживание переходов и прочтений Wizard не включает (письма без трекинга), но параметры `track_links`, `track_read` и `skip_unsubscribe` в запрос не передаются: отключить их Unisender разрешает только после обращения в поддержку, иначе запросы могут отклоняться. **Действие основателя:** написать в поддержку Unisender Go и попросить отключить отслеживание переходов и прочтений для аккаунта. До этого Unisender по умолчанию подменяет ссылки и добавляет пиксель прочтения и блок отписки.

Проверка настроек пилота (`pilot.mjs check`, строка «Почта: ключ API Unisender Go») проверяет ключ методом `system/ping` — письмо при этом не отправляется.

## Настройка

Переменные лежат в Secret `wizard-platform-env`, локально — в `.env`:

| Переменная | Значение |
|---|---|
| `WIZARD_SMTP_HOST` | SMTP-сервер провайдера (провайдер в РФ — решение основателя, E-ACCESS) |
| `WIZARD_SMTP_PORT` | 465 (по умолчанию) или 587 |
| `WIZARD_SMTP_TLS` | `implicit` (TLS с первого байта, по умолчанию для 465), `starttls` (обязательный STARTTLS, по умолчанию для других портов), `none` — только локальный приёмник; при `NODE_ENV=production` старт отклоняется |
| `WIZARD_SMTP_USER`, `WIZARD_SMTP_PASSWORD` | учётная запись отправки |
| `WIZARD_SMTP_FROM` | отправитель, например `Wizard <noreply@домен-платформы>`; без него при заданном хосте старт отклоняется |
| `WIZARD_OPS_ALERT_EMAIL` | необязательный адрес основателя для алертов |

Без `WIZARD_SMTP_HOST` письма пишутся файлами в `.data/outbox/platform`. Так работают локальная разработка, тесты и стенды. В production platform-api без SMTP не стартует. Одну временную ошибку (обрыв соединения, TLS, ответ 4xx) клиент повторяет один раз через 2 с. Ошибки 5xx (адрес не существует, неверный пароль) сразу считаются окончательными.

Те же `WIZARD_SMTP_HOST/PORT/USER/PASSWORD` использует коннектор email систем (`provider: platform`). Его отправитель — `noreply@<WIZARD_MAIL_DOMAIN>`, это домен систем. Отправитель писем платформы — `WIZARD_SMTP_FROM`, это домен платформы. Провайдер должен разрешать отправку от обоих доменов.

## DNS отправителя: SPF, DKIM, DMARC

Это записи DNS у регистратора и настройки провайдера, в коде их нет. Делаются один раз на каждый домен отправителя (действие основателя, E-ACCESS):

1. **SPF**: TXT на домене отправителя — `v=spf1 include:<spf-домен провайдера> -all`. Точное значение даёт провайдер.
2. **DKIM**: в кабинете провайдера включить подпись для домена и опубликовать выданный TXT `<selector>._domainkey.<домен>`. Подпись ставит провайдер, ключ у платформы не хранится.
3. **DMARC**: TXT `_dmarc.<домен>`. Для домена систем — `v=DMARC1; p=reject; adkim=s; aspf=s` (abuse.yaml#domain.reserved_slugs). Для домена платформы — сначала `p=quarantine` с отчётами `rua=mailto:…`, после недели без проблем — `p=reject`.
4. Проверка: отправить себе код входа и посмотреть заголовок `Authentication-Results` (`spf=pass`, `dkim=pass`, `dmarc=pass`).

## Проверка на стенде

```
WIZARD_SMTP_HOST=smtp.example.ru WIZARD_SMTP_FROM="Wizard <noreply@example.ru>" \
WIZARD_SMTP_USER=… WIZARD_SMTP_PASSWORD=… pnpm --filter @wizard/platform-api pilot invite me@example.ru
```

CLI пилота отправляет письма той же почтой платформы. Приглашения партнёрам уходят только после `pilot readiness on` (beta_readiness).
