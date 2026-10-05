// Egress-proxy grants of runtime-made requests (M2-52): ctx.http.fetch runs in the runtime on behalf of a function
// call, so the CONNECT carries a grant the runtime issued for that call — random, short-lived, bound to the system and
// the function's hosts. The proxy checks it at /_wizard/internal/egress-authorize like a sandbox capability token.
import { randomBytes } from "node:crypto";

export interface EgressGrant {
  systemId: string;
  env: "draft" | "prod";
  https: readonly string[];
  /** ms since epoch */
  exp: number;
}

export const GRANT_PREFIX = "g1.";

export class EgressGrants {
  private readonly grants = new Map<string, EgressGrant>();
  constructor(private readonly clock: () => number = Date.now) {}

  /** A token for `hosts` of one system, valid `ttlMs` (the call's limit). */
  issue(g: Omit<EgressGrant, "exp">, ttlMs: number): string {
    const now = this.clock();
    for (const [k, v] of this.grants) if (v.exp <= now) this.grants.delete(k);
    const token = `${GRANT_PREFIX}${randomBytes(32).toString("base64url")}`;
    this.grants.set(token, { ...g, https: [...g.https], exp: now + Math.max(1, ttlMs) });
    return token;
  }

  /** The live grant of `token`, or null (unknown, expired). */
  open(token: string): EgressGrant | null {
    const g = this.grants.get(token);
    if (!g || g.exp <= this.clock()) return null;
    return g;
  }

  revoke(token: string): void {
    this.grants.delete(token);
  }
}
