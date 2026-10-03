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

/** The render Worker's id in the pool: [a-z0-9_], independent of the G1 system key's length. */
export const renderWorkerId = (key: string) =>
  `r_${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;

export async function startG1Sandbox(
  env: Env,
  o: { log?: (line: Record<string, unknown>) => void; kube?: KubeApi } = {},
): Promise<G1Sandbox | null> {
  const sb = sandboxFromEnv(env, {
    owner: "g1",
    ...(o.log ? { log: o.log } : {}),
    ...(o.kube ? { kube: o.kube } : {}),
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
  await sb.orchestrator.reconcile();
  const { orchestrator, rpc } = sb;
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
          const endpoint = orchestrator.endpointOf(id, "draft");
          if (!endpoint) return { kind: "crash", message: "render Worker is not running" };
          seq += 1;
          return renderRemote({ endpoint, job: { ...job, id: seq }, answer, bridge, timeoutMs });
        },
        // The pod keeps running until the gate releases the system's functions too (one restart per G1 run less).
        close: () => orchestrator.remove(id, "draft", { resync: false }),
      };
    },
    async release(systemIds) {
      for (const id of systemIds) await orchestrator.remove(id, "draft");
    },
    async close() {
      await orchestrator.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
