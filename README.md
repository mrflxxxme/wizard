# Wizard

Российская альтернатива Яндекс VibeCraft для нетехнических пользователей: система описывается в чате, агенты собирают её (данные, права, интерфейс, логику, интеграции), проверяют гейтами качества и публикуют в российском облаке. Более гибкая, с выбором моделей и без привязки к Яндексу.

- **[Страница концепции v3.1 + макеты](https://claude.ai/artifact/15eJDC8h95675xwTHieTsv)** (исходник [docs/wizard-concept-v3.html](docs/wizard-concept-v3.html))
- **[Концепция v3.1](docs/concept.md)** — актуальная версия после грилла-3
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
