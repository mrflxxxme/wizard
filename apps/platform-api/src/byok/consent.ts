// The one-time consent to the terms of own model keys (V3-33, D77 (14б)): versioned text; a new version needs a new
// consent before the keys serve builds again. The record keeps the version, the sha256 of the text, who and when
// (platform.byok_consents). The wording is checked by the lawyer before public enablement (V3-35).
import { createHash } from "node:crypto";

export interface ByokConsentText {
  /** yyyy-mm-dd.n — db.yaml#byok_consents.text_version. */
  version: string;
  title: string;
  paragraphs: readonly string[];
}

export const BYOK_CONSENT: ByokConsentText = {
  version: "2026-10-09.1",
  title: "Условия подключения своих ключей моделей",
  paragraphs: [
    "Вы подключаете ключ своей учётной записи у провайдера моделей. Договор с провайдером, его условия, счета, лимиты и блокировки учётной записи — на вашей стороне.",
    "Запросы сборки по вашему ключу уходят провайдеру напрямую, если он принимает запросы из России, или через указанный вами шлюз. Свои способы обхода региональных ограничений Wizard не использует.",
    "Перед отправкой по вашему ключу Wizard заменяет персональные данные заглушками. Записи ваших систем и их пользователей провайдеру не передаются. Описания задач, тексты и код страниц уходят провайдеру, в том числе за пределы России.",
    "Модели, которые мы не проверяли, помечены «не проверена нами»: качество сборки на них может быть ниже. Проверки, критик и техревью работают на моделях Wizard, как обычно.",
    "Вызовы моделей по вашему ключу не списывают кредиты. Если ключ не сработал, шаг выполняется на моделях Wizard и оплачивается кредитами как обычно.",
    "Ключ хранится в зашифрованном виде, в интерфейсе видны только последние 4 символа. Отозвать ключ можно в любой момент, после отзыва он удаляется.",
  ],
};

/** sha256 of the exact text the user saw (title and paragraphs). */
export function consentSha256(c: ByokConsentText = BYOK_CONSENT): string {
  return createHash("sha256")
    .update([c.version, c.title, ...c.paragraphs].join("\n"))
    .digest("hex");
}
