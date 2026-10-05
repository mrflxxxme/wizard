// Internal port of the runtime (runtime.yaml#routing.rules, #service_endpoints; L3-19): 4101 locally, a ClusterIP-only
// Service in the cloud (NetworkPolicy: platform-api, worker, egress-proxy and sandbox pods). The public port never
// serves these paths (/_wizard/internal/* → 404 there).
import { timingSafeEqual } from "node:crypto";
import { platformDomains } from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import type postgres from "postgres";
import { backfillAiAction, findAiAction } from "./ai/actions.js";
import type { AiGatewayClient } from "./ai/gateway.js";
import type { RuntimeEnv } from "./env.js";
import { hostname, parseSystemHost } from "./http/guards.js";
import type { SystemEnv } from "./registry.js";
import { type EgressPolicy, egressPolicyFor } from "./sandbox/egress.js";
import { type EgressGrants, GRANT_PREFIX } from "./sandbox/egress-grants.js";
import type { SandboxRpc } from "./sandbox/rpc.js";
import { type SystemCache, SystemLoadError } from "./system.js";

export interface InternalOptions {
  env: RuntimeEnv;
  systems: SystemCache;
  db: postgres.Sql;
  /** Sandbox RPC listener (/rpc/<systemId>/<env>) and capability checks of the egress proxy. */
  rpc?: SandboxRpc;
  /** Image version reported by health (WIZARD_VERSION). */
  version?: string;
  /** Egress allowlist inputs (L3-24): global function allowlist and the platform SMTP host. */
  egress?: { globalAllow: Iterable<string>; platformSmtpHost?: string; platformMailApiHost?: string };
  /** DB probe timeout (default 2 s). */
  dbTimeoutMs?: number;
  /** M3-02: AI gateway of the platform for /_wizard/internal/ai-backfill. */
  ai?: () => AiGatewayClient | null | undefined;
  /** M2-52: grants of runtime-made ctx.http requests (CONNECT through the egress proxy). */
  grants?: EgressGrants;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const notFound = () => json(404, { error: { code: "NOT_FOUND" } });

/** Constant-time X-Wizard-Internal-Token check; no configured token → every call is refused. */
export function internalTokenOk(env: RuntimeEnv, header: string | null): boolean {
  if (!env.internalToken || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(env.internalToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: Request, max = 16_384): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > max) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isEnv = (v: unknown): v is SystemEnv => v === "draft" || v === "prod";

export function policyJson(p: EgressPolicy): { https: string[]; smtp: string[]; label?: string } {
  return { https: [...p.https].sort(), smtp: [...p.smtp].sort(), ...(p.label ? { label: p.label } : {}) };
}

/** Handler of the internal listener. */
export function createInternalHandler(o: InternalOptions): (req: Request) => Promise<Response> {
  const dbProbe = async (): Promise<"ok" | "fail"> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        o.db`select 1`,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), o.dbTimeoutMs ?? 2000);
        }),
      ]);
      return "ok";
    } catch {
      return "fail";
    } finally {
      clearTimeout(timer);
    }
  };

  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/rpc/")) return o.rpc ? o.rpc.fetch(req) : notFound();

    if (url.pathname === "/_wizard/health" && (req.method === "GET" || req.method === "HEAD")) {
      const body: Record<string, unknown> = {
        status: "ok",
        version: o.version ?? "dev",
        db: await dbProbe(),
        systemsLoaded: o.systems.size,
      };
      // On a system Host also {system, env, revision}: the publish smoke reads the revision here (L3-19).
      const name = hostname(req.headers.get("host") ?? "");
      const target = name ? parseSystemHost(name, o.env) : null;
      if (target?.kind === "system") {
        try {
          const sys = await o.systems.resolve(target.slug, target.env);
          if (!sys) return json(404, { ...body, status: "not_found" });
          Object.assign(body, { system: sys.entry.slug, env: sys.entry.env, revision: sys.entry.revision });
        } catch (e) {
          if (!(e instanceof SystemLoadError)) throw e;
          return json(503, { ...body, status: "unavailable" });
        }
      }
      return json(body.db === "ok" ? 200 : 503, body);
    }

    if (!url.pathname.startsWith("/_wizard/internal/")) return notFound();
    if (req.method !== "POST") return notFound();
    if (!internalTokenOk(o.env, req.headers.get("x-wizard-internal-token")))
      return json(403, { error: { code: "FORBIDDEN" } });
    const body = await readJson(req);
    if (!body) return json(400, { error: { code: "VALIDATION_FAILED" } });

    if (url.pathname === "/_wizard/internal/reload") {
      if (typeof body.systemId !== "string" || !isEnv(body.env))
        return json(400, { error: { code: "VALIDATION_FAILED" } });
      const evicted = o.systems.evict(body.systemId, body.env);
      return json(200, { evicted });
    }

    // M3-02 (runtime.yaml#ai_actions.triggers): one-time backfill of old records requested by the platform.
    if (url.pathname === "/_wizard/internal/ai-backfill") {
      if (
        typeof body.systemId !== "string" ||
        !isEnv(body.env) ||
        typeof body.action !== "string" ||
        typeof body.backfillId !== "string" ||
        !/^[0-9a-f-]{36}$/.test(body.backfillId)
      )
        return json(400, { error: { code: "VALIDATION_FAILED" } });
      const sys = await o.systems.current(body.systemId, body.env).catch(() => null);
      if (!sys) return notFound();
      try {
        const action = findAiAction(sys, body.action);
        return json(200, await backfillAiAction(sys, o.ai?.(), { action, backfillId: body.backfillId }));
      } catch (e) {
        if (e instanceof WizardError && e.code === "NOT_FOUND") return notFound();
        throw e;
      }
    }

    // Egress proxy (L3-24): Proxy-Authorization token → policy of the open call's system; the HMAC key stays here.
    if (url.pathname === "/_wizard/internal/egress-authorize") {
      if (typeof body.token !== "string") return json(403, { error: { code: "FORBIDDEN" } });
      if (body.token.startsWith(GRANT_PREFIX)) {
        // M2-52: a ctx.http.fetch request the runtime makes for a function call — only the granted host. The grant
        // is signed, so any replica behind the internal Service checks it, not only the one that issued it.
        const g = o.grants?.open(body.token);
        if (!g) return json(403, { error: { code: "FORBIDDEN" } });
        return json(200, { https: [...g.https].sort(), smtp: [], label: g.systemId, exp: g.exp });
      }
      if (!o.rpc) return json(403, { error: { code: "FORBIDDEN" } });
      const cap = o.rpc.openCapability(body.token);
      if (!cap) return json(403, { error: { code: "FORBIDDEN" } });
      const sys = await o.systems.byId(cap.systemId, cap.env).catch(() => null);
      if (!sys) return json(403, { error: { code: "FORBIDDEN" } });
      const policy = egressPolicyFor(sys.spec, {
        globalAllow: o.egress?.globalAllow ?? [],
        platformDomains: platformDomains(process.env),
        ...(o.egress?.platformSmtpHost ? { platformSmtpHost: o.egress.platformSmtpHost } : {}),
        ...(o.egress?.platformMailApiHost ? { platformMailApiHost: o.egress.platformMailApiHost } : {}),
        label: cap.systemId,
      });
      return json(200, { ...policyJson(policy), exp: cap.exp });
    }
    return notFound();
  };
}
