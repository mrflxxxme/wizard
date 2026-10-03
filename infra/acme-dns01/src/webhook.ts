// cert-manager ACME webhook solver protocol (cert-manager.io/docs/configuration/acme/dns01/webhook): an aggregated API
// group served behind kube-apiserver. cert-manager POSTs a ChallengePayload to
// /apis/<group>/v1alpha1/<solver> with action Present | CleanUp; we answer with the same kind and {uid, success}.
// Requests count only when kube-apiserver proxied them (front-proxy client certificate, checked by the TLS server and
// by `trusted`) on behalf of an allowed user (cert-manager's service account, X-Remote-User).

export interface ChallengeRequest {
  uid: string;
  action: "Present" | "CleanUp";
  type: string;
  dnsName: string;
  key: string;
  resourceNamespace?: string;
  resolvedFQDN: string;
  resolvedZone: string;
  allowAmbientCredentials?: boolean;
  config?: unknown;
}

export interface DnsBackend {
  presentTxt(zone: string, fqdn: string, value: string, ttl?: number): Promise<void>;
  cleanupTxt(zone: string, fqdn: string, value: string, ttl?: number): Promise<void>;
}

export interface WebhookOptions {
  /** API group of the APIService, e.g. acme.wizard.ru (Issuer: solvers[].dns01.webhook.groupName). */
  groupName: string;
  /** Solver name (Issuer: solvers[].dns01.webhook.solverName). */
  solverName: string;
  dns: DnsBackend;
  /** Zones this solver may touch (the platform and systems domains); anything else is refused. */
  zones: readonly string[];
  /** Users kube-apiserver may act for (X-Remote-User), e.g. system:serviceaccount:cert-manager:cert-manager. */
  allowedUsers: readonly string[];
  log?: (line: Record<string, unknown>) => void;
}

/** What the TLS layer tells about the caller. */
export interface CallerInfo {
  /** The client certificate chained to the front-proxy CA (requestheader-client-ca-file). */
  authorized: boolean;
  /** CN of that certificate. */
  commonName: string | null;
  /** requestheader-allowed-names; empty → any CN signed by the CA. */
  allowedNames: readonly string[];
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");

/** Front-proxy check of kube-apiserver → aggregated server (k8s.io/apiserver requestheader authenticator rules). */
export function trusted(caller: CallerInfo): boolean {
  if (!caller.authorized || !caller.commonName) return false;
  return caller.allowedNames.length === 0 || caller.allowedNames.includes(caller.commonName);
}

function parseRequest(body: unknown): ChallengeRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const r = (body as { request?: unknown }).request;
  if (typeof r !== "object" || r === null) return null;
  const x = r as Record<string, unknown>;
  const str = (k: string) =>
    typeof x[k] === "string" && (x[k] as string).length > 0 && (x[k] as string).length < 512;
  if (!str("uid") || !str("key") || !str("resolvedFQDN") || !str("resolvedZone")) return null;
  if (x.action !== "Present" && x.action !== "CleanUp") return null;
  // cert-manager sends the ACME challenge type as "DNS-01" (acme.cert-manager.io ACMEChallengeType); every request
  // was refused as malformed while this compared case-sensitively with "dns-01" (first live bootstrap, 2026-10-03).
  if (x.type !== undefined && String(x.type).toLowerCase() !== "dns-01") return null;
  return x as unknown as ChallengeRequest;
}

/** Only _acme-challenge names inside an allowed zone; the zone itself must be allowed exactly. */
export function inScope(
  req: Pick<ChallengeRequest, "resolvedFQDN" | "resolvedZone">,
  zones: readonly string[],
): boolean {
  const zone = norm(req.resolvedZone);
  const fqdn = norm(req.resolvedFQDN);
  if (!zones.map(norm).includes(zone)) return false;
  return (
    fqdn === `_acme-challenge.${zone}` || (fqdn.startsWith("_acme-challenge.") && fqdn.endsWith(`.${zone}`))
  );
}

