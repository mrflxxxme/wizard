# Стенд оценки V5 (V5-02)

Слепое сравнение сайта Wizard с эталоном на тот же бриф: `docs/reviews/grill-10.md`, `grill-12.md` (5), `product.yaml#decisions.D80_v5` (1), `D81_v5_finish`.

- **10 брифов** — `briefs.json`; срез на PR — 3 (поле `slice`).
- **10 эталонов** — `references.json`: 8 снимков шаблонов poehali.dev (первый экран 1440×900 и 390×844, `tools/fixtures/eval/v5/refs/`; код и тексты не копируются, GZ-03; перенять снимки — `node tools/eval/v5/shoot-refs.mjs`) и 2 сайта-планки V5-01 («Мастерская», «Ночной продукт», первый экран из `docs/prototypes/blocks`). Все снимки — PNG: формат файла не выдаёт источник. Нет файла — «снимок не получен»: пара вне доли.
- **Судьи** — `glm-5v-turbo`, `kimi-k3`, `qwen3.6-35b` (три провайдера, vision, allowlist). Видят только бриф и вложения `A-1440`, `A-390`, `B-1440`, `B-390`; кто эталон, неизвестно. Порядок пар и сторона Wizard — случайные из `--seed`. Пара «не хуже эталона», если большинство ответивших судей выбрало Wizard или ничью.

```bash
node tools/eval/v5/cli.mjs run --set slice                       # fixture, без сети: заглушки судей и снимков Wizard
node tools/eval/v5/cli.mjs run --set full --wizard-shots <dir>   # <dir>/<id брифа>/{1440,390}.png
node tools/eval/v5/cli.mjs run --mode live --set full --cap-rub 300 --wizard-shots <dir>   # ключи в окружении
```

Снимки Wizard из отчёта сборки (V5-10): `pnpm --filter @wizard/platform-api eval-shots <id прогона> <id брифа> <каталог>` кладёт главную в `<каталог>/<бриф>/{1440,390}.png` (JPEG отчёта пересохраняется в PNG).

Отчёт (`--out`, по умолчанию `tools/eval/results/v5-<набор>-<режим>/`): `summary.json`, `report.md` (доля пар «не хуже эталона», голоса судей, **стоимость**), `index.html` — лента пар для основателя (Wizard и эталон подписаны, голоса судей). Лента только для основателя. Цель 40 % — замер, не условие (D81 (1)).

Живой прогон — workflow `eval-v5` (вручную; потолок трат прогона в ₽, не больше 1 500; потолок на волну — 5 000 ₽).
