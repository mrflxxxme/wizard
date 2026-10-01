// Front-proxy trust of the aggregated API server: kube-apiserver signs its requests with a client certificate from
// requestheader-client-ca-file, published in kube-system/extension-apiserver-authentication (readable through the
// standard Role extension-apiserver-authentication-reader, bound by the chart).

export interface FrontProxyTrust {
  /** PEM bundle of requestheader-client-ca-file. */
  ca: string;
  /** requestheader-allowed-names (empty → any certificate of the CA). */
  allowedNames: string[];
}

export interface InClusterOptions {
  host?: string;
  port?: string;
  token: string;
  /** CA of the API server (serviceaccount/ca.crt) — used by the caller's fetch/agent. */
  fetch?: typeof fetch;
}

/** Parses the ConfigMap data of extension-apiserver-authentication. */
export function frontProxyTrust(data: Record<string, string | undefined>): FrontProxyTrust {
  const ca = data["requestheader-client-ca-file"];
  if (!ca?.includes("BEGIN CERTIFICATE")) throw new Error("requestheader-client-ca-file is missing");
  let names: unknown = [];
  try {
    names = JSON.parse(data["requestheader-allowed-names"] ?? "[]");
  } catch {
    throw new Error("requestheader-allowed-names is not JSON");
  }
  if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {
    throw new Error("requestheader-allowed-names must be a list of strings");
  }
  return { ca, allowedNames: names };
}

/** GET /api/v1/namespaces/kube-system/configmaps/extension-apiserver-authentication with the pod's token. */
export async function readFrontProxyTrust(o: InClusterOptions): Promise<FrontProxyTrust> {
  const host = o.host ?? process.env.KUBERNETES_SERVICE_HOST;
  const port = o.port ?? process.env.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) throw new Error("not in a cluster (KUBERNETES_SERVICE_HOST)");
  const h = host.includes(":") ? `[${host}]` : host;
  const res = await (o.fetch ?? fetch)(
    `https://${h}:${port}/api/v1/namespaces/kube-system/configmaps/extension-apiserver-authentication`,
    { headers: { authorization: `Bearer ${o.token}`, accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`extension-apiserver-authentication: HTTP ${res.status}`);
  const cm = (await res.json()) as { data?: Record<string, string> };
  return frontProxyTrust(cm.data ?? {});
}
