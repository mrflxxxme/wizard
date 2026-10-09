// Minimal in-cluster Kubernetes API client of the sandbox orchestrator (M2-18): ConfigMaps and Pods of one namespace,
// nothing else (the runtime's Role allows only these). Service account token and CA from the projected volume; the
// token is re-read on every request (kubelet rotates it).
import { readFileSync } from "node:fs";
import { request } from "node:https";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export interface KubePodStatus {
  name: string;
  phase: string;
  ready: boolean;
  podIP: string | null;
  /** Waiting/terminated reason of the container (ImagePullBackOff, CrashLoopBackOff, …). */
  reason: string | null;
  /** How the container's last run ended (Error, OOMKilled, …), its exit code and the restarts so far. */
  lastReason?: string | null;
  exitCode?: number | null;
  restarts?: number;
  /** Reason of a PodScheduled condition that is False (Unschedulable: no node has room). */
  unscheduled?: string | null;
  labels: Record<string, string>;
}

/** What the orchestrator needs from Kubernetes (tests pass a fake). */
export interface KubeApi {
  createConfigMap(cm: Record<string, unknown>): Promise<void>;
  deleteConfigMap(name: string): Promise<void>;
  listConfigMaps(labelSelector: string): Promise<string[]>;
  createPod(pod: Record<string, unknown>): Promise<void>;
  deletePod(name: string): Promise<void>;
  getPod(name: string): Promise<KubePodStatus | null>;
  listPods(labelSelector: string): Promise<KubePodStatus[]>;
}

export class KubeError extends Error {
  override name = "KubeError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Send = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

/** HTTPS transport to the API server of the cluster the pod runs in. */
export function inClusterSend(env: Readonly<Record<string, string | undefined>> = process.env): Send {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = Number(env.KUBERNETES_SERVICE_PORT ?? 443);
  if (!host)
    throw new Error("KUBERNETES_SERVICE_HOST is not set: the sandbox orchestrator runs inside Kubernetes");
  const ca = readFileSync(`${SA_DIR}/ca.crt`);
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const token = readFileSync(`${SA_DIR}/token`, "utf8").trim();
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          host: host.includes(":") ? `[${host}]` : host,
          port,
          method,
          path,
          ca,
          timeout: 15_000,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(data
              ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              parsed = text;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("kubernetes API timeout")));
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
}

function podStatus(p: {
  metadata?: { name?: string; labels?: Record<string, string> };
  status?: {
    phase?: string;
    podIP?: string;
    conditions?: { type?: string; status?: string; reason?: string }[];
    containerStatuses?: {
      state?: { waiting?: { reason?: string }; terminated?: { reason?: string } };
      lastState?: { terminated?: { reason?: string; exitCode?: number } };
      restartCount?: number;
    }[];
  };
}): KubePodStatus {
  const st = p.status ?? {};
  const c0 = st.containerStatuses?.[0];
  const cs = c0?.state;
  const last = c0?.lastState?.terminated;
  const sched = (st.conditions ?? []).find((c) => c.type === "PodScheduled" && c.status === "False");
  return {
    name: p.metadata?.name ?? "",
    phase: st.phase ?? "Unknown",
    ready: (st.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"),
    podIP: st.podIP ?? null,
    reason: cs?.waiting?.reason ?? cs?.terminated?.reason ?? null,
    lastReason: last?.reason ?? null,
    exitCode: typeof last?.exitCode === "number" ? last.exitCode : null,
    restarts: c0?.restartCount ?? 0,
    unscheduled: sched ? (sched.reason ?? "Unschedulable") : null,
    labels: p.metadata?.labels ?? {},
  };
}

/** KubeApi of one namespace over a transport (inClusterSend in the pod). */
export function kubeApi(namespace: string, send: Send): KubeApi {
  const ns = `/api/v1/namespaces/${encodeURIComponent(namespace)}`;
  const ok = async (method: string, path: string, body?: unknown, allow: number[] = []) => {
    const r = await send(method, path, body);
    if ((r.status >= 200 && r.status < 300) || allow.includes(r.status)) return r;
    const msg = (r.body as { message?: string } | null)?.message ?? `HTTP ${r.status}`;
    throw new KubeError(r.status, `${method} ${path}: ${msg}`);
  };
  const sel = (s: string) => `?labelSelector=${encodeURIComponent(s)}`;
  return {
    async createConfigMap(cm) {
      await ok("POST", `${ns}/configmaps`, cm);
    },
    async deleteConfigMap(name) {
      await ok("DELETE", `${ns}/configmaps/${encodeURIComponent(name)}`, undefined, [404]);
    },
    async listConfigMaps(labelSelector) {
      const r = await ok("GET", `${ns}/configmaps${sel(labelSelector)}`);
      return ((r.body as { items?: { metadata?: { name?: string } }[] }).items ?? []).map(
        (i) => i.metadata?.name ?? "",
      );
    },
    async createPod(pod) {
      await ok("POST", `${ns}/pods`, pod);
    },
    async deletePod(name) {
      await ok("DELETE", `${ns}/pods/${encodeURIComponent(name)}?gracePeriodSeconds=0`, undefined, [404]);
    },
    async getPod(name) {
      const r = await ok("GET", `${ns}/pods/${encodeURIComponent(name)}`, undefined, [404]);
      return r.status === 404 ? null : podStatus(r.body as Parameters<typeof podStatus>[0]);
    },
    async listPods(labelSelector) {
      const r = await ok("GET", `${ns}/pods${sel(labelSelector)}`);
      return ((r.body as { items?: Parameters<typeof podStatus>[0][] }).items ?? []).map(podStatus);
    },
  };
}
