// Kubernetes objects of a sandbox pod (security/isolation.yaml#M2.pods, #M2.network). Rendered as plain objects for
// the deploy tooling (M2-06, OpenTofu/kubectl); the hardening below is asserted by unit tests and is what the CI
// sandbox job reproduces with `docker run --runtime=runsc` (gVisor) on a disposable runner.
import type { SandboxPoolName } from "./pool.js";

export interface SandboxPodInput {
  name: string;
  namespace: string;
  pool: SandboxPoolName;
  /** Image with workerd only (no shell needed); pinned by digest. */
  image: string;
  /** ConfigMap with config.capnp and the embedded modules (workerd-config.ts). */
  configMap: string;
  /** Ports of the system sockets (basePort … basePort + n - 1) and the liveness socket. */
  basePort: number;
  systems: number;
  healthPort: number;
  /** Memory of the whole pod (≤ 10 isolates × 128 MB + workerd). */
  memoryLimit?: string;
  cpuLimit?: string;
  /** ConfigMap keys → file paths under /etc/workerd (keys cannot hold "/": s0/functions.mjs is s0__functions.mjs). */
  configItems?: readonly { key: string; path: string }[];
  /** Extra labels (the orchestrator's owner and pod id). */
  labels?: Readonly<Record<string, string>>;
}

/**
 * Node label value of a pool: nodes carry wizard.ru/pool=free|paid|business (infra/k3s/*.tftpl), the pool names of
 * SandboxPool are sandbox-free|… — a pod selecting "sandbox-free" would stay Pending forever.
 */
export const poolNodeLabel = (pool: SandboxPoolName): string => pool.replace(/^sandbox-/, "");

export const SANDBOX_RUNTIME_CLASS = "gvisor";
const NONROOT_UID = 65532;

export function sandboxPod(i: SandboxPodInput): Record<string, unknown> {
  const ports = Array.from({ length: i.systems }, (_, k) => ({
    name: `s${k}`,
    containerPort: i.basePort + k,
    protocol: "TCP",
  }));
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: i.name,
      namespace: i.namespace,
      labels: {
        ...i.labels,
        "app.kubernetes.io/name": "wizard-sandbox",
        "wizard.ru/pool": poolNodeLabel(i.pool),
      },
    },
    spec: {
      runtimeClassName: SANDBOX_RUNTIME_CLASS,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      // DNS is denied (isolation.yaml#M2.network): addresses of runtime-rpc and egress-proxy come from the config.
      dnsPolicy: "None",
      dnsConfig: { nameservers: ["127.0.0.1"] },
      nodeSelector: { "wizard.ru/pool": poolNodeLabel(i.pool) },
      tolerations: [
        { key: "wizard.ru/sandbox", operator: "Equal", value: poolNodeLabel(i.pool), effect: "NoSchedule" },
      ],
      securityContext: {
        runAsNonRoot: true,
        runAsUser: NONROOT_UID,
        runAsGroup: NONROOT_UID,
        seccompProfile: { type: "RuntimeDefault" },
      },
      restartPolicy: "Always",
      containers: [
        {
          name: "workerd",
          image: i.image,
          args: ["serve", "/etc/workerd/config.capnp", "--verbose"],
          ports: [...ports, { name: "health", containerPort: i.healthPort, protocol: "TCP" }],
          // A busy isolate blocks the event loop: the probe fails and the pod restarts (CPU limit of a call).
          livenessProbe: {
            httpGet: { path: "/", port: i.healthPort },
            periodSeconds: 5,
            timeoutSeconds: 2,
            failureThreshold: 3,
          },
          readinessProbe: { httpGet: { path: "/", port: i.healthPort }, periodSeconds: 5 },
          resources: {
            limits: { memory: i.memoryLimit ?? "1536Mi", cpu: i.cpuLimit ?? "1" },
            requests: { memory: i.memoryLimit ?? "1536Mi", cpu: "250m" },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            privileged: false,
            capabilities: { drop: ["ALL"] },
          },
          volumeMounts: [{ name: "config", mountPath: "/etc/workerd", readOnly: true }],
        },
      ],
      volumes: [
        {
          name: "config",
          configMap: {
            name: i.configMap,
            ...(i.configItems ? { items: i.configItems.map((x) => ({ ...x })) } : {}),
          },
        },
      ],
    },
  };
}

/**
 * NetworkPolicy of sandbox pods: ingress only from the runtime to the system/health ports; egress only to the runtime
 * RPC listener (rpcPort: 443 by default; the chart serves RPC on the internal port 4101) and the egress proxy (3128).
 * No DNS, no metadata, no other pods.
 */
export function sandboxNetworkPolicy(i: {
  rpcPort?: number;
  namespace: string;
  runtimeSelector: Record<string, string>;
  egressProxySelector: Record<string, string>;
  platformNamespace: string;
  basePort: number;
  systems: number;
  healthPort: number;
}): Record<string, unknown> {
  const platformNs = { "kubernetes.io/metadata.name": i.platformNamespace };
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "wizard-sandbox", namespace: i.namespace },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/name": "wizard-sandbox" } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: platformNs },
              podSelector: { matchLabels: i.runtimeSelector },
            },
          ],
          ports: [
            ...Array.from({ length: i.systems }, (_, k) => ({ protocol: "TCP", port: i.basePort + k })),
            { protocol: "TCP", port: i.healthPort },
          ],
        },
      ],
      egress: [
        {
          to: [
            {
              namespaceSelector: { matchLabels: platformNs },
              podSelector: { matchLabels: i.runtimeSelector },
            },
          ],
          ports: [{ protocol: "TCP", port: i.rpcPort ?? 443 }],
        },
        {
          to: [
            {
              namespaceSelector: { matchLabels: platformNs },
              podSelector: { matchLabels: i.egressProxySelector },
            },
          ],
          ports: [{ protocol: "TCP", port: 3128 }],
        },
      ],
    },
  };
}
