# Модели для пилота: китайские фронтиры против Cloud.ru FM (01.10.2026)

> Кабинетное исследование по открытым источникам на 01.10.2026. Цель — выбрать модели под установку основателя: «на пилоте лучший результат за меньшие усилия; передача ПДн не формализуется, это осознанный риск; юридическая обвязка — после валидации».
> Ограничения, которые остаются: никаких API и сервисов Anthropic, OpenAI, Google, xAI (открытые веса в РФ разрешены, D18). Перед любым вызовом T1 работает автоматический scrub ПДн (`packages/pii`). Рантайм-ИИ, поддержка и импорт значений остаются только на T0 (`models.yaml#pii_forbidden_for_T1`).
> **[?]** — не подтверждено по первоисточнику. **[оценка]** — расчёт агента. «Вендор» — цифры производителя на его собственной обвязке, «незав.» — независимый замер.
> Курс: ЦБ РФ на 02.10.2026 (установлен 01.10) — **83,25 ₽/$**. Цены зарубежных провайдеров ниже переведены как $ × 83,25 × 1,22 (НДС налогового агента) ≈ **101,6 ₽ за $1**. В `models.yaml` заложено 95 ₽/$ — запас ~14%, его стоит оставить: он покрывает комиссию платёжного посредника (5–15%).

## Сводная таблица

