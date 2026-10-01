// JSON error responses (runtime.yaml#data_api.error_shape, #data_api.error_codes) and plain Russian pages.
import { WizardError } from "@wizard/sdk";
import { toErrorResponse } from "@wizard/sdk/host";

/** Codes the shared SDK table does not know (runtime.yaml#data_api.error_codes + runtime-only codes). */
const EXTRA_STATUS: Readonly<Record<string, number>> = {
  LOGIN_METHOD_UNAVAILABLE: 403,
  UNSUPPORTED_MEDIA_TYPE: 415,
  AI_CREDITS_EXHAUSTED: 402,
  AI_LIMIT_REACHED: 429,
  AI_UNAVAILABLE: 503,
  OTP_BUDGET_EXCEEDED: 429,
  FUNCTIONS_DISABLED: 503,
  NOT_IMPLEMENTED: 501,
};

const EXTRA_MESSAGES: Readonly<Record<string, string>> = {
  LOGIN_METHOD_UNAVAILABLE: "Этот способ входа недоступен",
  UNSUPPORTED_MEDIA_TYPE: "Такой тип файла загрузить нельзя",
  NOT_IMPLEMENTED: "Функция пока недоступна",
  FUNCTIONS_DISABLED: "Функции системы временно недоступны",
  AI_CREDITS_EXHAUSTED: "ИИ-действие временно недоступно",
  AI_LIMIT_REACHED: "Лимит ИИ-действий на этот месяц исчерпан",
  AI_UNAVAILABLE: "ИИ-действие временно недоступно, попробуйте позже",
};

export function errorResponse(e: unknown, requestId: string): Response {
  const err =
    e instanceof WizardError && EXTRA_MESSAGES[e.code] && !e.details.message
      ? new WizardError(e.code, { ...e.details, message: EXTRA_MESSAGES[e.code] })
      : e;
  const { status, body } = toErrorResponse(err, requestId);
  body.error.requestId = requestId;
  const code = body.error.code;
  return Response.json(body, { status: EXTRA_STATUS[code] ?? status });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function page(status: number, title: string, text: string): Response {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export const notFoundPage = () =>
  page(404, "Система не найдена", "Проверьте адрес или обратитесь к владельцу системы.");
export const suspendedPage = () =>
  // security/abuse.yaml#messages_ru.http_451: neutral, no details of the complaint.
  page(451, "Система временно недоступна по жалобе", "Владелец системы уведомлён.");
export const misdirectedPage = () => page(421, "Неверный адрес", "Этот адрес не обслуживается.");
export const unavailablePage = () =>
  page(503, "Система временно недоступна", "Попробуйте обновить страницу позже.");
