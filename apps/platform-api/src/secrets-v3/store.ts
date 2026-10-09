// SQL of the key window (V3-21; db.yaml#secret_windows, #secret_bindings, migration 0042): fully qualified names,
// values only as parameters, every statement inside a transaction scoped to the org (RLS FORCE by
// pg_catalog.set_config('wizard.org_id', …, true)). No key value ever reaches these tables: a window keeps its public
// key and the KMS-sealed private key until it is used; a binding keeps the hosts, the last 4 characters and the check.
import type postgres from "postgres";
import type { WindowPublicKey } from "./crypto.js";

export type Tx = postgres.TransactionSql;
export type Env = "draft" | "prod";
export type WindowStatus = "open" | "filled" | "cancelled" | "expired";
export type BindingStatus = "unchecked" | "ok" | "failed";

/** A window lives a day; its private key is destroyed when it is used, cancelled or expired. */
export const WINDOW_TTL_MS = 24 * 60 * 60 * 1000;

export interface WindowRow {
  id: string;
  orgId: string;
  systemId: string;
  env: Env;
  name: string;
  integrationId: string | null;
  hosts: string[];
  purpose: string;
  requestedBy: "agent" | "user";
  runId: string | null;
  status: WindowStatus;
  publicKey: WindowPublicKey | null;
  sealedPrivate: string | null;
  wrappedDek: string | null;
  kekBackend: "local" | "openbao" | null;
  kekName: string | null;
  expiresAt: string;
  closedAt: string | null;
  createdAt: string;
}

export interface BindingRow {
  systemId: string;
  env: Env;
  name: string;
  integrationId: string | null;
  hosts: string[];
  last4: string;
  version: number;
  status: BindingStatus;
  checkCode: string | null;
  checkMessage: string | null;
  checkedAt: string | null;
  windowId: string | null;
  rotatedAt: string | null;
  createdAt: string;
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const arr = (v: unknown): string[] => (typeof v === "string" ? (JSON.parse(v) as string[]) : (v as string[]));
const obj = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
const jsonb = (v: unknown) => JSON.stringify(v);

function toWindow(r: Record<string, unknown>): WindowRow {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    systemId: r.system_id as string,
    env: r.env as Env,
    name: r.name as string,
    integrationId: (r.integration_id as string | null) ?? null,
    hosts: arr(r.hosts),
    purpose: r.purpose as string,
    requestedBy: r.requested_by as "agent" | "user",
    runId: (r.run_id as string | null) ?? null,
    status: r.status as WindowStatus,
    publicKey: r.public_jwk ? obj<WindowPublicKey>(r.public_jwk) : null,
    sealedPrivate: (r.sealed_private as string | null) ?? null,
    wrappedDek: (r.wrapped_dek as string | null) ?? null,
    kekBackend: (r.kek_backend as "local" | "openbao" | null) ?? null,
    kekName: (r.kek_name as string | null) ?? null,
    expiresAt: iso(r.expires_at) as string,
    closedAt: iso(r.closed_at),
    createdAt: iso(r.created_at) as string,
  };
}

function toBinding(r: Record<string, unknown>): BindingRow {
  return {
    systemId: r.system_id as string,
    env: r.env as Env,
    name: r.name as string,
    integrationId: (r.integration_id as string | null) ?? null,
    hosts: arr(r.hosts),
    last4: r.last4 as string,
    version: Number(r.version),
    status: r.status as BindingStatus,
    checkCode: (r.check_code as string | null) ?? null,
    checkMessage: (r.check_message as string | null) ?? null,
    checkedAt: iso(r.checked_at),
    windowId: (r.window_id as string | null) ?? null,
    rotatedAt: iso(r.rotated_at),
    createdAt: iso(r.created_at) as string,
  };
}

