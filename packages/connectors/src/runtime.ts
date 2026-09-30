// Host-side plumbing: PII-free logger, outbox receivers, action invocation with idempotency.
import { appendFile, mkdir } from "node:fs/promises";
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

/** `.data/outbox/<system>/<connector>.jsonl` */
export class JsonlOutbox implements Outbox {
  constructor(private readonly root = ".data/outbox") {}
  async write(message: OutboxMessage): Promise<void> {
    if (!SAFE_SEGMENT.test(message.system)) throw new Error("invalid system id for outbox path");
    const dir = join(this.root, message.system);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${message.connector}.jsonl`), `${JSON.stringify(message)}\n`);
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

/** M0: M1/M2 connectors have no live transport yet. */
export function requireTestMode(ctx: ConnectorCtx): void {
  if (ctx.mode !== "test") {
    throw new ConnectorError("EGRESS_DISABLED", "В этой версии коннектор работает только в тестовом режиме");
  }
}

/**
 * Validates input/output and, for effect actions, returns the stored result for a repeated
 * idempotency key without calling the handler again (connector-interface.md §2 «Идемпотентность»).
 */
export async function invokeAction(
  connector: AnyConnector,
  actionName: string,
  ctx: ConnectorCtx,
  rawInput: unknown,
): Promise<unknown> {
  const action = connector.actions[actionName];
  if (!action) throw new ConnectorError("INVALID_REQUEST", `Действие «${actionName}» не поддерживается`);
  const started = Date.now();
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
  try {
    const output = action.output.parse(await action.handler(ctx, parsed.data));
    if (action.effect) await ctx.store.set(cacheKey, { output }, CALL_TTL_MS);
    ctx.log.log({ ...logBase, status: "ok", durationMs: Date.now() - started });
    return output;
  } catch (e) {
    const errorCode = isConnectorError(e) ? e.code : "INTERNAL";
    ctx.log.log({ ...logBase, status: "error", errorCode, durationMs: Date.now() - started });
    throw e;
  }
}
