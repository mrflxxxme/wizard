// YooKassa API v3 client of the PLATFORM's own shop (billing.yaml#recurring.provider; never a client's shop —
// connectors/yookassa.yaml). Same conventions as the connector client (M2-02): Basic auth, Idempotence-Key =
// idempotenceKey(key) in UUID form, network/5xx repeated with the same key. Card data never passes through here:
// the buyer enters it on the YooKassa page, the platform keeps payment_method.id, last4 and a fingerprint.
import { idempotenceKey } from "@wizard/connectors";

export interface ShopCard {
  first6?: string;
  last4: string;
  expiry_month?: string;
  expiry_year?: string;
  card_type?: string;
  issuer_country?: string;
}

export interface ShopPayment {
  id: string;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  amount: { value: string; currency: string };
  metadata?: Record<string, string>;
  confirmation?: { type?: string; confirmation_url?: string };
  payment_method?: { type?: string; id: string; saved?: boolean; card?: ShopCard };
  authorization_details?: { three_d_secure?: { applied?: boolean } };
  cancellation_details?: { party?: string; reason?: string };
}

export class ShopError extends Error {
  override name = "ShopError";
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ShopOptions {
  shopId: string;
  secretKey: string;
  apiBase: string;
  fetch?: typeof fetch;
  /** Pause between repeated attempts (tests pass 0). */
  retryMs?: number;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export class PlatformShop {
  readonly #o: ShopOptions;
  constructor(o: ShopOptions) {
    this.#o = o;
  }

  createPayment(body: Record<string, unknown>, key: string): Promise<ShopPayment> {
    return this.#retry(() => this.#call<ShopPayment>("POST", "/payments", body, key));
  }

  getPayment(id: string): Promise<ShopPayment> {
    if (!ID.test(id)) return Promise.reject(new ShopError("payment not found", false, 404));
    return this.#retry(() => this.#call<ShopPayment>("GET", `/payments/${id}`));
  }

  cancelPayment(id: string, key: string): Promise<ShopPayment> {
    if (!ID.test(id)) return Promise.reject(new ShopError("payment not found", false, 404));
    return this.#retry(() => this.#call<ShopPayment>("POST", `/payments/${id}/cancel`, {}, key));
  }

  async #retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    for (let n = 0; ; n++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof ShopError) || !e.retryable || n + 1 >= attempts) throw e;
        await new Promise((r) => setTimeout(r, (this.#o.retryMs ?? 300) * 4 ** n));
      }
    }
  }

  async #call<T>(method: "GET" | "POST", path: string, body?: unknown, key?: string): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${this.#o.shopId}:${this.#o.secretKey}`).toString("base64")}`,
      accept: "application/json",
    };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      headers["idempotence-key"] = idempotenceKey(key as string);
    }
    let res: Response;
    try {
      res = await (this.#o.fetch ?? fetch)(`${this.#o.apiBase.replace(/\/+$/, "")}${path}`, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ShopError("YooKassa unreachable", true);
    }
    const parsed = (await res.json().catch(() => null)) as T | null;
    if (!res.ok || !parsed || typeof parsed !== "object")
      throw new ShopError(`YooKassa HTTP ${res.status}`, res.status >= 500 || res.ok, res.status);
    return parsed;
  }
}

export const rubles = (kop: number): { value: string; currency: "RUB" } => ({
  value: (kop / 100).toFixed(2),
  currency: "RUB",
});

export const kopOf = (amount: { value: string } | undefined): number =>
  Math.round(Number(amount?.value ?? Number.NaN) * 100);