function ttlOf(config: unknown): number {
  const t = (config as { ttl?: unknown } | null)?.ttl;
  return typeof t === "number" && Number.isInteger(t) && t >= 60 && t <= 3600 ? t : 120;
}

export function createWebhook(o: WebhookOptions): (req: Request, caller: CallerInfo) => Promise<Response> {
  const gv = `${o.groupName}/v1alpha1`;
  const solverPath = `/apis/${gv}/${o.solverName}`;
  const resources = {
    kind: "APIResourceList",
    apiVersion: "v1",
    groupVersion: gv,
    resources: [
      {
        name: o.solverName,
        singularName: o.solverName,
        namespaced: false,
        kind: "ChallengePayload",
        verbs: ["create"],
      },
    ],
  };
  const group = {
    kind: "APIGroup",
    apiVersion: "v1",
    name: o.groupName,
    versions: [{ groupVersion: gv, version: "v1alpha1" }],
    preferredVersion: { groupVersion: gv, version: "v1alpha1" },
  };
  const log = (line: Record<string, unknown>) =>
    o.log?.({ ts: new Date().toISOString(), svc: "acme-dns01", ...line });

  return async (req, caller) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (req.method === "GET" && (path === "/healthz" || path === "/livez" || path === "/readyz")) {
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }
    // Discovery and OpenAPI are read by kube-apiserver itself (front-proxy certificate, no remote user needed).
    if (req.method === "GET") {
      if (!trusted(caller)) return json(401, { kind: "Status", status: "Failure", code: 401 });
      if (path === "/apis") return json(200, { kind: "APIGroupList", apiVersion: "v1", groups: [group] });
      if (path === `/apis/${o.groupName}`) return json(200, group);
      if (path === `/apis/${gv}`) return json(200, resources);
      if (path === "/openapi/v2")
        return json(200, { swagger: "2.0", info: { title: o.groupName, version: "v1alpha1" }, paths: {} });
      if (path === "/openapi/v3") return json(200, { paths: {} });
      return json(404, { kind: "Status", status: "Failure", code: 404 });
    }
    if (req.method !== "POST" || path !== solverPath)
      return json(404, { kind: "Status", status: "Failure", code: 404 });
    const user = req.headers.get("x-remote-user") ?? "";
    if (!trusted(caller) || !o.allowedUsers.includes(user)) {
      log({ level: "warn", msg: "denied", reason: trusted(caller) ? "user" : "front_proxy" });
      return json(403, { kind: "Status", status: "Failure", code: 403, reason: "Forbidden" });
    }
    const body = await req.json().catch(() => null);
    const cr = parseRequest(body);
    const apiVersion = (body as { apiVersion?: unknown } | null)?.apiVersion ?? gv;
    const reply = (uid: string, success: boolean, message?: string) =>
      json(200, {
        apiVersion,
        kind: "ChallengePayload",
        response: {
          uid,
          success,
          ...(message ? { status: { status: "Failure", message, reason: "BadRequest", code: 400 } } : {}),
        },
      });
    if (!cr)
      return reply(
        String((body as { request?: { uid?: unknown } } | null)?.request?.uid ?? ""),
        false,
        "malformed ChallengeRequest",
      );
    if (!inScope(cr, o.zones)) {
      log({ level: "warn", msg: "out_of_scope", zone: norm(cr.resolvedZone) });
      return reply(cr.uid, false, `zone ${norm(cr.resolvedZone)} is not managed by this solver`);
    }
    const ttl = ttlOf(cr.config);
    try {
      if (cr.action === "Present") await o.dns.presentTxt(cr.resolvedZone, cr.resolvedFQDN, cr.key, ttl);
      else await o.dns.cleanupTxt(cr.resolvedZone, cr.resolvedFQDN, cr.key, ttl);
      log({ level: "info", msg: cr.action, zone: norm(cr.resolvedZone) });
      return reply(cr.uid, true);
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 300) : "DNS API error";
      log({ level: "error", msg: `${cr.action}_failed`, zone: norm(cr.resolvedZone), error: message });
      return reply(cr.uid, false, message);
    }
  };
}
