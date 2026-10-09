// The Kubernetes API as the repository sandbox's pod runner needs it (V3-32): pods, their logs, ConfigMaps and
// PersistentVolumeClaims of the sandbox namespace — exactly the Role wizard-repo-sandbox of the chart. In the cluster
// the service account token and CA come from the projected volume (re-read per request: kubelet rotates the token);
// tests pass a fake `send`. Responses are capped: a pod log is read only up to its limitBytes anyway.
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { KubeError } from "@wizard/runtime";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const MAX_BODY = 16 * 1024 * 1024;

export type RepoKubeKind = "pods" | "configmaps" | "persistentvolumeclaims";

export interface RepoKubeObject {
  name: string;
  labels: Record<string, string>;
  /** creationTimestamp, ms; null when absent. */
  createdAt: number | null;
}

export interface ContainerState {
  name: string;
  waiting: { reason: string | null; message: string | null } | null;
  running: { startedAt: number | null } | null;
  terminated: {
    exitCode: number | null;
    reason: string | null;
    startedAt: number | null;
    finishedAt: number | null;
  } | null;
}

export interface RepoPodStatus {
  name: string;
  phase: string;
  /** Pod-level reason and message (DeadlineExceeded, Evicted …). */
  reason: string | null;
  message: string | null;
  /** PodScheduled=False with its reason (Unschedulable …); null once scheduled or not reported yet. */
  unschedulable: string | null;
  init: ContainerState[];
  containers: ContainerState[];
}

/** What the pod runner needs from Kubernetes (tests pass a fake). */
export interface RepoKube {
  create(kind: RepoKubeKind, obj: Record<string, unknown>): Promise<void>;
  /** 404 is not an error (already gone). */
  delete(kind: RepoKubeKind, name: string): Promise<void>;
  list(kind: RepoKubeKind, labelSelector: string): Promise<RepoKubeObject[]>;
  getPod(name: string): Promise<RepoPodStatus | null>;
  /** The container's log: the last `tailLines` lines, at most `limitBytes`. */
  podLog(name: string, container: string, o: { tailLines: number; limitBytes: number }): Promise<string>;
}

export type KubeSend = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; text: string }>;

/** HTTPS transport to the API server of the cluster this pod runs in (service account of the pod). */
export function inClusterKubeSend(env: Readonly<Record<string, string | undefined>> = process.env): KubeSend {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = Number(env.KUBERNETES_SERVICE_PORT ?? 443);
  if (!host)
    throw new Error("KUBERNETES_SERVICE_HOST is not set: the repository sandbox runs pods in Kubernetes");
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
          timeout: 30_000,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json, */*",
            ...(data
              ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) return req.destroy(new Error("kubernetes API response too large"));
            chunks.push(c);
          });
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error("kubernetes API timeout")));
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
}

const ms = (t: unknown): number | null => {
  if (typeof t !== "string") return null;
  const v = Date.parse(t);
  return Number.isNaN(v) ? null : v;
};

// biome-ignore lint/suspicious/noExplicitAny: Kubernetes status objects are read field by field
type Raw = Record<string, any>;

function container(c: Raw): ContainerState {
  const s = c.state ?? {};
  return {
    name: String(c.name ?? ""),
    waiting: s.waiting ? { reason: s.waiting.reason ?? null, message: s.waiting.message ?? null } : null,
    running: s.running ? { startedAt: ms(s.running.startedAt) } : null,
    terminated: s.terminated
      ? {
          exitCode: typeof s.terminated.exitCode === "number" ? s.terminated.exitCode : null,
          reason: s.terminated.reason ?? null,
          startedAt: ms(s.terminated.startedAt),
          finishedAt: ms(s.terminated.finishedAt),
        }
      : null,
  };
}

/** The status the runner reads (exported for the fake API of the tests). */
export function podStatusOf(p: Raw): RepoPodStatus {
  const st = p.status ?? {};
  const sched = (st.conditions ?? []).find((c: Raw) => c.type === "PodScheduled");
  return {
    name: String(p.metadata?.name ?? ""),
    phase: st.phase ?? "Pending",
    reason: st.reason ?? null,
    message: st.message ?? null,
    unschedulable: sched && sched.status === "False" ? (sched.reason ?? "Unschedulable") : null,
    init: (st.initContainerStatuses ?? []).map(container),
    containers: (st.containerStatuses ?? []).map(container),
  };
}

/** RepoKube of one namespace over a transport (inClusterKubeSend in the pod). */
export function repoKube(namespace: string, send: KubeSend): RepoKube {
  const ns = `/api/v1/namespaces/${encodeURIComponent(namespace)}`;
  const call = async (method: string, path: string, body?: unknown, allow: number[] = []) => {
    const r = await send(method, path, body);
    if ((r.status >= 200 && r.status < 300) || allow.includes(r.status)) return r;
    let msg = `HTTP ${r.status}`;
    try {
      msg = (JSON.parse(r.text) as { message?: string }).message ?? msg;
    } catch {}
    throw new KubeError(r.status, `${method} ${path.split("?")[0]}: ${msg}`);
  };
  const json = (text: string): Raw => {
    try {
      return JSON.parse(text) as Raw;
    } catch {
      return {};
    }
  };
  return {
    async create(kind, obj) {
      await call("POST", `${ns}/${kind}`, obj);
    },
    async delete(kind, name) {
      const grace = kind === "pods" ? "?gracePeriodSeconds=0" : "";
      await call("DELETE", `${ns}/${kind}/${encodeURIComponent(name)}${grace}`, undefined, [404]);
    },
    async list(kind, labelSelector) {
      const r = await call("GET", `${ns}/${kind}?labelSelector=${encodeURIComponent(labelSelector)}`);
      return ((json(r.text).items ?? []) as Raw[]).map((i) => ({
        name: String(i.metadata?.name ?? ""),
        labels: i.metadata?.labels ?? {},
        createdAt: ms(i.metadata?.creationTimestamp),
      }));
    },
    async getPod(name) {
      const r = await call("GET", `${ns}/pods/${encodeURIComponent(name)}`, undefined, [404]);
      return r.status === 404 ? null : podStatusOf(json(r.text));
    },
    async podLog(name, c, o) {
      const q = `container=${encodeURIComponent(c)}&tailLines=${o.tailLines}&limitBytes=${o.limitBytes}`;
      const r = await call("GET", `${ns}/pods/${encodeURIComponent(name)}/log?${q}`, undefined, [400, 404]);
      // 400: the container never started (no log yet) — nothing to show.
      return r.status === 200 ? r.text : "";
    },
  };
}
