// YooKassa API v3 client (yookassa.yaml#api, #error_mapping). The shop keys never reach logs, errors or responses.
import { createHash } from "node:crypto";
import { ConnectorError } from "./errors.js";
import type { ConnectorCtx, YookassaPlatformConfig } from "./types.js";

export const YOOKASSA_API_BASE = "https://api.yookassa.ru/v3";
/** yookassa.yaml#webhooks.verification (sources of HTTP notifications). */
export const YOOKASSA_IP_ALLOWLIST: readonly string[] = [
  "185.71.76.0/27",
  "185.71.77.0/27",
  "77.75.153.0/25",
  "77.75.156.11",
  "77.75.156.35",
  "77.75.154.128/25",
  "2a02:5180::/32",
];
export const YOOKASSA_TIMEOUT_MS = 30_000;

export const DEFAULT_YOOKASSA_PLATFORM: YookassaPlatformConfig = {
  live: false,
  apiBase: YOOKASSA_API_BASE,
  ipAllowlist: YOOKASSA_IP_ALLOWLIST,
};

export function yookassaPlatform(ctx: Pick<ConnectorCtx, "platform">): YookassaPlatformConfig {
  return ctx.platform.yookassa ?? DEFAULT_YOOKASSA_PLATFORM;
}

export interface Amount {
  value: string;
  currency: string;
}

export interface ApiPayment {
  id: string;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  amount: Amount;
  metadata?: Record<string, string>;
  confirmation?: { type?: string; confirmation_url?: string };
  captured_at?: string;
  created_at?: string;
}

export interface ApiRefund {
  id: string;
  payment_id: string;
  status: "pending" | "succeeded" | "canceled";
  amount: Amount;
  created_at?: string;
}

/** Idempotence-Key: sha256 of the connector key in UUID v4 form (≤ 64 chars). */
export function idempotenceKey(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  const variant = ((Number.parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Kopecks of a money value (number of rubles or the API's "3025.00"). */
export const kop = (v: unknown) => Math.round(Number(v) * 100);
/** API amount {value: "3025.00", currency: "RUB"}. */
export const rub = (v: unknown): Amount => ({ value: (kop(v) / 100).toFixed(2), currency: "RUB" });

/**
 * shopId + secret key of the client's shop. Test mode (draft, or prod with testMode) requires a test shop
 * (`test_…` key); live mode refuses one (yookassa.yaml#test_mode).
 */
export async function shopCredentials(ctx: ConnectorCtx): Promise<{ shopId: string; secretKey: string }> {
  const shopId = await ctx.secrets.get("yookassa_shop_id");
  const secretKey = await ctx.secrets.get("yookassa_secret_key");
  const testKey = secretKey.startsWith("test_");
  if (ctx.mode === "test" && !testKey) {
    throw new ConnectorError(
      "CONFIG_INVALID",
      ctx.system.env === "draft"
        ? "Для черновика нужен тестовый магазин"
        : "Включены тестовые платежи — нужен ключ тестового магазина",
    );
  }
  if (ctx.mode === "live" && testKey) {
    throw new ConnectorError(
      "CONFIG_INVALID",
      "Указан ключ тестового магазина: включите тестовые платежи или укажите рабочий ключ",
    );
  }
  return { shopId, secretKey };
}

function mapError(status: number, code: string | undefined, retryAfter: string | null): ConnectorError {
  const opts = { providerStatus: status, ...(code ? { providerCode: code.slice(0, 64) } : {}) };
  if (status === 401 || status === 403) {
    return new ConnectorError("AUTH_FAILED", "ЮKassa не приняла ключи магазина", opts);
  }
  if (status === 404) return new ConnectorError("NOT_FOUND", "Объект в ЮKassa не найден", opts);
  if (status === 429) {
    const after = Number(retryAfter);
    return new ConnectorError("RATE_LIMITED", "ЮKassa просит подождать", {
      ...opts,
      ...(Number.isFinite(after) && after > 0 ? { retryAfterMs: after * 1000 } : {}),
    });
  }
  if (status >= 500) return new ConnectorError("UPSTREAM_UNAVAILABLE", "ЮKassa временно недоступна", opts);
  return new ConnectorError("INVALID_REQUEST", "ЮKassa отклонила запрос", opts);
}

/**
 * One API request with Basic auth; POST carries Idempotence-Key = idempotenceKey(`key`). Network errors, timeouts
 * (30 s) and 5xx → UPSTREAM_UNAVAILABLE: the caller repeats with the same key (yookassa.yaml#api.http_500).
 */
export async function yookassaRequest<T>(
  ctx: ConnectorCtx,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  key?: string,
): Promise<T> {
  const { shopId, secretKey } = await shopCredentials(ctx);
  const headers: Record<string, string> = {
    authorization: `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString("base64")}`,
    accept: "application/json",
  };
  if (method === "POST") {
    if (!key) throw new Error("YooKassa POST requires an idempotency key");
    headers["content-type"] = "application/json";
    headers["idempotence-key"] = idempotenceKey(key);
  }
  const base = yookassaPlatform(ctx).apiBase.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await ctx.fetch(`${base}${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: AbortSignal.timeout(YOOKASSA_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    throw new ConnectorError("UPSTREAM_UNAVAILABLE", "ЮKassa временно недоступна");
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const code = (parsed as { code?: unknown } | null)?.code;
    throw mapError(res.status, typeof code === "string" ? code : undefined, res.headers.get("retry-after"));
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ConnectorError("UPSTREAM_UNAVAILABLE", "ЮKassa вернула неожиданный ответ", {
      providerStatus: res.status,
    });
  }
  return parsed as T;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Repeats retryable failures with the same idempotency key (3 attempts, 0.3 s · 4^n) — /api/pay and webhooks. */
export async function withRetries<T>(
  fn: () => Promise<T>,
  attempts = 3,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ConnectorError) || !e.retryable || n + 1 >= attempts) throw e;
      await sleep(Math.min(e.retryAfterMs ?? 300 * 4 ** n, 5_000));
    }
  }
}

const seg = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new ConnectorError("NOT_FOUND", "Объект в ЮKassa не найден");
  }
  return id;
};

export const getPayment = (ctx: ConnectorCtx, id: string) =>
  yookassaRequest<ApiPayment>(ctx, "GET", `/payments/${seg(id)}`);

export const getRefund = (ctx: ConnectorCtx, id: string) =>
  yookassaRequest<ApiRefund>(ctx, "GET", `/refunds/${seg(id)}`);

export const createPayment = (ctx: ConnectorCtx, body: Record<string, unknown>, key: string) =>
  yookassaRequest<ApiPayment>(ctx, "POST", "/payments", body, key);

export const cancelPayment = (ctx: ConnectorCtx, id: string, key: string) =>
  yookassaRequest<ApiPayment>(ctx, "POST", `/payments/${seg(id)}/cancel`, {}, key);

export const createRefund = (ctx: ConnectorCtx, body: Record<string, unknown>, key: string) =>
  yookassaRequest<ApiRefund>(ctx, "POST", "/refunds", body, key);

export const createReceipt = (ctx: ConnectorCtx, body: Record<string, unknown>, key: string) =>
  yookassaRequest<{ id: string; status: string }>(ctx, "POST", "/receipts", body, key);
