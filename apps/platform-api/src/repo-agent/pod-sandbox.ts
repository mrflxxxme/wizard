// The cloud runner of the repository sandbox (V3-32; security/isolation.yaml#M2): the client's install, build and
// tests — and the agent's runs of them — execute as gVisor pods in the sandbox namespace, one pod per phase, created by
// platform-api through the Kubernetes API (Role wizard-repo-sandbox of the chart: pods, pods/log, ConfigMaps and PVCs
// of that namespace only). The same machinery as the runtime's workerd pods (apps/runtime sandbox/pod.ts): RuntimeClass
// gvisor on the sandbox pool, PodSecurity restricted, no service account token, no DNS, files through ConfigMaps.
//
// A phase pod: init `restore` (trusted: proves the NetworkPolicy is in effect, unpacks the workspace) → init `run` (the
// client's command under `timeout`, the only untrusted step: it sees /work and /tmp, nothing else) → `save` (trusted:
// packs /work into the workspace's PVC when the command succeeded). Why so:
//   * each phase gets its own NetworkPolicy by label (install → only the egress proxy; build, tests, the agent → no
//     network at all), and nothing the install started survives into the next phase;
//   * the workspace moves between phases as a tar on a per-task PVC that the client's command never mounts, so its
//     size is bounded by trusted code (du before packing) — local-path volumes of k3s enforce no size, an emptyDir with
//     sizeLimit does (kubelet evicts);
//   * the first files come from the platform as tar.gz parts in immutable ConfigMaps (no exec/attach rights needed,
//     a stream into a running pod would need pods/exec on every pod of the namespace); they are deleted once a phase
//     has saved the workspace.
// Limits: `timeout` kills the command at its limit (PID 1 of the container — nothing outlives it), activeDeadlineSeconds
// and the platform's own deadline back it up; every pod is deleted after its phase, the workspace's objects on close,
// and a sweep removes whatever a lost process left (by label and age).
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import {
  assertPhaseNetwork,
  isSafeRepoPath,
  type RepoSandbox,
  type RepoSnapshot,
  type SandboxCommand,
  type SandboxNetwork,
  type SandboxPhase,
  type SandboxResult,
  type SandboxWorkspace,
} from "@wizard/agents/repo";
import { KubeError } from "@wizard/runtime";
import { NeedsOwner, RetryLater } from "../git-sync/context.js";
import type { ContainerState, RepoKube, RepoKubeKind, RepoPodStatus } from "./kube.js";
import { type TarEntry, tarGz } from "./tar.js";

/** Last bytes of a command's output kept for the report (both runners). */
export const OUTPUT_MAX = 8 * 1024;

export const REPO_SANDBOX_APP = "wizard-repo-sandbox";
export const REPO_SANDBOX_RUNTIME_CLASS = "gvisor";
export const REPO_SANDBOX_UID = 10001;
export const LABEL_WORKSPACE = "wizard.ru/repo-sandbox-ws";
export const LABEL_NETWORK = "wizard.ru/repo-sandbox-network";
export const LABEL_PHASE = "wizard.ru/repo-sandbox-phase";
/** The npm registry and its yarn alias: the only hosts of the install phase unless the stand has a mirror. */
export const REGISTRY_HOSTS = ["registry.npmjs.org", "registry.yarnpkg.com"] as const;
/** Label of the install phase's egress grants in the proxy's log. */
export const GRANT_LABEL = "repo_sandbox";
/** One tunnel of the install may carry this much (a registry tarball can exceed the proxy's default 50 MiB). */
export const GRANT_TUNNEL_BYTES = 1024 * 1024 * 1024;

/** Raw bytes of one ConfigMap part (≤ 1 MiB per ConfigMap with the base64 of the request). */
const PART_BYTES = 700 * 1024;
/** Parts of a snapshot (≈ 44 MiB compressed). */
const MAX_PARTS = 64;
const RESTORE_RESOURCES = {
  limits: { cpu: "1", memory: "512Mi" },
  requests: { cpu: "100m", memory: "512Mi" },
};
/** Container states that waiting will not cure. */
const STUCK = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
]);

export const sandboxRu = {
  busy: "Песочница сборки занята другими задачами. Повторим автоматически",
  unavailable: "Песочница сборки не запустилась. Повторим автоматически",
  isolation: "Песочница сборки не подтвердила изоляцию сети. Повторим автоматически",
  tooLarge: "Репозиторий не помещается в песочницу сборки (больше 44 МБ в сжатом виде)",
  timedOut: (s: number) => `[песочница] команда остановлена: прошло ${Math.round(s / 60)} мин`,
  oom: (q: string) => `[песочница] процесс остановлен: не хватило памяти (предел ${q})`,
  workspace: (q: string) => `[песочница] рабочий каталог больше ${q}`,
  saveFailed: "[песочница] не удалось сохранить рабочий каталог после команды",
};

