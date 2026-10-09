// Rows of the agent for compatible repositories (V3-32, migration 0044): every statement runs in a transaction scoped to
// the org of its rows (orgTx of the repository sync, RLS FORCE). Only the task worker reads across orgs — the due tasks
// — under wizard.repo_dispatch = 'on' in a READ ONLY transaction (dispatchRead).
import { type Kysely, type RawBuilder, sql, type Transaction } from "kysely";
import { type DB, json } from "../db/index.js";
import { dispatchRead, orgTx } from "../git-sync/store.js";

export { dispatchRead, orgTx };

type Q = Kysely<DB> | Transaction<DB>;

export type AgentRepoStatus = "pending" | "checking" | "ready" | "incompatible" | "unchecked" | "error";

export interface AgentRepoRow {
  id: string;
  org_id: string;
  provider: "github" | "gitlab";
  status: AgentRepoStatus;
  host_url: string;
  repo_path: string | null;
  repo_id: string | null;
  installation_id: string | null;
  default_branch: string | null;
  clone_url: string | null;
  web_url: string | null;
  secret_ref: string;
  ciphertext: string | null;
  wrapped_dek: string | null;
  kek_backend: "local" | "openbao" | null;
  kek_name: string | null;
  head_oid: string | null;
  compat: Record<string, unknown> | null;
  checked_at: Date | null;
  rules_pr_url: string | null;
  last_error_code: string | null;
  last_error_ru: string | null;
  connected_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export type TaskKind = "check" | "rules" | "change";
export type TaskStatus = "queued" | "running" | "done" | "failed";

export interface AgentTaskRow {
  id: string;
  org_id: string;
  repo_id: string;
  kind: TaskKind;
  status: TaskStatus;
  task_ru: string | null;
  base_oid: string | null;
  head_oid: string | null;
  branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  draft: boolean;
  result: Record<string, unknown>;
  credits_milli: string;
  error_code: string | null;
  error_ru: string | null;
  attempts: number;
  next_attempt_at: Date;
  locked_until: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

// ---- repositories ----

export async function agentRepoById(
  q: Q,
  id: string,
  o: { lock?: boolean } = {},
): Promise<AgentRepoRow | null> {
  const { rows } = await sql<AgentRepoRow>`
    select r.* from platform.agent_repos as r where r.id = ${id} ${o.lock ? sql`for update` : sql``}`.execute(
    q,
  );
  return rows[0] ?? null;
}

export async function agentReposOf(q: Q, orgId: string): Promise<AgentRepoRow[]> {
  const { rows } = await sql<AgentRepoRow>`
    select r.* from platform.agent_repos as r where r.org_id = ${orgId} order by r.created_at desc limit 50`.execute(
    q,
  );
  return rows;
}

const REPO_COLUMNS = new Set([
  "status",
  "repo_path",
  "repo_id",
  "installation_id",
  "default_branch",
  "clone_url",
  "web_url",
  "ciphertext",
  "wrapped_dek",
  "kek_backend",
  "kek_name",
  "head_oid",
  "compat",
  "checked_at",
  "rules_pr_url",
  "last_error_code",
  "last_error_ru",
]);

export type AgentRepoPatch = Partial<
  Omit<AgentRepoRow, "id" | "org_id" | "provider" | "host_url" | "secret_ref">
>;

export async function updateAgentRepo(q: Q, id: string, patch: AgentRepoPatch): Promise<void> {
  const sets: RawBuilder<unknown>[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!REPO_COLUMNS.has(k)) throw new Error(`agent repo: column ${k}`);
    sets.push(
      k === "compat" ? sql`compat = ${v === null ? null : json(v)}` : sql`${sql.ref(k)} = ${v ?? null}`,
    );
  }
  if (!sets.length) return;
  sets.push(sql`updated_at = pg_catalog.now()`);
  await sql`update platform.agent_repos set ${sql.join(sets)} where id = ${id}`.execute(q);
}

export async function insertAgentRepo(
  q: Q,
  r: Pick<AgentRepoRow, "id" | "org_id" | "provider" | "host_url" | "secret_ref" | "connected_by"> &
    AgentRepoPatch,
): Promise<void> {
  await sql`
    insert into platform.agent_repos (id, org_id, provider, host_url, secret_ref, connected_by)
    values (${r.id}, ${r.org_id}, ${r.provider}, ${r.host_url}, ${r.secret_ref}, ${r.connected_by})`.execute(
    q,
  );
  const { id, org_id, provider, host_url, secret_ref, connected_by, ...rest } = r;
  await updateAgentRepo(q, id, rest);
}

export async function deleteAgentRepo(q: Q, id: string): Promise<void> {
  await sql`delete from platform.agent_repos where id = ${id}`.execute(q);
}

// ---- tasks ----

export async function taskById(q: Q, id: string): Promise<AgentTaskRow | null> {
  const { rows } = await sql<AgentTaskRow>`
    select t.* from platform.agent_repo_tasks as t where t.id = ${id}`.execute(q);
  return rows[0] ?? null;
}

export async function tasksOf(q: Q, repoId: string, limit = 10): Promise<AgentTaskRow[]> {
  const { rows } = await sql<AgentTaskRow>`
    select t.* from platform.agent_repo_tasks as t where t.repo_id = ${repoId}
     order by t.created_at desc, t.id limit ${limit}`.execute(q);
  return rows;
}

/** Queues a task; a check or rules task already waiting or running is kept (one per repository). */
export async function insertTask(
  q: Q,
  t: {
    orgId: string;
    repoId: string;
    kind: TaskKind;
    text?: string | null;
    userId?: string | null;
    at?: Date;
  },
): Promise<string | null> {
  const { rows } = await sql<{ id: string }>`
    insert into platform.agent_repo_tasks (org_id, repo_id, kind, task_ru, created_by, next_attempt_at)
    values (${t.orgId}, ${t.repoId}, ${t.kind}, ${t.text ?? null}, ${t.userId ?? null}, ${t.at ?? new Date()})
    on conflict (repo_id, kind) where status in ('queued','running') and kind in ('check','rules') do nothing
    returning id`.execute(q);
  return rows[0]?.id ?? null;
}

const TASK_COLUMNS = new Set([
  "status",
  "base_oid",
  "head_oid",
  "branch",
  "pr_number",
  "pr_url",
  "draft",
  "result",
  "credits_milli",
  "error_code",
  "error_ru",
  "attempts",
  "next_attempt_at",
  "locked_until",
]);

export type TaskPatch = Partial<Omit<AgentTaskRow, "credits_milli">> & { credits_milli?: number };

export async function updateTask(q: Q, id: string, patch: TaskPatch): Promise<void> {
  const sets: RawBuilder<unknown>[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!TASK_COLUMNS.has(k)) throw new Error(`agent task: column ${k}`);
    sets.push(k === "result" ? sql`result = ${json(v)}` : sql`${sql.ref(k)} = ${v ?? null}`);
  }
  if (!sets.length) return;
  sets.push(sql`updated_at = pg_catalog.now()`);
  await sql`update platform.agent_repo_tasks set ${sql.join(sets)} where id = ${id}`.execute(q);
}

