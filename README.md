# Born to Build (кодовое имя Wizard)

Рабочая система под задачу нетехнического человека или MVP нового дела: сайт с заявками, запись, подписка и платный доступ, CRM. Человек описывает задачу своими словами, агенты собирают систему (данные, права, интерфейс, логику, интеграции), проверяют её и публикуют в российском облаке; цена известна заранее, команда на связи, есть вариант «под ключ». Решения — [грилл-4](docs/reviews/grill-4.md) и `specs/product.yaml` D26–D64.

- **[План полнофункционального пилота (веха M2P)](docs/plans/2026-10-04-full-pilot.md)** — что делаем до первых клиентов, порядок, чек-лист основателя, как начать следующую сессию
- [Грилл-4](docs/reviews/grill-4.md) · [аудит готовности к живому пилоту](docs/reviews/2026-10-04-pilot-gap-audit.md) · [ревизия ограничений](docs/reviews/2026-10-04-restrictions-review.md) · аудиты плана: [соответствие решениям](docs/reviews/spec-audit/2026-10-04-M2P-fidelity.md), [исполнимость](docs/reviews/spec-audit/2026-10-04-M2P-executability.md)
- Исследования к пилоту: [офферы-ориентиры](docs/research/offer-benchmarks-2026-10.md) · [интеграции](docs/research/integrations-2026-10.md) · [дизайн-агент](docs/research/design-agent-sources.md) и [каталог](docs/research/design-agent-catalog.md)
- [Локальная репетиция пилота на этой машине](docs/ops/local-rehearsal.md) · [выкат](docs/ops/deploy.md)
- **[Страница концепции v3.1 + макеты](https://claude.ai/artifact/15eJDC8h95675xwTHieTsv)** (исходник [docs/wizard-concept-v3.html](docs/wizard-concept-v3.html))
- **[Концепция v3.1](docs/concept.md)** — версия после грилла-3; позиционирование и цены уточнены грилл-4
- [Грилл-3](docs/reviews/grill-3.md) · [Грилл-2](docs/reviews/grill-2.md) · [ревью основателя v2](docs/reviews/2026-09-30-founder-review-v2.md)
- Исследования раунда 2: [ниши](docs/research/niches-deep-dive.md) · [аудит VibeCraft](docs/research/vibecraft-audit.md) · [граница данных и фронтир-модели](docs/research/data-boundary-frontier.md)
- [Страница концепции v2 + макеты](https://claude.ai/artifact/QYHYt77zwpkzW7nU7tw1hJ) (устарела: ниша «ремонт»; исходник [docs/wizard-concept.html](docs/wizard-concept.html)) · [концепция v2](docs/concept-v2.md)
- [Аудит допущений: 4 трека](docs/audit/README.md)
- [Исследование: рынок, конкуренты, технологии](docs/research/market.md)
- [Разбор «Чистого листа» в Void0dev/nucex](docs/research/nucex-clean-slate.md)
- [Прототип v1 (холст, сценарий студии)](docs/prototype/README.md)

## Запуск прототипа

Нужны Node 22, pnpm 10 и Postgres 16 (`pnpm dev` сам поднимет его на :5433 в `.data/pg`, если порт свободен). Ключи моделей не нужны: по умолчанию платформа воспроизводит золотой прогон «форума» (`WIZARD_LLM_MODE=fixture`, `WIZARD_FIXTURE=demo/forum`).

```
pnpm i
cp .env.example .env
pnpm dev
```

Откройте http://localhost:5173, вставьте бриф форума из `tools/fixtures/golden/forum.yaml` и пройдите путь: вопросы-кнопки → карточка → «Строить» → G0 и G1 → превью, где можно войти любой ролью, зарегистрироваться на форум и проверить QR-билет сканером. Тот же сценарий автоматически проходит `pnpm e2e` (`packages/e2e/specs/forum.spec.ts`), снимки ключевых шагов — в [docs/prototype/m0](docs/prototype/m0).