/** Bytes of a Kubernetes quantity ("3Gi", "1536Mi", "500M", "1024"); NaN when it is none. */
export function quantityBytes(q: string): number {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(q.trim());
  if (!m) return Number.NaN;
  const unit = {
    Ki: 2 ** 10,
    Mi: 2 ** 20,
    Gi: 2 ** 30,
    Ti: 2 ** 40,
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
  } as const;
  return Number(m[1]) * (m[2] ? unit[m[2] as keyof typeof unit] : 1);
}

/** Hosts of the install phase: the mirror's host when the stand has one (https, a public DNS name), else the npm registry. */
export function registryHosts(mirror?: string | null): string[] {
  if (!mirror) return [...REGISTRY_HOSTS];
  const u = new URL(mirror);
  if (u.protocol !== "https:" || (u.port && u.port !== "443"))
    throw new Error("WIZARD_REPO_SANDBOX_REGISTRY: an https URL on port 443");
  return [u.hostname.toLowerCase()];
}

// ---------------------------------------------------------------------------------------------------------- pod

/** Workspace layout of a pod: /work/repo (the repository, cwd), /work/home (HOME), /work/cache (package managers). */
const W = "/work";

/** Environment of the client's command in a pod: built from scratch, nothing of the platform's. */
export function podEnv(
  network: SandboxNetwork,
  o: { proxyUrl?: string; registry?: string | null; memoryBytes?: number } = {},
): { name: string; value: string }[] {
  const env: Record<string, string> = {
    HOME: `${W}/home`,
    TMPDIR: "/tmp",
    CI: "1",
    NODE_ENV: "test",
    LANG: "C.UTF-8",
    XDG_CACHE_HOME: `${W}/cache`,
    npm_config_cache: `${W}/cache/npm`,
    npm_config_store_dir: `${W}/cache/pnpm`,
    YARN_CACHE_FOLDER: `${W}/cache/yarn`,
    COREPACK_HOME: `${W}/cache/corepack`,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    NEXT_TELEMETRY_DISABLED: "1",
    // Install scripts that fetch browsers or binaries from CDNs would fail behind the registry-only proxy: skipped.
    PUPPETEER_SKIP_DOWNLOAD: "1",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    CYPRESS_INSTALL_BINARY: "0",
    ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
  };
  if (o.memoryBytes && Number.isFinite(o.memoryBytes))
    env.NODE_OPTIONS = `--max-old-space-size=${Math.floor((o.memoryBytes / 2 ** 20) * 0.75)}`;
  if (o.registry) {
    // The mirror for every manager (corepack fetches pnpm and yarn from it too).
    Object.assign(env, {
      npm_config_registry: o.registry,
      YARN_REGISTRY: o.registry,
      YARN_NPM_REGISTRY_SERVER: o.registry,
      COREPACK_NPM_REGISTRY: o.registry,
    });
  } else env.COREPACK_NPM_REGISTRY = "https://registry.npmjs.org";
  if (network === "none") {
    Object.assign(env, {
      npm_config_offline: "true",
      YARN_ENABLE_NETWORK: "0",
      COREPACK_ENABLE_NETWORK: "0",
    });
  } else if (o.proxyUrl) {
    // Every manager's proxy setting: the egress proxy by address (no DNS), the grant as the password.
    for (const k of [
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "https_proxy",
      "http_proxy",
      "npm_config_https_proxy",
      "npm_config_proxy",
      "YARN_HTTPS_PROXY",
      "YARN_HTTP_PROXY",
    ])
      env[k] = o.proxyUrl;
    env.NO_PROXY = "";
    env.no_proxy = "";
  }
  return Object.entries(env).map(([name, value]) => ({ name, value }));
}

// The shell scripts are template literals: \${…} in them is the shell's parameter expansion, not JavaScript's.

/**
 * Restore (trusted): wait until the pod's NetworkPolicy holds (the API server must be unreachable — a new pod's rules
 * are programmed after it starts), then the saved workspace, or the snapshot parts; then the agent's changes.
 */
export const RESTORE_SCRIPT = `set -eu
W="\${WZ_WORK:-/work}"; S="\${WZ_STORE:-/store}"; I="\${WZ_IN:-/in}"
if [ -n "\${WZ_PROBE:-}" ]; then node -e "$WZ_PROBE_JS"; fi
mkdir -p "$W/repo" "$W/home" "$W/cache"
if [ -f "$S/ws.tar" ]; then tar -xf "$S/ws.tar" -C "$W"
elif [ -d "$I/snap" ]; then cat "$I"/snap/part-* | gzip -dc | tar -xf - -C "$W/repo"; fi
if [ -e "$I/changes/part-0000" ]; then cat "$I"/changes/part-* | gzip -dc | tar -xf - -C "$W/repo"; fi
if [ -s "$I/changes/deleted" ]; then (cd "$W/repo" && xargs -0 rm -f -- < "$I/changes/deleted"); fi
echo "restore: ok"`;

