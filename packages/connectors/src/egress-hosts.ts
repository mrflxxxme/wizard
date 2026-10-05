// Hosts of outgoing HTTP of system functions (M2-52, D71; security/isolation.yaml#M2.network): any public DNS name the
// spec declares in functions[].egress, never an IP literal, an internal name or a domain of the platform itself.
// Shared by the runtime (ctx.http.fetch) and G2-EGRESS-01 so both judge a host the same way; the address check after
// DNS resolution (rebinding) is the runtime's.
import { type AppSpec, EGRESS_HOST_RE } from "@wizard/appspec";

/** Domains of the platform (cabinet, systems, mail): a system never calls them through egress. */
export const PLATFORM_DOMAINS = ["borntobuild.ru", "sandpile.ru"] as const;

/** Internal or special-use name suffixes (cluster DNS, mDNS, RFC 6761/8375 and common private zones). */
export const INTERNAL_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "private",
  "svc",
  "cluster.local",
  "home.arpa",
  "in-addr.arpa",
  "ip6.arpa",
  "test",
  "example",
  "invalid",
  "onion",
] as const;

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Platform domains from the environment (systems domain, cabinet origin) on top of the built-in list. */
export function platformDomains(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const out = new Set<string>(PLATFORM_DOMAINS);
  const add = (h: string | undefined) => {
    const v = (h ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (v && v !== "localhost" && v.includes(".")) out.add(v);
  };
  add(env.WIZARD_SYSTEMS_DOMAIN);
  for (const o of [env.WIZARD_PLATFORM_ORIGIN, env.WIZARD_PUBLIC_ORIGIN]) {
    try {
      if (o) add(new URL(o).hostname);
    } catch {
      // not a URL — ignored
    }
  }
  for (const d of (env.WIZARD_EGRESS_DENY_DOMAINS ?? "").split(",")) add(d);
  return [...out];
}

export type EgressHostProblem = "format" | "internal" | "platform";

/** Why a declared host cannot be an egress target, or null when it is a valid public host. */
export function egressHostProblem(host: string, platform: readonly string[]): EgressHostProblem | null {
  const h = host.toLowerCase();
  if (!EGRESS_HOST_RE.test(h) || h.length > 253 || h.split(".").some((l) => l.length > 63)) return "format";
  if (/^\d+(\.\d+)*$/.test(h) || /^[0-9a-f:]+$/.test(h)) return "format";
  if (INTERNAL_SUFFIXES.some((s) => under(h, s))) return "internal";
  if (platform.some((d) => under(h, d))) return "platform";
  return null;
}

/** All hosts the spec's functions declare (sorted, unique). */
export function specEgressHosts(spec: AppSpec): string[] {
  const out = new Set<string>();
  for (const f of spec.functions ?? []) for (const h of f.egress ?? []) out.add(h.toLowerCase());
  return [...out].sort();
}

/** Hosts of `spec` that `prev` (the published revision) did not have. */
export function newEgressHosts(spec: AppSpec, prev: AppSpec | null): string[] {
  const before = new Set(prev ? specEgressHosts(prev) : []);
  return specEgressHosts(spec).filter((h) => !before.has(h));
}
