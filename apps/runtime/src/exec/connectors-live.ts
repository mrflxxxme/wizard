// ctx.connectors of action functions with connectors: 'live' (M1-06): every call goes through @wizard/connectors
// (validation, test/live mode, idempotency `<functionRunId>:<action>:<n>`, retries); a ConnectorError reaches
// the function as WizardError with the same code (connector-interface.md §3).
import { randomUUID } from "node:crypto";
import { getConnector, invokeAction, isConnectorError } from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import type { ConnectorHost } from "../preview/connectors.js";
import type { LoadedSystem } from "../system.js";

type ActionFn = (input: unknown) => Promise<unknown>;

/** Facade for one function run: a fresh run id per call of the factory. */
export function liveConnectors(
  sys: LoadedSystem,
  host: ConnectorHost,
): Readonly<Record<string, Readonly<Record<string, ActionFn>>>> {
  const runId = randomUUID();
  const counters = new Map<string, number>();
  const out: Record<string, Record<string, ActionFn>> = {};
  for (const integ of sys.spec.integrations ?? []) {
    const connector = getConnector(integ.connector);
    if (!connector) continue;
    const actions: Record<string, ActionFn> = {};
    for (const action of Object.keys(connector.actions)) {
      actions[action] = async (input) => {
        const slot = `${integ.name}:${action}`;
        const n = counters.get(slot) ?? 0;
        counters.set(slot, n + 1);
        const explicit = (input as { idempotencyKey?: unknown } | null)?.idempotencyKey;
        const idempotencyKey =
          typeof explicit === "string" && explicit !== ""
            ? `${integ.name}:${explicit}`
            : `${runId}:${slot}:${n}`;
        try {
          return await invokeAction(connector, action, { ...host.ctx(sys, integ), idempotencyKey }, input, {
            deadlineMs: 25_000,
          });
        } catch (e) {
          if (isConnectorError(e)) throw new WizardError(e.code, { message: e.message });
          throw e;
        }
      };
    }
    out[integ.name] = actions;
  }
  return out;
}