/**
 * The isolation probe of RESTORE_SCRIPT: a connection to WZ_PROBE (host:port of the API server) must fail; it is
 * retried while it succeeds (WZ_PROBE_TRIES, default 20, a second apart), then the pod fails with 70.
 */
export const PROBE_JS = [
  "const net = require('node:net');",
  "const a = process.env.WZ_PROBE; const i = a.lastIndexOf(':');",
  "const host = a.slice(0, i).replace(/^\\[|\\]$/g, ''); const port = Number(a.slice(i + 1));",
  "const tries = Number(process.env.WZ_PROBE_TRIES || 20);",
  "let n = 0;",
  "const once = () => {",
  "  const s = net.connect({ host, port, timeout: 1500 });",
  "  const blocked = () => { s.destroy(); process.exit(0); };",
  "  s.on('timeout', blocked); s.on('error', blocked);",
  "  s.on('connect', () => { s.destroy();",
  "    if (++n >= tries) { console.error('restore: network isolation is not in effect'); process.exit(70); }",
  "    setTimeout(once, 1000); });",
  "};",
  "once();",
].join("\n");

/**
 * Save (trusted): only after a successful command; refuses a workspace over the limit (exit 3); packs repo, home and
 * cache (not /work itself: the volume's root is not ours to restore), without the npm and yarn download caches;
 * replaces the saved copy atomically.
 */
export const SAVE_SCRIPT = `set -eu
W="\${WZ_WORK:-/work}"; S="\${WZ_STORE:-/store}"
if [ "\${WZ_SAVE:-1}" = "0" ]; then exit 0; fi
used=$(du -sk "$W" | cut -f1)
if [ "$used" -gt "$WZ_LIMIT_KIB" ]; then echo "save: $used KiB > $WZ_LIMIT_KIB KiB" >&2; exit 3; fi
set --
for d in repo home cache; do if [ -e "$W/$d" ]; then set -- "$@" "$d"; fi; done
rm -f "$S/ws.tar.new"
tar --sparse --anchored --exclude=cache/npm --exclude=cache/yarn -cf "$S/ws.tar.new" -C "$W" "$@"
mv -f "$S/ws.tar.new" "$S/ws.tar"
echo "save: $used KiB"`;

export interface RepoSandboxPodInput {
  name: string;
  namespace: string;
  /** Workspace id (label; names of its PVC and ConfigMaps). */
  workspace: string;
  phase: SandboxPhase;
  argv: readonly string[];
  timeoutMs: number;
  /** Node 22 + corepack image (infra/docker/repo-sandbox.Dockerfile). */
  image: string;
  /** wizard.ru/pool of the sandbox nodes (the pilot's node: free). */
  pool?: string;
  cpu?: string;
  cpuRequest?: string;
  memory?: string;
  /** emptyDir of the workspace (sizeLimit) and the limit of a save. */
  workspaceSize?: string;
  /** The workspace's PVC (its saved copy). */
  pvc: string;
  /** ConfigMaps of the snapshot parts (until a phase saved the workspace) and of the agent's changes. */
  snapshot?: readonly string[];
  changes?: readonly string[];
  /** Install only: the egress proxy as http://wizard:<grant>@<ip>:<port>. */
  proxyUrl?: string;
  registry?: string | null;
  /** host:port the restore step must find unreachable (the API server); none — no probe (tests). */
  probe?: string | null;
  /** Pack the workspace after a successful command (every phase but the final tests). */
  save: boolean;
  /** Time of restore, scheduling and save on top of the command's (activeDeadlineSeconds). */
  prepMs?: number;
}

const SECURITY = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  privileged: false,
  capabilities: { drop: ["ALL"] },
};

