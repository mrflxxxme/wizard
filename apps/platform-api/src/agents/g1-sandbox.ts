// G1 in the sandbox (M2-19; security/isolation.yaml#M2): with WIZARD_SANDBOX=k8s the G1 host (the worker running
// agent runs) executes the functions and renders the pages of the system under test in workerd pods under gVisor —
// the same orchestrator as the runtime, owner "g1". Sandbox Workers reach this process on WIZARD_G1_RPC_PORT:
// /rpc/<systemId>/<env> (ctx.* of function calls, capability tokens) and /render-fetch (page data, render tokens).
import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import { type PageRenderer, RenderBridge, renderRemote, renderWorkerModules } from "@wizard/gates";
import { type KubeApi, type SandboxOrchestrator, type SandboxRpc, sandboxFromEnv } from "@wizard/runtime";

export interface G1Sandbox {
  orchestrator: SandboxOrchestrator;
  rpc: SandboxRpc;
  /** RuntimeHandle.renderer of G1-RENDER-01. */
  renderer(input: { key: string; code: string }): Promise<PageRenderer>;
  /** Frees the pods of systems G1 loaded (after the gate). */
  release(systemIds: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Platform events of the G1 runtime that reach the worker log. */
const G1_RUNTIME_EVENTS = new Set([
  "functions_load_failed",
  "job_failed",
  "retention_failed",
  "system_load_failed",
  "unhandled",
]);
const CODE_RE = /^[A-Z][A-Z0-9_]{2,40}$/;
/** Watchdog of the G1 pods: a gate's checks are seconds apart, a hanging system is excluded soon. */
const G1_WATCHDOG_MS = 10_000;
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

/**
 * A log line of the G1 runtime as the worker logs it, or null. The code under test is AI-generated: its ctx.log lines
 * (they carry fn/fields) and any free text stay out of the worker log, and it cannot pass for a platform event —
 * only those events pass, reduced to fixed-shape fields.
 */
export function g1RuntimeLogLine(line: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof line.msg !== "string" || !G1_RUNTIME_EVENTS.has(line.msg) || "fn" in line || "fields" in line)
    return null;
  const out: Record<string, unknown> = { msg: line.msg, level: line.level === "warn" ? "warn" : "error" };
  for (const k of ["system", "env"]) if (typeof line[k] === "string") out[k] = line[k];
  if (typeof line.code === "string" && CODE_RE.test(line.code)) out.code = line.code;
  if (typeof line.sqlstate === "string" && SQLSTATE_RE.test(line.sqlstate)) out.sqlstate = line.sqlstate;
  for (const k of ["step", "attempts"]) if (typeof line[k] === "number") out[k] = line[k];
  return out;
}

/** The render Worker's id in the pool: [a-z0-9_], independent of the G1 system key's length. */
export const renderWorkerId = (key: string) =>
  `r_${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;

export async function startG1Sandbox(
  env: Env,
  o: { log?: (line: Record<string, unknown>) => void; kube?: KubeApi; fetch?: typeof fetch } = {},
): Promise<G1Sandbox | null> {
  const sb = sandboxFromEnv(env, {
    owner: "g1",
    // G1 pods serve only the gate's sequential calls: with no room in the shared quota G1 yields, not the runtime.
    inPlace: true,
    ...(o.log ? { log: o.log } : {}),
    ...(o.kube ? { kube: o.kube } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  if (!sb) return null;
  const bridge = new RenderBridge();
  const port = Number(env.WIZARD_G1_RPC_PORT ?? 4102);
  const server = serve({
    port,
    hostname: env.WIZARD_G1_RPC_HOST ?? "0.0.0.0",
    fetch: (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/rpc/")) return sb.rpc.fetch(req);
      if (path === "/render-fetch") return bridge.fetch(req);
      return new Response(null, { status: 404 });
    },
  });
  // Pods of a previous worker process; the API being unreachable here is not fatal (each prepare reports it).
  await sb.orchestrator
    .reconcile()
    .catch((e: unknown) => o.log?.({ msg: "sandbox_reconcile_failed", error: e }));
  const { orchestrator, rpc } = sb;
  // V3-18: the shared G1 pod runs the systems of several builds — one whose code hangs or crashes workerd is excluded
  // (its calls answer «Функция системы зависла…»), the other builds' checks keep their pod.
  orchestrator.startWatchdog(G1_WATCHDOG_MS);
  return {
    orchestrator,
    rpc,
    async renderer({ key, code }) {
      const id = renderWorkerId(key);
      await orchestrator.prepare({
        systemId: id,
        env: "draft",
        entities: [],
        functionsSource: "",
        worker: renderWorkerModules(code),
      });
      let seq = 0;
      return {
        render: async (job, answer, timeoutMs) => {
          // A pod restarting in place (namespace quota) is waited for within the render's own limit, and the lease
          // keeps a replaced pod alive until this render is done.
          const started = Date.now();
          let lease: Awaited<ReturnType<typeof orchestrator.lease>>;
          try {
            lease = await orchestrator.lease(id, "draft", timeoutMs);
          } catch (e) {
            const restarting = /перезапускается/.test(String((e as Error).message));
            return restarting
              ? { kind: "timeout" }
              : { kind: "crash", message: "render Worker is not running" };
          }
          try {
            const left = timeoutMs - (Date.now() - started);
            if (left < 50) return { kind: "timeout" };
            seq += 1;
            return await renderRemote({
              endpoint: lease.endpoint,
              job: { ...job, id: seq },
              answer,
              bridge,
              timeoutMs: left,
            });
          } finally {
            lease.release();
          }
        },
        // The pod keeps running until the gate releases the system's functions too (one restart per G1 run less).
        close: () => orchestrator.remove(id, "draft", { resync: false }),
      };
    },
    async release(systemIds) {
      // Each one is freed even when another's fails: a system left placed stays in its pod's config. No pod restart
      // for it (V3-18: up to 120 s awaited after every gate) — the pod's next prepare renders the config without it.
      for (const id of systemIds)
        await orchestrator
          .remove(id, "draft", { resync: false })
          .catch((e: unknown) =>
            o.log?.({ msg: "sandbox_release_failed", level: "warn", systemId: id, env: "draft", error: e }),
          );
    },
    async close() {
      await orchestrator.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
