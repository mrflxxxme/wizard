// The sync flows of a link (V3-31, D77 (3)) — each is one job of the retry queue and safe to repeat:
// push      — the latest revision goes to branch wizard/<slug>/<rev> as a PR to the default branch (the first one into an
//             empty repository goes straight to it); older open Wizard PRs are closed as replaced;
// statuses  — G0, G1, G2 and the techreview of the revision as check runs / commit statuses, the PR description, and the
//             auto-merge (owner's choice) once everything is green;
// import    — the default branch head (a merged PR or a push of the client's developers) is fetched, its changes since the
//             synced base are checked (compatibility, conflicts with Wizard, spec), gated G0 → G1 → G2 and become a new
//             revision; a refusal is recorded with a Russian reason and shown on the head commit;
// reconcile — PR states and the default branch head without a webhook (missed deliveries, outages), repository renames.

import { createHash } from "node:crypto";
import type { AppSpec } from "@wizard/appspec";
import { type Kysely, sql } from "kysely";
import type { DB } from "../db/index.js";
import { ensureRepo } from "../git/commit.js";
import type { TreeChange } from "../git/diff.js";
import {
  buildTrees,
  encodeCommit,
  type GitObject,
  makeObject,
  parseCommit,
  type Signature,
} from "../git/objects.js";
import {
  existingOids,
  findCommitRow,
  putObjects,
  readObject,
  readObjects,
  readTreeFlat,
} from "../git/store.js";
import { GitTransportError } from "../git/transport.js";
import { closureComplete, isAncestor, objectsToPush } from "../git/walk.js";
import { ACTIVE_STATUSES } from "../runs/queue.js";
import type { GateReport } from "../runs/types.js";
import { commitFilesRevision, loadSpec, lockSystem } from "../services/revisions.js";
import { conflicts, generatedEdits, importableChanges, importedSpec, incompatibilities } from "./compat.js";
import {
  apiOf,
  isImportablePath,
  isManagedPath,
  NeedsOwner,
  RetryLater,
  remoteOf,
  type SyncDeps,
  safeErr,
} from "./context.js";
import { allGreen, failedLine, revisionGateStatuses, settled } from "./gates.js";
import { ProviderError } from "./providers/http.js";
import type { RepoApi } from "./providers/types.js";
import {
  enqueue,
  importOfHead,
  type JobOutcome,
  type JobRow,
  type LinkRow,
  orgTx,
  type PrRow,
  prOfRevision,
  prsOf,
  saveImport,
  updateLink,
  updatePrRow,
  upsertPr,
} from "./store.js";
import { GATE_NAMES, PROVIDER_RU, syncRu } from "./texts.js";

type Q = Kysely<DB>;

/** Statuses of a PR are polled this often while a gate runs, for at most two days. */
const STATUS_POLL_MS = 30_000;
const STATUS_WINDOW_MS = 2 * 86_400_000;

export const branchOf = (slug: string, revision: number): string => `wizard/${slug}/${revision}`;

/** Stable address of a revision's preview (api.yaml getRepoSyncPreview): it opens the preview for a signed-in viewer. */
export const previewLink = (d: SyncDeps, systemId: string, revision: number): string =>
  `${d.config.platformOrigin}/api/v1/systems/${systemId}/repo-sync/preview/${revision}`;

const settingsLink = (d: SyncDeps, systemId: string) =>
  `${d.config.platformOrigin}/s/${systemId}/settings#repo`;

interface SystemRow {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  schema_key: string;
  draft_revision: number;
  preview_revision: number | null;
  deleted_at: Date | null;
}

async function systemOf(db: Q, id: string): Promise<SystemRow | null> {
  const { rows } = await sql<SystemRow>`
    select s.id, s.org_id, s.slug, s.name, s.schema_key, s.draft_revision, s.preview_revision, s.deleted_at
      from platform.systems as s where s.id = ${id}`.execute(db);
  return rows[0] ?? null;
}

