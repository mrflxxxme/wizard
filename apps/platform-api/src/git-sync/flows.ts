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
import {
  conflicts,
  type Flat,
  generatedEdits,
  importableChanges,
  importedSpec,
  incompatibilities,
  mergeClashes,
} from "./compat.js";
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
  closePreview,
  enqueue,
  importOfHead,
  importsOf,
  type JobOutcome,
  type JobRow,
  type LinkRow,
  orgTx,
  type PrRow,
  previewOf,
  prOfRevision,
  prsOf,
  saveImport,
  savePreview,
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

// ---- candidate: the client's changes over Wizard's draft ----

export type Candidate =
  | { kind: "noop"; warnings: string[] }
  | {
      kind: "reject";
      code: "INCOMPATIBLE" | "CONFLICT" | "SPEC_INVALID";
      reason: string;
      details: Record<string, unknown>;
    }
  | {
      kind: "ok";
      /** Importable changes base → head. */
      theirs: TreeChange[];
      /** The content a change brings: the client's blob, or the line-level merge with Wizard's edit (null — deleted). */
      content: (c: TreeChange) => Buffer | null;
      newSpec: AppSpec | null;
      /** Draft sources (ui/**, functions/**) with the changes applied — what G0–G2 check. */
      sources: Map<string, string>;
      details: Record<string, unknown>;
    };

const REPO_BEHIND_RU = "Внутренний репозиторий системы ещё не догнал ревизии. Повторим автоматически";

/**
 * What the client's tree `head` brings over the Wizard revision `base` it started from, applied to the current draft:
 * compatibility (paths, symlinks, sizes, UTF-8), changes on both sides merged line by line when apart (V3-32) and
 * conflicts otherwise, the spec checked. Used by the import of the default branch and by the preview of an open PR.
 */
export async function buildCandidate(
  d: SyncDeps,
  sys: Pick<SystemRow, "id" | "draft_revision">,
  head: string,
  base: number,
  prevHead: Flat | null,
): Promise<Candidate> {
  if (await ensureRepo(d.db, d.blobs, sys.id)) throw new RetryLater("REPO_BEHIND", REPO_BEHIND_RU);
  const baseRow = await findCommitRow(d.db, sys.id, { revision: base });
  const draftRow = await findCommitRow(d.db, sys.id, { revision: sys.draft_revision });
  if (!baseRow || !draftRow)
    throw new RetryLater("REPO_BEHIND", "Коммиты ревизий ещё не записаны. Повторим автоматически");
  const B = (await commitTree(d.db, sys.id, baseRow.oid)).flat;
  const D = (await commitTree(d.db, sys.id, draftRow.oid)).flat;
  const T = (await commitTree(d.db, sys.id, head)).flat;
  const theirs = importableChanges(B, T);
  const warnings: string[] = generatedEdits(prevHead, T).length ? [syncRu.import.generatedIgnored] : [];
  if (theirs.length === 0) return { kind: "noop", warnings };

  const blobs = await readObjects(
    d.db,
    sys.id,
    theirs.filter((c) => c.newOid).map((c) => c.newOid as string),
  );
  const after = new Set([...D.keys()].filter(isImportablePath));
  for (const c of theirs) c.status === "deleted" ? after.delete(c.path) : after.add(c.path);
  const bad = incompatibilities(theirs, T, (oid) => blobs.get(oid)?.body, after.size);
  const details: Record<string, unknown> = {
    files: theirs.map((c) => ({ path: c.path, status: c.status })).slice(0, 200),
    warnings,
  };
  if (bad.length)
    return { kind: "reject", code: "INCOMPATIBLE", reason: syncRu.import.incompatible(bad), details };

  // Paths both sides changed: a line-level merge where the hunks are apart, a conflict otherwise.
  const clash = conflicts(theirs, importableChanges(B, D), D, T);
  let merged = new Map<string, Buffer>();
  if (clash.length) {
    const oids = clash.flatMap((p) => [B.get(p)?.oid, D.get(p)?.oid, T.get(p)?.oid]).filter((x) => !!x);
    const three = await readObjects(d.db, sys.id, oids as string[]);
    const m = mergeClashes(clash, B, D, T, (oid) => three.get(oid)?.body);
    if (m.conflicts.length)
      return {
        kind: "reject",
        code: "CONFLICT",
        reason: syncRu.import.conflict(
          m.conflicts.map((c) => c.path),
          sys.draft_revision,
          m.conflicts.flatMap((c) => c.lines.map((l) => ({ path: c.path, ...l }))),
        ),
        details: { ...details, conflicts: m.conflicts },
      };
    merged = m.merged;
    if (merged.size) {
      details.merged = [...merged.keys()];
      warnings.push(syncRu.import.mergedLines([...merged.keys()]));
    }
  }
  const content = (c: TreeChange): Buffer | null =>
    c.status === "deleted"
      ? null
      : (merged.get(c.path) ??
        (blobs.get(c.newOid as string) as GitObject | undefined)?.body ??
        Buffer.alloc(0));

  let newSpec: AppSpec | null = null;
  const specChange = theirs.find((c: TreeChange) => c.path === "spec/appspec.json");
  if (specChange && specChange.status !== "deleted") {
    const r = importedSpec(content(specChange) ?? Buffer.alloc(0));
    if (!r.ok)
      return { kind: "reject", code: "SPEC_INVALID", reason: syncRu.import.badSpec(r.reasons), details };
    newSpec = r.spec;
  }

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
    const body = content(c);
    if (body === null) sources.delete(c.path);
    else sources.set(c.path, body.toString("utf8"));
  }
  return { kind: "ok", theirs, content, newSpec, sources, details };
}

