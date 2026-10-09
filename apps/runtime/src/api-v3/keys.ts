// Access keys of a system's own API (V3-20; runtime.yaml#incoming_api): the key is shown to the owner once, only its
// sha256 is stored (platform.system_api_keys, migration 0039), each key maps to one role of the spec and a scope
// list, can be revoked and dies with the system. The runtime reads keys the way it reads platform.deployments and
// appends the audit rows (platform.system_api_calls) — never a key, a body or a value.
import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import type { SystemEnv } from "../registry.js";
import { type ApiScope, parseScopes } from "./scopes.js";

/** Key format: wzk_ + 40 base32 characters (200 random bits). */
export const API_KEY_RE = /^wzk_[a-z2-7]{40}$/;
/** Shown in lists instead of the key: wzk_ + its first 8 characters. */
export const API_KEY_PREFIX_LEN = 12;
/** Default and largest requests per minute of one key. */
export const API_KEY_RATE_DEFAULT = 60;
export const API_KEY_RATE_MAX = 600;
/** Audit rows older than this are deleted by the runtime while it appends (per key). */
export const API_CALLS_RETENTION_DAYS = 90;

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** sha256 hex of a key (what platform.system_api_keys.key_hash keeps). */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** A new random key with its display prefix and hash; the key itself is returned to the owner once. */
export function newApiKey(): { key: string; prefix: string; hash: string } {
  const bytes = randomBytes(25);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  const key = `wzk_${out.slice(0, 40)}`;
  return { key, prefix: key.slice(0, API_KEY_PREFIX_LEN), hash: hashApiKey(key) };
}

/** An active key as the runtime sees it. */
export interface ApiKeyRecord {
  id: string;
  /** platform.systems.id (audit rows). */
  systemId: string;
  /** platform.systems.schema_key = registry systemId of the runtime. */
  systemKey: string;
  env: SystemEnv;
  name: string;
  /** Spec role the key acts as (permissions and RLS of that role). */
  role: string;
  scopes: ApiScope[];
  ratePerMinute: number;
}

/** One served request of a key (audit): no query, no body, no values. */
export interface ApiCallRecord {
  method: string;
  /** openapi | data:<entity> | data:<entity>/:id | fn:<name> */
  target: string;
  status: number;
  durationMs: number;
}

export interface ApiKeyStore {
  /** The active key with this hash (not revoked, its system not deleted or suspended), or null. */
  find(keyHash: string): Promise<ApiKeyRecord | null>;
  /** last_used_at and an audit row; best effort. */
  used(key: ApiKeyRecord, call: ApiCallRecord): Promise<void>;
}

type KeyRow = {
  id: string;
  system_id: string;
  schema_key: string;
  env: string;
  name: string;
  role: string;
  scopes: unknown;
  rate_per_minute: number;
};

function toRecord(r: KeyRow): ApiKeyRecord | null {
  const scopes = parseScopes(typeof r.scopes === "string" ? JSON.parse(r.scopes) : r.scopes);
  if (!scopes || (r.env !== "draft" && r.env !== "prod")) return null;
  return {
    id: r.id,
    systemId: r.system_id,
    systemKey: r.schema_key,
    env: r.env,
    name: r.name,
    role: r.role,
    scopes,
    ratePerMinute: r.rate_per_minute,
  };
}

/** Keys in platform.system_api_keys (one indexed lookup per request: a revoked key stops at once). */
export function pgApiKeyStore(sql: postgres.Sql): ApiKeyStore {
  let appended = 0;
  return {
    async find(keyHash) {
      let rows: KeyRow[];
      try {
        rows = await sql<KeyRow[]>`
        select k.id, k.system_id, s.schema_key, k.env, k.name, k.role, k.scopes, k.rate_per_minute
          from platform.system_api_keys k
          join platform.systems s on s.id = k.system_id
         where k.key_hash = ${keyHash}
           and k.revoked_at is null
           and s.deleted_at is null
           and s.suspended_at is null
         limit 1`;
      } catch (e) {
        // A database without the platform schema (local runtime over registry.json): no keys — fail closed.
        if ((e as { code?: unknown }).code === "42P01" || (e as { code?: unknown }).code === "3F000")
          return null;
        throw e;
      }
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async used(key, call) {
      await sql`
        update platform.system_api_keys set last_used_at = now()
         where id = ${key.id} and (last_used_at is null or last_used_at < now() - interval '1 minute')`;
      await sql`
        insert into platform.system_api_calls (key_id, system_id, method, target, status, duration_ms)
        values (${key.id}, ${key.systemId}, ${call.method}, ${call.target.slice(0, 120)}, ${call.status},
                ${Math.min(Math.max(0, Math.round(call.durationMs)), 2_147_483_647)})`;
      if (++appended % 100 === 0)
        await sql`
          delete from platform.system_api_calls
           where key_id = ${key.id}
             and created_at < now() - make_interval(days => ${API_CALLS_RETENTION_DAYS})`;
    },
  };
}

/** In-memory keys (tests, local runs without the platform). */
export class MemoryApiKeyStore implements ApiKeyStore {
  readonly keys = new Map<string, ApiKeyRecord & { revoked?: boolean }>();
  readonly calls: (ApiCallRecord & { keyId: string })[] = [];

  /** Adds a key; returns the key text to send. */
  add(rec: Omit<ApiKeyRecord, "id" | "ratePerMinute"> & { id?: string; ratePerMinute?: number }): string {
    const k = newApiKey();
    this.keys.set(k.hash, {
      ...rec,
      id: rec.id ?? k.hash.slice(0, 32),
      ratePerMinute: rec.ratePerMinute ?? API_KEY_RATE_DEFAULT,
    });
    return k.key;
  }

  revoke(key: string): void {
    const r = this.keys.get(hashApiKey(key));
    if (r) r.revoked = true;
  }

  async find(keyHash: string): Promise<ApiKeyRecord | null> {
    const r = this.keys.get(keyHash);
    if (!r || r.revoked) return null;
    const { revoked: _r, ...rec } = r;
    return rec;
  }

  async used(key: ApiKeyRecord, call: ApiCallRecord): Promise<void> {
    this.calls.push({ ...call, keyId: key.id });
  }
}
