# Известные межфайловые расхождения (от авторов разделов, не исправлены)

1. builder.yaml#code_conventions vs runtime/sdk.md: useQuery(api.fnName) vs строковые имена через Functions; типы из sdk.d.ts vs _generated/wizard.d.ts; страницы в ui/pages/ vs page.file. Предложение: builder и gates следуют sdk.md.
2. quality/gates.yaml G0-IDX-01 говорит withIndex(name)/take(≤100); SDK использует where по префиксу индекса (tsc), list ≤100 без where. Переформулировать.
3. security/compliance.yaml#consent требует ConsentCheckbox, которого нет в ui/ui-kit.yaml; разные форматы согласия (_consent {version} vs opts.consent {textHash}); формы, вызывающие функции (registerTicket), не имеют компонента согласия → не пройдут G2-PII-04. Добавить ConsentCheckbox в ui-kit, единый формат.
4. ui-kit.yaml: AppShell.Login «виджет Telegram Login» → OIDC redirect; QrScanner офлайн «сверяет подпись» → только сверка хеша; убрать data_binding.missing_in_sdk.
5. Событие уведомления о ПДн: orchestrator.yaml#pii_notice ждёт событие pii_notice, в platform/workflows.yaml#events его нет; ui использует Message{kind:notice,payload:{type:'pii'}}. Выбрать одно.
6. Форма SystemCard: api.yaml {version, credits{estimate,cap}} vs orchestrator.yaml#system_card {cardVersion, estimate{credits{min,expected,max},minutes}, cap{credits}} (platform-агент выровнял под orchestrator — проверить api.yaml).
7. POST /systems/:id/messages принимает только {text} (additionalProperties:false); для M3 нужен target {componentName, wzId, file}.
8. В api.yaml нет: загрузки логотипа (theme.logoFile), CSV-выгрузки (M2-10), вкладки «Данные» (админ-просмотр данных).
9. Имена событий строителя (builder.yaml) vs workflows.yaml#events: workflows — источник истины.
10. models.yaml usage_record.storage (.data/usage.jsonl) vs db.yaml platform.llm_calls; models.yaml «хранить редактированные промпты 30 дней» vs data-boundary.yaml (по умолчанию выключено).
11. tools/eval: id моделей и формат AppSpec в промпте eval — упрощённый, не соответствует appspec.schema.json (переход на реальную схему — в M0-18).
