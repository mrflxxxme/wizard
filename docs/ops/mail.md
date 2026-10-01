# Почта платформы (M2-09)

Через почту платформы уходят коды входа, приглашения в организацию, приглашения в пилот, уведомления владельцам, письма по оплате и алерты основателю. Отправку делает SMTP-клиент коннекторов (`@wizard/connectors`, `sendSmtp`), новой зависимости нет. Код — `apps/platform-api/src/auth/smtp-mailer.ts`.

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
