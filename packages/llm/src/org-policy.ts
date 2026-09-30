// Org policy changes (data-boundary.yaml#ru_only.effect, L3-42): a cache of ≤ 10 s, invalidated on change through
// an in-process pub/sub; routers abort their in-flight T1 calls of that org and repeat them on T0.
import type { OrgPolicy } from "./types.js";

export interface PolicyChange {
  orgId: string;
  /** The policy now in force. */
  policy: OrgPolicy;
}

export type PolicyListener = (change: PolicyChange) => void;

/** In-process pub/sub of policy changes (M1: one process; PgBouncer forbids LISTEN, AGENTS.md). */
export class PolicyBus {
  readonly #listeners = new Set<PolicyListener>();

  subscribe(listener: PolicyListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  publish(change: PolicyChange): void {
    for (const l of [...this.#listeners]) {
      try {
        l(change);
      } catch {
        // A failing listener must not stop the others from seeing the change.
      }
    }
  }

  get size(): number {
    return this.#listeners.size;
  }
}

/** Process-wide bus: the default of createRouter() and createPolicyCache(). */
export const orgPolicyBus = new PolicyBus();

/** T1 is not allowed for the org: ruOnly, or t1Restricted anything but an explicit false (fail-safe). */
export function forbidsT1(policy: OrgPolicy | null | undefined): boolean {
  return policy?.ruOnly === true || policy?.t1Restricted !== false;
}

export const POLICY_CACHE_TTL_MS = 10_000;

export interface PolicyCacheOptions {
  load(orgId: string): Promise<OrgPolicy>;
  /** ≤ 10 s (data-boundary.yaml#ru_only.effect). */
  ttlMs?: number;
  bus?: PolicyBus;
  now?: () => number;
}

export interface PolicyCache {
  get(orgId: string): Promise<OrgPolicy>;
  invalidate(orgId: string): void;
  /** Unsubscribes from the bus. */
  close(): void;
}

export function createPolicyCache(opts: PolicyCacheOptions): PolicyCache {
  const ttl = Math.min(opts.ttlMs ?? POLICY_CACHE_TTL_MS, POLICY_CACHE_TTL_MS);
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { at: number; value: Promise<OrgPolicy> }>();
  const invalidate = (orgId: string) => {
    entries.delete(orgId);
  };
  const unsubscribe = (opts.bus ?? orgPolicyBus).subscribe((c) => invalidate(c.orgId));
  return {
    async get(orgId) {
      const hit = entries.get(orgId);
      if (hit && now() - hit.at < ttl) return hit.value;
      const value = opts.load(orgId);
      // An invalidation during the load drops this entry, so a stale load is never served afterwards.
      entries.set(orgId, { at: now(), value });
      value.catch(() => {
        if (entries.get(orgId)?.value === value) entries.delete(orgId);
      });
      return value;
    },
    invalidate,
    close: unsubscribe,
  };
}
