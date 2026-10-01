// Grouping of systems into sandbox pods (security/isolation.yaml#M2.pods): Free and paid systems live in different
// node pools, at most 10 systems per pod in each; Business SHOULD get a pod per organization. A full pool refuses
// the placement (the scheduler scales pods, the runtime never packs more systems into a pod).
import type { SandboxEnv } from "./capability.js";

export type SandboxTier = "free" | "paid" | "business";
export type SandboxPoolName = "sandbox-free" | "sandbox-paid" | "sandbox-business";

/** Hard limit of systems per pod (Free and paid). */
export const MAX_SYSTEMS_PER_POD = 10;

export interface SandboxPoolConfig {
  /** Systems per pod in the Free pool (1…10). */
  freePerPod: number;
  /** Systems per pod in the paid pool (1…10). */
  paidPerPod: number;
  /** Pods each pool may run (capacity of its node pool). */
  maxPods: Readonly<Record<SandboxPoolName, number>>;
  /** Business: one pod per organization (true) or the paid pool (false). */
  dedicatedBusiness: boolean;
}

export const DEFAULT_POOL_CONFIG: SandboxPoolConfig = {
  freePerPod: MAX_SYSTEMS_PER_POD,
  paidPerPod: MAX_SYSTEMS_PER_POD,
  maxPods: { "sandbox-free": 50, "sandbox-paid": 50, "sandbox-business": 50 },
  dedicatedBusiness: true,
};

export class SandboxConfigError extends Error {
  override name = "SandboxConfigError";
}

/** Thrown when a pool has no room: the platform must add nodes/pods, never overfill a pod. */
export class SandboxPoolFullError extends Error {
  override name = "SandboxPoolFullError";
}

/** Rejects configurations that would put more than 10 systems into a Free or paid pod. */
export function validatePoolConfig(c: SandboxPoolConfig): SandboxPoolConfig {
  for (const [k, v] of [
    ["freePerPod", c.freePerPod],
    ["paidPerPod", c.paidPerPod],
  ] as const) {
    if (!Number.isInteger(v) || v < 1 || v > MAX_SYSTEMS_PER_POD) {
      throw new SandboxConfigError(`${k} must be 1…${MAX_SYSTEMS_PER_POD}, got ${v}`);
    }
  }
  for (const [pool, n] of Object.entries(c.maxPods)) {
    if (!Number.isInteger(n) || n < 0)
      throw new SandboxConfigError(`maxPods.${pool} must be a non-negative integer`);
  }
  return c;
}

export interface SandboxSystem {
  systemId: string;
  env: SandboxEnv;
  orgId: string;
  tier: SandboxTier;
}

export interface Placement {
  pool: SandboxPoolName;
  podId: string;
  /** Index of the system's Worker socket in the pod (port = base + slot). */
  slot: number;
}

interface Pod {
  id: string;
  pool: SandboxPoolName;
  /** Business pods belong to one organization. */
  orgId: string | null;
  slots: (string | null)[];
}

const keyOf = (s: Pick<SandboxSystem, "systemId" | "env">) => `${s.systemId}:${s.env}`;

/** In-memory placement table (the platform persists it with the deployment; pods are rendered from it). */
export class SandboxPool {
  private readonly config: SandboxPoolConfig;
  private readonly pods = new Map<string, Pod>();
  private readonly placed = new Map<string, Placement>();
  private seq = 0;

  constructor(config: SandboxPoolConfig = DEFAULT_POOL_CONFIG) {
    this.config = validatePoolConfig(config);
  }

  poolOf(s: SandboxSystem): SandboxPoolName {
    if (s.tier === "free") return "sandbox-free";
    if (s.tier === "business" && this.config.dedicatedBusiness) return "sandbox-business";
    return "sandbox-paid";
  }

  private capacity(pool: SandboxPoolName): number {
    return pool === "sandbox-free"
      ? this.config.freePerPod
      : pool === "sandbox-paid"
        ? this.config.paidPerPod
        : MAX_SYSTEMS_PER_POD;
  }

  /** Places a system (idempotent); throws SandboxPoolFullError when the pool has no free slot and no pod budget. */
  place(s: SandboxSystem): Placement {
    const known = this.placed.get(keyOf(s));
    if (known) return known;
    const pool = this.poolOf(s);
    const orgId = pool === "sandbox-business" ? s.orgId : null;
    const cap = this.capacity(pool);
    let pod = [...this.pods.values()].find(
      (p) => p.pool === pool && p.orgId === orgId && p.slots.some((x) => x === null),
    );
    if (!pod) {
      const count = [...this.pods.values()].filter((p) => p.pool === pool).length;
      if (count >= this.config.maxPods[pool]) {
        throw new SandboxPoolFullError(`${pool}: no free slot (${count} pods × ${cap} systems)`);
      }
      this.seq += 1;
      pod = { id: `${pool}-${this.seq}`, pool, orgId, slots: new Array<string | null>(cap).fill(null) };
      this.pods.set(pod.id, pod);
    }
    const slot = pod.slots.indexOf(null);
    pod.slots[slot] = keyOf(s);
    const placement: Placement = { pool, podId: pod.id, slot };
    this.placed.set(keyOf(s), placement);
    return placement;
  }

  /** Frees the slot of a system (unpublish, delete); an empty pod is removed. */
  remove(s: Pick<SandboxSystem, "systemId" | "env">): void {
    const p = this.placed.get(keyOf(s));
    if (!p) return;
    this.placed.delete(keyOf(s));
    const pod = this.pods.get(p.podId);
    if (!pod) return;
    pod.slots[p.slot] = null;
    if (pod.slots.every((x) => x === null)) this.pods.delete(pod.id);
  }

  placement(s: Pick<SandboxSystem, "systemId" | "env">): Placement | null {
    return this.placed.get(keyOf(s)) ?? null;
  }

  /** Systems of a pod as `systemId:env` keys (null = free slot). */
  podSlots(podId: string): readonly (string | null)[] {
    return this.pods.get(podId)?.slots ?? [];
  }

  listPods(): { id: string; pool: SandboxPoolName; orgId: string | null; systems: number }[] {
    return [...this.pods.values()].map((p) => ({
      id: p.id,
      pool: p.pool,
      orgId: p.orgId,
      systems: p.slots.filter((x) => x !== null).length,
    }));
  }
}
