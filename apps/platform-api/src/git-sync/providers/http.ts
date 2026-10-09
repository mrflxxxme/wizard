// HTTP of the provider APIs (V3-31): JSON calls with a timeout, no redirects (a redirect would carry the token to a host
// nobody checked), a bounded body and errors classified for the retry queue. An error never carries a token; it may
// carry the provider's short message (≤ 200 characters) for the owner's status line.

export type ProviderErrorCode =
  | "AUTH_FAILED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "PROTOCOL";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly status: number | null,
    readonly detail: string | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`provider ${code}${status ? ` ${status}` : ""}`);
    this.name = "ProviderError";
  }
  /** Outages and rate limits are retried with backoff; the rest need the owner or a code change. */
  get retryable(): boolean {
    return this.code === "UNAVAILABLE" || this.code === "RATE_LIMITED" || this.code === "PROTOCOL";
  }
}

export interface JsonInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  /** application/x-www-form-urlencoded instead of JSON (OAuth token endpoints accept both; forms are universal). */
  form?: Record<string, string>;
}

const MAX_BODY = 8 * 1024 * 1024;

function retryAfter(h: Headers): number | null {
  const ra = h.get("retry-after");
  if (ra && /^\d+$/.test(ra)) return Number(ra) * 1000;
  const reset = h.get("x-ratelimit-reset");
  if (h.get("x-ratelimit-remaining") === "0" && reset && /^\d+$/.test(reset))
    return Math.max(0, Number(reset) * 1000 - Date.now());
  return null;
}

/** One JSON call; returns the parsed body (null for 204) or throws ProviderError. */
export async function callJson<T>(
  fetchFn: typeof globalThis.fetch,
  url: string,
  init: JsonInit = {},
  timeoutMs = 20_000,
): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "wizard-git-sync/1",
    ...init.headers,
  };
  let body: string | undefined;
  if (init.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  } else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: init.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ProviderError("UNAVAILABLE", null);
  }
  const text = (await res.text()).slice(0, MAX_BODY);
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.ok) {
    if (text && data === null) throw new ProviderError("PROTOCOL", res.status);
    return data as T;
  }
  const msg = (data as { message?: unknown; error_description?: unknown; error?: unknown } | null) ?? null;
  const raw = msg?.message ?? msg?.error_description ?? msg?.error;
  const detail =
    typeof raw === "string" ? raw.slice(0, 200) : Array.isArray(raw) ? String(raw[0]).slice(0, 200) : null;
  const ra = retryAfter(res.headers);
  if (res.status === 401) throw new ProviderError("AUTH_FAILED", 401, detail);
  if (res.status === 403)
    throw new ProviderError(ra !== null ? "RATE_LIMITED" : "FORBIDDEN", 403, detail, ra);
  if (res.status === 404) throw new ProviderError("NOT_FOUND", 404, detail);
  if (res.status === 405 || res.status === 406 || res.status === 409)
    throw new ProviderError("CONFLICT", res.status, detail);
  if (res.status === 429) throw new ProviderError("RATE_LIMITED", 429, detail, ra);
  if (res.status >= 500) throw new ProviderError("UNAVAILABLE", res.status, detail, ra);
  if (res.status === 400 && /oauth|token|grant/i.test(url))
    throw new ProviderError("AUTH_FAILED", 400, detail);
  throw new ProviderError("INVALID", res.status, detail);
}