/** Runs `fn` in a transaction whose RLS scope is the org. */
export function withOrg<T>(pg: postgres.Sql, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return pg.begin(async (tx) => {
    await tx`select pg_catalog.set_config('wizard.org_id', ${orgId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** The org of a live system, or null (no RLS on platform.systems). */
export async function systemOrg(
  pg: postgres.Sql | Tx,
  systemId: string,
): Promise<{ orgId: string; schemaKey: string } | null> {
  const [r] = await pg`
    select s.org_id, s.schema_key from platform.systems s where s.id = ${systemId} and s.deleted_at is null`;
  return r ? { orgId: r.org_id as string, schemaKey: r.schema_key as string } : null;
}

/** Open windows past their time become expired, their private keys destroyed. */
export async function expireWindows(tx: Tx, systemId: string): Promise<void> {
  await tx`
    update platform.secret_windows
       set status = 'expired', closed_at = pg_catalog.now(), public_jwk = null, sealed_private = null,
           wrapped_dek = null, kek_backend = null, kek_name = null
     where system_id = ${systemId} and status = 'open' and expires_at <= pg_catalog.now()`;
}

export async function openWindowFor(
  tx: Tx,
  systemId: string,
  env: Env,
  name: string,
): Promise<WindowRow | null> {
  const [r] = await tx`
    select w.* from platform.secret_windows w
     where w.system_id = ${systemId} and w.env = ${env} and w.name = ${name} and w.status = 'open'`;
  return r ? toWindow(r) : null;
}

export async function insertWindow(
  tx: Tx,
  p: {
    orgId: string;
    systemId: string;
    env: Env;
    name: string;
    integrationId: string | null;
    hosts: string[];
    purpose: string;
    requestedBy: "agent" | "user";
    runId: string | null;
    createdBy: string | null;
    ttlMs?: number;
  },
): Promise<WindowRow> {
  const [r] = await tx`
    insert into platform.secret_windows
      (org_id, system_id, env, name, integration_id, hosts, purpose, requested_by, run_id, created_by, expires_at)
    values (${p.orgId}, ${p.systemId}, ${p.env}, ${p.name}, ${p.integrationId},
            cast(cast(${jsonb(p.hosts)} as text) as jsonb), ${p.purpose}, ${p.requestedBy}, ${p.runId},
            ${p.createdBy}, pg_catalog.now() + pg_catalog.make_interval(secs => ${(p.ttlMs ?? WINDOW_TTL_MS) / 1000}))
    returning *`;
  return toWindow(r as Record<string, unknown>);
}

export async function getWindow(
  tx: Tx,
  systemId: string,
  id: string,
  lock = false,
): Promise<WindowRow | null> {
  const [r] = lock
    ? await tx`select w.* from platform.secret_windows w where w.id = ${id} and w.system_id = ${systemId} for update`
    : await tx`select w.* from platform.secret_windows w where w.id = ${id} and w.system_id = ${systemId}`;
  return r ? toWindow(r) : null;
}

export async function listOpenWindows(tx: Tx, systemId: string): Promise<WindowRow[]> {
  const rows = await tx`
    select w.* from platform.secret_windows w
     where w.system_id = ${systemId} and w.status = 'open' order by w.created_at`;
  return rows.map((r) => toWindow(r));
}

/** Stores the window's key pair (public JWK, KMS-sealed private key) once; returns the row as stored. */
export async function setWindowKey(
  tx: Tx,
  p: {
    id: string;
    publicKey: WindowPublicKey;
    sealedPrivate: string;
    wrappedDek: string;
    kekBackend: "local" | "openbao";
    kekName: string;
  },
): Promise<WindowRow | null> {
  const [r] = await tx`
    update platform.secret_windows
       set public_jwk = cast(cast(${jsonb(p.publicKey)} as text) as jsonb), sealed_private = ${p.sealedPrivate},
           wrapped_dek = ${p.wrappedDek}, kek_backend = ${p.kekBackend}, kek_name = ${p.kekName}
     where id = ${p.id} and status = 'open' and sealed_private is null
    returning *`;
  return r ? toWindow(r) : null;
}

/** Closes an open window (filled or cancelled) and destroys its key pair; false — it was not open any more. */
export async function closeWindow(tx: Tx, id: string, status: "filled" | "cancelled"): Promise<boolean> {
  const rows = await tx`
    update platform.secret_windows
       set status = ${status}, closed_at = pg_catalog.now(), public_jwk = null, sealed_private = null,
           wrapped_dek = null, kek_backend = null, kek_name = null
     where id = ${id} and status = 'open'
    returning id`;
  return rows.length === 1;
}

export async function getBinding(
  tx: Tx,
  systemId: string,
  env: Env,
  name: string,
): Promise<BindingRow | null> {
  const [r] = await tx`
    select b.* from platform.secret_bindings b
     where b.system_id = ${systemId} and b.env = ${env} and b.name = ${name}`;
  return r ? toBinding(r) : null;
}

export async function listBindings(tx: Tx, systemId: string): Promise<BindingRow[]> {
  const rows = await tx`
    select b.* from platform.secret_bindings b where b.system_id = ${systemId} order by b.name, b.env`;
  return rows.map((r) => toBinding(r));
}

/** A new key for (system, env, name): version 1, or the next version of a rotation (rotated_at set). */
export async function upsertBinding(
  tx: Tx,
  p: {
    orgId: string;
    systemId: string;
    env: Env;
    name: string;
    integrationId: string | null;
    hosts: string[];
    last4: string;
    status: BindingStatus;
    checkCode: string | null;
    checkMessage: string | null;
    windowId: string | null;
    createdBy: string | null;
  },
): Promise<BindingRow> {
  const checked = p.status === "unchecked" ? null : new Date();
  const [r] = await tx`
    insert into platform.secret_bindings
      (org_id, system_id, env, name, integration_id, hosts, last4, status, check_code, check_message, checked_at,
       window_id, created_by)
    values (${p.orgId}, ${p.systemId}, ${p.env}, ${p.name}, ${p.integrationId},
            cast(cast(${jsonb(p.hosts)} as text) as jsonb), ${p.last4}, ${p.status}, ${p.checkCode},
            ${p.checkMessage}, ${checked}, ${p.windowId}, ${p.createdBy})
    on conflict (system_id, env, name) do update
       set integration_id = excluded.integration_id, hosts = excluded.hosts, last4 = excluded.last4,
           version = platform.secret_bindings.version + 1, status = excluded.status,
           check_code = excluded.check_code, check_message = excluded.check_message, checked_at = excluded.checked_at,
           window_id = excluded.window_id, created_by = excluded.created_by, rotated_at = pg_catalog.now()
    returning *`;
  return toBinding(r as Record<string, unknown>);
}

/** The result of a re-check of the stored key. */
export async function setBindingCheck(
  tx: Tx,
  p: {
    systemId: string;
    env: Env;
    name: string;
    status: BindingStatus;
    code: string | null;
    message: string | null;
  },
): Promise<BindingRow | null> {
  const [r] = await tx`
    update platform.secret_bindings
       set status = ${p.status}, check_code = ${p.code}, check_message = ${p.message},
           checked_at = case when ${p.status} = 'unchecked' then null else pg_catalog.now() end
     where system_id = ${p.systemId} and env = ${p.env} and name = ${p.name}
    returning *`;
  return r ? toBinding(r) : null;
}

export async function deleteBinding(tx: Tx, systemId: string, env: Env, name: string): Promise<boolean> {
  const rows = await tx`
    delete from platform.secret_bindings
     where system_id = ${systemId} and env = ${env} and name = ${name} returning name`;
  return rows.length === 1;
}

/** Is a value of secret://name set for the system (secrets_refs metadata; the value is never read)? */
export async function secretRefExists(
  sql: postgres.Sql | Tx,
  systemId: string,
  name: string,
  env?: Env,
): Promise<boolean> {
  const rows = env
    ? await sql`select 1 from platform.secrets_refs r where r.system_id = ${systemId} and r.name = ${name} and r.env = ${env}`
    : await sql`select 1 from platform.secrets_refs r where r.system_id = ${systemId} and r.name = ${name}`;
  return rows.length > 0;
}
