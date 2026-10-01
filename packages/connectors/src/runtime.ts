// Host-side plumbing: PII-free logger, outbox receivers, action invocation with idempotency.
import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConnectorError, isConnectorError } from "./errors.js";
import type {
  AnyConnector,
  ConnectorCtx,
  ConnectorLogEntry,
  ConnectorLogger,
  Outbox,
  OutboxMessage,
} from "./types.js";

export const CALL_TTL_MS = 7 * 24 * 60 * 60_000;

const LOG_FIELDS = [
  "ts",
  "system",
  "env",
  "integration",
  "connector",
  "action",
  "mode",
  "status",
  "errorCode",
  "providerStatus",
  "providerCode",
  "durationMs",
  "idempotencyKey",
] as const satisfies readonly (keyof ConnectorLogEntry)[];

/** Keeps only allowlisted fields with scalar values; strings are cut to 128 chars. */
export function createConnectorLogger(
  base: Pick<ConnectorLogEntry, "system" | "env" | "integration" | "connector">,
  sink: (entry: Partial<ConnectorLogEntry>) => void,
): ConnectorLogger {
  return {
    log(entry) {
      const merged: Record<string, unknown> = { ts: new Date().toISOString(), ...entry, ...base };
      const out: Record<string, string | number> = {};
      for (const k of LOG_FIELDS) {
        const v = merged[k];
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
        else if (typeof v === "string") out[k] = v.slice(0, 128);
      }
      sink(out as Partial<ConnectorLogEntry>);
    },
  };
}

export class MemoryOutbox implements Outbox {
  readonly messages: OutboxMessage[] = [];
  async write(message: OutboxMessage): Promise<void> {
    this.messages.push(structuredClone(message));
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * `.data/outbox/<system>/<connector>.jsonl`; a message with a string `payload.eml` (email) is also written as
 * `.data/outbox/<system>/email/<ts>-<key hash>.eml` (email.yaml#test_mode.draft).
 */
export class JsonlOutbox implements Outbox {
  constructor(private readonly root = ".data/outbox") {}
  async write(message: OutboxMessage): Promise<void> {
    if (!SAFE_SEGMENT.test(message.system)) throw new Error("invalid system id for outbox path");
    const dir = join(this.root, message.system);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${message.connector}.jsonl`), `${JSON.stringify(message)}\n`);
    const eml = message.payload.eml;
    if (typeof eml === "string") {
      const emlDir = join(dir, message.connector);
      await mkdir(emlDir, { recursive: true });
      const key = createHash("sha256").update(message.idempotencyKey).digest("hex").slice(0, 16);
      const ts = message.ts.replace(/[^0-9]/g, "").slice(0, 17);
      await writeFile(join(emlDir, `${ts}-${key}.eml`), eml);
    }
  }
}

export function outboxMessage(
  ctx: ConnectorCtx,
  connector: OutboxMessage["connector"],
  action: string,
  payload: Record<string, unknown>,
): OutboxMessage {
  return {
    ts: ctx.now().toISOString(),
    system: ctx.system.id,
    env: ctx.system.env,
    connector,
    integration: ctx.integration.name,
    action,
    idempotencyKey: ctx.idempotencyKey,
    payload,
  };
}

/** Effects that exist only in test mode (YooKassa draft mock refunds). */
export function requireTestMode(ctx: ConnectorCtx): void {
  if (ctx.mode !== "test") {
    throw new ConnectorError("EGRESS_DISABLED", "В этой версии коннектор работает только в тестовом режиме");
  }
}

export interface InvokeOptions {
  /** Time budget of the caller (connector-interface.md §2 «Повторы»: 30 s for an action). */
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Validates input/output, retries retryable errors (`baseMs · 4^n` ±20% or the provider's retry-after) within the
 * deadline and, for effect actions, returns the stored result for a repeated idempotency key without calling the
 * handler again (connector-interface.md §2 «Идемпотентность», «Повторы»).
 */
export async function invokeAction(
  connector: AnyConnector,
  actionName: string,
  ctx: ConnectorCtx,
  rawInput: unknown,
  opts: InvokeOptions = {},
): Promise<unknown> {
  const action = connector.actions[actionName];
  if (!action) throw new ConnectorError("INVALID_REQUEST", `Действие «${actionName}» не поддерживается`);
  const started = Date.now();
  const deadline = started + (opts.deadlineMs ?? 30_000);
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  const logBase = { action: actionName, mode: ctx.mode, idempotencyKey: ctx.idempotencyKey };
  const parsed = action.input.safeParse(rawInput);
  if (!parsed.success) {
    ctx.log.log({ ...logBase, status: "error", errorCode: "INVALID_REQUEST", durationMs: 0 });
    throw new ConnectorError("INVALID_REQUEST", "Неверные параметры вызова коннектора");
  }
  const cacheKey = `call:${actionName}:${ctx.idempotencyKey}`;
  if (action.effect) {
    if (!ctx.idempotencyKey) throw new Error("effect action requires an idempotency key");
    const hit = await ctx.store.get<{ output: unknown }>(cacheKey);
    if (hit) {
      ctx.log.log({ ...logBase, status: "replayed", durationMs: Date.now() - started });
      return hit.output;
    }
  }
  const attempts = Math.max(1, action.retry?.attempts ?? 1);
  for (let n = 0; ; n++) {
    try {
      const output = action.output.parse(await action.handler(ctx, parsed.data));
      if (action.effect) await ctx.store.set(cacheKey, { output }, CALL_TTL_MS);
      ctx.log.log({ ...logBase, status: "ok", durationMs: Date.now() - started });
      return output;
    } catch (e) {
      const ce = isConnectorError(e) ? e : null;
      const entry: Partial<ConnectorLogEntry> = {
        ...logBase,
        status: "error",
        errorCode: ce ? ce.code : "INTERNAL",
        durationMs: Date.now() - started,
      };
      if (ce?.providerStatus !== undefined) entry.providerStatus = ce.providerStatus;
      if (ce?.providerCode !== undefined) entry.providerCode = ce.providerCode;
      if (ce?.retryable && action.retry && n + 1 < attempts) {
        const wait = ce.retryAfterMs ?? action.retry.baseMs * 4 ** n * (0.8 + 0.4 * random());
        if (Date.now() + wait < deadline) {
          ctx.log.log({ ...entry, status: "retry" });
          await sleep(wait);
          continue;
        }
      }
      ctx.log.log(entry);
      throw e;
    }
  }
}

/**
 * Fixed-window counter in the connector store; over `limit` in the current window → RATE_LIMITED with the time
 * left (email ≤ 300/h, platform Telegram bot per system, invitations ≤ 20/day).
 */
export async function consumeQuota(
  ctx: Pick<ConnectorCtx, "store" | "now">,
  name: string,
  limit: number,
  windowMs: number,
  message: string,
): Promise<void> {
  const now = ctx.now().getTime();
  const window = Math.floor(now / windowMs);
  const key = `quota:${name}:${window}`;
  const used = (await ctx.store.get<number>(key)) ?? 0;
  if (used >= limit) {
    throw new ConnectorError("RATE_LIMITED", message, { retryAfterMs: (window + 1) * windowMs - now });
  }
  await ctx.store.set(key, used + 1, windowMs * 2);
}
