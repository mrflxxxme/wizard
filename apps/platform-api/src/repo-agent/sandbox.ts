// Runners of the repository sandbox (V3-32; security/isolation.yaml): the client's install, build and tests are
// untrusted code and never run in the platform's process.
// - process — ONLY with WIZARD_UNSAFE_LOCAL_EXEC=1 and WIZARD_REPO_SANDBOX=process (local stands, the founder's machine):
//   a child process in a temp directory with an environment built from scratch (no platform secrets, no WIZARD_*),
//   a time limit that kills the whole process group, and the network of a phase approximated: build, tests and the
//   agent's runs get offline package managers and a closed proxy. Like node:vm in M0–M1 this is NOT a security boundary.
// - pod — the cloud: a gVisor pod per phase in the sandbox pool (repoSandboxPod) and its NetworkPolicy
//   (repoSandboxNetworkPolicy): install reaches only the egress proxy (registry hosts), every other phase no network.
//   The specs are the contract of the runner; the runner itself is the infrastructure step (docs/ops/git-sync.md).
// Without a runner the compatibility check of a JS repository stays «unchecked» and the agent takes no tasks for it;
// Wizard systems need none (G0 and the static G2 in process).
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  assertPhaseNetwork,
  isSafeRepoPath,
  type RepoSandbox,
  type RepoSnapshot,
  type SandboxCommand,
  type SandboxPhase,
  type SandboxResult,
  type SandboxWorkspace,
} from "@wizard/agents/repo";
import type { Config } from "../config.js";

const OUTPUT_MAX = 8 * 1024;

/** Where a file of the workspace goes; null — outside the workspace (never written). */
function inside(root: string, path: string): string | null {
  if (!isSafeRepoPath(path)) return null;
  const full = resolve(root, path);
  return full.startsWith(root + sep) ? full : null;
}

/** The environment of a command: built from scratch, never the platform's (no secrets, no WIZARD_*). */
export function sandboxEnv(
  dir: string,
  cmd: Pick<SandboxCommand, "network">,
  base = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: base.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: join(dir, ".home"),
    TMPDIR: join(dir, ".tmp"),
    CI: "1",
    NODE_ENV: "test",
    LANG: "C.UTF-8",
    npm_config_cache: join(dir, ".cache", "npm"),
    npm_config_store_dir: join(dir, ".cache", "pnpm"),
    YARN_CACHE_FOLDER: join(dir, ".cache", "yarn"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  if (cmd.network === "none") {
    // No network for build, tests and the agent: package managers offline, and every HTTP(S) client that honours the
    // proxy variables gets a closed port. Locally this is a best effort; the pod has no route at all.
    Object.assign(env, {
      npm_config_offline: "true",
      YARN_ENABLE_NETWORK: "0",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      http_proxy: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
      NO_PROXY: "",
      no_proxy: "",
    });
  } else {
    // Install: the registry through the platform's proxy when it has one (the registry mirror of the stand).
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"])
      if (base[k]) env[k] = base[k];
    if (base.WIZARD_REPO_SANDBOX_REGISTRY) env.npm_config_registry = base.WIZARD_REPO_SANDBOX_REGISTRY;
  }
  return env;
}

/** Local runner (WIZARD_UNSAFE_LOCAL_EXEC=1 only): see the header. */
export class ProcessSandbox implements RepoSandbox {
  readonly kind = "process";
  constructor(private readonly base: NodeJS.ProcessEnv = process.env) {}

  async open(snapshot: RepoSnapshot): Promise<SandboxWorkspace> {
    const root = await mkdtemp(join(tmpdir(), "wz-repo-"));
    for (const d of [".home", ".tmp", ".cache"]) await mkdir(join(root, d), { recursive: true });
    const put = async (path: string, data: Uint8Array | string, mode?: string) => {
      const full = inside(root, path);
      if (!full) return;
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, data);
      if (mode === "100755") await chmod(full, 0o755);
    };
    for (const [path, f] of snapshot) {
      if (f.mode === "160000" || !f.data) continue;
      if (f.mode === "120000") {
        // A symlink stays one only when it points inside the workspace.
        const full = inside(root, path);
        const target = Buffer.from(f.data).toString("utf8");
        const points = full ? resolve(dirname(full), target) : "";
        if (full && !target.startsWith("/") && points.startsWith(root + sep)) {
          await mkdir(dirname(full), { recursive: true });
          await symlink(target, full).catch(() => {});
        }
        continue;
      }
      await put(path, f.data, f.mode);
    }
    const base = this.base;
    return {
      async run(cmd: SandboxCommand, signal?: AbortSignal): Promise<SandboxResult> {
        assertPhaseNetwork(cmd);
        const started = Date.now();
        const [bin, ...args] = cmd.argv;
        if (!bin)
          return { phase: cmd.phase, ok: false, exitCode: null, timedOut: false, durationMs: 0, output: "" };
        return new Promise((done) => {
          let out = "";
          let timedOut = false;
          const child = spawn(bin, args, {
            cwd: root,
            env: sandboxEnv(root, cmd, base),
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
          });
          const add = (b: Buffer) => {
            out = (out + b.toString("utf8")).slice(-OUTPUT_MAX);
          };
          child.stdout?.on("data", add);
          child.stderr?.on("data", add);
          const kill = () => {
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          };
          const timer = setTimeout(() => {
            timedOut = true;
            kill();
          }, cmd.timeoutMs);
          signal?.addEventListener("abort", kill, { once: true });
          const finish = (code: number | null) => {
            clearTimeout(timer);
            done({
              phase: cmd.phase,
              ok: code === 0 && !timedOut,
              exitCode: code,
              timedOut,
              durationMs: Date.now() - started,
              output: out,
            });
          };
          child.on("error", (e) => {
            add(Buffer.from(String(e.message)));
            finish(null);
          });
          child.on("close", (code) => finish(code));
        });
      },
      async write(changes) {
        for (const [path, text] of changes) {
          const full = inside(root, path);
          if (!full) continue;
          if (text === null) await rm(full, { force: true });
          else await put(path, text);
        }
      },
      async close() {
        await rm(root, { recursive: true, force: true });
      },
    };
  }
}

