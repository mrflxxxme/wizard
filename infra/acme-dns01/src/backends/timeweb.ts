// Timeweb Cloud DNS backend of the DNS-01 solver (public API https://api.timeweb.cloud, bearer token from
// https://timeweb.cloud/my/api-keys): one TXT record per challenge value under the zone's _acme-challenge label.
//   POST   /api/v1/domains/{zone}/dns-records            {subdomain: "_acme-challenge[.sub]", type: "TXT", value}
//   GET    /api/v1/domains/{zone}/dns-records            {dns_records: [{id, type, fqdn?, data: {subdomain?, value}}]}
//   DELETE /api/v1/domains/{zone}/dns-records/{id}       204 (404 → already gone)
// Request shapes follow the official SDK models (timeweb-cloud/sdk-python: CreateDns, DnsRecord) and the MIT-licensed
// libdns-timeweb client; written from scratch here.
import { normalizeDomain, relativeName } from "../dns-util.js";

export interface TimewebDnsOptions {
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
}

interface TwRecord {
  id?: number | string;
  type?: string;
  fqdn?: string;
  data?: { subdomain?: string; value?: string };
}

export class TimewebApiError extends Error {
  override name = "TimewebApiError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const TIMEWEB_API_URL = "https://api.timeweb.cloud";

export class TimewebDns {
  private readonly f: typeof fetch;
  private readonly api: string;

  constructor(private readonly o: TimewebDnsOptions) {
    if (!o.token) throw new Error("Timeweb DNS: token is required");
    this.f = o.fetch ?? fetch;
    this.api = (o.apiUrl ?? TIMEWEB_API_URL).replace(/\/$/, "");
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.o.token}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const e = JSON.parse(text) as { message?: unknown; error_code?: unknown };
        if (typeof e.message === "string") message = e.message.slice(0, 300);
        else if (Array.isArray(e.message)) message = String(e.message.join("; ")).slice(0, 300);
      } catch {}
      throw new TimewebApiError(res.status, `${method} ${path.split("?")[0]}: ${message}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async records(zone: string): Promise<TwRecord[]> {
    const r = await this.call<{ dns_records?: TwRecord[] }>(
      "GET",
      `/api/v1/domains/${encodeURIComponent(zone)}/dns-records`,
    );
    return r.dns_records ?? [];
  }

  private matches(r: TwRecord, zone: string, name: string, value: string): boolean {
    if ((r.type ?? "").toUpperCase() !== "TXT" || r.data?.value !== value) return false;
    const sub = r.data?.subdomain ? normalizeDomain(r.data.subdomain) : null;
    const fqdn = r.fqdn ? normalizeDomain(r.fqdn) : null;
    const full = name ? `${name}.${zone}` : zone;
    return sub === name || sub === full || fqdn === full;
  }

  /** Adds a TXT record with value at fqdn (one record per value; idempotent). */
  async presentTxt(zoneDomain: string, fqdn: string, value: string): Promise<void> {
    const zone = normalizeDomain(zoneDomain);
    const name = relativeName(fqdn, zone);
    const existing = await this.records(zone);
    if (existing.some((r) => this.matches(r, zone, name, value))) return;
    await this.call("POST", `/api/v1/domains/${encodeURIComponent(zone)}/dns-records`, {
      subdomain: name,
      type: "TXT",
      value,
    });
  }

  /** Removes the TXT record(s) with value at fqdn; missing → no-op. */
  async cleanupTxt(zoneDomain: string, fqdn: string, value: string): Promise<void> {
    const zone = normalizeDomain(zoneDomain);
    const name = relativeName(fqdn, zone);
    for (const r of await this.records(zone)) {
      if (!this.matches(r, zone, name, value) || r.id === undefined) continue;
      try {
        await this.call(
          "DELETE",
          `/api/v1/domains/${encodeURIComponent(zone)}/dns-records/${encodeURIComponent(String(r.id))}`,
        );
      } catch (e) {
        if (!(e instanceof TimewebApiError && e.status === 404)) throw e;
      }
    }
  }
}