/** G0 → G1 → G2 over a candidate (the run engine's gate executor), stopping at the first failure. */
export async function gateCandidate(
  d: SyncDeps,
  sys: Pick<SystemRow, "draft_revision" | "schema_key" | "slug">,
  spec: AppSpec,
  prevSpec: AppSpec | null,
  sources: ReadonlyMap<string, string>,
): Promise<{
  passed: boolean;
  reports: GateReport[];
  failedLevel?: "G0" | "G1" | "G2";
  failedTitle?: string;
}> {
  const gates = d.gates;
  if (!gates) throw new RetryLater("GATES_UNAVAILABLE", syncRu.import.noGates, 10 * 60_000);
  const reports: GateReport[] = [];
  for (const level of ["G0", "G1", "G2"] as const) {
    const report = {
      ...(await gates(level, {
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
      return { passed: false, reports, failedLevel: level, failedTitle: failedLine(report).title };
  }
  return { passed: true, reports };
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

  const prevHead =
    link.remote_head_oid &&
    (await existingOids(d.db, sys.id, [link.remote_head_oid])).has(link.remote_head_oid)
      ? (await commitTree(d.db, sys.id, link.remote_head_oid)).flat
      : null;
  const cand = await buildCandidate(d, sys, head, base, prevHead);
  if (cand.kind === "noop") {
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
        details: { warnings: cand.warnings },
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
  if (cand.kind === "reject")
    return rejectImport(d, link, api, head, {
      source,
      prNumber,
      base,
      code: cand.code,
      reason: cand.reason,
      details: cand.details,
    });
  const { theirs, newSpec, sources, details } = cand;
  if (await systemBusy(d.db, sys.id, now))
    throw new RetryLater("SYSTEM_BUSY", syncRu.import.building, 60_000);
  if (!d.gates) throw new RetryLater("GATES_UNAVAILABLE", syncRu.import.noGates, 10 * 60_000);

  // G0 → G1 → G2 over the candidate before anything is written.
  const spec = newSpec ?? (await loadSpec(d.db, sys, sys.draft_revision));
  const prevSpec = sys.preview_revision !== null ? await loadSpec(d.db, sys, sys.preview_revision) : null;
  const gated = await gateCandidate(d, sys, spec, prevSpec, sources);
  const reports = gated.reports;
  if (!gated.passed)
    return rejectImport(d, link, api, head, {
      source,
      prNumber,
      base,
      code: "GATES_FAILED",
      reason: syncRu.import.gatesFailed(gated.failedLevel as string, [gated.failedTitle as string]),
      details: { ...details, gates: reports.map((r) => ({ level: r.level, passed: r.passed })) },
    });

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
        changes: theirs.map((c) => {
          const body = cand.content(c);
          return { path: c.path, content: body === null ? null : new Uint8Array(body) };
        }),
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

// ---- PR preview (V3-32) ----

/** Stable address of a developer's PR preview in Wizard (api.yaml getRepoSyncPull): JSON, or the settings for a browser. */
export const pullLink = (d: SyncDeps, systemId: string, number: number): string =>
  `${d.config.platformOrigin}/api/v1/systems/${systemId}/repo-sync/pulls/${number}`;

/** Wizard's own branches (revision PRs, the agent's PRs) are never previewed as a developer's PR. */
export const isWizardBranch = (branch: string | null | undefined): boolean => !!branch?.startsWith("wizard/");

/** The latest Wizard revision synced with the default branch whose commit the PR head contains (its base). */
async function previewBase(
  d: SyncDeps,
  link: LinkRow,
  systemId: string,
  head: string,
): Promise<number | null> {
  const prs = await orgTx(d.db, link.org_id, (trx) => prsOf(trx, link.id, { states: ["merged", "direct"] }));
  const imports = await orgTx(d.db, link.org_id, (trx) => importsOf(trx, link.id, 50));
  const candidates: { oid: string; revision: number }[] = [];
  for (const p of prs) {
    if (p.merge_oid) candidates.push({ oid: p.merge_oid, revision: p.revision });
    candidates.push({ oid: p.head_oid, revision: p.revision });
  }
  for (const i of imports) {
    const rev = i.status === "imported" ? i.revision : i.status === "noop" ? i.base_revision : null;
    if (rev) candidates.push({ oid: i.head_oid, revision: rev });
  }
  if (link.remote_head_oid && link.remote_head_revision)
    candidates.push({ oid: link.remote_head_oid, revision: link.remote_head_revision });
  candidates.sort((a, b) => b.revision - a.revision);
  for (const c of candidates) if (await isAncestor(d.db, systemId, c.oid, head)) return c.revision;
  return null;
}

/**
 * The preview of a developer's open PR into the default branch: the PR head is fetched, its changes since the Wizard
 * revision it started from are applied to the current draft (line-level merge where safe) and gated G0 → G1 → G2 — what
 * the import would do after the merge. The result goes to the PR head as checks (one per gate and «Wizard / Превью PR»
 * with the summary) and to its stable address in Wizard. Nothing is written to the system.
 */
export async function prPreviewFlow(d: SyncDeps, link: LinkRow, job: JobRow): Promise<JobOutcome> {
  const now = d.now();
  const p = job.payload as { number?: unknown; head?: unknown; branch?: unknown; url?: unknown };
  const number = Number(p.number);
  if (!Number.isInteger(number) || number < 1) return { kind: "done" };
  const sys = await systemOf(d.db, link.system_id);
  if (!sys || sys.deleted_at || link.status !== "active") return { kind: "done" };
  const api = apiOf(d, link);
  const pr = await api.getPr(number);
  if (pr.state !== "open") {
    await orgTx(d.db, link.org_id, (trx) => closePreview(trx, link.id, number));
    return { kind: "done" };
  }
  const head = pr.headSha ?? (typeof p.head === "string" ? p.head : null);
  if (!head || !/^[0-9a-f]{40}$/.test(head)) return { kind: "done" };
  const branch = typeof p.branch === "string" ? p.branch.slice(0, 250) : null;
  if (isWizardBranch(branch)) return { kind: "done" };
  const prev = await orgTx(d.db, link.org_id, (trx) => previewOf(trx, link.id, number));
  if (prev && prev.head_oid === head && prev.status !== "pending") return { kind: "done" };
  const url = pr.url ?? (typeof p.url === "string" ? p.url : null);
  const address = pullLink(d, sys.id, number);
  const save = (
    r: Omit<Parameters<typeof savePreview>[1], "org_id" | "system_id" | "link_id" | "number" | "head_oid">,
  ) =>
    orgTx(d.db, link.org_id, (trx) =>
      savePreview(trx, {
        org_id: link.org_id,
        system_id: sys.id,
        link_id: link.id,
        number,
        head_oid: head,
        branch,
        url,
        ...r,
      }),
    );
  await save({ status: "pending" });
  const post = async (
    name: string,
    state: "success" | "failure" | "neutral",
    title: string,
    summary: string,
  ) => {
    try {
      await api.setCheck(head, { name, state, title, summary, detailsUrl: address }, null);
    } catch (e) {
      d.log("git-sync: a PR preview check failed", safeErr(e));
    }
  };

  const remote = await remoteOf(d, link, api);
  if (!(await fetchHead(d, link, remote, head)))
    throw new RetryLater("FETCH_INCOMPLETE", syncRu.import.fetchIncomplete);
  const base = await previewBase(d, link, sys.id, head);
  if (base === null) {
    await save({ status: "rejected", reason_code: "NO_BASE", reason_ru: syncRu.preview.noBase });
    await post(GATE_NAMES.preview, "failure", syncRu.preview.noBase.slice(0, 200), syncRu.preview.noBase);
    return { kind: "done" };
  }
  const cand = await buildCandidate(d, sys, head, base, null);
  if (cand.kind === "noop") {
    await save({ status: "noop", base_revision: base, details: { warnings: cand.warnings } });
    await post(GATE_NAMES.preview, "neutral", syncRu.preview.noop.slice(0, 200), syncRu.preview.noop);
    return { kind: "done" };
  }
  if (cand.kind === "reject") {
    await save({
      status: "rejected",
      base_revision: base,
      reason_code: cand.code,
      reason_ru: cand.reason.slice(0, 2000),
      details: cand.details,
    });
    await post(GATE_NAMES.preview, "failure", cand.reason.slice(0, 200), cand.reason);
    return { kind: "done" };
  }
  // A build holds the system: the preview waits for it without spending its attempts.
  if (await systemBusy(d.db, sys.id, now)) return { kind: "wait", at: new Date(now.getTime() + 60_000) };
  const spec = cand.newSpec ?? (await loadSpec(d.db, sys, sys.draft_revision));
  const prevSpec = sys.preview_revision !== null ? await loadSpec(d.db, sys, sys.preview_revision) : null;
  const gated = await gateCandidate(d, sys, spec, prevSpec, cand.sources);
  const gates = (["G0", "G1", "G2"] as const).map((level) => {
    const r = gated.reports.find((x) => x.level === level);
    return {
      level,
      passed: r ? r.passed : null,
      title: r
        ? r.passed
          ? syncRu.gate.passed(r.checks.filter((c) => c.status === "pass").length)
          : failedLine(r).title
        : syncRu.preview.notRun(gated.failedLevel ?? "G0"),
    };
  });
  const checks: Record<string, { state: string; title: string }> = {};
  for (const g of gates) {
    const state = g.passed === null ? "neutral" : g.passed ? "success" : "failure";
    checks[g.level] = { state, title: g.title };
    await post(GATE_NAMES[g.level], state, g.title, g.title);
  }
  const reason = gated.passed
    ? null
    : syncRu.preview.failed(gated.failedLevel as string, gated.failedTitle ?? "");
  const summary = syncRu.preview.summary({
    files: (cand.details.files as { path: string; status: string }[] | undefined) ?? [],
    merged: (cand.details.merged as string[] | undefined) ?? [],
    gates,
    url: address,
  });
  checks.preview = { state: gated.passed ? "success" : "failure", title: reason ?? syncRu.preview.passed };
  await post(
    GATE_NAMES.preview,
    gated.passed ? "success" : "failure",
    (reason ?? syncRu.preview.passed).slice(0, 200),
    summary,
  );
  await save({
    status: gated.passed ? "passed" : "failed",
    base_revision: base,
    reason_code: gated.passed ? null : "GATES_FAILED",
    reason_ru: reason,
    checks,
    details: { ...cand.details, gates },
  });
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
