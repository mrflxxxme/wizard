# Уведомления по почте и в Telegram
> Точный формат подключений email и telegram и шагов notify: кому, каким шаблоном, когда нужно согласие.

Когда: в карточке есть письма или сообщения в Telegram — владельцу, сотрудникам или посетителю.

Подключения (add_integration)
- Почта: connector email, config.templates — словарь {id: {subject, body}}. Подстановки {{поле}} записи, {{ref.поле}}, {{link}} — ссылка на запись. В subject нет полей с ПДн (pii≠none). provider не указывай: по умолчанию почта платформы.
- Telegram: connector telegram, config {} — общий бот платформы. Свой бот (bot=own, secret://telegram_bot_token) — только если в карточке есть вход через Telegram. В Telegram никаких ПДн: ни {{поля}} с pii≠none, ни имён и телефонов в тексте.

Шаг notify (в workflow, обычно trigger on_create сущности)
- params.integration — имя подключения; params.to — один получатель или список: "$owner" (владелец системы), "$role:<роль со входом>", "$record.<поле ref на users>", "$record.<поле email посетителя>".
- Почта: params.template — id шаблона из config.templates этого подключения. Telegram: params.text — текст сообщения.
- Письмо посетителю ($record.<email>) — только с его согласия: params.consentField — поле записи type bool, которое форма заполняет отдельной неотмеченной галочкой «Согласен получать служебные сообщения». Telegram посетителю нельзя: только сотрудникам с аккаунтом.

Пример (заявка lead, владельцу письмо и сообщение в Telegram):
```json
[
  { "op": "add_integration", "integration": { "name": "mail", "connector": "email", "config": { "templates": { "new_lead": { "subject": "Новая заявка", "body": "Новая заявка от {{name}}. Открыть: {{link}}" } } } } },
  { "op": "add_integration", "integration": { "name": "tg", "connector": "telegram", "config": {} } },
  { "op": "add_workflow", "workflow": { "name": "lead_notify", "label": "Уведомить о новой заявке", "trigger": { "type": "on_create", "entity": "lead" }, "steps": [
    { "type": "notify", "params": { "integration": "mail", "to": "$owner", "template": "new_lead" } },
    { "type": "notify", "params": { "integration": "tg", "to": "$owner", "text": "Новая заявка — откройте по ссылке: {{link}}" } }
  ] } }
]
```

Критерии для QA: после create записи в outbox есть письмо владельцу (и сообщение Telegram), без ПДн в Telegram.