/** Due tasks across orgs (dispatch read): queued and due, or running with an expired lease (a crashed worker). */
export async function dueTasks(
  db: Kysely<DB>,
  now: Date,
  limit: number,
): Promise<{ id: string; org_id: string; repo_id: string }[]> {
  return dispatchRead(db, async (trx) => {
    const { rows } = await sql<{ id: string; org_id: string; repo_id: string }>`
      select t.id, t.org_id, t.repo_id from platform.agent_repo_tasks as t
       where (t.status = 'queued' and t.next_attempt_at <= ${now})
          or (t.status = 'running' and t.locked_until < ${now})
       order by t.next_attempt_at, t.created_at limit ${limit}`.execute(trx);
    return rows;
  });
}

/** Claims a task under the repository row lock — only when no other task of the repository runs. */
export async function claimTask(
  db: Kysely<DB>,
  orgId: string,
  taskId: string,
  repoId: string,
  now: Date,
  leaseMs: number,
): Promise<AgentTaskRow | null> {
  return orgTx(db, orgId, async (trx) => {
    if (!(await agentRepoById(trx, repoId, { lock: true }))) return null;
    const until = new Date(now.getTime() + leaseMs);
    const { rows } = await sql<AgentTaskRow>`
      update platform.agent_repo_tasks as t
         set status = 'running', locked_until = ${until}, attempts = t.attempts + 1, updated_at = pg_catalog.now()
       where t.id = ${taskId}
         and ((t.status = 'queued' and t.next_attempt_at <= ${now}) or (t.status = 'running' and t.locked_until < ${now}))
         and not exists (
           select 1 from platform.agent_repo_tasks as r
            where r.repo_id = t.repo_id and r.id <> t.id and r.status = 'running' and r.locked_until >= ${now})
      returning t.*`.execute(trx);
    return rows[0] ?? null;
  });
}
