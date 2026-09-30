// Idempotency-Key for mutating POSTs (api.yaml#info.description). M0: in-process store, 24 h TTL.
import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { ApiError } from "../errors.js";
import type { AppEnv } from "./auth.js";

const TTL_MS = 24 * 3600_000;
const MAX_ENTRIES = 10_000;

interface Entry {
  bodyHash: string;
  at: number;
  response?: { status: number; body: string; contentType: string };
  pending?: Promise<void>;
}

export class IdempotencyCache {
  readonly #m = new Map<string, Entry>();
  get(key: string): Entry | undefined {
    const e = this.#m.get(key);
    if (e && Date.now() - e.at > TTL_MS) {
      this.#m.delete(key);
      return undefined;
    }
    return e;
  }
  set(key: string, e: Entry): void {
    this.#m.set(key, e);
    while (this.#m.size > MAX_ENTRIES) {
      const oldest = this.#m.keys().next().value;
      if (oldest === undefined) break;
      this.#m.delete(oldest);
    }
  }
  delete(key: string): void {
    this.#m.delete(key);
  }
}

export function idempotency(cache: IdempotencyCache): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (c.req.method !== "POST" || key === undefined) return next();
    if (key.length === 0 || key.length > 64)
      throw new ApiError("VALIDATION_FAILED", "Idempotency-Key — от 1 до 64 символов");
    const ct = c.req.header("content-type") ?? "";
    const raw = ct.startsWith("multipart/") ? "" : await c.req.text();
    const bodyHash = createHash("sha256").update(raw).digest("hex");
    const full = `${c.get("user").id} ${c.req.path} ${key}`;
    let prev = cache.get(full);
    if (prev?.pending) {
      await prev.pending;
      prev = cache.get(full);
    }
    if (prev) {
      if (prev.bodyHash !== bodyHash)
        throw new ApiError(
          "IDEMPOTENCY_MISMATCH",
          "Этот ключ идемпотентности уже использован с другим запросом",
        );
      if (prev.response)
        return c.body(prev.response.body, prev.response.status as 200, {
          "content-type": prev.response.contentType,
          "idempotent-replayed": "true",
        });
    }
    let done!: () => void;
    const entry: Entry = { bodyHash, at: Date.now(), pending: new Promise<void>((r) => (done = r)) };
    cache.set(full, entry);
    try {
      await next();
      if (c.res.status < 500) {
        entry.response = {
          status: c.res.status,
          body: await c.res.clone().text(),
          contentType: c.res.headers.get("content-type") ?? "application/json",
        };
      } else cache.delete(full);
    } catch (e) {
      cache.delete(full);
      throw e;
    } finally {
      entry.pending = undefined;
      done();
    }
  };
}
