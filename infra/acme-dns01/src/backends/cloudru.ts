// Client of the Cloud.ru Evolution DNS public API (https://dns.api.cloud.ru, OpenAPI "Evolution DNS Public API"):
// public zones and TXT record sets of the ACME DNS-01 challenge. Written after the MIT-licensed lego provider
// `cloudruevolution` (github.com/metrica-pro/lego, © Ludovic Fernandez, Sebastian Erhart and contributors;
// THIRD_PARTY_NOTICES.md): IAM token exchange, zone lookup, record upsert with value merging, async operations.
import { normalizeDomain, relativeName } from "../dns-util.js";

export interface CloudruCredentials {
  keyId: string;
  secret: string;
  projectId: string;
}

export interface CloudruDnsOptions extends CloudruCredentials {
  apiUrl?: string;
  authUrl?: string;
  fetch?: typeof fetch;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Async operation polling (default 2 s, timeout 2 min). */
  pollMs?: number;
  operationTimeoutMs?: number;
}

export interface PublicZone {
  id: string;
  domain: string;
  name?: string;
}

export interface PublicRecord {
  id?: string;
  publicZoneId?: string;
  name: string;
  type: string;
  values: string[];
  ttl: number;
}

interface Operation {
  id: string;
  resourceId?: string;
  done?: boolean;
  error?: { code?: number; message?: string } | null;
}

export class CloudruApiError extends Error {
  override name = "CloudruApiError";
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

export const DEFAULT_API_URL = "https://dns.api.cloud.ru";
export const DEFAULT_AUTH_URL = "https://iam.api.cloud.ru/api/v1/auth/token";
/** gRPC codes the API returns in its error envelope. */
const ALREADY_EXISTS = 6;
const NOT_FOUND = 5;
const FAILED_PRECONDITION = 9;

export class CloudruDns {
  private readonly f: typeof fetch;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly api: string;
  private readonly auth: string;
  private token: { value: string; until: number } | null = null;
  private zones = new Map<string, PublicZone>();