/** A build, publish, rollback or table import holds the system (its lock or an active run). */
async function systemBusy(db: Q, systemId: string, now: Date): Promise<boolean> {
  const { rows } = await sql<{ n: number }>`
    select (select count(*) from platform.locks as l where l.system_id = ${systemId} and l.lease_until > ${now})
         + (select count(*) from platform.runs as r where r.system_id = ${systemId}
             and r.kind in ('build','publish','rollback','import_table') and r.status in (${sql.join([...ACTIVE_STATUSES])})) as n`.execute(
    db,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

async function commitTree(db: Q, systemId: string, oid: string) {
  const o = await readObject(db, systemId, oid);
  if (o?.type !== "commit") throw new Error(`git: commit ${oid} missing`);
  const commit = parseCommit(o.body);
  return { commit, flat: await readTreeFlat(db, systemId, commit.tree) };
}

/** Commits the remote is known to hold (for `have` lines and to leave objects out of a push). */
async function knownRemoteCommits(db: Q, link: LinkRow): Promise<string[]> {
  const prs = await prsOf(db, link.id, { limit: 20 });
  const candidates = [
    link.remote_head_oid,
    ...prs.map((p) => p.head_oid),
    ...prs.map((p) => p.merge_oid),
  ].filter((x): x is string => !!x);
  const have = await existingOids(db, link.system_id, candidates);
  return candidates.filter((c) => have.has(c));
}

/**
 * The commit a PR proposes: Wizard's files of W (the managed paths) next to the client's own files of the default
 * branch head H; parents [W, H] (so the merge base is H and the PR shows only Wizard's change), or [W] when H is already
 * in W's history. W itself when nothing would differ. Deterministic: the time is W's.
 */
export async function prCommit(
  db: Q,
  systemId: string,
  w: string,
  h: string | null,
  revision: number,
): Promise<string> {
  const W = await commitTree(db, systemId, w);
  if (!h) return w;
  const H = await commitTree(db, systemId, h);
  const files = new Map<string, { oid: string; mode: string }>();
  for (const [p, e] of W.flat) if (isManagedPath(p)) files.set(p, e);
  for (const [p, e] of H.flat) if (!isManagedPath(p)) files.set(p, e);
  const { root, trees } = buildTrees(files);
  const inHistory = await isAncestor(db, systemId, h, w);
  if (inHistory && root === W.commit.tree) return w;
  const sig: Signature = { ...W.commit.committer };
  const commit = makeObject(
    "commit",
    encodeCommit({
      tree: root,
      parents: inHistory ? [w] : [w, h],
      author: sig,
      committer: sig,
      message: `Wizard: ревизия ${revision} поверх основной ветки\n\nWizard-Revision: ${revision}\n`,
    }),
  );
  await putObjects(db, systemId, [...trees, commit]);
  return commit.oid;
}

/** List items of a Wizard commit message («- …» lines). */
const messageItems = (message: string): string[] =>
  message
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));