/** The pod of one phase (see the header). */
export function repoSandboxPod(i: RepoSandboxPodInput): Record<string, unknown> {
  const network = i.phase === "install" ? "registry" : "none";
  const pool = i.pool ?? "free";
  const memory = i.memory ?? "2Gi";
  const size = i.workspaceSize ?? "3Gi";
  const seconds = Math.max(1, Math.ceil(i.timeoutMs / 1000));
  const snapshot = i.snapshot?.length ? i.snapshot : null;
  const changes = i.changes?.length ? i.changes : null;
  const projected = (name: string, maps: readonly string[]) => ({
    name,
    projected: { sources: maps.map((m) => ({ configMap: { name: m } })) },
  });
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: i.name,
      namespace: i.namespace,
      labels: {
        "app.kubernetes.io/name": REPO_SANDBOX_APP,
        [LABEL_WORKSPACE]: i.workspace,
        [LABEL_NETWORK]: network,
        [LABEL_PHASE]: i.phase,
      },
    },
    spec: {
      runtimeClassName: REPO_SANDBOX_RUNTIME_CLASS,
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      activeDeadlineSeconds: seconds + Math.ceil((i.prepMs ?? 600_000) / 1000),
      terminationGracePeriodSeconds: 5,
      // No DNS in any phase (security/isolation.yaml#M2.network): the proxy is given by address.
      dnsPolicy: "None",
      dnsConfig: { nameservers: ["127.0.0.1"] },
      nodeSelector: { "wizard.ru/pool": pool },
      tolerations: [{ key: "wizard.ru/sandbox", operator: "Equal", value: pool, effect: "NoSchedule" }],
      securityContext: {
        runAsNonRoot: true,
        runAsUser: REPO_SANDBOX_UID,
        runAsGroup: REPO_SANDBOX_UID,
        fsGroup: REPO_SANDBOX_UID,
        seccompProfile: { type: "RuntimeDefault" },
      },
      initContainers: [
        {
          name: "restore",
          image: i.image,
          command: ["sh", "-c", RESTORE_SCRIPT],
          workingDir: "/",
          env: [
            ...(i.probe
              ? [
                  { name: "WZ_PROBE", value: i.probe },
                  { name: "WZ_PROBE_JS", value: PROBE_JS },
                ]
              : []),
          ],
          resources: RESTORE_RESOURCES,
          securityContext: SECURITY,
          volumeMounts: [
            { name: "work", mountPath: W },
            { name: "tmp", mountPath: "/tmp" },
            { name: "store", mountPath: "/store", readOnly: true },
            ...(snapshot ? [{ name: "snap", mountPath: "/in/snap", readOnly: true }] : []),
            ...(changes ? [{ name: "changes", mountPath: "/in/changes", readOnly: true }] : []),
          ],
        },
        {
          name: "run",
          image: i.image,
          // timeout is PID 1 of the container: TERM at the limit, KILL 10 s later; nothing it started outlives it.
          command: ["timeout", "-k", "10", String(seconds), ...i.argv],
          workingDir: `${W}/repo`,
          env: podEnv(network, {
            ...(i.proxyUrl ? { proxyUrl: i.proxyUrl } : {}),
            registry: i.registry ?? null,
            memoryBytes: quantityBytes(memory),
          }),
          resources: {
            limits: { cpu: i.cpu ?? "2", memory },
            requests: { cpu: i.cpuRequest ?? "500m", memory },
          },
          securityContext: SECURITY,
          volumeMounts: [
            { name: "work", mountPath: W },
            { name: "tmp", mountPath: "/tmp" },
          ],
        },
      ],
      containers: [
        {
          name: "save",
          image: i.image,
          command: ["sh", "-c", SAVE_SCRIPT],
          workingDir: "/",
          env: [
            { name: "WZ_SAVE", value: i.save ? "1" : "0" },
            { name: "WZ_LIMIT_KIB", value: String(Math.floor(quantityBytes(size) / 1024)) },
          ],
          resources: RESTORE_RESOURCES,
          securityContext: SECURITY,
          volumeMounts: [
            { name: "work", mountPath: W, readOnly: true },
            { name: "tmp", mountPath: "/tmp" },
            { name: "store", mountPath: "/store" },
          ],
        },
      ],
      volumes: [
        { name: "work", emptyDir: { sizeLimit: size } },
        { name: "tmp", emptyDir: { sizeLimit: "1Gi" } },
        { name: "store", persistentVolumeClaim: { claimName: i.pvc } },
        ...(snapshot ? [projected("snap", snapshot)] : []),
        ...(changes ? [projected("changes", changes)] : []),
      ],
    },
  };
}

/**
 * NetworkPolicies of the repository sandbox (the chart renders them from this function; the namespace's default-deny
 * is there too): install → only the egress proxy's port; build, tests and the agent → nothing; no ingress at all.
 */
export function repoSandboxNetworkPolicy(i: {
  namespace: string;
  proxy: { namespace: string; selector: Record<string, string>; port: number };
}): Record<string, unknown>[] {
  const policy = (name: string, network: SandboxNetwork, egress: unknown[]) => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name, namespace: i.namespace },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/name": REPO_SANDBOX_APP, [LABEL_NETWORK]: network } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress,
    },
  });
  return [
    policy("wizard-repo-sandbox-none", "none", []),
    policy("wizard-repo-sandbox-registry", "registry", [
      {
        to: [
          {
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": i.proxy.namespace } },
            podSelector: { matchLabels: i.proxy.selector },
          },
        ],
        ports: [{ protocol: "TCP", port: i.proxy.port }],
      },
    ]),
  ];
}

// --------------------------------------------------------------------------------------------------- the runner

