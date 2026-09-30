# Рынок, конкуренты и технологии (30.09.2026)


> **Исправления после аудита (30.09.2026).** Часть данных ниже устарела или неверна, список — в [audit/README.md](../audit/README.md#исправления-к-researchmarketmd):
> - Яндекс VibeCraft — прямой аналог, он есть;
> - в таблице бенчмарков смешаны версии Terminal-Bench;
> - «96%» у Opus 5 не подтверждено;
> - Qwen3-Coder-480B в Cloud.ru нет;
> - синхронный Yandex Search стоит 488 ₽ за 1 тыс. запросов.

**Об источниках.** Многие цифры 2026 года взяты из агрегаторов и SEO-обзоров, а не из первоисточников. Особенно это касается бенчмарков. Где данные расходятся или не подтверждены, стоит пометка **[?]**.

---

## 1. Мировые конкуренты

| Продукт | Подход, стек и бэкенд | Песочница | Цена | Открытый код и что можно взять | Доступ из РФ |
|---|---|---|---|---|---|
| **Convex Chef** | Форк bolt.diy. React/Vite + Convex, то есть реактивная БД, авторизация, файлы и cron «из коробки». Модели Anthropic, Google, OpenAI и xAI подключаются своими ключами ([GitHub](https://github.com/get-convex/chef)) | Превью в браузере (наследие bolt.diy, WebContainers **[?]**). Бэкенд в облаке Convex | Бесплатный тариф + тарифы Convex | **Apache-2.0**, около 4.6k звёзд ([OSS-анонс](https://news.convex.dev/open-kitchen-chef-is-now-oss/)). Локальная разработка всё равно привязана к облачной control plane Convex | Сайт открывается, но нужны ключи зарубежных LLM |
| **Lovable** | React + Supabase. «Lovable Cloud» — это Supabase «под капотом» ([Supabase](https://supabase.com/blog/lovable-cloud-launch)) | Облачные песочницы **Modal**: 250 тыс. приложений за выходные, оркестрация сократилась с 15k до 700 строк ([Modal](https://modal.com/blog/lovable-case-study)) | Free / Pro $25 / Business $50. Реальная стоимость в 2–3 раза выше из-за кредитов ([eesel](https://www.eesel.ai/blog/lovable-pricing)) | Закрыт. Оценка $13.3B, ARR около $500M+ ([ValueAdd VC](https://valueaddvc.com/blog/lovable-valuation-2026-13-2b-and-500m-arr-how-vibe-coding-actually-makes-money)) **[?]** | Российские карты не проходят |
| **Bolt.new / bolt.diy** | WebContainers (Node в браузере). V2 добавил Bolt Cloud: БД, хостинг, авторизацию, edge-функции ([banani](https://www.banani.co/blog/bolt-new-ai-review-and-alternatives)) | WebContainers | Free 1M токенов в месяц, Pro $25, Teams $30 за участника ([Taskade](https://www.taskade.com/blog/bolt-review)) | bolt.diy под MIT, но **коммитов нет с февраля 2026** ([vp0](https://vp0.com/blogs/open-source-lovable-alternative)) | Оплата недоступна |
| **v0 (Vercel)** | Next.js. С февраля 2026 полноценный full-stack: импорт репозиториев, Git-панель, БД ([UI Bakery](https://uibakery.io/blog/vercel-v0-pricing-explained-what-you-get-and-how-it-compares)) | Vercel Sandbox (microVM, 19 регионов) | Free $5, Premium $20, Team $30, Business $100. v0 Max: $10/$50 за 1M токенов ([nocode.mba](https://www.nocode.mba/articles/v0-pricing)) | Закрыт. Открыт AI SDK | Оплата недоступна |
| **Replit Agent 4** | Параллельные агенты, дизайн-канвас, веб и мобильные приложения. Своя БД и хостинг | Собственные облачные контейнеры | Оплата «по усилию» (от $0.06 за задачу), Pro от $100 для команд. ARR около $525M, оценка $9B ([Sacra](https://sacra.com/c/replit/)) | Закрыт | Сайт открывается без VPN, российские карты отклоняются ([oplatim](https://oplatim.com/kak-oplatit-replit-russia-2026/)) |
| **Base44 (Wix)** | Полностью своя платформа: БД, авторизация, платежи, хостинг, собственная модель Base1 | Свой облачный рантайм | $20 / $50 / $100 в месяц. После покупки Wix цены выросли на 15–30% ([ProductOS](https://productos.dev/blog/base44-review-pricing-features-free-tier)) | Закрыт. Куплен за $80M ([Base44Devs](https://www.base44devs.com/blog/base44-after-wix-acquisition-what-changed)) | Оплата недоступна |
| **Firebase Studio** | **Закрывается.** Новые воркспейсы нельзя создать с 22.06.2026, отключение 22.03.2027. Замена — AI Studio и Antigravity ([Firebase](https://firebase.google.com/docs/studio/migrating-project)) | Облачные VM (Cloud Workstations) | — | — | Google-сервисы в РФ ограничены |
| **Emergent** | Мультиагентная сборка веб- и мобильных приложений, агенты-тестировщики | Облачные VM/K8s **[?]** | ARR $100M за 8 месяцев, 150 тыс. платящих ([TechCrunch](https://techcrunch.com/2026/02/17/emergent-hits-100m-arr-eight-months-after-launch-rolls-out-mobile-app)). Оценка до $1.5B **[?]** | Закрыт | Оплата недоступна |
| **Anything (бывш. Create.xyz)** | Веб и мобильные приложения, 50+ интеграций, Neon Postgres ([Neon](https://neon.com/guides/create-xyz-neon)) | Облако | $39 / $80 / $150 | Закрыт. После ребрендинга были жалобы на потерянные проекты ([hostadvice](https://hostadvice.com/ai-app-builders/anything-review/)) | Оплата недоступна |
| **Dyad** | Локальное десктоп-приложение, любые модели (Ollama/OpenRouter) | Локально | Бесплатно, Pro — хостинговые модели | **Apache-2.0**, кроме каталога `src/pro` (FSL-1.1) ([GitHub](https://github.com/dyad-sh/dyad/)). Активно развивается | Работает, если есть доступ к моделям |
| **Macaly** | Всё в одном: генерация, визуальный редактор, БД, CMS, хостинг. Бэкенд, вероятно, на Convex **[?]** | Облако | Около £25 в месяц ([names.co.uk](https://www.names.co.uk/macaly-ai-vibe-coding-tool/ai-guides/best-ai-app-creator)) | Закрыт | Оплата недоступна |
| **Same.dev** | Свежих данных за 2026 год не нашёл **[?]** | — | — | — | — |

**Выводы по конкурентам:**
- Категория огромная (Lovable, Replit и Emergent выросли до сотен миллионов ARR).
- В России никто из них нормально не продаёт.
- Из открытых решений реально поддерживаются только **Chef** и **Dyad**. bolt.diy и Open Lovable заброшены.

---

## 2. Российский рынок

**Кто уже есть:**
- **Битрикс24 Вайбкод** — бета с апреля 2026. Бизнес-приложения внутри CRM, с сентября есть биржа лидов для студий ([Битрикс24](https://www.bitrix24.ru/journal/bitriks24-otkryl-testirovanie-platformy-dlya-vaybkodinga/)). Это ближайший «промпт → приложение с хостингом», но он заперт в экосистеме Битрикс24.
- **Chatium** — no-code «под ключ»: сайты, боты, Telegram-мини-приложения, хостинг, оплата за токены ([submarineedu](https://submarineedu.ru/blog/rossijskie-servisy-dlya-vaybkodinga)).
- **Yandex SourceCraft Code Assistant** — агентный режим с сентября 2025: репозиторий → код → тесты → PR → деплой. SourceCraft CLI с апреля 2026 построен на OpenCode. Бесплатно 500 нейрокредитов в месяц ([TAdviser](https://www.tadviser.ru/index.php/%D0%9F%D1%80%D0%BE%D0%B4%D1%83%D0%BA%D1%82:Yandex_B2B_Tech:_SourceCraft_Code_Assistant)). Инструмент для разработчиков, не для обычных пользователей.
- **Сбер GigaCode** — плагины, CLI, агентный режим в GitVerse (март 2026) и **GigaCode Desktop** с командой агентов (июль 2026) ([3DNews](https://3dnews.ru/1145177/sber-predstavil-platformu-gigacode-desktop-dlya-avtomatizatsii-zadach-silami-iiagentov)). Тоже для разработчиков.
- **Zerocoder** — это образование (курсы по вайбкодингу), а не платформа ([zerocoder](https://zerocoder.ru/vibe-coding)).
- **MTS/MWS и Timeweb**: подтверждённых конструкторов «промпт → приложение» **не нашёл [?]**.

**Итог по рынку:** в России нет прямого аналога Lovable или Chef для обычного пользователя с чатом, уточняющими вопросами-кнопками и живым превью. Это главная возможность.

**Сигналы спроса:**
- 76–80% российских разработчиков пробовали вайбкодинг ([TAdviser](https://www.tadviser.ru/index.php/%D0%A1%D1%82%D0%B0%D1%82%D1%8C%D1%8F:%D0%92%D0%B0%D0%B9%D0%B1-%D0%BA%D0%BE%D0%B4%D0%B8%D0%BD%D0%B3_(Vibe_coding))).
- Растёт спрос на корпоративный low-code с развёртыванием в закрытом контуре ([Anti-Malware](https://www.anti-malware.ru/analytics/Market_Analysis/Russian-low-code-and-no-code-platforms)).
- Надёжной оценки объёма рынка в рублях нет **[?]**.

**Регулирование:**
- **152-ФЗ.** Первичный сбор и хранение персональных данных граждан РФ — только в базах на территории РФ. Трансграничную передачу нужно заранее уведомить в РКН. Штрафы до 18 млн ₽ ([klerk](https://www.klerk.ru/blogs/roskom24/674017/)). Отсюда требование: и ваша платформа, и **сгенерированные приложения пользователей** должны хранить ПДн в российском облаке. Персональные данные нельзя отправлять в зарубежную LLM без оснований и уведомления.
- **243-ФЗ от 26.07.2026 «О поддержке развития технологий ИИ»**, в силу с 01.09.2026, часть норм с 01.03.2027. Закон рамочный и поддерживающий: вводит категории «суверенных» и «национальных» моделей. Национальные могут включать зарубежные открытые компоненты. Государство вправе требовать только российские модели в чувствительных госсистемах. Платформы с аудиторией 500k+ в сутки обязаны маркировать ИИ-контент ([Хабр](https://habr.com/ru/news/1063114/), [Консультант](https://www.consultant.ru/document/cons_doc_LAW_540336/)). Для B2G и крупных клиентов это аргумент за открытые модели в российском облаке.
- **Блокировки.** Cloudflare частично блокируется с июня 2025 года ([AdminVPS](https://adminvps.ru/blog/blokirovka-cloudflare-v-rossii-tekushhaya-situacziya-i-resheniya-dlya-polzovatelej/)). YouTube заблокирован с февраля 2026. Есть «белые списки» на мобильном интернете ([Wiki](https://en.wikipedia.org/wiki/Wartime_internet_restrictions_in_Russia_(2025%E2%80%93present))). Поэтому превью и хостинг пользовательских приложений нельзя строить на Cloudflare, Vercel или Netlify.
- **Платежи.** Российский эквайринг (ЮKassa, CloudPayments, Т-Банк) работает без проблем. Зарубежные конкуренты принимать рубли не могут, и это ваше преимущество.

---

## 3. Доступ к LLM уровня tier-1 из России

**Прямые API закрыты.** Россия не входит в список поддерживаемых стран Anthropic. С сентября 2025 года запрещены и компании, **более чем на 50% принадлежащие** владельцам из России или Китая, где бы они ни работали ([Anthropic](https://anthropic.com/news/updating-restrictions-of-sales-to-unsupported-regions), [The Decoder](https://the-decoder.com/anthropic-bans-companies-majority-controlled-by-china-russia-iran-and-north-korea-from-claude/)).

**OpenRouter** в мае–июне 2026 перестал принимать оплату из РФ и начал отвечать 403 на российские IP ([Хабр](https://habr.com/ru/news/1034012/)).

**Российские посредники:**
- Работают ProxyAPI, AITunnel, VseGPT, Polza, BotHub, provod, OpenRusRouter.
- Наценка примерно ×3 к официальной цене на Claude у ProxyAPI и ×5–6 на GPT. AITunnel примерно на 25% дешевле, Claude Sonnet — 576/2880 ₽ за 1M токенов ([sostav](https://www.sostav.ru/blogs/289807/86785)).
- Есть закрывающие документы для юрлиц.
- Риски: прямо нарушаются правила поставщика (Anthropic и OpenAI), ключи могут в любой момент отозвать, SLA нет, ваш код и промпты проходят через третью сторону.
- **Схема «иностранное юрлицо + релей за рубежом»** законна только при реальном иностранном владельце (менее 50% у россиян) и конечных пользователях не из РФ. Для продукта для россиян это по сути обход правил, и доступ могут отключить в любой момент.

**Лидеры по бенчмаркам (сентябрь 2026)** **[?: цифры от поставщиков и агрегаторов, методики разные]:**
- Закрытые модели: Claude Opus 5 — около 96% SWE-bench Verified по данным [DataNorth](https://datanorth.ai/news/claude-opus-5-by-anthropic) (на части трекеров официального числа нет). GPT-5.5 — 82% Terminal-Bench 2.0 ([BenchLM](https://benchlm.ai/benchmarks/terminal-bench-2)). На новом Terminal-Bench 4.0 лидирует Claude Fable 5.1 с 57.9%.
- Открытые модели ([Kingy](https://kingy.ai/news/best-open-weight-ai-models-in-2026-glm-5-2-vs-deepseek-v4-vs-kimi-k2-6-vs-qwen-vs-mistral/), [Critique](https://www.critique.sh/blog/minimax-m3-qwen37-plus-welcome-june-2026)):

| Модель | Параметры (всего / активных) | Лицензия | SWE-bench Verified | SWE-bench Pro | Terminal-Bench |
|---|---|---|---|---|---|
| GLM-5.2 | 753B / 40B | MIT | — | 62.1 | 81–83 |
| DeepSeek V4 Pro | 1.6T / 49B | MIT | 80.6 | 55.4 | 67.9 |
| Kimi K2.6 | 1T / 32B | modified MIT | 80.2 | 58.6 | 66.7 |
| MiniMax M3 | — | — | 80.5 | 59.0 | — |
| MiniMax M2.5 | 229B / 10B | — | 80.2 | — | — |
| Qwen3-Coder-Next | 80B / 3B | Apache 2.0 | 70.6 | — | — |
| Kimi K3 | 2.8T / 104B | своя лицензия | — | — | — |

- Kimi K3: веса открыты 27.07.2026, контекст 1M ([Interconnects](https://www.interconnects.ai/p/kimi-k3-the-open-weights-escalation)).
- На Terminal-Bench 2.1 GLM-5.3 показывает 88.2% против 85.0% у Claude Opus 4.8 ([CodingFleet](https://codingfleet.com/blog/terminal-bench-leaderboard-2026/)).
- **Итог:** открытые модели отстают от передовых закрытых примерно на одно поколение, это 3–6 месяцев. На длинных автономных сценариях разрыв заметнее, чем показывают бенчмарки.
- Российские модели: GigaChat 3/3.5 Ultra (открыты под MIT, 702B и 432B-A28B). Публичных SWE-bench-результатов уровня GLM/Kimi нет ([HF](https://huggingface.co/ai-sage/GigaChat3.5-432B-A28B)).

**Открытые модели по API в российских облаках (законно, оплата в рублях):**
- **Cloud.ru Evolution Foundation Models:** GLM-5.1, Kimi K2.6, DeepSeek V4 (с июня 2026), Qwen3-Coder-480B. API совместим с OpenAI ([CISOClub](https://cisoclub.ru/cloud-ru-otkryl-dostup-k-modeljam-glm-5-1-kimi-k2-6-i-deepseek-v4)).
- **Yandex AI Studio:** Qwen3-235B (0.5 ₽ за 1k токенов), gpt-oss-120b (0.3 ₽), Qwen3.6-35B, DeepSeek, Gemma. Есть MCP Hub и конструктор агентов ([pawetta](https://pawetta.com/servisy/yandex-ai-studio/)). Флагманов GLM-5 и Kimi в каталоге **не видно [?]**.

**Аренда GPU в РФ:**
- H100 — около 342–353 ₽/час, H200 — около 423–428 ₽/час (Immers, Intelion, Selectel и др.). В часы пик H100/H200 разбирают, у Timeweb они по предзаказу ([tproger](https://tproger.ru/articles/podborka-oblachnyh-gpu-dlya-ml-2026), [ailist](https://ailist.ru/arenda-gpu-servera-dlya-nejrosetej-v-rossii-2026/)).
- Моя оценка: GLM-5.x в FP8 занимает около 750 ГБ, это узел 8×H200. Выходит примерно 3.4k ₽/час, около 2.5 млн ₽ в месяц за узел. Kimi K3 требует нескольких узлов. Своё железо окупается только при стабильной высокой загрузке, поэтому начинать стоит с API.

---

## 4. Строительные блоки

**Песочницы:**
- **WebContainers:** для коммерческого продакшена нужна лицензия StackBlitz, у коммерческих планов лимит 500 сессий в месяц ([webcontainers.io](https://webcontainers.io/enterprise)). Вендор американский, есть санкционный риск, и Python или нативные зависимости не запускаются. Для России не рекомендую.
- **E2B:** открытый код, Firecracker microVM, около $0.05 за vCPU-час. Можно поднять у себя, но control plane придётся эксплуатировать самим ([Northflank](https://northflank.com/blog/daytona-vs-e2b-ai-code-execution-sandboxes)).
- **Daytona** закрыла код в июне 2026, полностью у себя её больше не развернуть ([bex.co](https://bex.co/blog/2026/07/09/e2b-daytona-modal-sandbox-price-parity)).
- **Modal** — только как облачный сервис США.
- **Практичный вариант для РФ:** своя оркестрация Firecracker или gVisor поверх Kubernetes в Yandex Cloud, Selectel или Cloud.ru. Либо развернуть E2B у себя.

**Бэкенд, на котором строятся сгенерированные приложения:**
- **Convex self-hosted** под лицензией FSL-1.1: запрещён продукт, конкурирующий с Convex Cloud, через 2 года код переходит на Apache ([bex.co](https://bex.co/blog/2026/07/12/convex-fsl-source-available-non-compete)). Платформа, которая массово хостит чужие приложения на Convex, может попасть под этот запрет. **Перед использованием нужна юридическая проверка.**
- **Supabase** (Apache-2) — самый безопасный вариант по лицензии.
- **PocketBase** (MIT) — простой, один бинарник на приложение.
- **Appwrite** (BSD).
- **InstantDB** — открытый код, но менее зрелый **[?]**.

**Фреймворки агентов:**
- Claude Agent SDK удобен, но привязан к Claude и, значит, к санкционному риску.
- Для мультимодельности подходят LangGraph (Python/JS, произвольные графы), Mastra (TypeScript), OpenAI Agents SDK (работает с OpenAI-совместимыми эндпоинтами), OpenHands (готовый открытый агент-разработчик) ([обзор](https://www.morphllm.com/ai-agent-framework)).
- Готовые агенты-ядра: OpenCode (на нём SourceCraft CLI), OpenHands.

**Поиск и документация:**
- **Yandex Search API:** обычный поиск примерно 50–200 ₽ за 1k запросов **[?]**, генеративный ответ — 5 080 ₽ за 1k. Бесплатно около 10k в месяц ([NeuralDeep](https://neuraldeep.ru/yandex-search-api)).
- Tavily (куплен Nebius в феврале 2026), Exa, Brave и Context7: подтверждений блокировки из РФ нет, но зарубежная оплата недоступна, а правила могут измениться **[?]**.
- **Надёжнее всего** собственный индекс документации: зеркало llms.txt, документации npm-пакетов и Context7-подобный RAG в своём облаке, плюс Yandex Search для свежих данных.

---

## 5. Три реалистичных варианта архитектуры

**Общая основа во всех трёх:**
- Хостинг, песочницы, БД пользователей и превью — в российском облаке (152-ФЗ, никакого Cloudflare/Vercel).
- Чат с кнопками-вариантами и живым превью под чатом.
- Цикл «планировщик → кодогенераторы → QA-агент (тесты, Playwright, линтер, аудит безопасности) → исправления».

### A. «Суверенный стек на открытых моделях» — рекомендую как основу

- **Модели:** GLM-5.x, Kimi K2.6 или DeepSeek V4 через Cloud.ru FM или Yandex AI Studio. Позже, по мере роста, свой vLLM на H200.
- **Шаблоны:** жёсткие («Chef-подход»: один хорошо знакомый модели стек, например React + Supabase или PocketBase, с готовыми модулями авторизации, платежей через ЮKassa, CRUD и админки).
- **Качество:** около 80% SWE-bench Verified, примерно на поколение ниже Claude. Разрыв закрывается узким стеком, тестами и QA-циклами.
- **Стоимость:** низкая, токены в 5–20 раз дешевле Claude через посредников.
- **Юридический риск:** минимальный, подходит для B2G и крупных компаний (243-ФЗ, «национальные» модели).
- **Запуск:** 4–6 месяцев до MVP.

### B. «Максимум качества через посредника»

- **Модели:** Claude Opus/Sonnet 5.x через ProxyAPI или AITunnel, либо через зарубежное юрлицо с релеем.
- **Основа:** форк Chef (Apache-2) с заменой WebContainers на свою песочницу.
- **Качество:** максимальное.
- **Стоимость:** высокая, наценка ×3.
- **Юридический и операционный риск:** высокий. Прямое нарушение правил Anthropic, в том числе запрета для компаний под российским контролем. Доступ могут отключить внезапно, как это сделал OpenRouter. Корпоративным клиентам этот вариант продать нельзя.
- **Запуск:** самый быстрый, 2–3 месяца.
- Годится только для закрытой беты и проверки спроса.

### C. «Гибридный маршрутизатор» — целевой вариант

- **Стек:** A как основа, плюс слой маршрутизации моделей (LiteLLM, LangGraph).
- **Кто что делает:** массовую генерацию, исправления и QA делают открытые модели в РФ. Сложные решения по архитектуре и трудные ошибки при включённой настройке отправляются передовой модели через посредника. Туда уходит только код, без ПДн.
- **Отказоустойчивость:** при потере доступа платформа автоматически откатывается на открытые модели.
- **Корпоративный сегмент:** тариф «только российские модели».
- **Качество:** почти как у лучших закрытых моделей при умеренных затратах. Риск ограничен, потому что продукт не зависит от зарубежного API.
- **Запуск:** 5–7 месяцев.

**Что можно сразу взять из открытого кода:**
- Chef (Apache-2) — как образец интерфейса чата с превью и промптов под конкретный бэкенд.
- Dyad (Apache-2, кроме каталога `src/pro`) — логика агентов.
- E2B (открытый код) — песочницы.
- Supabase или PocketBase — бэкенд.
- Convex self-hosted — только после юридической проверки FSL.

**Не опираться на:** WebContainers, Daytona, OpenRouter и Cloudflare.