  constructor(private readonly o: CloudruDnsOptions) {
    if (!o.keyId || !o.secret || !o.projectId)
      throw new Error("Cloud.ru DNS: keyId, secret and projectId are required");
    this.f = o.fetch ?? fetch;
    this.clock = o.clock ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.api = (o.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    this.auth = o.authUrl ?? DEFAULT_AUTH_URL;
  }

  private async accessToken(): Promise<string> {
    const now = this.clock();
    if (this.token && this.token.until > now) return this.token.value;
    const res = await this.f(this.auth, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ keyId: this.o.keyId, secret: this.o.secret }),
    });
    if (!res.ok) throw new CloudruApiError(res.status, null, `IAM token: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new CloudruApiError(res.status, null, "IAM token: empty access_token");
    }
    const ttl = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    // Refresh at half the lifetime (at most a minute early): parallel challenges never hammer IAM.
    this.token = { value: body.access_token, until: now + ttl * 1000 - Math.min(60_000, (ttl * 1000) / 2) };
    return this.token.value;
  }

  private async call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const res = await this.f(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && !retried) {
      this.token = null;
      return this.call<T>(method, path, body, true);
    }
    const text = await res.text();
    if (!res.ok) {
      let code: number | null = null;
      let message = `HTTP ${res.status}`;
      try {
        const e = JSON.parse(text) as { code?: unknown; message?: unknown };
        if (typeof e.code === "number") code = e.code;
        if (typeof e.message === "string") message = e.message.slice(0, 300);
      } catch {}
      throw new CloudruApiError(res.status, code, `${method} ${path.split("?")[0]}: ${message}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async listZones(): Promise<PublicZone[]> {
    const out: PublicZone[] = [];
    let page = "";
    do {
      const q = new URLSearchParams({ projectId: this.o.projectId, ...(page ? { pageToken: page } : {}) });
      const r = await this.call<{ zones?: PublicZone[]; nextPageToken?: string }>(
        "GET",
        `/v1/publicZones?${q}`,
      );
      out.push(...(r.zones ?? []));
      page = r.nextPageToken ?? "";
    } while (page);
    return out;
  }

  async zoneByDomain(domain: string): Promise<PublicZone | null> {
    const key = normalizeDomain(domain);
    const hit = this.zones.get(key);
    if (hit) return hit;
    for (const z of await this.listZones()) this.zones.set(normalizeDomain(z.domain), z);
    return this.zones.get(key) ?? null;
  }

  async listRecords(zoneId: string): Promise<PublicRecord[]> {
    const out: PublicRecord[] = [];
    let page = "";
    do {
      const q = new URLSearchParams({ publicZoneId: zoneId, ...(page ? { pageToken: page } : {}) });
      const r = await this.call<{ records?: PublicRecord[]; nextPageToken?: string }>(
        "GET",
        `/v1/publicRecordsSole?${q}`,
      );
      out.push(...(r.records ?? []));
      page = r.nextPageToken ?? "";
    } while (page);
    return out;
  }

  private async findTxt(zoneId: string, name: string): Promise<PublicRecord | null> {
    const records = await this.listRecords(zoneId);
    return records.find((r) => r.type.toLowerCase() === "txt" && normalizeDomain(r.name) === name) ?? null;
  }

  private async wait(op: Operation): Promise<Operation> {
    const deadline = this.clock() + (this.o.operationTimeoutMs ?? 120_000);
    let cur = op;
    for (;;) {
      if (cur.error && (cur.error.code || cur.error.message)) {
        throw new CloudruApiError(
          200,
          cur.error.code ?? null,
          `operation ${op.id}: ${cur.error.message ?? "failed"}`,
        );
      }
      if (cur.done) return cur;
      if (this.clock() > deadline) throw new CloudruApiError(200, null, `operation ${op.id}: timeout`);
      await this.sleep(this.o.pollMs ?? 2000);
      cur = await this.call<Operation>("GET", `/v1/operations/${encodeURIComponent(op.id)}`);
    }
  }

  /** Adds value to the TXT set at fqdn (merging with values other challenges put there). Idempotent. */
  async presentTxt(zoneDomain: string, fqdn: string, value: string, ttl = 120): Promise<void> {
    const zone = await this.zoneByDomain(zoneDomain);
    if (!zone) throw new Error(`zone ${zoneDomain} is not in the Cloud.ru project`);
    const name = relativeName(fqdn, zone.domain);
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await this.findTxt(zone.id, name);
      if (!existing?.id) {
        try {
          const op = await this.call<Operation>("POST", "/v1/publicRecordsSole", {
            publicZoneId: zone.id,
            name,
            type: "txt",
            values: [value],
            ttl,
          });
          await this.wait(op);
          return;
        } catch (e) {
          // A parallel challenge for the same name created the set first: merge into it.
          if (e instanceof CloudruApiError && (e.code === ALREADY_EXISTS || e.status === 409)) continue;
          throw e;
        }
      }
      if (existing.values.includes(value)) return;
      const op = await this.call<Operation>(
        "PATCH",
        `/v1/publicRecordsSole/${encodeURIComponent(existing.id)}`,
        {
          values: [...existing.values, value],
          ttl,
        },
      );
      await this.wait(op);
      return;
    }
    throw new Error(`TXT ${fqdn}: lost the race 5 times`);
  }

  /** Removes value from the TXT set at fqdn; the set is deleted when it becomes empty. Missing → no-op. */
  async cleanupTxt(zoneDomain: string, fqdn: string, value: string, ttl = 120): Promise<void> {
    const zone = await this.zoneByDomain(zoneDomain);
    if (!zone) return;
    const name = relativeName(fqdn, zone.domain);
    const existing = await this.findTxt(zone.id, name);
    if (!existing?.id || !existing.values.includes(value)) return;
    const rest = existing.values.filter((v) => v !== value);
    try {
      const op =
        rest.length === 0
          ? await this.call<Operation>("DELETE", `/v1/publicRecordsSole/${encodeURIComponent(existing.id)}`)
          : await this.call<Operation>("PATCH", `/v1/publicRecordsSole/${encodeURIComponent(existing.id)}`, {
              values: rest,
              ttl,
            });
      await this.wait(op);
    } catch (e) {
      if (e instanceof CloudruApiError && (e.code === NOT_FOUND || e.code === FAILED_PRECONDITION)) return;
      throw e;
    }
  }
}