export interface PodSandboxOptions {
  kube: RepoKube;
  namespace: string;
  image: string;
  pool?: string;
  cpu?: string;
  cpuRequest?: string;
  memory?: string;
  workspaceSize?: string;
  /** PVC request (the saved copy and its replacement during a save). */
  storeSize?: string;
  storageClass?: string | null;
  /** npm registry mirror (https); none — registry.npmjs.org and registry.yarnpkg.com. */
  registry?: string | null;
  /** The egress proxy as the pods reach it: {host: <IP>, port} (they have no DNS). */
  proxy: () => Promise<{ host: string; port: number }>;
  /** An egress grant (signed like the runtime's) for `hosts`, valid `ttlMs`, with the install's tunnel limits. */
  grant: (hosts: readonly string[], ttlMs: number) => string;
  /** host:port the restore step must find unreachable (the API server). */
  probe?: string | null;
  /** Objects older than this are swept (default 90 min; a task's lease is 30 min). */
  ttlMs?: number;
  /** Waiting for room in the namespace quota (default 5 min). */
  quotaWaitMs?: number;
  /** A pod nobody can schedule is given up after (default 3 min). */
  scheduleWaitMs?: number;
  /** Restore, start and save on top of a command's limit (default 10 min). */
  prepMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: Record<string, unknown>) => void;
}

const isQuota = (e: unknown) => e instanceof KubeError && e.status === 403 && /quota/i.test(e.message);
const tailOf = (s: string) => (s.length > OUTPUT_MAX ? s.slice(-OUTPUT_MAX) : s);
const human = (q: string) => {
  const b = quantityBytes(q);
  if (!Number.isFinite(b)) return q;
  if (b >= 2 ** 30) return `${String(+(b / 2 ** 30).toFixed(1)).replace(".", ",")} ГБ`;
  return b >= 2 ** 20 ? `${Math.round(b / 2 ** 20)} МБ` : `${Math.round(b / 1024)} КБ`;
};

/** The snapshot as tar entries: regular files and symlinks that stay inside the repository; no submodules. */
export function snapshotEntries(snapshot: RepoSnapshot): TarEntry[] {
  const out: TarEntry[] = [];
  for (const [path, f] of snapshot) {
    if (f.mode === "160000" || !f.data || !isSafeRepoPath(path)) continue;
    if (f.mode === "120000") {
      const target = Buffer.from(f.data).toString("utf8");
      const points = posix.resolve("/r", posix.dirname(path), target);
      if (!target.startsWith("/") && points.startsWith("/r/")) out.push({ path, link: target });
      continue;
    }
    out.push({ path, data: f.data, exec: f.mode === "100755" });
  }
  return out;
}

const parts = (b: Buffer): Buffer[] => {
  const out: Buffer[] = [];
  for (let at = 0; at < b.length; at += PART_BYTES) out.push(b.subarray(at, at + PART_BYTES));
  return out;
};
const partKey = (n: number) => `part-${String(n).padStart(4, "0")}`;

export class PodSandbox implements RepoSandbox {
  readonly kind = "pod";
  #sweeper: NodeJS.Timeout | undefined;
  constructor(readonly o: PodSandboxOptions) {}

