// isolation.yaml#M2.pods: Free ≤ 10 systems per pod, paid ≤ 10, separate pools, Business — a pod per organization;
// overflow → refusal, never packing (L3-23); workerd config and pod manifests keep those limits and the hardening.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POOL_CONFIG,
  MAX_SYSTEMS_PER_POD,
  SANDBOX_RUNTIME_CLASS,
  SandboxConfigError,
  SandboxPool,
  SandboxPoolFullError,
  sandboxNetworkPolicy,
  sandboxPod,
  validatePoolConfig,
  WORKERD_COMPATIBILITY_FLAGS,
  workerdPodConfig,
} from "../../src/index.js";
import { dockerFlagsOf } from "./pod-docker.js";

const sys = (i: number, tier: "free" | "paid" | "business" = "free", orgId = `org${i}`) => ({
  systemId: `s${String(i).padStart(11, "0")}`,
  env: "prod" as const,
  orgId,
  tier,
});

describe("SandboxPool", () => {
  it("Free: at most 10 systems per pod; the 11th opens a new pod", () => {
    const pool = new SandboxPool();
    const placements = Array.from({ length: 25 }, (_, i) => pool.place(sys(i)));
    const byPod = new Map<string, number>();
    for (const p of placements) byPod.set(p.podId, (byPod.get(p.podId) ?? 0) + 1);
    expect([...byPod.values()]).toEqual([10, 10, 5]);
    expect(new Set(placements.map((p) => p.pool))).toEqual(new Set(["sandbox-free"]));
    expect(pool.listPods().every((p) => p.systems <= MAX_SYSTEMS_PER_POD)).toBe(true);
    expect(pool.place(sys(3))).toEqual(placements[3]);
  });

  it("Free and paid never share a pod; Business gets a pod per organization", () => {
    const pool = new SandboxPool();
    const f = pool.place(sys(1, "free"));
    const p = pool.place(sys(2, "paid"));
    const b1 = pool.place(sys(3, "business", "orgA"));
    const b2 = pool.place(sys(4, "business", "orgB"));
    const b3 = pool.place(sys(5, "business", "orgA"));
    expect([f.pool, p.pool, b1.pool]).toEqual(["sandbox-free", "sandbox-paid", "sandbox-business"]);
    expect(f.podId).not.toBe(p.podId);
    expect(b1.podId).not.toBe(b2.podId);
    expect(b3.podId).toBe(b1.podId);
  });

  it("a full pool refuses instead of overfilling a pod; a freed slot is reused", () => {
    const pool = new SandboxPool({
      ...DEFAULT_POOL_CONFIG,
      maxPods: { ...DEFAULT_POOL_CONFIG.maxPods, "sandbox-free": 1 },
    });
    for (let i = 0; i < 10; i++) pool.place(sys(i));
    expect(() => pool.place(sys(10))).toThrow(SandboxPoolFullError);
    pool.remove(sys(4));
    expect(pool.place(sys(10)).slot).toBe(4);
  });

  it("configuration above 10 systems per pod is rejected", () => {
    expect(() => validatePoolConfig({ ...DEFAULT_POOL_CONFIG, freePerPod: 11 })).toThrow(SandboxConfigError);
    expect(() => validatePoolConfig({ ...DEFAULT_POOL_CONFIG, paidPerPod: 0 })).toThrow(SandboxConfigError);
    expect(() => new SandboxPool({ ...DEFAULT_POOL_CONFIG, paidPerPod: 12 })).toThrow(SandboxConfigError);
  });
});