₽ за сборку — средний профиль из [аудита 01](../audit/01-llm-access-and-costs.md#a5-юнит-экономика): 320k токенов (интервью 15k, план 30k, строитель 200k, QA 75k), 80% вход / 20% выход. Через «/» — стресс-профиль 1,2M токенов (контекст пересылается на каждом шаге, ретраи; 90/10). Если у провайдера есть скидка на кэш, учтено 50% попаданий в среднем профиле и 60% в стрессе. Цифры по выбранному миксу ролей (оркестратор, строитель, QA) — в разделе 4.

| Модель | Где | ₽ за сборку [оценка] | Tool calling | Качество для нас | Оплата из РФ | Риски |
|---|---|---|---|---|---|---|
| **GLM-5.3** | Z.ai (Сингапур), T1, **уже в коде** | **50–65 / 130–245** | да, OpenAI-совместимый, thinking выключается параметром | **Лучшая открытая модель по незав. индексам**: Vals Index 53,5 (№1 среди открытых), AA Index 45 (№2 из 117) | карты РФ не проходят → посредник (Oplatym, виртуальная карта) или агрегатор AITUNNEL в ₽ (280/880 ₽, ~2× дороже, без кэша) | ПДн не формализованы (осознанно); дорогая и многословная среди открытых; оплата через посредника |
| **DeepSeek V4-Pro (Cloud.ru)** | Cloud.ru FM, внутр., T0, **уже в коде** | 94 / 285 | да (FC, SO) | Ниже GLM-5.3. Какая сборка у Cloud.ru — апрельская preview или GA 0813 — **[?]**. У 0813: Vals 47,6, AA 36; у preview вендор даёт TB 2.1 72,1 против 87,9 у 0813 | ₽, юрлицо, закрывающие документы | нет кэш-скидки → в агентном цикле дороже T1 |
| **Kimi K2.6 (Cloud.ru)** | Cloud.ru FM, внутр., T0, **уже в коде** | 91 / 277 | да | AA Index 27 (на v4.3, против 45 у GLM-5.3); хороший русский и WebDev (Code Arena №6 в мае) | ₽ | заметно слабее фронтира; без кэша |
| **GLM-5.1 (Cloud.ru)** | Cloud.ru FM, внутр., T0 | 104 / 314 | да | AA 26, Z.ai пометила модель deprecated; медленная (43 ток/с) | ₽ | устаревает |
| **DeepSeek V4.1-Flash** | DeepSeek API (Ханчжоу), T1 — **нужен код** | **12–16 / 28–48** | да; thinking по умолчанию **включён** → нужен `thinking: {type: disabled}` | Vals Index **51,3** (незав., с рассуждением на максимуме) за $0,33 на тест; AA 39 | посредник, виртуальная карта; [РБК](https://companies.rbc.ru/news/0Su2q3GJoP/kak-oplatit-deepseek-api-iz-rossii-v-2026-godu-popolnenie-balansa/) | хранит данные в КНР, обучение с opt-out; часы пик ×2 |
| **DeepSeek V4-Pro-0813** | DeepSeek API, T1 — **нужен код** | 43–60 / 110–195 (в пик) | да | Vals 47,6; SWE-bench Verified (Vals) 96,4 — потолок бенчмарка; AA 36 | как выше | как выше |
| **DeepSeek V4.1-Flash (Yandex)** | Yandex AI Studio, внутр., T0, провайдер **уже в коде**, нужна строка в каталоге | 80–109 / 240–385 | заявлен для API в целом; для этой модели **[?]** — нужен контрактный тест | как у V4.1-Flash выше | ₽, юрлицо | цена в 10 раз выше, чем у DeepSeek напрямую; поведение thinking у Yandex **[?]** |
| **Kimi K3** | Moonshot (Сингапур), T1, выключена в коде | 140–175 / 335–510 | да | Vals 50,7, AA 44 — на уровне GLM-5.3 | посредник; AITUNNEL 600/3000 ₽ | **обучается на контенте API**; в 2–3 раза дороже GLM-5.3 |
| **Qwen3.8-Max** | Alibaba Model Studio Intl (Сингапур), T1 — нужен код | ~91 / ~290 (без учёта кэша) | да | Vals 48,3; вендор: SWE-bench Pro 67,7 | карты РФ не проходят; регистрация из РФ **[?]** | веса закрыты; оплата и условия для РФ не проверены |
| **Qwen3-Coder-Next** | Cloud.ru FM, внутр., T0 | 47 / 161 | да (FC, SO) | малая (80B, 3B активных); вендор: SWE-V 70,6, TB 2.0 36,2 | ₽ | для сложных сборок слабовата |
| **MiniMax-M3** | Cloud.ru внутр. (240/1009 ₽) или MiniMax API ($0,3/$1,2) | 126 (Cloud.ru) / 12–16 (напрямую) | да | Vals 36,5 — слабейшая из флагманов | Cloud.ru — ₽; напрямую **[?]** | условия API MiniMax не прочитаны **[?]** |
| **GLM-5.2 (Cloud.ru «внешняя»)** | Cloud.ru FM, запросы уходят за рубеж | 83 / 260 | да | между GLM-5.1 и 5.3 | ₽ тем же ключом Cloud.ru | маршрут не раскрыт; id в каталоге в стиле OpenRouter (`z-ai/glm-4.6`, `xiaomi/mimo-v2.5-pro`) → возможно, американский агрегатор **[?]**; сейчас запрещена спекой (`data-boundary.yaml#model_registry`) |
| **gpt-oss-120b** | Cloud.ru FM, внутр., T0 | — (ИИ-действия: ~4 ₽ за 100 вызовов) | да | достаточно для извлечения полей | ₽ | — |

## Рекомендация для пилота

1. **Строитель по умолчанию — GLM-5.3 через Z.ai (T1).** Это лучший по независимым замерам вариант из разрешённых, кода он не требует (провайдер `zai`, `WIZARD_BUILD_DEFAULT_TIER` пустой = T1). Он же и дешевле внутренних моделей Cloud.ru: 50–65 ₽ за среднюю сборку против 91–104 ₽, потому что у Cloud.ru нет кэш-скидки. Z.ai по своей политике не хранит API-контент и не обучается на нём. Это лучший профиль данных среди китайских провайдеров. Фолбэк на T0 (DeepSeek-V4-Pro → Kimi-K2.6 → GLM-5.1 на Cloud.ru) уже работает автоматически.
2. **Интервью и оркестратор — оставить как в `models.yaml`:** GLM-5.3 на T1. Если в брифе найдены ПДн, роутер сам уходит на T0: шаг 5 отправляет такие вызовы на Kimi-K2.6 (Cloud.ru), это хорошая модель для русского диалога. Ослаблять это правило не нужно. Подстановки в интервью почти ничего не стоят (15k токенов), а сырой бриф с ПДн за рубеж не уходит.
3. **ИИ-действия extract/generate — оставить T0:** `gpt-oss-120b` (около 4 ₽ за 100 вызовов) для извлечения и `gigachat-3.5` для генерации русского текста. **Ослаблять T0-only не рекомендую, даже с учётом новой установки.** Эти вызовы по определению работают с записями клиентов. Scrub уничтожил бы данные, нужные для задачи, а без scrub это прямая передача ПДн клиентов (оператор — клиент) в КНР или Сингапур. Выигрыша по цене нет: T0 здесь и так копеечный. Если основатель всё же захочет T1 для ИИ-действий, это изменение `pii_forbidden_for_T1.always`, `runtime-ai.ts` и тестов M3-02 (~0,5 дня). Делать его не советую.
4. **A/B в еженедельном eval — 1–2 альтернативы:**
   - **(а) DeepSeek-V4-Pro на Cloud.ru (T0)** против GLM-5.3. Сравнение нужно и для правила F2 (≥10 п. п.), и чтобы понять, можно ли обойтись одним Cloud.ru. Кода не требует: `--models=glm-5.3,deepseek-v4-pro`. Заодно спросить Cloud.ru, какая сборка V4-Pro развёрнута (preview или 0813), — от этого зависит результат.
   - **(б) DeepSeek V4.1-Flash напрямую (T1)** — самый сильный кандидат «цена/качество»: независимый Vals Index 51,3 при цене 12–16 ₽ за сборку, в 4–5 раз дешевле GLM-5.3. Нужен провайдер `deepseek` (код, ~0,5–1 агенто-дня, см. раздел 5) и отдельный аккаунт. Включать его после первого цикла (а), если GLM-5.3 подтвердит лидерство и захочется снизить себестоимость.
5. **Ключи и аккаунты — минимум два:** `CLOUDRU_API_KEY` (обязателен в любом случае: T0 для ПДн, рантайм-ИИ, фолбэки) и `ZAI_API_KEY`. Yandex на пилоте не нужен. DeepSeek — опционально, после решения по (б).
6. **«Только Cloud.ru FM» на пилоте не рекомендую.** По публичным независимым индексам внутренние модели Cloud.ru (Kimi-K2.6 — AA 27, GLM-5.1 — 26) заметно уступают GLM-5.3 (45). В агентном цикле они ещё и дороже из-за отсутствия кэша. Итоговое решение всё равно принимает eval недели 0 по правилу F2. Если разрыв < 10 п. п., переход на Cloud.ru-only — это одна переменная `WIZARD_BUILD_DEFAULT_TIER=T0`, без кода.

---

## 1. Cloud.ru Foundation Models (РФ, ₽, уже интегрировано)

Цены с НДС 22%, ₽ за 1M токенов, тарифы от 28.09.2026 ([тарифы](https://cloud.ru/documents/tariffs/evolution/foundation-models), [каталог с ценами](https://cloud.ru/products/evolution-ai-factory/catalog-foundation-models), [обзор моделей и размещение](https://cloud.ru/docs/foundation-models/ug/topics/overview__available__models)).

**Внутренние модели (данные не покидают РФ, допустимы для T0):**

| id у Cloud.ru | Вход / выход, ₽ | Контекст | FC / SO / Reasoning | Есть в `models.yaml` |
|---|---|---|---|---|
| `deepseek-ai/DeepSeek-V4-Pro` | 183 / 732 | 1 048 576 | да / да / да | да |
| `moonshotai/Kimi-K2.6` | 175,68 / 725,9 | 262 144 | да / да / да (+vision) | да |
| `zai-org/GLM-5.1` | 198,86 / 829,6 | 202 752 | да / да / да | да |
| `zai-org/GLM-4.7` | 549 / 793 **[?: цена входа выглядит опечаткой]** | 202 752 | да / да / да | нет |
| `MiniMaxAI/MiniMax-M3` | 240,22 / 1008,85 | 524 288 | да / да / да | нет |
| `MiniMaxAI/MiniMax-M2.5` | 353,8 / 475,8 | 196 608 | да / да / да | нет |
| `Qwen/Qwen3-Coder-Next` | 122 / 244 | 262 144 | да / да / нет | да |
| `Qwen/Qwen3.5-397B-A17B` | 915 / 1085,8 | 262 144 | да / да / да | нет |
| `Qwen/Qwen3.6-35B-A3B` | 219,6 / 329,4 | 262 144 | да / да / да | нет |
| `openai/gpt-oss-120b` | 15,86 / 61 | 131 072 | да / да / да | да |
| `ai-sage/GigaChat3.5-432B-A28B` | 96,22 / 288,6 | 262 144 | да / да / нет | да |

- **Новое с 30.09:** в каталоге появились внутренние Qwen3.5-397B, Qwen3.6-35B, MiniMax-M2.5 и GLM-4.7. Ни одна из них не сильнее V4-Pro или K2.6 для нашей задачи, а Qwen3.5-397B в 5 раз дороже. Добавлять в каталог не нужно.
- **GLM-5.3, Kimi K3 и DeepSeek V4.1-Flash / V4-Pro-0813 во внутреннем контуре нет.** Вопрос о GLM-5.3 уже стоит в [тикете Cloud.ru](../week0/cloudru-questions.md). Стоит добавить вопрос: «какая сборка DeepSeek-V4-Pro развёрнута (preview от апреля или GA 0813) и есть ли план на V4.1-Flash».
- **Внешние модели Cloud.ru** (запросы уходят за рубеж, SLA нет, риск ПДн на заказчике): GLM-5.2 (173,15 / 606,05), DeepSeek-V4-Flash (43,3 / 86,58), Kimi-K2.5 (117,85 / 589,26), Qwen3-Max-Thinking (204,96 / 1024,8), MiMo-V2.5-Pro (74 / 149) и другие. Через кого идёт маршрут, в [анонсе от 03.07.2026](https://cloud.ru/blog/cloud-ru-dobavil-vneshniye-yazykovyye-modeli) не сказано. Идентификаторы совпадают со схемой OpenRouter, и это намекает на американского агрегатора **[?]**. Плюс: один ключ и оплата в ₽. Минус: спека их запрещает, а происхождение маршрута неизвестно. Для пилота не рекомендую. Как ориентир T1 в eval без ключа Z.ai допустимо (`ext-glm-5.2` в `tools/eval/models.json`).
- **Лимиты:** 20 запросов/с на сервисный ключ, в пакетном режиме 20 параллельных запросов на ключ ([режимы](https://cloud.ru/docs/foundation-models/ug/topics/concepts__request-mode)). TPM не опубликован **[?]**. Для пилота (2 клиента, `WIZARD_RUN_CONCURRENCY=2`) этого хватает с запасом.
- **Кэш-скидок у внутренних моделей нет** (в тарифе кэш есть только у партнёрских Claude). Для агентного цикла, где 80–90% токенов — повторно отправляемый вход, это главная причина, почему T0 дороже T1.

## 2. Китайские API напрямую (T1, за рубежом)

| Провайдер | Модели и цены, $ за 1M (вход / кэш / выход) | OpenAI-совместимость, tools | Данные и обучение | Россия по условиям | Оплата из РФ |
|---|---|---|---|---|---|
| **Z.ai** (Сингапур) | GLM-5.3: 1,4 / 0,26 / 4,4; GLM-5.3-Flash: 0,15 / 0,03 / 0,5; GLM-5.3-FlashX: 0,37 / 0,075 / 1,25 ([pricing](https://docs.z.ai/guides/overview/pricing)) | да, `https://api.z.ai/api/paas/v4`; `thinking: {type: disabled}` уже в `transformBody` | **API-контент не хранится и не используется для обучения**, обработка в Сингапуре ([privacy](https://docs.z.ai/legal-agreement/privacy-policy), ред. 29.09.2025) | разрешена ([ToU](https://docs.z.ai/legal-agreement/terms-of-use), по исследованию 30.09) | карты РФ не проходят, 3-DS при пополнении не поддерживается → посредник или виртуальная карта ([vc.ru](https://vc.ru/services/3099390-kak-oplatit-zai-iz-rossii)); агрегатор AITUNNEL: GLM-5.3 — 280 / 880 ₽, «Prime» — 560 / 1760 ₽ ([AITUNNEL](https://aitunnel.ru/providers/z-ai)) |
| **DeepSeek** (Ханчжоу) | `deepseek-v4-pro` (= V4-Pro-0813): 1,32 / 0,044 / 3,96 в пик, ×0,5 вне пика; `deepseek-flash` (= V4.1-Flash): 0,3 / 0,006 / 1,2 в пик; контекст 1M ([pricing](https://api-docs.deepseek.com/quick_start/pricing)). Пик: 01–04 и 06–10 UTC (04–07 и 09–13 МСК) по будням | да, tools и JSON; **thinking включён по умолчанию** (`{"thinking": {"type": "disabled"}}` выключает). С tools в режиме thinking API требует возвращать `reasoning_content`, иначе 400 ([thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)) | **хранение в КНР**, обучение с правом opt-out; удержание «сколько нужно» ([privacy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html), ред. 10.02.2026) | разрешена (по исследованию 30.09) | карты РФ не принимаются; посредник (Oplatym, СБП) или виртуальная карта ([РБК](https://companies.rbc.ru/news/0Su2q3GJoP/kak-oplatit-deepseek-api-iz-rossii-v-2026-godu-popolnenie-balansa/)); AITUNNEL: V4.1-Flash 30 / 120 ₽ (в пик 60 / 240), V4-Pro-0813 — 115,9 / 347,69 ₽ ([AITUNNEL](https://aitunnel.ru/providers/deepseek)) |
| **Moonshot** (Сингапур) | Kimi K3: 3 / 0,3 / 15, контекст 1M; K2.7-Code: 0,95 / 0,19 / 4; K2.6: 0,95 / 0,16 / 4 ([pricing](https://platform.kimi.ai/docs/pricing/chat)) | да | **может обучаться на контенте API**; исключение — по договору. В коде выключен (`models.yaml#providers.moonshot`) | разрешена | посредник; AITUNNEL: K3 — 600 / 3000 ₽ |
| **Alibaba Model Studio Intl** (Сингапур) | Qwen3.8-Max: 2 / ? / 6; Qwen3.7-Max: 2,5 / 7,5; Qwen3-Coder-Plus (32–128k): 1,8 / 9; Qwen3-Coder-Flash (до 32k): 0,3 / 1,5; Qwen-Flash: 0,05 / 0,4. Новым аккаунтам — 1M бесплатных токенов на модель ([pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing)) | да (DashScope compatible-mode) | данные «в выбранном регионе» ([regions](https://www.alibabacloud.com/help/en/model-studio/regions)); политика обучения **[?]** | **[?]** — запрет для РФ не найден, но и подтверждения нет | карта Alibaba Cloud Intl; карты РФ не проходят **[?]** |
| **MiniMax** | M3: 0,3 / 0,06 / 1,2 (до 512k), M2.7 — то же ([pricing](https://platform.minimax.io/docs/guides/pricing-paygo)) | да | **[?]** | **[?]** | **[?]**; AITUNNEL продаёт M3 |
| **ByteDance Seed / Doubao** | международно — через BytePlus ModelArk **[?: не проверял]** | — | — | — | — |

**Агрегаторы с оплатой в рублях.** У [AITUNNEL](https://aitunnel.ru/) и [Polza.ai](https://polza.ai/blog/api-neyrosetei) OpenAI-совместимый эндпоинт, счёт для юрлица и закрывающие документы (ЭДО). AITUNNEL заявляет транзит без хранения. Наценка 5–20% у Polza; у AITUNNEL на GLM-5.3 — около 2× к прямой цене, кэш-скидки нет. Риски:
- через кого агрегатор ходит к Z.ai или DeepSeek, не раскрыто. Если через OpenRouter (американский сервис, с 11.05.2026 отключил платежи РФ), это серая зона по условиям upstream **[?]**;
- данные проходят через ещё одного посредника;
- включён ли НДС, не указано **[?]**.

Для пилота это запасной путь оплаты, а не основной. Технически AITUNNEL подключается без нового провайдера: в `ZAI_BASE_URL` указывается `https://api.aitunnel.ru/v1`, а в `ZAI_API_KEY` — ключ агрегатора. Но если id модели у агрегатора не `glm-5.3`, нужна одна строка в каталоге **[?]**, а параметр `thinking` агрегатор может не пробрасывать **[?]**. Проверяется контрактным тестом `tools/eval --contract`.

**Доступность из РФ (гео-блок).** Явных блокировок по IP у Z.ai и DeepSeek не нашёл. Их условия Россию не исключают. Но реальную доступность с сервера Timeweb (Москва) нужно проверить первым live-вызовом **[?]**.

## 3. Качество для наших задач

Наши задачи: агентная сборка с tool calling (операции над спекой в JSON, TSX/TS по спеке), интервью на русском. Важная оговорка: **все публичные цифры сняты с включённым рассуждением (часто max effort), а Wizard вызывает инструменты с выключенным thinking** (`models.yaml#call_policy.thinking`). Реальный уровень будет ниже, и расстановка может поменяться. Поэтому решает только наш eval.

**Независимые замеры:**

| Модель | Vals Index v2.1 (30.09.2026) | AA Intelligence Index v4.3 (сент. 2026) | Прочее |
|---|---|---|---|
| GLM-5.3 | **53,51** (№16 из 41, №1 среди открытых), $7,25 на тест | **45** (№2 из 117) | SWE-bench Verified (Vals) 95,4 — по вторичному источнику [morphllm](https://www.morphllm.com/best-open-source-coding-model-2026) |
| DeepSeek V4.1-Flash | **51,32** (№23), **$0,33 на тест** | 39 | №1 SkillsBench (Vals) |
| Kimi K3 | 50,70 (№26) | 44 | SWE-V (Vals) 93,4 — вторичный источник |
| Qwen3.8-Max | 48,27 (№29) | — | — |
| DeepSeek V4-Pro-0813 | 47,63 (№31) | 36 | SWE-V (Vals) 96,4; LiveCodeBench 87,5 |
| DeepSeek V4 (ранний) | 38,63 (№34) | — | — |
| MiniMax-M3 | 36,53 (№35) | — | — |
| Kimi K2.6 | — | 27 (№21) | Code Arena WebDev — 6-е место (май) |
| GLM-5.1 | — | 26 (№22), deprecated | — |
| Для сравнения: лидер | Claude Sonnet 5.5 — 67,04 | — | — |

Источники: [Vals Index](https://www.vals.ai/benchmarks/vals_index), [Vals V4-Pro-0813](https://www.vals.ai/models/deepseek_deepseek-v4-pro-0813), [Vals V4.1-Flash](https://www.vals.ai/models/deepseek_deepseek-v4.1-flash), [AA GLM-5.3](https://artificialanalysis.ai/models/glm-5-3), [AA Kimi K2.6](https://artificialanalysis.ai/models/kimi-k2-6), [AA DeepSeek V4 Pro](https://artificialanalysis.ai/models/deepseek-v4-pro), [AA GLM-5.1](https://artificialanalysis.ai/models/glm-5-1), [AA V4.1-Flash vs GLM-5.3-Flash](https://artificialanalysis.ai/models/comparisons/deepseek-v4-1-flash-vs-glm-5-3-flash), [The Batch о K2.6](https://www.deeplearning.ai/the-batch/kimi-k2-6-matches-open-qwen3-6-max-anddeepseek-v4-falls-just-behind-top-closed-models).

**Цифры вендоров** (их собственные обвязки, между собой не сравнимы):
- DeepSeek V4-Pro-0813: TB 2.1 87,9 против 72,1 у preview; DeepSWE 62,7 против 12,8 ([vc.ru](https://vc.ru/ai/3076772-deepseek-obnovila-api-s-modelyu-deepseek-v4-pro)). Независимый прогон на эталонной обвязке Terminus 2 дал 54,7 ([codersera](https://codersera.com/blog/deepseek-v4-pro-0813-guide-2026/), вторичный источник **[?]**). Разрыв вендор/независимый — около 30 п. п.
- GLM-5.3: TB 2.1 88,2, TB 3.0 28,3 ([HF](https://huggingface.co/zai-org/GLM-5.3), по аудиту 01).
- Qwen3-Coder-Next: SWE-V 70,6, SWE-Pro 44,3, TB 2.0 36,2 ([Qwen](https://qwen.ai/blog?id=qwen3-coder-next)).
- MCPMark (tool use, вендоры, май 2026): Qwen3.6-Plus 37,0, K2.6 34,5, GLM-5.1 33,8, V4-Pro 32,1 ([обзор](https://lushbinary.com/blog/best-open-source-llms-ai-agents-may-2026-comparison/)).

**Что из этого следует:**
- **SWE-bench Verified упёрся в потолок** (93–96% у всех лидеров) и модели не различает. Полезнее Vals Index, AA Index (в v4.x стал агентным) и Terminal-Bench на эталонной обвязке.
- **BFCL v4 и tau2-bench:** свежих независимых цифр по нашим кандидатам не нашёл. Агрегаторы вроде benchlm и llm-stats собирают данные вендоров **[?]**.
- **Русский язык:** актуальных сравнимых замеров не нашёл. У [LLM Arena](https://llmarena.ru/) таблица рендерится скриптом и не прочиталась, по MERA свежих результатов для этих моделей нет **[?]**. Единственный надёжный сигнал — наш eval на 30 русских брифах: `questions_asked`, `g0_pass`, `coverage`.
- **Порядок для Wizard [оценка]:** GLM-5.3 ≈ V4.1-Flash ≈ K3 > V4-Pro-0813 ≈ Qwen3.8-Max > внутренние Cloud.ru (V4-Pro неизвестной сборки, K2.6, GLM-5.1) > MiniMax-M3 > Qwen3-Coder-Next.

## 4. Стоимость сборки и потолки пилота

Расчёт — скриптом по ценам из разделов 1–2 [оценка]. Микс — интервью и карточка 15k, план и строитель 230k, QA 75k.

| Микс (оркестратор / строитель / QA) | Средняя сборка, ₽ | Стресс 1,2M, ₽ | Сборок на 6 000 ₽ (сред. / стресс) |
|---|---|---|---|
| **GLM-5.3 / GLM-5.3 / GLM-5.3 (Z.ai)** — рекомендация | **50–65** | **175–245** | **~90–120 / ~25–35** |
| Текущий T0 «микс A»: Kimi-K2.6 / V4-Pro / GLM-5.1 (Cloud.ru) | 96 | ~360 | ~60 / ~16 |
| Kimi-K2.6 / V4.1-Flash / V4.1-Flash (Yandex, всё в РФ) | 81–108 | 280–405 | ~55–75 / ~15–20 |
| DeepSeek V4-Pro-0813 напрямую (пик) | 43–60 | 150–225 | ~100–140 / ~27–40 |
| **DeepSeek V4.1-Flash напрямую** | **12–16** | **41–58** | **~375–500 / ~100–145** |
| Kimi K3 напрямую | 140–175 | 500–660 | ~35–43 / ~9–12 |
| GLM-5.3 через AITUNNEL (без кэша) | ~128 | ~410 | ~47 / ~15 |

- **Правка** (~75k токенов) — примерно ¼ сборки: 12–15 ₽ на GLM-5.3.
- **ИИ-действия** (~1,5k вход, 0,3k выход): gpt-oss-120b — ~4 ₽, GigaChat-3.5 — ~23 ₽, Kimi-K2.6 — ~48 ₽ за 100 вызовов.
- **Потолок 6 000 ₽/мес на сборки клиентов** (`WIZARD_LLM_MONTHLY_CAP_RUB`) на GLM-5.3 даёт пилоту с двумя клиентами запас на порядок даже в стрессовом профиле.
- **Потолок 4 000 ₽/мес на eval** (`D20_eval_budget`):
  - разовый прогон spec_only (один вызов на бриф, ~3–5 ₽) по 30 брифам × 3 модели — 300–500 ₽;
  - еженедельно: 5 брифов harness на GLM-5.3 (~300–1 200 ₽) плюс 5 брифов претендента. Претендент (а), Cloud.ru V4-Pro, стоит ~500–1 800 ₽ в неделю, поэтому чередовать через неделю или брать 3 брифа. Претендент (б), V4.1-Flash, — ~60–300 ₽ в неделю, его можно гонять еженедельно;
  - `tools/eval/ci.mjs` сам не даст выйти за 4 000 ₽. До трёх реальных прогонов он закладывает 60 ₽ на пару, и для стрессового профиля этого может не хватить. После первых прогонов прогноз пересчитается по факту.
- **Главная неизвестная** — реальный токен-профиль сборки (0,3–1,5M). Первый live-прогон harness её закроет.

## 5. Ключи, переменные и изменения кода

**Переменные, которые код уже читает** (`.env.example`, `packages/llm/src/registry.ts`, `docs/ops/eval.md`):

| Переменная | Нужна на пилоте | Зачем |
|---|---|---|
| `CLOUDRU_API_KEY` | **да** | T0: интервью с ПДн, рантайм-ИИ, поддержка, все фолбэки |
| `CLOUDRU_BASE_URL` | нет (по умолчанию `https://foundation-models.api.cloud.ru/v1`) | — |
| `ZAI_API_KEY` | **да** | T1: GLM-5.3 — строитель, интервью без ПДн, QA |
| `ZAI_BASE_URL` | нет (по умолчанию `https://api.z.ai/api/paas/v4`); при оплате через агрегатор — его URL **[?]** | — |
| `WIZARD_LLM_MODE` | `live` | — |
| `WIZARD_BUILD_DEFAULT_TIER` | оставить пустым (= T1); `T0` — если eval недели 0 решит в пользу Cloud.ru | — |
| `WIZARD_LLM_MONTHLY_CAP_RUB` | 6000 (по умолчанию) | — |
| `YANDEX_API_KEY`, `YANDEX_FOLDER_ID`, `YANDEX_BASE_URL` | нет (резерв T0) | — |
| `MOONSHOT_API_KEY`, `MOONSHOT_BASE_URL` | нет (провайдер выключен) | — |

Для ночного eval в GitHub Actions Secrets нужны те же `CLOUDRU_API_KEY` и `ZAI_API_KEY`.

**Что потребует кода [оценка]:**
- **DeepSeek напрямую (провайдер `deepseek`, T1)** — ~0,5–1 агенто-дня:
  - `ProviderId` и `PROVIDERS` в `registry.ts`: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` (по умолчанию `https://api.deepseek.com`), `termsCheckedAt`;
  - ветка в `transformBody`: `thinking: {type: "disabled"}` для `deepseek`. **Без неё запрос с tools уйдёт с thinking по умолчанию. Мы вырезаем `reasoning_content`, и второй ход вернёт 400**;
  - строки в `models.yaml#providers/models/routes` (chain.T1), тест реестра (список провайдеров), `data-boundary.yaml#model_registry`, `.env.example`, `deploy.yaml#local.env_vars`, `tools/eval/models.json`, `docs/ops/eval.md`, CHANGELOG.

  Эскалация не нужна, если поставщик уже признан допустимым для «нет ПДн» (исследование data-boundary, решение 3). Но хранение в КНР — это довод `ст. 18 ч. 5` в `escalation.yaml` E-LEGAL. Основатель принимает этот риск сознательно; scrub его снижает.
- **Новые модели Cloud.ru или Yandex (MiniMax-M3, Qwen3.6, V4.1-Flash у Yandex)** — 1–2 часа: только каталог (`models.yaml` + `registry.ts` + тест). Для Yandex нужен контрактный тест tools и thinking **[?]**.
- **Внешние модели Cloud.ru как T1 (GLM-5.2 одним ключом)** — ~0,5 дня: отдельный провайдер с тем же ключом и `tier: T1` плюс правка запрета в `data-boundary.yaml`. Не рекомендую, пока маршрут не раскрыт.
- **T1 для ИИ-действий** — ~0,5 дня, не рекомендую (см. рекомендацию, п. 3).
- **Thinking в вызовах с tools** (может поднять качество всех моделей) — отдельная задача на 1–2 дня. Нужно хранить и возвращать `reasoning_content` в пределах хода для DeepSeek, Kimi и GLM, а это противоречит текущему MUST в `call_policy.thinking`. Рассматривать только если eval покажет, что качество упирается в это.

## 6. Что сделать основателю

1. Получить **ключ Cloud.ru FM** (если ещё нет) и **ключ Z.ai** с пополнением на $20–50. Платить через посредника или виртуальную карту; запасной путь — счёт AITUNNEL на юрлицо. Ключи положить в `.env` или Secrets, не в чат.
2. Добавить в тикет Cloud.ru вопрос о сборке DeepSeek-V4-Pro (preview или 0813) и планах на V4.1-Flash и GLM-5.3 внутри контура.
3. Решить после первого цикла eval: нужен ли третий аккаунт (DeepSeek) ради снижения себестоимости в 4–5 раз.

## Источники (проверены 01.10.2026)

- Cloud.ru: [обзор моделей](https://cloud.ru/docs/foundation-models/ug/topics/overview__available__models), [каталог с ценами](https://cloud.ru/products/evolution-ai-factory/catalog-foundation-models), [тарифы 7.EVO.11.2](https://cloud.ru/documents/tariffs/evolution/foundation-models), [режимы и лимиты](https://cloud.ru/docs/foundation-models/ug/topics/concepts__request-mode), [внешние модели](https://cloud.ru/blog/cloud-ru-dobavil-vneshniye-yazykovyye-modeli), [условия](https://cloud.ru/documents/contracts/terms-of-service/evolution/foundation-models/description-foundation-models)
- Yandex AI Studio: [тарифы](https://aistudio.yandex.ru/docs/ru/ai-studio/pricing), [модели](https://aistudio.yandex.ru/docs/ru/ai-studio/concepts/generation/models), [function calling](https://aistudio.yandex.ru/docs/en/ai-studio/operations/generation/completions-function.html)
- Z.ai: [pricing](https://docs.z.ai/guides/overview/pricing), [privacy](https://docs.z.ai/legal-agreement/privacy-policy), [terms](https://docs.z.ai/legal-agreement/terms-of-use)
- DeepSeek: [pricing](https://api-docs.deepseek.com/quick_start/pricing), [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode), [privacy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html), [V4-Pro-0813 на vc.ru](https://vc.ru/ai/3076772-deepseek-obnovila-api-s-modelyu-deepseek-v4-pro)
- Moonshot: [pricing](https://platform.kimi.ai/docs/pricing/chat); Alibaba: [pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing), [regions](https://www.alibabacloud.com/help/en/model-studio/regions); MiniMax: [pricing](https://platform.minimax.io/docs/guides/pricing-paygo)
- Бенчмарки: [Vals Index](https://www.vals.ai/benchmarks/vals_index), [Vals V4-Pro-0813](https://www.vals.ai/models/deepseek_deepseek-v4-pro-0813), [Vals V4.1-Flash](https://www.vals.ai/models/deepseek_deepseek-v4.1-flash), [AA GLM-5.3](https://artificialanalysis.ai/models/glm-5-3), [AA Kimi K2.6](https://artificialanalysis.ai/models/kimi-k2-6), [AA DeepSeek V4 Pro](https://artificialanalysis.ai/models/deepseek-v4-pro), [AA GLM-5.1](https://artificialanalysis.ai/models/glm-5-1), [AA V4.1-Flash vs GLM-5.3-Flash](https://artificialanalysis.ai/models/comparisons/deepseek-v4-1-flash-vs-glm-5-3-flash), [The Batch о K2.6](https://www.deeplearning.ai/the-batch/kimi-k2-6-matches-open-qwen3-6-max-anddeepseek-v4-falls-just-behind-top-closed-models), [Qwen3-Coder-Next](https://qwen.ai/blog?id=qwen3-coder-next), [morphllm — вторичный](https://www.morphllm.com/best-open-source-coding-model-2026), [codersera — вторичный](https://codersera.com/blog/deepseek-v4-pro-0813-guide-2026/), [lushbinary — вторичный](https://lushbinary.com/blog/best-open-source-llms-ai-agents-may-2026-comparison/)
- Оплата и агрегаторы: [ЦБ РФ, курсы](https://www.cbr.ru/currency_base/daily/), [РБК: оплата DeepSeek](https://companies.rbc.ru/news/0Su2q3GJoP/kak-oplatit-deepseek-api-iz-rossii-v-2026-godu-popolnenie-balansa/), [vc.ru: оплата Z.ai](https://vc.ru/services/3099390-kak-oplatit-zai-iz-rossii), [AITUNNEL](https://aitunnel.ru/), [AITUNNEL Z.ai](https://aitunnel.ru/providers/z-ai), [AITUNNEL DeepSeek](https://aitunnel.ru/providers/deepseek), [AITUNNEL Moonshot](https://aitunnel.ru/providers/moonshotai), [Polza.ai](https://polza.ai/blog/api-neyrosetei)
- Внутренние: [аудит 01](../audit/01-llm-access-and-costs.md), [граница данных](../research/data-boundary-frontier.md), [`specs/agents/models.yaml`](../../specs/agents/models.yaml), [неделя 0](../week0/README.md)
