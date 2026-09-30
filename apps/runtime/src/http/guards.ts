// Host routing and request guards: runtime.yaml#routing, #auth.csrf, #security_headers;
// platform/deploy.yaml#local.host_guard (L3-10, L3-14).
import type { RuntimeEnv } from "../env.js";
import { SLUG_RE, type SystemEnv } from "../registry.js";

/** Hostname of a Host header without port, lowercased; null when malformed. */
export function hostname(host: string): string | null {
  const h = host.trim().toLowerCase();
  if (h === "") return null;
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end < 0) return null;
    const rest = h.slice(end + 1);
    if (rest !== "" && !/^:\d{1,5}$/.test(rest)) return null;
    return h.slice(0, end + 1);
  }
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(h);
  return m ? (m[1] as string) : null;
}

const LOCAL_BARE = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** deploy.yaml#local.host_guard: Host ∈ {localhost, 127.0.0.1, [::1], *.localhost} (port optional). */
export function isAllowedLocalHost(name: string): boolean {
  return LOCAL_BARE.has(name) || (name.endsWith(".localhost") && name.length > ".localhost".length);
}

export function isBareHost(name: string): boolean {
  return LOCAL_BARE.has(name);
}

/** Tunnel/proxy headers banned in local modes: X-Forwarded-*, Forwarded, CF-*. */
export function hasForwardingHeaders(headers: Headers): boolean {
  for (const [k] of headers) {
    const n = k.toLowerCase();
    if (n === "forwarded" || n.startsWith("x-forwarded-") || n.startsWith("cf-")) return true;
  }
  return false;
}

export type HostTarget =
  | { kind: "system"; slug: string; env: SystemEnv }
  | { kind: "prod-redirect"; slug: string }
  | { kind: "unknown" }
  | { kind: "foreign" };

/**
 * <slug>--<env>.<systemsDomain> → system; <slug>.<systemsDomain> → prod alias; <slug>--prod.* → 301 to the alias.
 * Other labels under the systems domain → unknown (404); hosts outside it → foreign (421).
 */
export function parseSystemHost(name: string, env: RuntimeEnv): HostTarget {
  const suffix = `.${env.systemsDomain}`;
  if (!name.endsWith(suffix)) return { kind: "foreign" };
  const label = name.slice(0, -suffix.length);
  if (label === "" || label.includes(".")) return { kind: "unknown" };
  const i = label.lastIndexOf("--");
  const slug = i < 0 ? label : label.slice(0, i);
  const envPart = i < 0 ? "prod" : label.slice(i + 2);
  if (!SLUG_RE.test(slug) || slug.includes("--")) return { kind: "unknown" };
  if (envPart !== "draft" && envPart !== "prod") return { kind: "unknown" };
  if (i >= 0 && envPart === "prod") return { kind: "prod-redirect", slug };
  return { kind: "system", slug, env: envPart };
}

/** Non-GET/HEAD requests must carry X-Wizard-Request: 1 and Origin = the system host (runtime.yaml#auth.csrf). */
export function csrfOk(req: Request, host: string, env: RuntimeEnv): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  if (req.headers.get("x-wizard-request") !== "1") return false;
  return req.headers.get("origin") === `${env.publicScheme}://${host}`;
}

export function isHookPath(path: string): boolean {
  return path.startsWith("/_wizard/hooks/");
}

/** M0 security headers (runtime.yaml#security_headers.M0). CORS headers are never sent. */
export function securityHeaders(headers: Headers, sysEnv: SystemEnv | null, env: RuntimeEnv): void {
  headers.set("X-Content-Type-Options", "nosniff");
  const ancestors = sysEnv === "draft" ? env.platformOrigin : "'none'";
  const csp = headers.get("Content-Security-Policy");
  headers.set(
    "Content-Security-Policy",
    csp ? `${csp}; frame-ancestors ${ancestors}` : `frame-ancestors ${ancestors}`,
  );
  for (const [k] of [...headers]) if (k.toLowerCase().startsWith("access-control-")) headers.delete(k);
}
