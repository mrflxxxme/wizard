# Z.ai (GLM-5.3): договор, данные, оплата. И короткая записка по Moonshot

**Зачем.** GLM-5.3 — основная модель сборки (T1) по концепции v3.1. Прежде чем строить слой T1, нужно письменно зафиксировать три вещи: Россия допустима, API-контент не хранится и не идёт в обучение, есть законный способ платить. Письмо составлено на английском: контрагент сингапурский.

## Что уже известно из открытых условий (проверено 30.09.2026)

| Пункт | Что сказано | Источник |
|---|---|---|
| Контрагент | JINGSHENG HENGXING TECHNOLOGY PTE. LTD., Сингапур; право Сингапура, арбитраж SIAC | [Terms of Use](https://docs.z.ai/legal-agreement/terms-of-use) |
| Запрещённые регионы | Иран, КНДР, Куба, Крым, Донецк, Запорожье. **России в списке нет** | там же |
| Обучение | для API-клиентов контент не используется для улучшения сервисов без явного согласия | там же |
| Хранение | «do not store any of the content… processed in real-time… not saved on our servers» | [Privacy Policy](https://docs.z.ai/legal-agreement/privacy-policy) |
| Место обработки | в основном Сингапур | там же |
| Контакт по данным | user_feedback@z.ai | там же |
| API | `https://api.z.ai/api/paas/v4/`, `Authorization: Bearer`, модель `glm-5.3` | [Quick start](https://docs.z.ai/guides/overview/quick-start) |
| Цена GLM-5.3 | $1.4 вход / $0.26 кэш / $4.4 выход за 1M | [Pricing](https://docs.z.ai/guides/overview/pricing) (по research, не перепроверено) |

**Следствие для роутера.** По условиям Z.ai запросы от имени пользователей из Крыма, ДНР и Запорожской области недопустимы. Тенантов с такими адресами роутер отправляет только в T0. ЛНР в списке нет, но её лучше обрабатывать так же **[?: юрист]**.

## Чек-лист: что должно быть подтверждено письменно

- [ ] Российское юрлицо может быть клиентом API; конечные пользователи — компании в РФ (кроме регионов из списка).
- [ ] **Zero data retention**: промпты и ответы не хранятся. Если что-то хранится (abuse monitoring, логи ошибок), то что именно, где и сколько.
- [ ] **No training**: контент API не используется для обучения ни при каких настройках по умолчанию.
- [ ] **DPA** или письмо о данных за подписью, с перечнем субобработчиков и страной обработки.
- [ ] Корпоративный договор (MSA / Order Form) вместо click-through, если возможно.
- [ ] Лимиты: RPM, TPM, concurrency для нашего профиля (пик 300–700 тыс. TPM на старте, рост ×10 за 6–9 месяцев). Порядок повышения.
- [ ] Кэш промптов: автоматический ли, TTL, цена $0.26 применяется автоматически?
- [ ] GLM-5.3: стабильный id и снапшоты. **Политика вывода моделей**: срок уведомления, минимальный срок поддержки.
- [ ] SLA или хотя бы целевая доступность и статус-страница.
- [ ] Оплата: инвойс на российское юрлицо в USD/CNY/SGD по SWIFT; или приём оплаты от платёжного агента / нашей зарубежной компании; пополнение предоплатного баланса по инвойсу.
- [ ] Закрывающие документы: инвойс и акт (statement of services) — нужны для расходов и НДС налогового агента.
- [ ] Объёмные скидки; кредиты для стартапа.
- [ ] Контакт для эскалаций.

## Письмо (отправить с корпоративного адреса)

Куда: форма на [z.ai](https://z.ai) или раздел Contact Sales, копия — user_feedback@z.ai (вопросы по данным). Если на сайте есть адрес отдела продаж, писать туда. `[...]` заполнить.

> **Subject:** Enterprise API agreement for GLM-5.3 — data processing terms, limits and invoicing (Russian company)
>
> Hello Z.ai team,
>
> I am the founder of `[Company LLC]`, a company incorporated in the Russian Federation (TIN `[...]`). We are building a SaaS platform where AI agents generate business applications for small and mid-sized companies. We would like to use **GLM-5.3** via the Z.ai API as the primary model for application generation, starting with ~`[5–20]` million tokens per day and growing roughly 10× within 6–9 months.
>
> Our design sends the API **no personal data**: only application specifications, source code and synthetic examples, after automatic redaction. We need the following confirmed in writing before we commit:
>
> 1. **Eligibility.** Your Terms of Use restrict Iran, North Korea, Cuba, Crimea, Donetsk and Zaporizhzhia. Please confirm that a Russian-incorporated company may use the API commercially to serve business customers located in Russia (outside the restricted regions).
> 2. **Data retention.** Your Privacy Policy states that API content is not stored. Please confirm zero retention of prompts and completions for our account, and describe any metadata or abuse-monitoring logs you do keep (what, where, how long).
> 3. **No training.** Please confirm that API content is never used to train or improve models.
> 4. **DPA.** Can you provide a Data Processing Agreement or a signed letter covering points 2–3, the processing location (Singapore?) and your subprocessors?
> 5. **Contract.** Do you offer an enterprise agreement (MSA / order form) instead of click-through terms? What is the minimum commitment?
> 6. **Rate limits.** What are the default RPM / TPM / concurrency limits for GLM-5.3, and how can we raise them to ~700k TPM at launch?
> 7. **Model lifecycle.** Is there a pinned snapshot ID for GLM-5.3? What is your deprecation policy (notice period, minimum support window)? Is there an SLA or uptime target and a status page?
> 8. **Prompt caching.** Is caching automatic, what is the cache TTL, and is the cached-input price applied automatically?
> 9. **Payment.** Russian bank cards do not work on your platform. Can you invoice our Russian company directly (USD / CNY / SGD, SWIFT wire), and top up a prepaid balance against an invoice? Alternatively, can you accept payment on our behalf from a licensed payment agent or from our affiliated company abroad? We need a formal invoice and a statement of services for accounting.
> 10. **Pricing.** Are volume discounts or startup credits available?
>
> We would be glad to have a short call. Thank you!
>
> Best regards,
> `[Name]`, Founder, `[Company]`
> `[email]`, `[phone]`

## Если ответ отрицательный или его нет 2 недели

1. Стопорные ответы: Россия недопустима, контент хранится или идёт в обучение, оплаты нет → T1 = Z.ai снимается. Роутер работает на T0. Параллельно — запрос Cloud.ru развернуть GLM-5.3 внутри ([cloudru-questions.md](cloudru-questions.md), п. D).
2. Нет только способа оплаты → вопрос юристу (платёжный агент, [lawyer-brief.md](lawyer-brief.md), P1-9). Для eval хватит $10–20 пополнения любым законным способом.

---

## Moonshot (Kimi K3): параллельная короткая записка

**Статус:** второй кандидат в T1. **Главный стопор** — условия Moonshot допускают обучение на контенте. Без отдельного договора с запретом обучения K3 не включаем.

- Контрагент: Moonshot AI PTE. LTD., Сингапур. Запрет только для стран под всеобъемлющими санкциями ([ToS](https://platform.kimi.ai/docs/agreement/modeluse)), России в нём нет.
- Цена K3: $3 / $0.3 кэш / $15 за 1M ([pricing](https://platform.kimi.ai/docs/pricing/chat)). Это в 2–3 раза дороже GLM-5.3, K3 нужен как резерв и аудитор «другого семейства».
- Страна обработки не указана **[?]**.

**Письмо** — то же, что для Z.ai, с заменой пунктов 2–4:

> 2–3. **No-training agreement.** Your Model Use terms allow content to be used for model improvement. We require a written agreement (or an enterprise opt-out applied to our account) that **no API content is used for training or model improvement**, and that prompts and completions are not retained beyond processing. Please describe what you retain and for how long.
> 4. **Processing location and DPA.** Where is API content processed and stored (country)? Can you sign a DPA listing subprocessors?

Куда отправить: адрес для бизнеса на [platform.kimi.ai](https://platform.kimi.ai) **[?: найти контакт отдела продаж]**. Приоритет ниже Z.ai: отправлять в ту же неделю, но решение по K3 не блокирует старт.
