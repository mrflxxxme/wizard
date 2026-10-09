// Rows of the repository sync (V3-31, migration 0043): every statement runs in a transaction scoped to the org of its rows
// (pg_catalog.set_config('wizard.org_id', …, true), RLS FORCE). Only two reads cross orgs — the webhook router and the
// queue worker finding their link or due jobs — under wizard.repo_dispatch = 'on' in a READ ONLY transaction.
import { type Kysely, type RawBuilder, sql, type Transaction } from "kysely";
import { type DB, json } from "../db/index.js";

type Q = Kysely<DB> | Transaction<DB>;

export type Provider = "github" | "gitlab";
export type LinkStatus = "pending" | "active" | "paused" | "error";

export interface LinkRow {
  id: string;
  org_id: string;
  system_id: string;
  provider: Provider;
  status: LinkStatus;
  host_url: string;
  repo_path: string | null;
  repo_id: string | null;
  installation_id: string | null;
  default_branch: string | null;
  clone_url: string | null;
  web_url: string | null;
  auto_merge: boolean;
  secret_ref: string;
  ciphertext: string | null;
  wrapped_dek: string | null;
  kek_backend: "local" | "openbao" | null;
  kek_name: string | null;
  remote_head_oid: string | null;
  remote_head_revision: number | null;
  last_pushed_revision: number;
  last_reconcile_at: Date | null;
  last_sync_at: Date | null;
  last_error_code: string | null;
  last_error_ru: string | null;
  connected_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export type PrState = "open" | "merged" | "closed" | "superseded" | "direct";

export interface PrRow {
  id: string;
  org_id: string;
  system_id: string;
  link_id: string;
  revision: number;
  branch: string;
  head_oid: string;
  base_oid: string | null;
  number: number | null;
  url: string | null;
  state: PrState;
  /** gate key → {state, id (GitHub check run), title} as posted last. */
  checks: Record<string, { state: string; id: string | null; title: string }>;
  body_sha256: string | null;
  merged_at: Date | null;
  merge_oid: string | null;
  created_at: Date;
  updated_at: Date;
}

export type ImportStatus = "pending" | "noop" | "imported" | "rejected";

export interface ImportRow {
  id: string;
  link_id: string;
  head_oid: string;
  source: "webhook" | "reconcile" | "merge";
  pr_number: number | null;
  status: ImportStatus;
  base_revision: number | null;
  revision: number | null;
  reason_code: string | null;
  reason_ru: string | null;
  details: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/** pr_preview — V3-32: the preview of a developer's open PR (migration 0044). */
export type JobKind = "push" | "statuses" | "import" | "reconcile" | "pr_preview";

export type PreviewStatus = "pending" | "passed" | "failed" | "rejected" | "noop" | "closed";

/** V3-32: the preview of a developer's PR before its merge (platform.system_repo_pr_previews, migration 0044). */
export interface PreviewRow {
  id: string;
  link_id: string;
  number: number;
  branch: string | null;
  url: string | null;
  head_oid: string;
  status: PreviewStatus;
  base_revision: number | null;
  reason_code: string | null;
  reason_ru: string | null;
  /** level (G0, G1, G2, preview) → {state, title} as posted to the PR head. */
  checks: Record<string, { state: string; title: string }>;
  details: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface JobRow {
  id: string;
  org_id: string;
  system_id: string;
  link_id: string;
  kind: JobKind;
  dedupe_key: string;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "done" | "dead";
  attempts: number;
  next_attempt_at: Date;
  locked_until: Date | null;
  last_error_code: string | null;
  last_error_ru: string | null;
  created_at: Date;
}

/** Runs fn in a transaction scoped to the org (RLS of platform.system_repo_*). */
export function orgTx<T>(
  db: Kysely<DB>,
  orgId: string,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select pg_catalog.set_config('wizard.org_id', ${orgId}, true)`.execute(trx);
    return fn(trx);
  });
}

/** Cross-org routing read (webhooks, the queue): READ ONLY, links and jobs only (their dispatch policies). */
export function dispatchRead<T>(db: Kysely<DB>, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`set transaction read only`.execute(trx);
    await sql`select pg_catalog.set_config('wizard.repo_dispatch', 'on', true)`.execute(trx);
    return fn(trx);
  });
}

// ---- links ----

export async function linkOfSystem(q: Q, systemId: string): Promise<LinkRow | null> {
  const { rows } = await sql<LinkRow>`
    select l.* from platform.system_repo_links as l where l.system_id = ${systemId}`.execute(q);
  return rows[0] ?? null;
}

export async function linkById(q: Q, id: string, o: { lock?: boolean } = {}): Promise<LinkRow | null> {
  const { rows } = await sql<LinkRow>`
    select l.* from platform.system_repo_links as l where l.id = ${id} ${o.lock ? sql`for update` : sql``}`.execute(
    q,
  );
  return rows[0] ?? null;
}

const LINK_COLUMNS = new Set([
  "status",
  "host_url",
  "repo_path",
  "repo_id",
  "installation_id",
  "default_branch",
  "clone_url",
  "web_url",
  "auto_merge",
  "ciphertext",
  "wrapped_dek",
  "kek_backend",
  "kek_name",
  "remote_head_oid",
  "remote_head_revision",
  "last_pushed_revision",
  "last_reconcile_at",
  "last_sync_at",
  "last_error_code",
  "last_error_ru",
  "connected_by",
]);

export type LinkPatch = Partial<
  Omit<LinkRow, "id" | "org_id" | "system_id" | "provider" | "secret_ref" | "created_at" | "updated_at">
>;

export async function updateLink(q: Q, id: string, patch: LinkPatch): Promise<void> {
  const sets: RawBuilder<unknown>[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!LINK_COLUMNS.has(k)) throw new Error(`repo link: column ${k}`);
    sets.push(sql`${sql.ref(k)} = ${v ?? null}`);
  }
  if (!sets.length) return;
  sets.push(sql`updated_at = pg_catalog.now()`);
  await sql`update platform.system_repo_links set ${sql.join(sets)} where id = ${id}`.execute(q);
}

export async function insertLink(
  q: Q,
  r: Pick<LinkRow, "id" | "org_id" | "system_id" | "provider" | "host_url" | "secret_ref" | "connected_by"> &
    LinkPatch,
): Promise<void> {
  await sql`
    insert into platform.system_repo_links (id, org_id, system_id, provider, host_url, secret_ref, connected_by)
    values (${r.id}, ${r.org_id}, ${r.system_id}, ${r.provider}, ${r.host_url}, ${r.secret_ref}, ${r.connected_by})`.execute(
    q,
  );
  const { id, org_id, system_id, provider, host_url, secret_ref, connected_by, ...rest } = r;
  await updateLink(q, id, rest);
}

export async function deleteLink(q: Q, id: string): Promise<void> {
  await sql`delete from platform.system_repo_links where id = ${id}`.execute(q);
}

// ---- PRs ----

export async function prOfRevision(q: Q, linkId: string, revision: number): Promise<PrRow | null> {
  const { rows } = await sql<PrRow>`
    select p.* from platform.system_repo_prs as p where p.link_id = ${linkId} and p.revision = ${revision}`.execute(
    q,
  );
  return rows[0] ?? null;
}

export async function prByNumber(q: Q, linkId: string, number: number): Promise<PrRow | null> {
  const { rows } = await sql<PrRow>`
    select p.* from platform.system_repo_prs as p where p.link_id = ${linkId} and p.number = ${number}
     order by p.revision desc limit 1`.execute(q);
  return rows[0] ?? null;
}

export async function prsOf(
  q: Q,
  linkId: string,
  o: { states?: PrState[]; limit?: number } = {},
): Promise<PrRow[]> {
  const { rows } = await sql<PrRow>`
    select p.* from platform.system_repo_prs as p
     where p.link_id = ${linkId} ${o.states?.length ? sql`and p.state in (${sql.join(o.states)})` : sql``}
     order by p.revision desc limit ${o.limit ?? 50}`.execute(q);
  return rows;
}

export async function upsertPr(
  q: Q,
  r: Pick<
    PrRow,
    | "org_id"
    | "system_id"
    | "link_id"
    | "revision"
    | "branch"
    | "head_oid"
    | "base_oid"
    | "number"
    | "url"
    | "state"
  >,
): Promise<void> {
  await sql`
    insert into platform.system_repo_prs (org_id, system_id, link_id, revision, branch, head_oid, base_oid, number, url, state)
    values (${r.org_id}, ${r.system_id}, ${r.link_id}, ${r.revision}, ${r.branch}, ${r.head_oid}, ${r.base_oid},
            ${r.number}, ${r.url}, ${r.state})
    on conflict (link_id, revision) do update set
      branch = excluded.branch, head_oid = excluded.head_oid, base_oid = excluded.base_oid, number = excluded.number,
      url = excluded.url, state = excluded.state, updated_at = pg_catalog.now()`.execute(q);
}

export async function updatePrRow(
  q: Q,
  id: string,
  patch: Partial<Pick<PrRow, "state" | "checks" | "body_sha256" | "merged_at" | "merge_oid">>,
): Promise<void> {
  const sets: RawBuilder<unknown>[] = [];
  if (patch.state !== undefined) sets.push(sql`state = ${patch.state}`);
  if (patch.checks !== undefined) sets.push(sql`checks = ${json(patch.checks)}`);
  if (patch.body_sha256 !== undefined) sets.push(sql`body_sha256 = ${patch.body_sha256}`);
  if (patch.merged_at !== undefined) sets.push(sql`merged_at = ${patch.merged_at}`);
  if (patch.merge_oid !== undefined) sets.push(sql`merge_oid = ${patch.merge_oid}`);
  if (!sets.length) return;
  sets.push(sql`updated_at = pg_catalog.now()`);
  await sql`update platform.system_repo_prs set ${sql.join(sets)} where id = ${id}`.execute(q);
}

// ---- imports ----

export async function importOfHead(q: Q, linkId: string, head: string): Promise<ImportRow | null> {
  const { rows } = await sql<ImportRow>`
    select i.* from platform.system_repo_imports as i where i.link_id = ${linkId} and i.head_oid = ${head}`.execute(
    q,
  );
  return rows[0] ?? null;
}

export async function importsOf(q: Q, linkId: string, limit = 20): Promise<ImportRow[]> {
  const { rows } = await sql<ImportRow>`
    select i.* from platform.system_repo_imports as i where i.link_id = ${linkId}
     order by i.created_at desc limit ${limit}`.execute(q);
  return rows;
}

export async function saveImport(
  q: Q,
  r: Pick<
    ImportRow,
    | "link_id"
    | "head_oid"
    | "source"
    | "pr_number"
    | "status"
    | "base_revision"
    | "revision"
    | "reason_code"
    | "reason_ru"
    | "details"
  > & {
    org_id: string;
    system_id: string;
  },
): Promise<void> {
  await sql`
    insert into platform.system_repo_imports
      (org_id, system_id, link_id, head_oid, source, pr_number, status, base_revision, revision, reason_code, reason_ru, details)
    values (${r.org_id}, ${r.system_id}, ${r.link_id}, ${r.head_oid}, ${r.source}, ${r.pr_number}, ${r.status},
            ${r.base_revision}, ${r.revision}, ${r.reason_code}, ${r.reason_ru}, ${json(r.details)})
    on conflict (link_id, head_oid) do update set
      status = excluded.status, base_revision = excluded.base_revision, revision = excluded.revision,
      reason_code = excluded.reason_code, reason_ru = excluded.reason_ru, details = excluded.details,
      pr_number = coalesce(excluded.pr_number, platform.system_repo_imports.pr_number), updated_at = pg_catalog.now()`.execute(
    q,
  );
}

// ---- PR previews (V3-32) ----

export async function previewOf(q: Q, linkId: string, number: number): Promise<PreviewRow | null> {
  const { rows } = await sql<PreviewRow>`
    select v.* from platform.system_repo_pr_previews as v where v.link_id = ${linkId} and v.number = ${number}`.execute(
    q,
  );
  return rows[0] ?? null;
}

export async function previewsOf(q: Q, linkId: string, limit = 10): Promise<PreviewRow[]> {
  const { rows } = await sql<PreviewRow>`
    select v.* from platform.system_repo_pr_previews as v where v.link_id = ${linkId}
     order by v.updated_at desc limit ${limit}`.execute(q);
  return rows;
}

export async function savePreview(
  q: Q,
  r: Pick<PreviewRow, "link_id" | "number" | "head_oid" | "status"> &
    Partial<
      Pick<
        PreviewRow,
        "branch" | "url" | "base_revision" | "reason_code" | "reason_ru" | "checks" | "details"
      >
    > & {
      org_id: string;
      system_id: string;
    },
): Promise<void> {
  await sql`
    insert into platform.system_repo_pr_previews
      (org_id, system_id, link_id, number, branch, url, head_oid, status, base_revision, reason_code, reason_ru, checks, details)
    values (${r.org_id}, ${r.system_id}, ${r.link_id}, ${r.number}, ${r.branch ?? null}, ${r.url ?? null}, ${r.head_oid},
            ${r.status}, ${r.base_revision ?? null}, ${r.reason_code ?? null}, ${r.reason_ru ?? null},
            ${json(r.checks ?? {})}, ${json(r.details ?? {})})
    on conflict (link_id, number) do update set
      branch = coalesce(excluded.branch, platform.system_repo_pr_previews.branch),
      url = coalesce(excluded.url, platform.system_repo_pr_previews.url),
      head_oid = excluded.head_oid, status = excluded.status, base_revision = excluded.base_revision,
      reason_code = excluded.reason_code, reason_ru = excluded.reason_ru, checks = excluded.checks,
      details = excluded.details, updated_at = pg_catalog.now()`.execute(q);
}

/** A preview that could not be made (the provider down after every attempt): failed with the reason. */
export async function failPreview(
  q: Q,
  linkId: string,
  number: number,
  code: string,
  reason_ru: string,
): Promise<void> {
  if (!Number.isInteger(number)) return;
  await sql`update platform.system_repo_pr_previews
               set status = 'failed', reason_code = ${code}, reason_ru = ${reason_ru.slice(0, 2000)},
                   updated_at = pg_catalog.now()
             where link_id = ${linkId} and number = ${number} and status = 'pending'`.execute(q);
}

export async function closePreview(q: Q, linkId: string, number: number): Promise<void> {
  await sql`update platform.system_repo_pr_previews set status = 'closed', updated_at = pg_catalog.now()
             where link_id = ${linkId} and number = ${number}`.execute(q);
}

// ---- jobs ----

/** Queues a job; a waiting job with the same key takes the new payload and the earlier due time (coalescing). */
export async function enqueue(
  q: Q,
  j: {
    orgId: string;
    systemId: string;
    linkId: string;
    kind: JobKind;
    key: string;
    payload?: Record<string, unknown>;
    at?: Date;
  },
): Promise<void> {
  const at = j.at ?? new Date();
  await sql`
    insert into platform.system_repo_jobs (org_id, system_id, link_id, kind, dedupe_key, payload, next_attempt_at)
    values (${j.orgId}, ${j.systemId}, ${j.linkId}, ${j.kind}, ${j.key}, ${json(j.payload ?? {})}, ${at})
    on conflict (link_id, dedupe_key) where status = 'queued' do update set
      payload = excluded.payload,
      next_attempt_at = case when platform.system_repo_jobs.attempts > 0
        then platform.system_repo_jobs.next_attempt_at
        else least(platform.system_repo_jobs.next_attempt_at, excluded.next_attempt_at) end,
      updated_at = pg_catalog.now()`.execute(q);
}

/** Due jobs across orgs (dispatch read): queued and due, or running with an expired lease (a crashed worker). */
export async function dueJobs(
  db: Kysely<DB>,
  now: Date,
  limit: number,
): Promise<{ id: string; org_id: string; link_id: string }[]> {
  return dispatchRead(db, async (trx) => {
    const { rows } = await sql<{ id: string; org_id: string; link_id: string }>`
      select j.id, j.org_id, j.link_id from platform.system_repo_jobs as j
       where (j.status = 'queued' and j.next_attempt_at <= ${now})
          or (j.status = 'running' and j.locked_until < ${now})
       order by j.next_attempt_at limit ${limit}`.execute(trx);
    return rows;
  });
}

/**
 * Claims one job for this worker: under the link row lock, only when no other job of the link runs (one job per link at
 * a time, so a push and an import never interleave). Returns the job or null (taken, or its link busy).
 */
export async function claimJob(
  db: Kysely<DB>,
  orgId: string,
  jobId: string,
  linkId: string,
  now: Date,
  leaseMs: number,
): Promise<JobRow | null> {
  return orgTx(db, orgId, async (trx) => {
    if (!(await linkById(trx, linkId, { lock: true }))) return null;
    const until = new Date(now.getTime() + leaseMs);
    const { rows } = await sql<JobRow>`
      update platform.system_repo_jobs as j
         set status = 'running', locked_until = ${until}, attempts = j.attempts + 1, updated_at = pg_catalog.now()
       where j.id = ${jobId}
         and ((j.status = 'queued' and j.next_attempt_at <= ${now}) or (j.status = 'running' and j.locked_until < ${now}))
         and not exists (
           select 1 from platform.system_repo_jobs as r
            where r.link_id = j.link_id and r.id <> j.id and r.status = 'running' and r.locked_until >= ${now})
      returning j.*`.execute(trx);
    return rows[0] ?? null;
  });
}

export type JobOutcome =
  | { kind: "done" }
  | { kind: "wait"; at: Date }
  | { kind: "retry"; at: Date; code: string; message_ru: string }
  | { kind: "dead"; code: string; message_ru: string };

/** Ends a run of a job. A retry or wait that meets a newer waiting job of the same key gives way to it. */
export async function finishJob(q: Q, job: JobRow, out: JobOutcome): Promise<void> {
  if (out.kind === "done") {
    await sql`update platform.system_repo_jobs set status = 'done', locked_until = null, updated_at = pg_catalog.now()
               where id = ${job.id}`.execute(q);
    return;
  }
  if (out.kind === "dead") {
    await sql`update platform.system_repo_jobs set status = 'dead', locked_until = null, last_error_code = ${out.code},
               last_error_ru = ${out.message_ru}, updated_at = pg_catalog.now() where id = ${job.id}`.execute(
      q,
    );
    return;
  }
  const { rows } = await sql<{ id: string }>`
    update platform.system_repo_jobs as j
       set status = 'queued', locked_until = null, next_attempt_at = ${out.at},
           attempts = ${out.kind === "wait" ? sql`greatest(j.attempts - 1, 0)` : sql`j.attempts`},
           last_error_code = ${out.kind === "retry" ? out.code : null},
           last_error_ru = ${out.kind === "retry" ? out.message_ru : null},
           updated_at = pg_catalog.now()
     where j.id = ${job.id}
       and not exists (select 1 from platform.system_repo_jobs as w
                        where w.link_id = j.link_id and w.dedupe_key = j.dedupe_key and w.status = 'queued')
    returning j.id`.execute(q);
  if (!rows.length)
    await sql`update platform.system_repo_jobs set status = 'done', locked_until = null, updated_at = pg_catalog.now()
               where id = ${job.id}`.execute(q);
}

export async function jobsOf(q: Q, linkId: string, limit = 20): Promise<JobRow[]> {
  const { rows } = await sql<JobRow>`
    select j.* from platform.system_repo_jobs as j where j.link_id = ${linkId}
     order by j.created_at desc limit ${limit}`.execute(q);
  return rows;
}

/** Puts dead jobs of a link back in the queue (the owner's «Повторить»). */
export async function requeueDead(q: Q, linkId: string, now: Date): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    update platform.system_repo_jobs as j set status = 'queued', attempts = 0, next_attempt_at = ${now},
           updated_at = pg_catalog.now()
     where j.link_id = ${linkId} and j.status = 'dead'
       and not exists (select 1 from platform.system_repo_jobs as w
                        where w.link_id = j.link_id and w.dedupe_key = j.dedupe_key and w.status = 'queued')
    returning j.id`.execute(q);
  return rows.length;
}

// ---- deliveries ----

/** Records a webhook delivery; false — it was seen before (a redelivery). */
export async function recordDelivery(
  q: Q,
  r: { orgId: string; linkId: string; deliveryId: string; event: string },
): Promise<boolean> {
  const { rows } = await sql<{ link_id: string }>`
    insert into platform.system_repo_deliveries (org_id, link_id, delivery_id, event)
    values (${r.orgId}, ${r.linkId}, ${r.deliveryId}, ${r.event})
    on conflict (link_id, delivery_id) do nothing returning link_id`.execute(q);
  return rows.length > 0;
}

/** Housekeeping of a link: finished jobs after 7 days, deliveries after 30. */
export async function prune(q: Q, linkId: string, now: Date): Promise<void> {
  await sql`delete from platform.system_repo_jobs where link_id = ${linkId} and status = 'done'
             and updated_at < ${new Date(now.getTime() - 7 * 86_400_000)}`.execute(q);
  await sql`delete from platform.system_repo_deliveries where link_id = ${linkId}
             and created_at < ${new Date(now.getTime() - 30 * 86_400_000)}`.execute(q);
  await sql`delete from platform.system_repo_pr_previews where link_id = ${linkId} and status = 'closed'
             and updated_at < ${new Date(now.getTime() - 30 * 86_400_000)}`.execute(q);
}
