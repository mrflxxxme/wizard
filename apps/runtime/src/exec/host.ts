// FunctionHost of a loaded system: createFunctionHost (@wizard/sdk/host) over DataAccess.runner(), with every
// handler executed in the isolated executor (./executor.ts). One executor pool per LoadedSystem.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { type CurrentUser, type FnKind, WizardError } from "@wizard/sdk";
import {
  createFunctionHost,
  DEFAULT_LIMITS,
  type FunctionHost,
  type Limits,
  type RegisteredFunction,
} from "@wizard/sdk/host";
import type { RuntimeServices } from "../http/context.js";
import type { LoadedSystem } from "../system.js";
import { liveConnectors } from "./connectors-live.js";
import { FunctionExecutor, type HostCtx, UNSAFE_CEILING_MS } from "./executor.js";
import { toShape } from "./validators.js";

export type FunctionLog = (line: Record<string, unknown>) => void;

export interface SystemFunctions {
  host: FunctionHost;
  executor: FunctionExecutor;
}

/** Per-kind deadline of the executor (sdk.md §2.1, capped by the unsafe-local ceiling). */
export function deadlineOf(kind: FnKind, limits: Limits = DEFAULT_LIMITS): number {
  const ms =
    kind === "query"
      ? limits.queryTimeoutMs
      : kind === "mutation"
        ? limits.mutationTimeoutMs
        : limits.actionTimeoutMs;
  return Math.min(ms, UNSAFE_CEILING_MS);
}

// The executor kills the process at its deadline; the host-side race only backs it up.
const HOST_SLACK_MS = 500;

/** Outbox connectors for actions (connectors: 'outbox'): record the call, answer like test mode. */
export function outboxConnectors(
  spec: AppSpec,
  services: RuntimeServices,
): Readonly<Record<string, Readonly<Record<string, (input: unknown) => Promise<unknown>>>>> {
  const out: Record<string, Record<string, (input: unknown) => Promise<unknown>>> = {};
  for (const integ of spec.integrations ?? []) {
    const record = (action: string, input: unknown) => {
      const userId = (input as { userId?: unknown } | null)?.userId;
      services.outbox.push({
        integration: integ.name,
        action,
        userId: typeof userId === "string" ? userId : null,
        payload: input,
        at: services.clock().toISOString(),
      });
    };
    const act =
      (action: string, answer: () => unknown) =>
      async (input: unknown): Promise<unknown> => {
        record(action, input);
        return answer();
      };
    switch (integ.connector) {
      case "telegram":
        out[integ.name] = {
          sendToUser: act("sendToUser", () => ({ delivered: false, reason: "test_mode" })),
        };
        break;
      case "email":
        out[integ.name] = { sendTemplate: act("sendTemplate", () => ({ messageId: randomUUID() })) };
        break;
      case "yookassa":
        out[integ.name] = {
          refund: act("refund", () => ({ refundId: randomUUID(), status: "pending" })),
          getPaymentStatus: act("getPaymentStatus", () => "none"),
        };
        break;
      case "qr":
        out[integ.name] = { revoke: act("revoke", () => null) };
        break;
    }
  }
  return out;
}

async function build(
  sys: LoadedSystem,
  services: RuntimeServices,
  log?: FunctionLog,
): Promise<SystemFunctions> {
  const dir = sys.artifactDir ? resolve(sys.artifactDir) : null;
  if (!dir || !existsSync(join(dir, "server", "functions.mjs"))) {
    throw new WizardError("FUNCTIONS_DISABLED", { message: "Функции системы не загружены" });
  }
  const executor = new FunctionExecutor({ bundleDir: dir, entities: sys.spec.entities.map((e) => e.name) });
  let guest: Awaited<ReturnType<FunctionExecutor["functions"]>>;
  const functions: Record<string, RegisteredFunction> = {};
  try {
    guest = await executor.functions();
    for (const [name, g] of Object.entries(guest)) {
      if (g.kind !== "query" && g.kind !== "mutation" && g.kind !== "action") continue;
      const kind = g.kind;
      const handler = (ctx: HostCtx, args: unknown) => {
        const user = ctx.user as CurrentUser;
        const now = ctx.now instanceof Date ? ctx.now : services.clock();
        return executor.run(name, kind, args, user, now, ctx, deadlineOf(kind));
      };
      functions[name] = Object.freeze({
        kind,
        args: toShape(g.args),
        handler,
        __wizardFunction: true as const,
      }) as unknown as RegisteredFunction;
    }
  } catch (e) {
    executor.close();
    log?.({
      ts: new Date().toISOString(),
      level: "error",
      msg: "functions_load_failed",
      system: sys.entry.slug,
      env: sys.entry.env,
      error: e instanceof Error ? e.message.slice(0, 300) : "unknown",
    });
    throw new WizardError("FUNCTIONS_DISABLED", { message: "Функции системы не загружены" });
  }
  const host = createFunctionHost({
    spec: sys.spec,
    functions,
    transactions: sys.data.runner(),
    connectors: () =>
      services.connectors === "live" && services.connectorHost
        ? liveConnectors(sys, services.connectorHost)
        : outboxConnectors(sys.spec, services),
    clock: services.clock,
    limits: {
      queryTimeoutMs: deadlineOf("query") + HOST_SLACK_MS,
      mutationTimeoutMs: deadlineOf("mutation") + HOST_SLACK_MS,
      actionTimeoutMs: deadlineOf("action") + HOST_SLACK_MS,
    },
    log: (level, msg, fields, fn) =>
      log?.({
        ts: new Date().toISOString(),
        level,
        msg,
        fields,
        fn,
        system: sys.entry.slug,
        env: sys.entry.env,
      }),
  });
  return { host, executor };
}

const cache = new WeakMap<LoadedSystem, Promise<SystemFunctions>>();
const live = new Set<FunctionExecutor>();

/** FunctionHost for a system; the executor pool is created on first use and reused while the system is loaded. */
export function systemFunctions(
  sys: LoadedSystem,
  services: RuntimeServices,
  log?: FunctionLog,
): Promise<SystemFunctions> {
  let p = cache.get(sys);
  if (!p) {
    p = build(sys, services, log).then((f) => {
      live.add(f.executor);
      return f;
    });
    cache.set(sys, p);
    // A failed load is retried on the next call.
    p.catch(() => cache.delete(sys));
  }
  return p;
}

/** Stops every executor process of this runtime process (tests, shutdown). */
export function closeExecutors(): void {
  for (const e of live) e.close();
  live.clear();
}