  now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  wait(ms: number): Promise<void> {
    return this.o.sleep ? this.o.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** A log line: failures at warn (the sweep or a retry takes care of them), the rest at info. */
  log(line: Record<string, unknown>): void {
    this.o.log?.({ level: /_failed$|_lost$/.test(String(line.msg)) ? "warn" : "info", ...line });
  }

  /** Creates an object, waiting while the namespace quota has no room; API failures become RetryLater. */
  async create(kind: RepoKubeKind, obj: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const until = this.now() + (this.o.quotaWaitMs ?? 300_000);
    for (let first = true; ; first = false) {
      try {
        await this.o.kube.create(kind, obj);
        return;
      } catch (e) {
        if (!isQuota(e)) {
          this.log({ msg: "repo_sandbox_api_failed", step: kind, error: e });
          throw new RetryLater("SANDBOX_UNAVAILABLE", sandboxRu.unavailable);
        }
        if (first) this.log({ msg: "repo_sandbox_quota_wait", step: kind });
        if (this.now() >= until || signal?.aborted) throw new RetryLater("SANDBOX_BUSY", sandboxRu.busy);
        await this.wait(this.o.pollMs ?? 2000);
      }
    }
  }

  /** Deletes an object; a failure is logged and left to the sweep. */
  async drop(kind: RepoKubeKind, name: string): Promise<void> {
    await this.o.kube
      .delete(kind, name)
      .catch((e: unknown) =>
        this.log({ msg: "repo_sandbox_delete_failed", step: `${kind}/${name}`, error: e }),
      );
  }

  /** ConfigMaps holding `data` in parts (immutable, labelled with the workspace). */
  async putParts(
    ws: string,
    base: string,
    data: Buffer,
    extra: Record<string, Uint8Array> = {},
    signal?: AbortSignal,
  ): Promise<string[]> {
    const chunks = parts(data);
    const names: string[] = [];
    const count = Math.max(1, chunks.length);
    for (let n = 0; n < count; n++) {
      const name = `${base}-${n}`;
      const binaryData: Record<string, string> = {};
      const chunk = chunks[n];
      if (chunk) binaryData[partKey(n)] = chunk.toString("base64");
      if (n === 0)
        for (const [k, v] of Object.entries(extra)) binaryData[k] = Buffer.from(v).toString("base64");
      await this.create(
        "configmaps",
        {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: {
            name,
            namespace: this.o.namespace,
            labels: { "app.kubernetes.io/name": REPO_SANDBOX_APP, [LABEL_WORKSPACE]: ws },
          },
          immutable: true,
          binaryData,
        },
        signal,
      );
      names.push(name);
    }
    return names;
  }

  async open(snapshot: RepoSnapshot, signal?: AbortSignal): Promise<SandboxWorkspace> {
    const id = randomBytes(5).toString("hex");
    const ws = new PodWorkspace(this, id);
    try {
      const packed = await tarGz(snapshotEntries(snapshot));
      if (parts(packed).length > MAX_PARTS) throw new NeedsOwner("TOO_LARGE", sandboxRu.tooLarge);
      ws.snapshot = await this.putParts(id, `${ws.base}-snap`, packed, {}, signal);
      await this.create(
        "persistentvolumeclaims",
        {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: {
            name: ws.base,
            namespace: this.o.namespace,
            labels: { "app.kubernetes.io/name": REPO_SANDBOX_APP, [LABEL_WORKSPACE]: id },
          },
          spec: {
            accessModes: ["ReadWriteOnce"],
            ...(this.o.storageClass ? { storageClassName: this.o.storageClass } : {}),
            resources: { requests: { storage: this.o.storeSize ?? "6Gi" } },
          },
        },
        signal,
      );
    } catch (e) {
      await ws.close();
      throw e;
    }
    this.log({ msg: "repo_sandbox_open", step: id, count: snapshot.size });
    return ws;
  }

  /** Removes the repository sandbox's objects older than the TTL (a lost process, a failed delete). */
  async sweep(): Promise<number> {
    const before = this.now() - (this.o.ttlMs ?? 90 * 60_000);
    let n = 0;
    for (const kind of ["pods", "configmaps", "persistentvolumeclaims"] as const) {
      const items = await this.o.kube.list(kind, `app.kubernetes.io/name=${REPO_SANDBOX_APP}`);
      for (const it of items) {
        if (it.createdAt === null || it.createdAt >= before) continue;
        await this.drop(kind, it.name);
        n++;
      }
    }
    if (n) this.log({ msg: "repo_sandbox_swept", count: n });
    return n;
  }

  /** Sweeps now and every `intervalMs` (the process's lifetime; the timer does not hold it). */
  startSweeper(intervalMs = 10 * 60_000): void {
    if (this.#sweeper) return;
    const run = () =>
      void this.sweep().catch((e: unknown) => this.log({ msg: "repo_sandbox_sweep_failed", error: e }));
    run();
    this.#sweeper = setInterval(run, intervalMs);
    this.#sweeper.unref();
  }

  stopSweeper(): void {
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = undefined;
  }
}

type PodEnd =
  | { kind: "done"; pod: RepoPodStatus }
  | { kind: "deadline"; pod: RepoPodStatus | null }
  | { kind: "aborted" };

class PodWorkspace implements SandboxWorkspace {
  readonly base: string;
  /** ConfigMaps of the snapshot; null once a phase saved the workspace (deleted then). */
  snapshot: string[] | null = null;
  #saved = false;
  /** The agent's changes not yet in a saved workspace (path → text, null deletes). */
  readonly #pending = new Map<string, string | null>();
  #seq = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(
    private readonly sb: PodSandbox,
    readonly id: string,
  ) {
    this.base = `wz-repo-${id}`;
  }

  async run(cmd: SandboxCommand, signal?: AbortSignal): Promise<SandboxResult> {
    assertPhaseNetwork(cmd);
    // One phase at a time: the PVC is ReadWriteOnce and a phase starts from the previous one's save.
    const next = this.#queue.catch(() => {}).then(() => this.#run(cmd, signal));
    this.#queue = next;
    return next;
  }

  async write(changes: ReadonlyMap<string, string | null>): Promise<void> {
    for (const [path, text] of changes) if (isSafeRepoPath(path)) this.#pending.set(path, text);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const sel = `${LABEL_WORKSPACE}=${this.id}`;
    for (const kind of ["pods", "configmaps", "persistentvolumeclaims"] as const) {
      const items = await this.sb.o.kube.list(kind, sel).catch((e: unknown) => {
        this.sb.log({ msg: "repo_sandbox_delete_failed", step: kind, error: e });
        return [];
      });
      for (const it of items) await this.sb.drop(kind, it.name);
    }
  }

  async #putChanges(
    k: number,
    signal?: AbortSignal,
  ): Promise<{ names: string[]; sent: Map<string, string | null> }> {
    const sent = new Map(this.#pending);
    const files: TarEntry[] = [];
    const deleted: string[] = [];
    for (const [path, text] of sent) {
      if (text === null) deleted.push(path);
      else files.push({ path, data: Buffer.from(text, "utf8") });
    }
    const extra: Record<string, Uint8Array> = deleted.length
      ? { deleted: Buffer.from(`${deleted.join("\0")}\0`, "utf8") }
      : {};
    const names = await this.sb.putParts(
      this.id,
      `${this.base}-ch${k}`,
      files.length ? await tarGz(files) : Buffer.alloc(0),
      extra,
      signal,
    );
    return { names, sent };
  }

  async #run(cmd: SandboxCommand, signal?: AbortSignal): Promise<SandboxResult> {
    if (this.#closed) throw new Error("repo sandbox: the workspace is closed");
    const o = this.sb.o;
    const started = this.sb.now();
    const k = ++this.#seq;
    const name = `${this.base}-${cmd.phase}-${k}`;
    const save = cmd.phase !== "test";
    let changes: { names: string[]; sent: Map<string, string | null> } | null = null;
    let token: string | null = null;
    try {
      if (this.#pending.size) changes = await this.#putChanges(k, signal);
      let proxyUrl: string | undefined;
      if (cmd.network === "registry") {
        const p = await o.proxy().catch((e: unknown) => {
          this.sb.log({ msg: "repo_sandbox_proxy_failed", step: name, error: e });
          throw new RetryLater("SANDBOX_UNAVAILABLE", sandboxRu.unavailable);
        });
        token = o.grant(registryHosts(o.registry), cmd.timeoutMs + (o.prepMs ?? 600_000));
        proxyUrl = `http://wizard:${token}@${p.host.includes(":") ? `[${p.host}]` : p.host}:${p.port}`;
      }
      const pod = repoSandboxPod({
        name,
        namespace: o.namespace,
        workspace: this.id,
        phase: cmd.phase,
        argv: cmd.argv,
        timeoutMs: cmd.timeoutMs,
        image: o.image,
        pvc: this.base,
        save,
        ...(o.pool ? { pool: o.pool } : {}),
        ...(o.cpu ? { cpu: o.cpu } : {}),
        ...(o.cpuRequest ? { cpuRequest: o.cpuRequest } : {}),
        ...(o.memory ? { memory: o.memory } : {}),
        ...(o.workspaceSize ? { workspaceSize: o.workspaceSize } : {}),
        ...(this.snapshot && !this.#saved ? { snapshot: this.snapshot } : {}),
        ...(changes ? { changes: changes.names } : {}),
        ...(proxyUrl ? { proxyUrl } : {}),
        registry: o.registry ?? null,
        probe: o.probe ?? null,
        ...(o.prepMs !== undefined ? { prepMs: o.prepMs } : {}),
      });
      await this.sb.create("pods", pod, signal);
      const end = await this.#wait(name, cmd, signal);
      const r = await this.#result(name, cmd, end, started, save, token);
      this.sb.log({
        msg: "repo_sandbox_phase",
        step: `${this.id}/${cmd.phase}`,
        status: r.ok ? "ok" : r.timedOut ? "timeout" : "failed",
        durationMs: r.durationMs,
      });
      if (r.saved) {
        this.#saved = true;
        if (changes)
          for (const [p, t] of changes.sent) if (this.#pending.get(p) === t) this.#pending.delete(p);
        if (this.snapshot) {
          // The workspace now lives in the PVC: the client's files leave the ConfigMaps.
          for (const cm of this.snapshot) await this.sb.drop("configmaps", cm);
          this.snapshot = null;
        }
      }
      const { saved: _saved, ...result } = r;
      return result;
    } finally {
      await this.sb.drop("pods", name);
      for (const cm of changes?.names ?? []) await this.sb.drop("configmaps", cm);
    }
  }

  async #wait(name: string, cmd: SandboxCommand, signal?: AbortSignal): Promise<PodEnd> {
    const o = this.sb.o;
    const created = this.sb.now();
    const deadline = created + cmd.timeoutMs + (o.prepMs ?? 600_000) + 30_000;
    let last: RepoPodStatus | null = null;
    for (;;) {
      if (signal?.aborted) return { kind: "aborted" };
      let p: RepoPodStatus | null | undefined;
      try {
        p = await o.kube.getPod(name);
      } catch (e) {
        // A blip of the API server: keep polling until the deadline.
        this.sb.log({ msg: "repo_sandbox_api_failed", step: name, error: e });
        p = undefined;
      }
      if (p === null) {
        this.sb.log({ msg: "repo_sandbox_pod_lost", step: name });
        throw new RetryLater("SANDBOX_UNAVAILABLE", sandboxRu.unavailable);
      }
      if (p) {
        last = p;
        if (p.phase === "Succeeded" || p.phase === "Failed") return { kind: "done", pod: p };
        const stuck = [...p.init, ...p.containers].find(
          (c) => c.waiting && STUCK.has(c.waiting.reason ?? ""),
        );
        if (stuck) {
          this.sb.log({ msg: "repo_sandbox_pod_failed", step: name, reason: stuck.waiting?.reason });
          throw new RetryLater("SANDBOX_UNAVAILABLE", sandboxRu.unavailable);
        }
        if (p.unschedulable && this.sb.now() - created > (o.scheduleWaitMs ?? 180_000)) {
          this.sb.log({ msg: "repo_sandbox_pod_failed", step: name, reason: p.unschedulable });
          throw new RetryLater("SANDBOX_UNAVAILABLE", sandboxRu.unavailable);
        }
      }
      if (this.sb.now() >= deadline) return { kind: "deadline", pod: last };
      await this.sb.wait(o.pollMs ?? 1000);
    }
  }

  async #result(
    name: string,
    cmd: SandboxCommand,
    end: PodEnd,
    started: number,
    save: boolean,
    token: string | null,
  ): Promise<SandboxResult & { saved: boolean }> {
    const o = this.sb.o;
    const wall = () => this.sb.now() - started;
    if (end.kind === "aborted")
      return {
        phase: cmd.phase,
        ok: false,
        exitCode: null,
        timedOut: false,
        durationMs: wall(),
        output: "",
        saved: false,
      };
    const pod = end.pod;
    const restore = pod?.init.find((c) => c.name === "restore");
    const run = pod?.init.find((c) => c.name === "run");
    const saver = pod?.containers.find((c) => c.name === "save");
    // The trusted restore failed or never let the command start: the platform's problem, not the repository's.
    if (restore?.terminated && restore.terminated.exitCode !== 0) {
      const log = await o.kube.podLog(name, "restore", { tailLines: 20, limitBytes: 4096 }).catch(() => "");
      this.sb.log({ msg: "repo_sandbox_restore_failed", step: name, reason: log.slice(-500) });
      throw new RetryLater(
        "SANDBOX_UNAVAILABLE",
        restore.terminated.exitCode === 70 ? sandboxRu.isolation : sandboxRu.unavailable,
      );
    }
    const t = run?.terminated ?? null;
    if (!t && !run?.running) {
      this.sb.log({ msg: "repo_sandbox_pod_failed", step: name, reason: pod?.reason ?? end.kind });
      throw new RetryLater("SANDBOX_UNAVAILABLE", sandboxRu.unavailable);
    }
    let output = await o.kube
      .podLog(name, "run", { tailLines: 200, limitBytes: 1024 * 1024 })
      .catch(() => "");
    if (token) output = output.split(token).join("***");
    const notes: string[] = [];
    const runMs = (c: ContainerState["terminated"]) =>
      c?.startedAt != null && c.finishedAt != null ? c.finishedAt - c.startedAt : null;
    const startedAt = t?.startedAt ?? run?.running?.startedAt ?? null;
    const durationMs = runMs(t) ?? (startedAt !== null ? this.sb.now() - startedAt : wall());
    // Evicted: the workspace outgrew its emptyDir (kubelet); timeout: `timeout` (124, or 137 after its KILL), the
    // pod's deadline, or still running at the platform's deadline.
    const evicted = pod?.reason === "Evicted";
    const timedOut =
      !evicted &&
      (t === null ||
        t.exitCode === 124 ||
        (pod?.reason === "DeadlineExceeded" && t.exitCode !== 0) ||
        (t.exitCode === 137 && durationMs >= cmd.timeoutMs - 1000));
    if (timedOut) notes.push(sandboxRu.timedOut(cmd.timeoutMs / 1000));
    if (t?.reason === "OOMKilled") notes.push(sandboxRu.oom(human(o.memory ?? "2Gi")));
    if (evicted) notes.push(sandboxRu.workspace(human(o.workspaceSize ?? "3Gi")));
    let ok = !timedOut && t?.exitCode === 0;
    let saved = false;
    if (ok && save) {
      const s = saver?.terminated;
      if (s?.exitCode === 0) saved = true;
      else {
        ok = false;
        notes.push(
          s?.exitCode === 3 ? sandboxRu.workspace(human(o.workspaceSize ?? "3Gi")) : sandboxRu.saveFailed,
        );
      }
    }
    if (notes.length)
      output = `${output && !output.endsWith("\n") ? `${output}\n` : output}${notes.join("\n")}\n`;
    return {
      phase: cmd.phase,
      ok,
      exitCode: t?.exitCode ?? null,
      timedOut,
      durationMs: timedOut ? Math.max(durationMs, cmd.timeoutMs) : durationMs,
      output: tailOf(output),
      saved,
    };
  }
}
