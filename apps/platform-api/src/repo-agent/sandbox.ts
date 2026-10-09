// Runners of the repository sandbox (V3-32; security/isolation.yaml): the client's install, build and tests are
// untrusted code and never run in the platform's process.
// - pod — the cloud (WIZARD_REPO_SANDBOX=pod, set by the chart with repoSandbox.enabled): a gVisor pod per phase in the
//   sandbox namespace (pod-sandbox.ts): install reaches only the registry hosts through the egress proxy, every other
//   phase has no network and no DNS.
// - process — ONLY with WIZARD_UNSAFE_LOCAL_EXEC=1 and WIZARD_REPO_SANDBOX=process (local stands, the founder's machine):
//   a child process in a temp directory with an environment built from scratch (no platform secrets, no WIZARD_*),
//   a time limit that kills the whole process group, and the network of a phase approximated: build, tests and the
//   agent's runs get offline package managers and a closed proxy. Like node:vm in M0–M1 this is NOT a security boundary.
// Without a runner the compatibility check of a JS repository stays «unchecked» and the agent takes no tasks for it;
// Wizard systems need none (G0 and the static G2 in process).
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  assertPhaseNetwork,
  isSafeRepoPath,
  type RepoSandbox,
  type RepoSnapshot,
  type SandboxCommand,
  type SandboxResult,
  type SandboxWorkspace,
} from "@wizard/agents/repo";
import { EgressGrants, egressGrantKey, GRANT_MAX_DURATION_MS } from "@wizard/runtime";
import type { Config } from "../config.js";
import { inClusterKubeSend, type RepoKube, repoKube } from "./kube.js";
import { GRANT_LABEL, GRANT_TUNNEL_BYTES, OUTPUT_MAX, PodSandbox, registryHosts } from "./pod-sandbox.js";

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

/**
 * The cloud runner from the chart's env (templates/_helpers.tpl wizard.repoSandboxEnv):
 *   WIZARD_REPO_SANDBOX_IMAGE, _NAMESPACE      image (wizard-repo-sandbox) and the sandbox namespace
 *   WIZARD_REPO_SANDBOX_PROXY                  the egress proxy's Service URL (resolved here: the pods have no DNS)
 *   WIZARD_REPO_SANDBOX_POOL, _CPU, _CPU_REQUEST, _MEMORY, _WORKSPACE, _STORE, _STORAGE_CLASS, _TTL_MIN
 *   WIZARD_REPO_SANDBOX_REGISTRY               npm mirror of the install (https; none — registry.npmjs.org)
 *   WIZARD_SANDBOX_KEY | WIZARD_INTERNAL_TOKEN the key of egress grants, the same as the runtime's
 */
export function podSandboxFromEnv(
  env: NodeJS.ProcessEnv,
  deps: { kube?: RepoKube; log?: (line: Record<string, unknown>) => void; sweep?: boolean } = {},
): PodSandbox {
  const image = env.WIZARD_REPO_SANDBOX_IMAGE;
  const proxy = env.WIZARD_REPO_SANDBOX_PROXY;
  if (!image || !proxy)
    throw new Error("WIZARD_REPO_SANDBOX=pod needs WIZARD_REPO_SANDBOX_IMAGE and WIZARD_REPO_SANDBOX_PROXY");
  const key = egressGrantKey(env);
  if (!key) throw new Error("WIZARD_REPO_SANDBOX=pod needs WIZARD_SANDBOX_KEY or WIZARD_INTERNAL_TOKEN");
  const grants = new EgressGrants(key);
  const proxyUrl = new URL(proxy);
  const registry = env.WIZARD_REPO_SANDBOX_REGISTRY || null;
  registryHosts(registry);
  const namespace = env.WIZARD_REPO_SANDBOX_NAMESPACE || "wizard-sandbox";
  const opt = (k: string) => env[`WIZARD_REPO_SANDBOX_${k}`] || undefined;
  const ttlMin = Number(opt("TTL_MIN"));
  const api = env.KUBERNETES_SERVICE_HOST;
  const sb = new PodSandbox({
    kube: deps.kube ?? repoKube(namespace, inClusterKubeSend(env)),
    namespace,
    image,
    pool: opt("POOL"),
    cpu: opt("CPU"),
    cpuRequest: opt("CPU_REQUEST"),
    memory: opt("MEMORY"),
    workspaceSize: opt("WORKSPACE"),
    storeSize: opt("STORE"),
    storageClass: opt("STORAGE_CLASS") ?? null,
    registry,
    // The Service's ClusterIP: the NetworkPolicy of the install admits the proxy's pods behind it.
    proxy: async () => ({
      host: (await lookup(proxyUrl.hostname)).address,
      port: Number(proxyUrl.port || 3128),
    }),
    grant: (hosts, ttlMs) =>
      grants.issue(
        {
          systemId: GRANT_LABEL,
          env: "draft",
          https: hosts,
          maxBytes: GRANT_TUNNEL_BYTES,
          maxDurationMs: Math.max(1000, Math.min(ttlMs, GRANT_MAX_DURATION_MS)),
        },
        ttlMs,
      ),
    // The restore step proves the pod's NetworkPolicy holds: the API server must be unreachable from it.
    probe: api ? `${api.includes(":") ? `[${api}]` : api}:${env.KUBERNETES_SERVICE_PORT ?? "443"}` : null,
    ...(ttlMin > 0 ? { ttlMs: ttlMin * 60_000 } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
  if (deps.sweep !== false) sb.startSweeper();
  return sb;
}

/** The kind of runner repoSandboxFromEnv builds, without building it (what enqueue-only platform-api reports). */
export function repoSandboxKindFromEnv(
  config: Pick<Config, "unsafeLocalExec">,
  env: NodeJS.ProcessEnv = process.env,
): "pod" | "process" | null {
  if (env.WIZARD_REPO_SANDBOX === "pod") return "pod";
  if (env.WIZARD_REPO_SANDBOX === "process" && config.unsafeLocalExec) return "process";
  return null;
}

/**
 * The runner of this process (null — none: JS repositories stay «unchecked»). Never the process runner in the cloud.
 * Only the process that runs the agent's tasks builds it (apps/worker; platform-api in tests and M0).
 */
export function repoSandboxFromEnv(
  config: Pick<Config, "unsafeLocalExec">,
  env: NodeJS.ProcessEnv = process.env,
  deps: { kube?: RepoKube; log?: (line: Record<string, unknown>) => void; sweep?: boolean } = {},
): RepoSandbox | null {
  const kind = repoSandboxKindFromEnv(config, env);
  if (kind === "pod") return podSandboxFromEnv(env, deps);
  return kind === "process" ? new ProcessSandbox(env) : null;
}

/** Why there is no runner (the owner's report says it). */
export const NO_SANDBOX_RU =
  "песочница для сборки JS-проектов на этой площадке пока не включена — проверку сборки и тестов повторим, когда она появится";
