// SQL of the integrations harness (V3-20; db.yaml#system_integration_contracts, #system_api_keys, #system_api_calls):
// fully qualified names, values only as parameters. No key value ever reaches these tables — only its sha256.
import type { IntegrationContract, KeyCheckResult } from "@wizard/agents/integrations";
import type { ApiScope } from "@wizard/runtime";
import type postgres from "postgres";

export type ContractStatus = "mock" | "live" | "failed";

export interface ContractRow {
  integrationId: string;
  version: number;
  contract: IntegrationContract;
  sha256: string;
  status: ContractStatus;
  tests: Record<string, unknown>;
  keyCheck: KeyCheckResult | null;
  checkedAt: string | null;
  createdAt: string;
}

type Sql = postgres.Sql | postgres.TransactionSql;

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const obj = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

function toContract(r: Record<string, unknown>): ContractRow {
  return {
    integrationId: r.integration_id as string,
    version: Number(r.version),
    contract: obj<IntegrationContract>(r.contract),
    sha256: r.sha256 as string,
    status: r.status as ContractStatus,
    tests: obj<Record<string, unknown>>(r.tests),
    keyCheck: r.key_check ? obj<KeyCheckResult>(r.key_check) : null,
    checkedAt: iso(r.checked_at),
    createdAt: iso(r.created_at) as string,
  };
}

/** The latest version of every integration contract of a system. */
export async function latestContracts(sql: Sql, systemId: string): Promise<ContractRow[]> {
  const rows = await sql`
    select distinct on (c.integration_id) c.*
      from platform.system_integration_contracts c
     where c.system_id = ${systemId}
     order by c.integration_id, c.version desc`;
  return rows.map((r) => toContract(r));
}

/** The latest version of one integration's contract, or null. */
export async function latestContract(
  sql: Sql,
  systemId: string,
  integrationId: string,
): Promise<ContractRow | null> {
  const [r] = await sql`
    select c.* from platform.system_integration_contracts c
     where c.system_id = ${systemId} and c.integration_id = ${integrationId}
     order by c.version desc limit 1`;
  return r ? toContract(r) : null;
}

/** Stores a new version (max+1) under a lock of the system row. */
export async function insertContract(
  sql: postgres.TransactionSql,
  p: {
    systemId: string;
    contract: IntegrationContract;
    sha256: string;
    tests: unknown;
    createdBy: string | null;
    runId?: string | null;
  },
): Promise<ContractRow> {
  await sql`select 1 from platform.systems where id = ${p.systemId} for no key update`;
  const [v] = await sql`
    select coalesce(max(version), 0)::int as v from platform.system_integration_contracts
     where system_id = ${p.systemId} and integration_id = ${p.contract.id}`;
  const [r] = await sql`
    insert into platform.system_integration_contracts
      (system_id, integration_id, version, contract, sha256, status, tests, created_by, run_id)
    values (${p.systemId}, ${p.contract.id}, ${Number(v?.v ?? 0) + 1}, cast(cast(${JSON.stringify(p.contract)} as text) as jsonb), ${p.sha256},
            'mock', cast(cast(${JSON.stringify(p.tests)} as text) as jsonb), ${p.createdBy}, ${p.runId ?? null})
    returning *`;
  return toContract(r as Record<string, unknown>);
}

/** Result of a key check on a version: live / failed (or mock when no key). */
export async function setContractCheck(
  sql: Sql,
  p: {
    systemId: string;
    integrationId: string;
    version: number;
    status: ContractStatus;
    check: KeyCheckResult;
  },
): Promise<void> {
  await sql`
    update platform.system_integration_contracts
       set status = ${p.status}, key_check = cast(cast(${JSON.stringify(p.check)} as text) as jsonb), checked_at = now()
     where system_id = ${p.systemId} and integration_id = ${p.integrationId} and version = ${p.version}`;
}

// ------------------------------------------------------------------------------------------------ API keys

export interface ApiKeyRow {
  id: string;
  env: "draft" | "prod";
  name: string;
  role: string;
  scopes: ApiScope[];
  prefix: string;
  ratePerMinute: number;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function toKey(r: Record<string, unknown>): ApiKeyRow {
  return {
    id: r.id as string,
    env: r.env as "draft" | "prod",
    name: r.name as string,
    role: r.role as string,
    scopes: obj<ApiScope[]>(r.scopes),
    prefix: r.prefix as string,
    ratePerMinute: Number(r.rate_per_minute),
    createdAt: iso(r.created_at) as string,
    lastUsedAt: iso(r.last_used_at),
    revokedAt: iso(r.revoked_at),
  };
}

export async function insertApiKey(
  sql: Sql,
  p: {
    systemId: string;
    env: "draft" | "prod";
    name: string;
    role: string;
    scopes: ApiScope[];
    prefix: string;
    hash: string;
    ratePerMinute: number;
    createdBy: string | null;
  },
): Promise<ApiKeyRow> {
  const [r] = await sql`
    insert into platform.system_api_keys
      (system_id, env, name, role, scopes, prefix, key_hash, rate_per_minute, created_by)
    values (${p.systemId}, ${p.env}, ${p.name}, ${p.role}, cast(cast(${JSON.stringify(p.scopes)} as text) as jsonb), ${p.prefix}, ${p.hash},
            ${p.ratePerMinute}, ${p.createdBy})
    returning id, env, name, role, scopes, prefix, rate_per_minute, created_at, last_used_at, revoked_at`;
  return toKey(r as Record<string, unknown>);
}

export async function listApiKeys(sql: Sql, systemId: string): Promise<ApiKeyRow[]> {
  const rows = await sql`
    select id, env, name, role, scopes, prefix, rate_per_minute, created_at, last_used_at, revoked_at from platform.system_api_keys
     where system_id = ${systemId} order by created_at desc limit 200`;
  return rows.map((r) => toKey(r));
}

export async function getApiKey(sql: Sql, systemId: string, keyId: string): Promise<ApiKeyRow | null> {
  const [r] = await sql`
    select id, env, name, role, scopes, prefix, rate_per_minute, created_at, last_used_at, revoked_at from platform.system_api_keys
     where system_id = ${systemId} and id = ${keyId}`;
  return r ? toKey(r) : null;
}

/** Revokes a key (idempotent: the first revocation time stays). */
export async function revokeApiKey(sql: Sql, systemId: string, keyId: string): Promise<ApiKeyRow | null> {
  const [r] = await sql`
    update platform.system_api_keys set revoked_at = coalesce(revoked_at, now())
     where system_id = ${systemId} and id = ${keyId}
    returning id, env, name, role, scopes, prefix, rate_per_minute, created_at, last_used_at, revoked_at`;
  return r ? toKey(r) : null;
}

export interface ApiCallRow {
  method: string;
  target: string;
  status: number;
  durationMs: number;
  at: string;
}

export async function listApiCalls(
  sql: Sql,
  systemId: string,
  keyId: string,
  limit = 100,
): Promise<ApiCallRow[]> {
  const rows = await sql`
    select method, target, status, duration_ms, created_at from platform.system_api_calls
     where system_id = ${systemId} and key_id = ${keyId}
     order by created_at desc limit ${limit}`;
  return rows.map((r) => ({
    method: r.method as string,
    target: r.target as string,
    status: Number(r.status),
    durationMs: Number(r.duration_ms),
    at: iso(r.created_at) as string,
  }));
}
