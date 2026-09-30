// Telegram Bot API calls (telegram.yaml#api, #error_mapping). The URL contains the bot token: it never reaches
// logs, errors or responses (connector-interface.md §2 «Логи без ПДн»).
import { createHmac } from "node:crypto";
import { ConnectorError } from "./errors.js";

export const TELEGRAM_API_BASE = "https://api.telegram.org";

const TOKEN_IN_PATH = /\/bot[^/\s]+/g;

/** Masks `/bot<token>` segments (for any text that may carry a Bot API URL). */
export function maskTelegramToken(text: string): string {
  return text.replace(TOKEN_IN_PATH, "/bot***");
}

interface BotResponse {
  ok?: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

function mapError(status: number, body: BotResponse): ConnectorError {
  const code = body.error_code ?? status;
  const opts = { providerStatus: code };
  if (code === 400) return new ConnectorError("INVALID_REQUEST", "Telegram отклонил сообщение", opts);
  if (code === 401) return new ConnectorError("AUTH_FAILED", "Telegram не принял токен бота", opts);
  if (code === 403) {
    return new ConnectorError("RECIPIENT_UNAVAILABLE", "Пользователь заблокировал бота", {
      ...opts,
      providerCode: "blocked",
    });
  }
  if (code === 404) return new ConnectorError("AUTH_FAILED", "Telegram не принял токен бота", opts);
  if (code === 429) {
    const after = body.parameters?.retry_after;
    return new ConnectorError("RATE_LIMITED", "Telegram просит подождать", {
      ...opts,
      ...(typeof after === "number" ? { retryAfterMs: after * 1000 } : {}),
    });
  }
  return new ConnectorError("UPSTREAM_UNAVAILABLE", "Telegram временно недоступен", opts);
}

/** POST <apiBase>/bot<token>/<method> with a JSON body; returns `result` or throws a mapped ConnectorError. */
export async function botCall<T = unknown>(
  fetchFn: typeof fetch,
  apiBase: string,
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(`${apiBase.replace(/\/+$/, "")}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    // The fetch error message/cause may contain the URL (and so the token): never propagate it.
    throw new ConnectorError("UPSTREAM_UNAVAILABLE", "Telegram временно недоступен");
  }
  let parsed: BotResponse = {};
  try {
    parsed = (await res.json()) as BotResponse;
  } catch {
    parsed = {};
  }
  if (!res.ok || parsed.ok !== true) throw mapError(res.status, parsed);
  return parsed.result as T;
}

/** 32 chars [A-Za-z0-9_-] derived from a secret (webhook secret_token and hookToken without extra storage). */
export function derivedToken(secret: string, purpose: string): string {
  return createHmac("sha256", secret).update(purpose).digest("base64url").slice(0, 32);
}
