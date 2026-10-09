// Client of /orgs/{orgId}/byok* (specs/platform/api.yaml, V3-33) over the transport of api/client.ts (CSRF double
// submit, Idempotency-Key, ApiError with message_ru, 401 → /login): createApiClient exposes it as `api.byok`.
// The key is sent once in add's body and never kept by the client.

export interface ByokKey {
  id: string;
  provider: string;
  providerName: string;
  model: string;
  verified: boolean;
  direct: boolean;
  gatewayHost: string | null;
  last4: string;
  status: "active" | "paused" | "revoked";
  check: {
    status: "pending" | "ok" | "failed";
    code: string | null;
    message_ru: string | null;
    checkedAt: string | null;
  };
  lastUsedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
}

export interface ByokProvider {
  id: string;
  name: string;
  direct: boolean;
  location: "ru" | "foreign";
  verifiedModels: string[];
  suggestedModels: string[];
}

export interface ByokState {
  available: boolean;
  consent?: { version: string; title: string; paragraphs: string[]; acceptedAt: string | null };
  providers?: ByokProvider[];
  keys?: ByokKey[];
  callTypes?: string[];
}

export interface ByokAdd {
  provider: string;
  model: string;
  key: string;
  gatewayUrl?: string;
}

export interface ByokClient {
  get(orgId: string): Promise<ByokState>;
  accept(orgId: string, version: string): Promise<ByokState>;
  add(orgId: string, body: ByokAdd): Promise<{ key: ByokKey }>;
  check(orgId: string, keyId: string): Promise<{ key: ByokKey }>;
  setStatus(orgId: string, keyId: string, status: "active" | "paused"): Promise<{ key: ByokKey }>;
  revoke(orgId: string, keyId: string): Promise<{ key: ByokKey }>;
}

/** The `call` of createApiClient (mutations get an Idempotency-Key there). */
export type ByokCall = <T>(
  method: string,
  path: string,
  init?: { body?: Record<string, unknown>; idempotencyKey?: string },
) => Promise<T>;

const newKey = (): string => crypto.randomUUID();

export function createByokClient(call: ByokCall): ByokClient {
  const org = (id: string) => `/orgs/${encodeURIComponent(id)}/byok`;
  const key = (orgId: string, keyId: string) => `${org(orgId)}/keys/${encodeURIComponent(keyId)}`;
  return {
    get: (orgId) => call("GET", org(orgId)),
    accept: (orgId, version) =>
      call("POST", `${org(orgId)}/consent`, { body: { version }, idempotencyKey: newKey() }),
    add: (orgId, body) => call("POST", `${org(orgId)}/keys`, { body: { ...body }, idempotencyKey: newKey() }),
    check: (orgId, keyId) => call("POST", `${key(orgId, keyId)}/check`, { idempotencyKey: newKey() }),
    setStatus: (orgId, keyId, status) =>
      call("PATCH", key(orgId, keyId), { body: { status }, idempotencyKey: newKey() }),
    revoke: (orgId, keyId) => call("DELETE", key(orgId, keyId), { idempotencyKey: newKey() }),
  };
}