/** The runner of this process (null — none: JS repositories stay «unchecked»). */
export function repoSandboxFromEnv(
  config: Pick<Config, "unsafeLocalExec">,
  env = process.env,
): RepoSandbox | null {
  if (env.WIZARD_REPO_SANDBOX === "process" && config.unsafeLocalExec) return new ProcessSandbox(env);
  return null;
}

/** Why there is no runner (the owner's report says it). */
export const NO_SANDBOX_RU =
  "песочница для сборки JS-проектов на этой площадке пока не включена — проверку сборки и тестов повторим, когда она появится";

// ---------------------------------------------------------------- the cloud runner's contract

export const REPO_SANDBOX_RUNTIME_CLASS = "gvisor";
const IMAGE = "ghcr.io/wizard/repo-sandbox:node22";

/** The pod of one sandbox phase (gVisor, no service account, read-only root, no capabilities, 10-minute deadline). */
export function repoSandboxPod(i: {
  name: string;
  phase: SandboxPhase;
  /** Image with node 22, npm, pnpm and yarn (corepack); the workspace is mounted at /work. */
  image?: string;
  argv: readonly string[];
  timeoutMs: number;
  /** Install only: the egress proxy of the registry hosts, by address (no DNS in the pod). */
  proxyUrl?: string;
}): Record<string, unknown> {
  const net = i.phase === "install";
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: i.name,
      labels: {
        "app.kubernetes.io/name": "wizard-repo-sandbox",
        "wizard.repo-sandbox/network": net ? "registry" : "none",
      },
    },
    spec: {
      runtimeClassName: REPO_SANDBOX_RUNTIME_CLASS,
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      activeDeadlineSeconds: Math.ceil(i.timeoutMs / 1000),
      nodeSelector: { "wizard.pool": "sandbox" },
      tolerations: [{ key: "wizard.pool", operator: "Equal", value: "sandbox", effect: "NoSchedule" }],
      // No DNS in any phase (security/isolation.yaml#M2.network): the proxy is given by address.
      dnsPolicy: "None",
      dnsConfig: { nameservers: ["127.0.0.1"] },
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 10001,
        fsGroup: 10001,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "run",
          image: i.image ?? IMAGE,
          command: [...i.argv],
          workingDir: "/work",
          env: [
            { name: "HOME", value: "/work/.home" },
            { name: "CI", value: "1" },
            ...(net && i.proxyUrl
              ? [
                  { name: "HTTPS_PROXY", value: i.proxyUrl },
                  { name: "HTTP_PROXY", value: i.proxyUrl },
                ]
              : [{ name: "npm_config_offline", value: "true" }]),
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
          resources: {
            limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "4Gi" },
            requests: { cpu: "1", memory: "2Gi" },
          },
          volumeMounts: [
            { name: "work", mountPath: "/work" },
            { name: "tmp", mountPath: "/tmp" },
          ],
        },
      ],
      volumes: [
        { name: "work", emptyDir: { sizeLimit: "4Gi" } },
        { name: "tmp", emptyDir: { sizeLimit: "1Gi" } },
      ],
    },
  };
}

/** NetworkPolicy of the sandbox pods: install → only the egress proxy; build, tests and the agent → nothing. */
export function repoSandboxNetworkPolicy(i: {
  namespace: string;
  proxy: { namespace: string; app: string; port: number };
}): Record<string, unknown>[] {
  const base = (name: string, network: "registry" | "none", egress: unknown[]) => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name, namespace: i.namespace },
    spec: {
      podSelector: {
        matchLabels: {
          "app.kubernetes.io/name": "wizard-repo-sandbox",
          "wizard.repo-sandbox/network": network,
        },
      },
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress,
    },
  });
  return [
    base("wizard-repo-sandbox-none", "none", []),
    base("wizard-repo-sandbox-registry", "registry", [
      {
        to: [
          {
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": i.proxy.namespace } },
            podSelector: { matchLabels: { "app.kubernetes.io/name": i.proxy.app } },
          },
        ],
        ports: [{ protocol: "TCP", port: i.proxy.port }],
      },
    ]),
  ];
}
