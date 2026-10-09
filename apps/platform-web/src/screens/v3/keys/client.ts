// Client of /systems/{id}/secrets* and /systems/{id}/secret-windows* (specs/platform/api.yaml, V3-21) over the transport
// of api/client.ts (CSRF, Idempotency-Key, ApiError with message_ru): createApiClient exposes it as `api.keys`. The key
// itself never goes through here — only the ciphertext made by seal.ts.
import type { SealedSecret, WindowPublicKey } from "./seal.js";

export type KeyEnv = "draft" | "prod";

export interface KeyWindow {
  id: string;
  env: KeyEnv;
  name: string;
  secretRef: string;
  integrationId: string | null;
  integrationName: string | null;
  hosts: string[];
  purpose: string;
  requestedBy: "agent" | "user";
  status: "open" | "filled" | "cancelled" | "expired";
  expiresAt: string;
  createdAt: string;
}

/** The fields of an API passport (V3-22): the page encrypts {"fields": {…}} instead of one key. */
export interface PassportForm {
  passport: string;
  name: string;
  where_ru: string;
  compose: "plain" | "basic" | "oauth_client_credentials" | "webhook_url";
  fields: {
    key: string;
    label_ru: string;
    hint_ru: string;
    example: string;
    pattern: string | null;
    flags: string;
    error_ru: string | null;
    secret: boolean;
  }[];
  /** Per-account APIs: the key goes to the account typed into `field`. */
  account: {
    label_ru: string;
    example: string;
    suffixes: string[];
    customHost: boolean;
    reserved: string[];
    field: string;
  } | null;
}

export interface KeyWindowWithKey extends KeyWindow {
  alg: string;
  publicKey: WindowPublicKey;
  context: string;
  form: PassportForm | null;
}

export interface SystemKey {
  name: string;
  secretRef: string;
  env: KeyEnv;
  integrationId: string | null;
  integrationName: string | null;
  hosts: string[];
  last4: string;
  version: number;
  status: "unchecked" | "ok" | "failed";
  check: { code: string | null; message_ru: string | null; checkedAt: string | null };
  rotatedAt: string | null;
  createdAt: string;
}

export interface NeededKey {
  integrationId: string;
  integrationName: string;
  name: string;
  secretRef: string;
  hosts: string[] | null;
  present: boolean;
  keyless: boolean;
  /** A per-account passport API without its account yet: the key goes to the account typed into the window. */
  account: { label_ru: string; suffixes: string[] } | null;
}

export interface KeyCheckLine {
  integrationId: string;
  ok: boolean;
  status: "mock" | "live" | "failed";
  message_ru: string;
  code?: string;
}

export interface KeysState {
  items: SystemKey[];
  windows: KeyWindow[];
  needed: NeededKey[];
}

export interface KeySubmitResult {
  saved: boolean;
  secret: SystemKey | null;
  checks: KeyCheckLine[];
  message_ru: string;
}

export interface KeysClient {
  list(systemId: string): Promise<KeysState>;
  open(systemId: string, integrationId: string, env?: KeyEnv): Promise<{ window: KeyWindowWithKey }>;
  window(systemId: string, windowId: string): Promise<{ window: KeyWindowWithKey }>;
  submit(systemId: string, windowId: string, sealed: SealedSecret): Promise<KeySubmitResult>;
  cancel(systemId: string, windowId: string): Promise<{ window: KeyWindow }>;
  check(
    systemId: string,
    name: string,
    env?: KeyEnv,
  ): Promise<{ secret: SystemKey; checks: KeyCheckLine[]; message_ru: string }>;
  remove(systemId: string, name: string, env?: KeyEnv): Promise<{ removed: true }>;
}

/** The `call` of createApiClient. */
export type KeysCall = <T>(
  method: string,
  path: string,
  init?: {
    body?: Record<string, unknown>;
    idempotencyKey?: string;
    query?: Record<string, string | undefined>;
  },
) => Promise<T>;

const newKey = (): string => crypto.randomUUID();

export function createKeysClient(call: KeysCall): KeysClient {
  const sys = (id: string) => `/systems/${encodeURIComponent(id)}`;
  const win = (id: string, w: string) => `${sys(id)}/secret-windows/${encodeURIComponent(w)}`;
  return {
    list: (id) => call("GET", `${sys(id)}/secrets`),
    open: (id, integrationId, env) =>
      call("POST", `${sys(id)}/secret-windows`, {
        body: { integrationId, ...(env ? { env } : {}) },
        idempotencyKey: newKey(),
      }),
    window: (id, w) => call("GET", win(id, w)),
    submit: (id, w, sealed) =>
      call("POST", `${win(id, w)}/submit`, { body: { ...sealed }, idempotencyKey: newKey() }),
    cancel: (id, w) => call("DELETE", win(id, w), { idempotencyKey: newKey() }),
    check: (id, name, env) =>
      call("POST", `${sys(id)}/secrets/${encodeURIComponent(name)}/check`, {
        body: env ? { env } : {},
        idempotencyKey: newKey(),
      }),
    remove: (id, name, env) =>
      call("DELETE", `${sys(id)}/secrets/${encodeURIComponent(name)}`, {
        query: { env },
        idempotencyKey: newKey(),
      }),
  };
}
