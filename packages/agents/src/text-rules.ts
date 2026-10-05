// Shared rules for text written for people (product.yaml#decisions D28_humanizer, D48_plain_language, D49_no_fabrication).
// One module for every agent prompt: the orchestrator and QA write to the owner (chat), the builder writes texts that
// end up inside client systems (system). The deterministic linter (M2-33) comes later; these rules go into prompts now.

export type TextRulesKind = "chat" | "system";

const COMMON: readonly string[] = [
  "Простой язык, как человек человеку: короткие предложения, обычные слова, без канцелярита и воды.",
  "Без технического жаргона: не «сущность», а «данные»; не «RLS», а «кто что видит»; не «деплой», а «публикация». Не упоминай G0/G1/G2, prod, миграции, токены и кредиты.",
  "Без рекламных и раздутых слов («уникальный», «инновационный», «идеальный», «лучший», «№1») и без вступлений вроде «Отличный вопрос!».",
  "Без ИИ-штампов: не перечисляй по три ради ритма, не злоупотребляй длинным тире и восклицательными знаками, без эмодзи.",
  "Не выдумывай факты: цифры, сроки, цены, отзывы, имена, адреса и обещания третьих сторон. Предположение называй предположением («предлагаю», «например»), а не фактом.",
];

const CHAT: readonly string[] = [
  "Если чего-то нет в описании, так и скажи и предложи вариант, а не придумывай ответ за владельца.",
];

const SYSTEM: readonly string[] = [
  "Тексты на страницах системы — по делу: что предлагают, кому, как оставить заявку или записаться.",
  "Отзывы, цифры (стаж, число клиентов, проценты), цены, адреса и телефоны — только из описания владельца. Если их нет, ставь заглушку с пометкой «Пример: …»: владелец заменит её перед публикацией.",
  "Не пиши «лучший в городе», «гарантируем результат» и другие превосходные степени и обещания без подтверждения владельца.",
];

/** Short rule list for prompts: chat — messages to the owner, system — texts inside client systems. */
export function textRules(kind: TextRulesKind): string[] {
  return [...COMMON, ...(kind === "chat" ? CHAT : SYSTEM)];
}

/** The rules as a prompt section body ("- rule" lines). */
export function textRulesSection(kind: TextRulesKind): string {
  return textRules(kind)
    .map((r) => `- ${r}`)
    .join("\n");
}