describe("workerd pod config", () => {
  const systems = Array.from({ length: 3 }, (_, i) => ({
    systemId: `sys${i}aaaaaaaa`,
    env: "prod" as const,
    functionsSource: `export default {};`,
    entities: ["ticket", "stream"],
  }));
  const cfg = workerdPodConfig({ systems, rpcAddress: "10.0.0.1:4102", basePort: 8081, healthPort: 8080 });

  it("one Worker per system, globalOutbound deny-all, only RUNTIME_RPC and text bindings, no nodejs_compat", () => {
    const workers = cfg.capnp.split("const w").slice(1);
    expect(workers).toHaveLength(3);
    for (const w of workers) {
      expect(w).toContain('globalOutbound = "deny-all"');
      expect(w).toContain('(name = "RUNTIME_RPC", service = "runtime-rpc")');
      expect(w.match(/service = /g)).toHaveLength(1);
      expect(w).not.toMatch(/nodejs_compat|precise_timers|unsafeEval|fromEnvironment|durableObject|disk/);
    }
    expect(WORKERD_COMPATIBILITY_FLAGS).toEqual([]);
    expect(cfg.capnp).toContain('(name = "deny-all", network = (allow = []))');
    // workerd resolves specifiers relative to the importer's module name ("@wizard/sdk" → "../worker-host.mjs").
    expect(cfg.files["sdk.mjs"]).toContain('from "../worker-host.mjs"');
    expect(cfg.files["main.mjs"]).toContain('from "./functions.mjs"');
    expect(cfg.capnp).toContain('address = "*:8083"');
    expect(Object.keys(cfg.files).sort()).toEqual(
      [
        "guest.mjs",
        "main.mjs",
        "s0/functions.mjs",
        "s1/functions.mjs",
        "s2/functions.mjs",
        "sdk.mjs",
        "worker-host.mjs",
      ].sort(),
    );
  });

  it("more than 10 systems, duplicates and unsafe names are refused", () => {
    const one = systems[0] as (typeof systems)[number];
    const many = Array.from({ length: 11 }, (_, i) => ({ ...one, systemId: `s${i}xxxxxxxxxx` }));
    expect(() =>
      workerdPodConfig({ systems: many, rpcAddress: "a:1", basePort: 1, healthPort: 2 }),
    ).toThrow();
    expect(() =>
      workerdPodConfig({
        systems: [one, one],
        rpcAddress: "a:1",
        basePort: 1,
        healthPort: 2,
      }),
    ).toThrow();
    expect(() =>
      workerdPodConfig({
        systems: [{ ...one, systemId: 'x"; ' }],
        rpcAddress: "a:1",
        basePort: 1,
        healthPort: 2,
      }),
    ).toThrow();
    expect(() =>
      workerdPodConfig({
        systems: [{ ...one, entities: ['a")'] }],
        rpcAddress: "a:1",
        basePort: 1,
        healthPort: 2,
      }),
    ).toThrow();
  });
});

describe("sandbox pod manifests", () => {
  const pod = sandboxPod({
    name: "sb-1",
    namespace: "sandbox",
    pool: "sandbox-free",
    image: "registry.example/wizard-workerd@sha256:0000",
    configMap: "sb-1",
    basePort: 8081,
    systems: 10,
    healthPort: 8080,
  }) as { spec: Record<string, never> };

  it("gVisor RuntimeClass, non-root, read-only root, no capabilities, RuntimeDefault seccomp, no token/hostPath", () => {
    // biome-ignore lint/suspicious/noExplicitAny: manifest object
    const spec = pod.spec as Record<string, any>;
    expect(spec.runtimeClassName).toBe(SANDBOX_RUNTIME_CLASS);
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(spec.hostNetwork).toBe(false);
    expect(spec.securityContext).toMatchObject({
      runAsNonRoot: true,
      seccompProfile: { type: "RuntimeDefault" },
    });
    const c = spec.containers[0];
    expect(c.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      privileged: false,
      capabilities: { drop: ["ALL"] },
    });
    expect(JSON.stringify(spec)).not.toMatch(/hostPath|hostPort/);
    // Node label of the pool (infra/k3s: wizard.ru/pool=free), not the SandboxPool name.
    expect(spec.nodeSelector).toEqual({ "wizard.ru/pool": "free" });
    expect(spec.dnsPolicy).toBe("None");
  });

  it("the CI sandbox job reproduces exactly these settings with docker --runtime=runsc", () => {
    expect(dockerFlagsOf(pod)).toEqual([
      "--runtime=runsc",
      "--user=65532:65532",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--memory=1536m",
      "--cpus=1",
      "--pids-limit=256",
      "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
    ]);
    const weakened = structuredClone(pod) as unknown as {
      spec: { containers: { securityContext: object }[] };
    };
    (weakened.spec.containers[0] as { securityContext: object }).securityContext = { privileged: false };
    expect(() => dockerFlagsOf(weakened)).toThrow(/securityContext/);
  });

  it("NetworkPolicy: egress only to runtime :443 and egress-proxy :3128, ingress only from runtime", () => {
    const np = sandboxNetworkPolicy({
      namespace: "sandbox",
      runtimeSelector: { app: "runtime" },
      egressProxySelector: { app: "egress-proxy" },
      platformNamespace: "platform",
      basePort: 8081,
      systems: 2,
      healthPort: 8080,
    }) as { spec: { egress: { ports: { port: number }[] }[]; ingress: unknown[]; policyTypes: string[] } };
    expect(np.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(np.spec.egress.flatMap((e) => e.ports.map((p) => p.port))).toEqual([443, 3128]);
    expect(np.spec.ingress).toHaveLength(1);
  });
});