/** Description of a Wizard PR; `base` — the default branch head it was made on (a refused import there is named). */
async function prBody(
  d: SyncDeps,
  link: LinkRow,
  sys: SystemRow,
  revision: number,
  w: string,
  base: string | null,
) {
  const c = await readObject(d.db, sys.id, w);
  const items = c?.type === "commit" ? messageItems(parseCommit(c.body).message) : [];
  const gates = await revisionGateStatuses(d.db, sys.id, revision);
  const imp = base ? await orgTx(d.db, link.org_id, (trx) => importOfHead(trx, link.id, base)) : null;
  const revertsNote =
    base && imp?.status === "rejected" && imp.reason_ru ? syncRu.rejectedNote(base, imp.reason_ru) : null;
  return syncRu.prBody({
    systemName: sys.name,
    revision,
    items,
    gates,
    previewUrl: previewLink(d, sys.id, revision),
    autoMerge: link.auto_merge,
    revertsNote,
  });
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Fetches what the remote's `head` needs and we lack; true when the closure is complete afterwards. */
async function fetchHead(
  d: SyncDeps,
  link: LinkRow,
  remote: Awaited<ReturnType<typeof remoteOf>>,
  head: string,
): Promise<boolean> {
  if (await closureComplete(d.db, link.system_id, head)) return true;
  const haves = await knownRemoteCommits(d.db, link);
  const objects = await remote.fetch([head], haves, (oids) => readObjects(d.db, link.system_id, oids));
  await putObjects(d.db, link.system_id, objects);
  return closureComplete(d.db, link.system_id, head);
}

// ---- push ----

/**
 * `force` (after a refused import): the current revision goes out again on top of the new default branch head, so the
 * Wizard PR shows — and on merge undoes — what Wizard did not take.
 */
export async function pushFlow(
  d: SyncDeps,
  link: LinkRow,
  job?: Pick<JobRow, "payload">,
): Promise<JobOutcome> {
  const now = d.now();
  const sys = await systemOf(d.db, link.system_id);
  if (!sys || sys.deleted_at || link.status !== "active") return { kind: "done" };
  const R = sys.draft_revision;
  const force = job?.payload.force === true;
  if (R < 1 || (R <= link.last_pushed_revision && !force)) return { kind: "done" };
  if (await systemBusy(d.db, sys.id, now)) return { kind: "wait", at: new Date(now.getTime() + 30_000) };
  if (await ensureRepo(d.db, d.blobs, sys.id))
    throw new RetryLater(
      "REPO_BEHIND",
      "Внутренний репозиторий системы ещё не догнал ревизии. Повторим автоматически",
    );
  const wRow = await findCommitRow(d.db, sys.id, { revision: R });
  if (!wRow) throw new RetryLater("REPO_BEHIND", "Коммит ревизии ещё не записан. Повторим автоматически");
  const api = apiOf(d, link);
  const remote = await remoteOf(d, link, api);
  const adv = await remote.receiveRefs();
  const defaultRef = `refs/heads/${link.default_branch}`;
  const H = adv.refs.get(defaultRef) ?? null;
  const remoteTips = [...adv.refs.values()];

  // The default branch moved since the last sync: its changes are imported (or refused) first, so a PR never undoes
  // changes nobody looked at.
  if (H && H !== link.remote_head_oid) {
    const imp = await orgTx(d.db, link.org_id, (trx) => importOfHead(trx, link.id, H));
    if (!imp || imp.status === "pending") {
      await orgTx(d.db, link.org_id, (trx) =>
        enqueue(trx, {
          orgId: link.org_id,
          systemId: sys.id,
          linkId: link.id,
          kind: "import",
          key: "import",
          payload: { source: "reconcile" },
        }),
      );
      return { kind: "wait", at: new Date(now.getTime() + 5_000) };
    }
  }

  if (!H) {
    // An empty repository: the system's source goes straight to the default branch (nothing to review yet).
    const objects = await objectsToPush(d.db, sys.id, wRow.oid, remoteTips);
    const res = await remote.push([{ ref: defaultRef, old: null, new: wRow.oid }], objects, adv);
    if (!res.ok)
      throw new RetryLater("PUSH_REJECTED", syncRu.errors.PUSH_REJECTED(PROVIDER_RU[link.provider]));
    await orgTx(d.db, link.org_id, async (trx) => {
      await upsertPr(trx, {
        org_id: link.org_id,
        system_id: sys.id,
        link_id: link.id,
        revision: R,
        branch: link.default_branch as string,
        head_oid: wRow.oid,
        base_oid: null,
        number: null,
        url: null,
        state: "direct",
      });
      await updateLink(trx, link.id, {
        remote_head_oid: wRow.oid,
        remote_head_revision: R,
        last_pushed_revision: R,
        last_sync_at: now,
        last_error_code: null,
        last_error_ru: null,
      });
      await enqueue(trx, {
        orgId: link.org_id,
        systemId: sys.id,
        linkId: link.id,
        kind: "statuses",
        key: "statuses",
        payload: { revision: R },
      });
    });
    return { kind: "done" };
  }

  if (!(await fetchHead(d, link, remote, H)))
    throw new RetryLater("FETCH_INCOMPLETE", syncRu.import.fetchIncomplete);
  const P = await prCommit(d.db, sys.id, wRow.oid, H, R);
  const pTree = parseCommit((await readObject(d.db, sys.id, P))?.body ?? Buffer.alloc(0)).tree;
  const hTree = (await commitTree(d.db, sys.id, H)).commit.tree;
  if (pTree === hTree) {
    // The default branch already has exactly this content (e.g. the client merged it by hand).
    await orgTx(d.db, link.org_id, (trx) =>
      updateLink(trx, link.id, {
        last_pushed_revision: R,
        remote_head_revision: R,
        last_sync_at: now,
        last_error_code: null,
        last_error_ru: null,
      }),
    );
    return { kind: "done" };
  }
  const branch = branchOf(sys.slug, R);
  const ref = `refs/heads/${branch}`;
  const old = adv.refs.get(ref) ?? null;
  if (old !== P) {
    const objects = await objectsToPush(d.db, sys.id, P, remoteTips);
    const res = await remote.push([{ ref, old, new: P }], objects, adv);
    if (!res.ok)
      throw new RetryLater("PUSH_REJECTED", syncRu.errors.PUSH_REJECTED(PROVIDER_RU[link.provider]));
  }
  const first = (await orgTx(d.db, link.org_id, (trx) => prsOf(trx, link.id, { limit: 1 }))).length === 0;
  const title = first ? syncRu.firstPrTitle(R) : syncRu.prTitle(R, wRow.subject);
  const body = await prBody(d, link, sys, R, wRow.oid, H);
  const found = await api.findPr(branch);
  // A branch may come back after its PR was merged or closed (a forced push): that one gets a new PR.
  const pr =
    found?.state === "open"
      ? found
      : await api.createPr({ branch, base: link.default_branch as string, title, body });
  await orgTx(d.db, link.org_id, async (trx) => {
    await upsertPr(trx, {
      org_id: link.org_id,
      system_id: sys.id,
      link_id: link.id,
      revision: R,
      branch,
      head_oid: P,
      base_oid: H,
      number: pr.number,
      url: pr.url,
      state: pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : "open",
    });
    const row = await prOfRevision(trx, link.id, R);
    if (row) await updatePrRow(trx, row.id, { body_sha256: sha256(body) });
  });

  // Older open Wizard PRs are replaced by this one: closed with a comment, their branches removed (best effort).
  const older = (await orgTx(d.db, link.org_id, (trx) => prsOf(trx, link.id, { states: ["open"] }))).filter(
    (p) => p.revision < R,
  );
  for (const p of older) {
    try {
      if (p.number) await api.closePr(p.number, syncRu.supersededComment(pr.url, R));
      const cur = adv.refs.get(`refs/heads/${p.branch}`);
      if (cur) await remote.push([{ ref: `refs/heads/${p.branch}`, old: cur, new: null }], [], adv);
    } catch (e) {
      d.log("git-sync: closing a replaced PR failed", safeErr(e));
    }
    await orgTx(d.db, link.org_id, (trx) => updatePrRow(trx, p.id, { state: "superseded" }));
  }
  await orgTx(d.db, link.org_id, async (trx) => {
    await updateLink(trx, link.id, {
      last_pushed_revision: R,
      last_sync_at: now,
      last_error_code: null,
      last_error_ru: null,
    });
    await enqueue(trx, {
      orgId: link.org_id,
      systemId: sys.id,
      linkId: link.id,
      kind: "statuses",
      key: "statuses",
      payload: { revision: R },
    });
  });
  return { kind: "done" };
}

// ---- statuses ----

export async function statusesFlow(d: SyncDeps, link: LinkRow, job: JobRow): Promise<JobOutcome> {
  const now = d.now();
  const revision = Number(job.payload.revision);
  if (!Number.isInteger(revision) || link.status === "pending") return { kind: "done" };
  const sys = await systemOf(d.db, link.system_id);
  const pr = await orgTx(d.db, link.org_id, (trx) => prOfRevision(trx, link.id, revision));
  if (!sys || sys.deleted_at || !pr || pr.state === "superseded" || pr.state === "closed")
    return { kind: "done" };
  const api = apiOf(d, link);
  const gates = await revisionGateStatuses(d.db, sys.id, revision);
  const checks = { ...pr.checks };
  for (const g of gates) {
    const prev = checks[g.key];
    if (prev && prev.state === g.state && prev.title === g.title) continue;
    const id = await api.setCheck(
      pr.head_oid,
      {
        name: g.name,
        state: g.state,
        title: g.title,
        summary: g.summary || g.title,
        detailsUrl: previewLink(d, sys.id, revision),
      },
      prev?.id ?? null,
    );
    checks[g.key] = { state: g.state, id, title: g.title };
    await orgTx(d.db, link.org_id, (trx) => updatePrRow(trx, pr.id, { checks }));
  }
  if (pr.state === "open" && pr.number) {
    const wRow = await findCommitRow(d.db, sys.id, { revision });
    if (wRow) {
      const body = await prBody(d, link, sys, revision, wRow.oid, pr.base_oid);
      if (sha256(body) !== pr.body_sha256) {
        await api.updatePr(pr.number, { body });
        await orgTx(d.db, link.org_id, (trx) => updatePrRow(trx, pr.id, { body_sha256: sha256(body) }));
      }
    }
  }
  if (!settled(gates)) {
    if (now.getTime() - pr.created_at.getTime() > STATUS_WINDOW_MS) return { kind: "done" };
    return { kind: "wait", at: new Date(now.getTime() + STATUS_POLL_MS) };
  }
  if (pr.state === "open" && pr.number && link.auto_merge && allGreen(gates)) {
    try {
      const r = await api.mergePr(pr.number, { sha: pr.head_oid, title: syncRu.mergeTitle(revision) });
      await orgTx(d.db, link.org_id, async (trx) => {
        await updatePrRow(trx, pr.id, { state: "merged", merged_at: now, merge_oid: r.sha });
        await enqueue(trx, {
          orgId: link.org_id,
          systemId: sys.id,
          linkId: link.id,
          kind: "import",
          key: "import",
          payload: { source: "merge", prNumber: pr.number },
        });
      });
    } catch (e) {
      if (!(e instanceof ProviderError) || e.retryable) throw e;
      // Not mergeable (conflict, branch protection): the owner decides; the PR stays open.
      await orgTx(d.db, link.org_id, (trx) =>
        updateLink(trx, link.id, {
          last_error_code: "AUTO_MERGE_FAILED",
          last_error_ru: `Автомерж PR #${pr.number} не удался${e.detail ? `: ${e.detail}` : ""}. Слейте PR вручную`,
        }),
      );
    }
  }
  return { kind: "done" };
}

// ---- import ----

interface ImportPayload {
  source?: "webhook" | "reconcile" | "merge";
  prNumber?: number;
  mergeSha?: string;
}

async function rejectImport(
  d: SyncDeps,
  link: LinkRow,
  api: RepoApi,
  head: string,
  a: {
    source: ImportPayload["source"];
    prNumber: number | null;
    base: number | null;
    code: string;
    reason: string;
    details?: Record<string, unknown>;
  },
): Promise<JobOutcome> {
  await orgTx(d.db, link.org_id, async (trx) => {
    await saveImport(trx, {
      org_id: link.org_id,
      system_id: link.system_id,
      link_id: link.id,
      head_oid: head,
      source: a.source ?? "webhook",
      pr_number: a.prNumber,
      status: "rejected",
      base_revision: a.base,
      revision: null,
      reason_code: a.code,
      reason_ru: a.reason.slice(0, 2000),
      details: a.details ?? {},
    });
    await updateLink(trx, link.id, { remote_head_oid: head, last_sync_at: d.now() });
    await enqueue(trx, {
      orgId: link.org_id,
      systemId: link.system_id,
      linkId: link.id,
      kind: "push",
      key: "push",
      payload: { force: true },
    });
  });
  // A repository with its own history before the first Wizard PR (NO_BASE) is the normal start, not a failure to show.
  if (a.code === "NO_BASE") return { kind: "done" };
  try {
    await api.setCheck(
      head,
      {
        name: GATE_NAMES.import,
        state: "failure",
        title: a.reason.slice(0, 200),
        summary: a.reason,
        detailsUrl: settingsLink(d, link.system_id),
      },
      null,
    );
  } catch (e) {
    d.log("git-sync: import check on the head failed", safeErr(e));
  }
  return { kind: "done" };
}

export async function importFlow(d: SyncDeps, link: LinkRow, job: JobRow): Promise<JobOutcome> {
  const now = d.now();
  const p = job.payload as ImportPayload;
  const sys = await systemOf(d.db, link.system_id);
  if (!sys || sys.deleted_at || link.status === "pending" || link.status === "paused")
    return { kind: "done" };
  const api = apiOf(d, link);
  const remote = await remoteOf(d, link, api);
  const refs = await remote.lsRefs();
  const head = refs.refs.get(`refs/heads/${link.default_branch}`);
  if (!head || head === link.remote_head_oid) return { kind: "done" };
  const done = await orgTx(d.db, link.org_id, (trx) => importOfHead(trx, link.id, head));
  if (done && done.status !== "pending") {
    await orgTx(d.db, link.org_id, (trx) =>
      updateLink(trx, link.id, {
        remote_head_oid: head,
        ...(done.status !== "rejected" ? { remote_head_revision: done.revision ?? done.base_revision } : {}),
      }),
    );
    return { kind: "done" };
  }
  if (!(await fetchHead(d, link, remote, head)))
    throw new RetryLater("FETCH_INCOMPLETE", syncRu.import.fetchIncomplete);

  // Which Wizard revision the head is based on: merged Wizard PRs (the webhook's PR, PR heads in the head's history,
  // the provider's word) and the last synced head.
  const prNumber = typeof p.prNumber === "number" ? p.prNumber : null;
  const open = await orgTx(d.db, link.org_id, (trx) => prsOf(trx, link.id, { states: ["open"] }));
  const merged: { row: PrRow; sha: string | null }[] = [];
  for (const row of open) {
    if (row.number === prNumber) merged.push({ row, sha: p.mergeSha ?? null });
    else if (await isAncestor(d.db, sys.id, row.head_oid, head)) merged.push({ row, sha: null });
  }
  if (merged.length)
    await orgTx(d.db, link.org_id, async (trx) => {
      for (const m of merged)
        await updatePrRow(trx, m.row.id, {
          state: "merged",
          merged_at: now,
          ...(m.sha ? { merge_oid: m.sha } : {}),
        });
    });
  const all = await orgTx(d.db, link.org_id, (trx) => prsOf(trx, link.id, { states: ["merged", "direct"] }));
  const base = Math.max(link.remote_head_revision ?? 0, ...all.map((r) => r.revision)) || null;
  const source = p.source ?? "webhook";
  const subject =
    parseCommit((await readObject(d.db, sys.id, head))?.body ?? Buffer.alloc(0)).message.split("\n")[0] ?? "";
  if (base === null)
    return rejectImport(d, link, api, head, {
      source,
      prNumber,
      base: null,
      code: "NO_BASE",
      reason: syncRu.import.noBase,
    });

  if (await ensureRepo(d.db, d.blobs, sys.id))
    throw new RetryLater(
      "REPO_BEHIND",
      "Внутренний репозиторий системы ещё не догнал ревизии. Повторим автоматически",
    );
  const baseRow = await findCommitRow(d.db, sys.id, { revision: base });
  const draftRow = await findCommitRow(d.db, sys.id, { revision: sys.draft_revision });
  if (!baseRow || !draftRow)
    throw new RetryLater("REPO_BEHIND", "Коммиты ревизий ещё не записаны. Повторим автоматически");
  const B = (await commitTree(d.db, sys.id, baseRow.oid)).flat;
  const D = (await commitTree(d.db, sys.id, draftRow.oid)).flat;
  const T = (await commitTree(d.db, sys.id, head)).flat;
  const prevHead =
    link.remote_head_oid &&
    (await existingOids(d.db, sys.id, [link.remote_head_oid])).has(link.remote_head_oid)
      ? (await commitTree(d.db, sys.id, link.remote_head_oid)).flat
      : null;
  const theirs = importableChanges(B, T);
  const warnings = generatedEdits(prevHead, T).length ? [syncRu.import.generatedIgnored] : [];
  if (theirs.length === 0) {
    await orgTx(d.db, link.org_id, async (trx) => {
      await saveImport(trx, {
        org_id: link.org_id,
        system_id: sys.id,
        link_id: link.id,
        head_oid: head,
        source,
        pr_number: prNumber,
        status: "noop",
        base_revision: base,
        revision: null,
        reason_code: null,
        reason_ru: null,
        details: { warnings },
      });
      await updateLink(trx, link.id, {
        remote_head_oid: head,
        remote_head_revision: base,
        last_sync_at: now,
        last_error_code: null,
        last_error_ru: null,
      });
    });
    return { kind: "done" };
  }

  const blobs = await readObjects(
    d.db,
    sys.id,
    theirs.filter((c) => c.newOid).map((c) => c.newOid as string),
  );
  const after = new Set([...D.keys()].filter(isImportablePath));
  for (const c of theirs) c.status === "deleted" ? after.delete(c.path) : after.add(c.path);
  const bad = incompatibilities(theirs, T, (oid) => blobs.get(oid)?.body, after.size);
  const details = { files: theirs.map((c) => ({ path: c.path, status: c.status })).slice(0, 200), warnings };
  if (bad.length)
    return rejectImport(d, link, api, head, {
      source,
      prNumber,
      base,
      code: "INCOMPATIBLE",
      reason: syncRu.import.incompatible(bad),
      details,
    });
  const clash = conflicts(theirs, importableChanges(B, D), D, T);
  if (clash.length)
    return rejectImport(d, link, api, head, {
      source,
      prNumber,
      base,
      code: "CONFLICT",
      reason: syncRu.import.conflict(clash, sys.draft_revision),
      details: { ...details, conflicts: clash },
    });
  let newSpec: AppSpec | null = null;
  const specChange = theirs.find((c: TreeChange) => c.path === "spec/appspec.json");
  if (specChange?.newOid) {
    const r = importedSpec(blobs.get(specChange.newOid)?.body ?? Buffer.alloc(0));
    if (!r.ok)
      return rejectImport(d, link, api, head, {
        source,
        prNumber,
        base,
        code: "SPEC_INVALID",
        reason: syncRu.import.badSpec(r.reasons),
        details,
      });
    newSpec = r.spec;
  }
  if (await systemBusy(d.db, sys.id, now))
    throw new RetryLater("SYSTEM_BUSY", syncRu.import.building, 60_000);
  if (!d.gates) throw new RetryLater("GATES_UNAVAILABLE", syncRu.import.noGates, 10 * 60_000);

  // The candidate: the draft's sources with the changes applied; G0 → G1 → G2 before anything is written.
  const sources = new Map<string, string>();
  const draftSrc = [...D].filter(([path]) => path.startsWith("ui/") || path.startsWith("functions/"));
  const draftBlobs = await readObjects(
    d.db,
    sys.id,
    draftSrc.map(([, e]) => e.oid),
  );
  for (const [path, e] of draftSrc)
    sources.set(path, (draftBlobs.get(e.oid)?.body ?? Buffer.alloc(0)).toString("utf8"));
  for (const c of theirs) {
    if (!(c.path.startsWith("ui/") || c.path.startsWith("functions/"))) continue;
    if (c.status === "deleted") sources.delete(c.path);
    else sources.set(c.path, (blobs.get(c.newOid as string)?.body ?? Buffer.alloc(0)).toString("utf8"));
  }
  const spec = newSpec ?? (await loadSpec(d.db, sys, sys.draft_revision));
  const prevSpec = sys.preview_revision !== null ? await loadSpec(d.db, sys, sys.preview_revision) : null;
  const reports: GateReport[] = [];
  for (const level of ["G0", "G1", "G2"] as const) {
    const report = {
      ...(await d.gates(level, {
        spec,
        prevSpec,
        specVersion: sys.draft_revision + 1,
        files: sources,
        env: "draft",
        systemKey: sys.schema_key,
        db: d.pg,
        milestone: d.config.milestone,
        slug: sys.slug,
      })),
      level,
    };
    reports.push(report);
    if (!report.passed)
      return rejectImport(d, link, api, head, {
        source,
        prNumber,
        base,
        code: "GATES_FAILED",
        reason: syncRu.import.gatesFailed(level, [failedLine(report).title]),
        details: { ...details, gates: reports.map((r) => ({ level: r.level, passed: r.passed })) },
      });
  }

  const key = `repo:${link.id}:${head}`.slice(0, 200);
  const summary = syncRu.import.summary(PROVIDER_RU[link.provider], subject, prNumber);
  const draftBefore = sys.draft_revision;
  const revision = await d.db.transaction().execute(async (trx) => {
    const s = await lockSystem({ trx, events: [] }, sys.id);
    if (s.draft_revision !== draftBefore)
      throw new RetryLater(
        "DRAFT_MOVED",
        "Пока шла проверка, в Wizard появилась новая ревизия. Повторим импорт",
        1000,
      );
    const hit = await trx
      .selectFrom("platform.revisions")
      .select("version")
      .where("system_id", "=", sys.id)
      .where("idempotency_key", "=", key)
      .executeTakeFirst();
    let version = hit?.version;
    if (version === undefined) {
      const r = await commitFilesRevision({ trx, events: [] }, d.blobs, {
        systemId: sys.id,
        changes: theirs.map((c) => ({
          path: c.path,
          content:
            c.status === "deleted" ? null : new Uint8Array((blobs.get(c.newOid as string) as GitObject).body),
        })),
        author: "user",
        authorUserId: link.connected_by,
        kind: "files",
        ...(newSpec ? { spec: newSpec } : {}),
        summaryRu: summary,
        idempotencyKey: key,
      });
      version = r.version;
      // The gates passed on exactly this content.
      await trx
        .updateTable("platform.revisions")
        .set({ g0_passed: true })
        .where("system_id", "=", sys.id)
        .where("version", "=", version)
        .execute();
    }
    await sql`select pg_catalog.set_config('wizard.org_id', ${link.org_id}, true)`.execute(trx);
    await saveImport(trx, {
      org_id: link.org_id,
      system_id: sys.id,
      link_id: link.id,
      head_oid: head,
      source,
      pr_number: prNumber,
      status: "imported",
      base_revision: base,
      revision: version,
      reason_code: null,
      reason_ru: null,
      details: { ...details, gates: reports.map((r) => ({ level: r.level, passed: r.passed })) },
    });
    await updateLink(trx, link.id, {
      remote_head_oid: head,
      remote_head_revision: version,
      last_pushed_revision: version,
      last_sync_at: now,
      last_error_code: null,
      last_error_ru: null,
    });
    return version;
  });

  // Preview of the imported revision (the run engine's post-G0 step: draft schema and bundle); best effort — a publish
  // builds it anyway.
  if (d.onG0Passed) {
    try {
      const r = await d.onG0Passed({
        systemId: sys.id,
        systemKey: sys.schema_key,
        revision,
        spec,
        files: sources,
        runId: `repo-import:${link.id}`,
        prevSpec,
      });
      if (r?.bundleKey) {
        const bundleKey = r.bundleKey;
        await d.db.transaction().execute(async (trx) => {
          await trx
            .updateTable("platform.revisions")
            .set({ bundle_key: bundleKey })
            .where("system_id", "=", sys.id)
            .where("version", "=", revision)
            .execute();
          await sql`update platform.systems set preview_revision = ${revision}, updated_at = pg_catalog.now()
                     where id = ${sys.id} and (preview_revision is null or preview_revision < ${revision})`.execute(
            trx,
          );
        });
      }
    } catch (e) {
      d.log("git-sync: preview of an imported revision failed", safeErr(e));
    }
  }
  try {
    await api.setCheck(
      head,
      {
        name: GATE_NAMES.import,
        state: "success",
        title: syncRu.import.imported(revision),
        summary: summary,
        detailsUrl: previewLink(d, sys.id, revision),
      },
      null,
    );
  } catch (e) {
    d.log("git-sync: import check on the head failed", safeErr(e));
  }
  return { kind: "done" };
}

// ---- reconcile ----

export async function reconcileFlow(d: SyncDeps, link: LinkRow): Promise<JobOutcome> {
  const now = d.now();
  const sys = await systemOf(d.db, link.system_id);
  if (!sys || sys.deleted_at || link.status === "pending") return { kind: "done" };
  const api = apiOf(d, link);
  const info = await api.repo();
  const patch: Parameters<typeof updateLink>[2] = {};
  if (info.path !== link.repo_path) patch.repo_path = info.path;
  if (info.cloneUrl !== link.clone_url) patch.clone_url = info.cloneUrl;
  if (info.webUrl !== link.web_url) patch.web_url = info.webUrl;
  if (info.defaultBranch && info.defaultBranch !== link.default_branch)
    patch.default_branch = info.defaultBranch;
  const fresh = { ...link, ...patch } as LinkRow;
  const open = await orgTx(d.db, link.org_id, (trx) => prsOf(trx, link.id, { states: ["open"] }));
  let mergedPr: number | null = null;
  for (const row of open) {
    if (!row.number) continue;
    const pr = await api.getPr(row.number);
    if (pr.state === "open") continue;
    await orgTx(d.db, link.org_id, (trx) =>
      updatePrRow(
        trx,
        row.id,
        pr.state === "merged"
          ? { state: "merged", merged_at: now, merge_oid: pr.mergeSha }
          : { state: "closed" },
      ),
    );
    if (pr.state === "merged") mergedPr = row.number;
  }
  const remote = await remoteOf(d, fresh, api);
  const refs = await remote.lsRefs();
  const head = refs.refs.get(`refs/heads/${fresh.default_branch}`) ?? null;
  await orgTx(d.db, link.org_id, async (trx) => {
    await updateLink(trx, link.id, {
      ...patch,
      last_reconcile_at: now,
      ...(link.status === "error" ? { status: "active" as const } : {}),
      last_error_code: null,
      last_error_ru: null,
    });
    if (head && head !== link.remote_head_oid && link.status !== "paused")
      await enqueue(trx, {
        orgId: link.org_id,
        systemId: sys.id,
        linkId: link.id,
        kind: "import",
        key: "import",
        payload: { source: "reconcile", ...(mergedPr ? { prNumber: mergedPr } : {}) },
      });
  });
  return { kind: "done" };
}

/** Classifies a failure of a flow for the queue (Russian reason; never a token or a response body). */
export function outcomeOf(
  e: unknown,
  provider: "github" | "gitlab",
  attempts: number,
  now: Date,
  maxAttempts: number,
): JobOutcome & { owner?: boolean } {
  const p = PROVIDER_RU[provider];
  const backoff = (min: number | null) => {
    const base = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
    const jitter = base * (0.9 + Math.random() * 0.2);
    return new Date(now.getTime() + Math.max(jitter, min ?? 0));
  };
  const retry = (
    code: string,
    message_ru: string,
    min: number | null = null,
  ): JobOutcome & { owner?: boolean } =>
    attempts >= maxAttempts
      ? { kind: "dead", code, message_ru, owner: true }
      : { kind: "retry", at: backoff(min), code, message_ru };
  if (e instanceof RetryLater) return retry(e.code, e.message_ru, e.delayMs);
  if (e instanceof NeedsOwner) return { kind: "dead", code: e.code, message_ru: e.message_ru, owner: true };
  if (e instanceof ProviderError) {
    const text = syncRu.errors[e.code](p);
    if (e.retryable) return retry(e.code, text, e.retryAfterMs);
    if (e.code === "AUTH_FAILED" && attempts < 2) return retry(e.code, text);
    return { kind: "dead", code: e.code, message_ru: text, owner: true };
  }
  if (e instanceof GitTransportError) {
    if (e.retryable || e.code === "PROTOCOL")
      return retry(e.code === "UNREACHABLE" ? "UNAVAILABLE" : e.code, syncRu.errors.UNAVAILABLE(p));
    if (e.code === "AUTH_FAILED" && attempts < 2) return retry(e.code, syncRu.errors.AUTH_FAILED(p));
    const text =
      e.code === "AUTH_FAILED"
        ? syncRu.errors.AUTH_FAILED(p)
        : e.code === "NOT_FOUND"
          ? syncRu.errors.NOT_FOUND(p)
          : syncRu.errors.PUSH_REJECTED(p);
    return {
      kind: "dead",
      code: e.code === "REJECTED" ? "PUSH_REJECTED" : e.code,
      message_ru: text,
      owner: true,
    };
  }
  return retry("INTERNAL", syncRu.errors.INTERNAL);
}
