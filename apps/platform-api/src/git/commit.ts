// Commits of a system repository (V3-30, D77_v3 (3)): every revision of the system is a commit on refs/heads/main,
// every brief version too; both streams are replayed in the order they were written. syncRepo is idempotent and
// catches up whatever is missing (systems older than the repository, a commit that failed), so the hook in the
// revision transaction and the owner's read API share it. Author «Wizard», the acting user id in a trailer.
import type { AppSpec, BriefChange, SystemBrief } from "@wizard/appspec";
import { scrub } from "@wizard/pii";
import { type Kysely, sql } from "kysely";
import type { DB } from "../db/index.js";
import { type BlobStore, sha256 } from "../storage/blobs.js";
import { generatedFiles, isGeneratedPath, isRepoPath, scrubBrief } from "./layout.js";
import { buildTrees, encodeCommit, makeObject, type Signature } from "./objects.js";
import {
  blobOidsByContent,
  insertCommitRow,
  MAIN_REF,
  putObjects,
  repoCursor,
  type StoredObject,
  setRef,
} from "./store.js";

type Q = Kysely<DB>;

export const COMMIT_AUTHOR = { name: "Wizard", email: "noreply@borntobuild.ru" } as const;
/** Moscow time in the signatures: the platform and its clients live in it. */
const TZ = "+0300";
const PAGE = 100;
const SUBJECT_MAX = 100;
const BODY_LINES = 50;
const EMPTY_MANIFEST_SHA = sha256("{}");

interface RevisionEvent {
  kind: "revision";
  at: Date;
  version: number;
  revKind: string;
  spec: AppSpec;
  manifestSha: string;
  summary: string | null;
  runKind: string | null;
  runMode: string | null;
  runId: string | null;
  userId: string | null;
}

interface BriefEvent {
  kind: "brief";
  at: Date;
  version: number;
  brief: SystemBrief;
  diff: BriefChange[];
  runId: string | null;
  userId: string | null;
}

type RepoEvent = RevisionEvent | BriefEvent;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** «Сборка» for a build from scratch, «Возврат» for a revert, «Правка» for everything else. */
export function revisionPrefix(e: Pick<RevisionEvent, "revKind" | "runKind" | "runMode">): string {
  if (e.revKind === "revert") return "Возврат";
  if (e.runKind === "build" && (e.runMode === "create" || e.runMode === null)) return "Сборка";
  return "Правка";
}

/** Message of a commit: subject, list body and the Wizard-* trailers; personal data is scrubbed out of the text. */
export function commitMessage(
  e: RepoEvent,
  briefVersion: number | null,
): { subject: string; message: string } {
  let subject: string;
  let items: string[] = [];
  if (e.kind === "revision") {
    items = (e.summary ?? "").split(/;\s+/).map(oneLine).filter(Boolean);
    const prefix = revisionPrefix(e);
    // «Возврат к ревизии 3» → «Возврат: к ревизии 3», not the prefix twice.
    const first = items[0]?.startsWith(`${prefix} `) ? items[0].slice(prefix.length + 1) : items[0];
    subject = `${prefix}: ${first ?? `ревизия ${e.version}`}${items.length > 1 ? ` и ещё ${items.length - 1}` : ""}`;
  } else {
    items = e.diff.map((c) => oneLine(c.text_ru)).filter(Boolean);
    subject = `Бриф: версия ${e.version}${items[0] ? ` — ${items[0]}` : ""}`;
  }
  subject = clip(oneLine(scrub(subject).text), SUBJECT_MAX);
  const body =
    items.length > 1
      ? [
          ...items.slice(0, BODY_LINES).map((i) => `- ${scrub(i).text}`),
          ...(items.length > BODY_LINES ? [`- …и ещё ${items.length - BODY_LINES}`] : []),
        ]
      : [];
  const trailers = [
    ...(e.kind === "revision" ? [`Wizard-Revision: ${e.version}`] : []),
    ...(briefVersion !== null ? [`Wizard-Brief-Version: ${briefVersion}`] : []),
    ...(e.runId ? [`Wizard-Run: ${e.runId}`] : []),
    ...(e.userId ? [`Wizard-User: ${e.userId}`] : []),
  ];
  const parts = [subject, ...(body.length ? [body.join("\n")] : []), trailers.join("\n")];
  return { subject, message: `${parts.join("\n\n")}\n` };
}

async function manifestOf(blobs: BlobStore, sha: string): Promise<Record<string, string>> {
  if (sha === EMPTY_MANIFEST_SHA) return {};
  return JSON.parse((await blobs.get(sha)).toString("utf8")) as Record<string, string>;
}

async function pendingRevisions(q: Q, systemId: string, after: number): Promise<RevisionEvent[]> {
  const rows = await q
    .selectFrom("platform.revisions as r")
    .leftJoin("platform.runs as u", "u.id", "r.run_id")
    .select([
      "r.version",
      "r.kind",
      "r.spec",
      "r.files_manifest_sha",
      "r.summary_ru",
      "r.run_id",
      "r.author_user_id",
      "r.created_at",
      "u.kind as run_kind",
      "u.mode as run_mode",
      "u.started_by",
    ])
    .where("r.system_id", "=", systemId)
    .where("r.version", ">", after)
    .orderBy("r.version")
    .limit(PAGE)
    .execute();
  return rows.map((r) => ({
    kind: "revision",
    at: new Date(r.created_at),
    version: r.version,
    revKind: r.kind,
    spec: r.spec as unknown as AppSpec,
    manifestSha: r.files_manifest_sha,
    summary: r.summary_ru,
    runKind: r.run_kind ?? null,
    runMode: r.run_mode ?? null,
    runId: r.run_id,
    userId: r.author_user_id ?? r.started_by ?? null,
  }));
}

async function pendingBriefs(q: Q, systemId: string, after: number): Promise<BriefEvent[]> {
  const rows = await q
    .selectFrom("platform.system_briefs as b")
    .leftJoin("platform.runs as u", "u.id", "b.run_id")
    .select([
      "b.version",
      "b.brief",
      "b.diff",
      "b.run_id",
      "b.author_user_id",
      "b.created_at",
      "u.started_by",
    ])
    .where("b.system_id", "=", systemId)
    .where("b.version", ">", after)
    .orderBy("b.version")
    .limit(PAGE)
    .execute();
  return rows.map((r) => ({
    kind: "brief",
    at: new Date(r.created_at),
    version: r.version,
    brief: r.brief as unknown as SystemBrief,
    diff: (r.diff ?? []) as unknown as BriefChange[],
    runId: r.run_id,
    userId: r.author_user_id ?? r.started_by ?? null,
  }));
}

/**
 * Both streams of one page in write order (a brief version before a revision of the same instant). A full page ends
 * at its last event: only events up to the earlier end are taken, the rest wait for the next page.
 */
function mergePage(revs: RevisionEvent[], briefs: BriefEvent[]): RepoEvent[] {
  const ends = [revs, briefs]
    .filter((xs) => xs.length === PAGE)
    .map((xs) => (xs.at(-1) as RepoEvent).at.getTime());
  const cutoff = ends.length ? Math.min(...ends) : Number.POSITIVE_INFINITY;
  const all: RepoEvent[] = [...briefs, ...revs].filter((e) => e.at.getTime() <= cutoff);
  return all.sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() ||
      (a.kind === b.kind ? a.version - b.version : a.kind === "brief" ? -1 : 1),
  );
}

export interface SyncResult {
  /** Commits written by this call. */
  commits: number;
  head: string | null;
}

/**
 * Writes the missing commits of a system: brief versions and revisions not yet in the repository, in write order.
 * The caller holds the systems row lock (a revision transaction, or ensureRepo), so two syncs never interleave.
 */
export async function syncRepo(q: Q, blobs: BlobStore, systemId: string): Promise<SyncResult> {
  const system = await q
    .selectFrom("platform.systems")
    .select(["id", "name"])
    .where("id", "=", systemId)
    .executeTakeFirst();
  if (!system) return { commits: 0, head: null };
  const cursor = await repoCursor(q, systemId);
  let { seq, head } = cursor;
  let written = 0;

  // The state the next commit starts from: the last committed revision and brief version. The revision is read only
  // when a brief version comes first (a new revision replaces it anyway — the usual case of the revision hook).
  let spec: AppSpec | null = null;
  let manifest: Record<string, string> = {};
  let brief: { version: number; brief: SystemBrief } | null = null;
  let baseRevision = cursor.revision;
  const loadBase = async () => {
    if (baseRevision === 0) return;
    const r = await q
      .selectFrom("platform.revisions")
      .select(["spec", "files_manifest_sha"])
      .where("system_id", "=", systemId)
      .where("version", "=", baseRevision)
      .executeTakeFirstOrThrow();
    spec = r.spec as unknown as AppSpec;
    manifest = await manifestOf(blobs, r.files_manifest_sha);
    baseRevision = 0;
  };
  if (cursor.briefVersion > 0) {
    const b = await q
      .selectFrom("platform.system_briefs")
      .select(["brief"])
      .where("system_id", "=", systemId)
      .where("version", "=", cursor.briefVersion)
      .executeTakeFirstOrThrow();
    brief = {
      version: cursor.briefVersion,
      brief: scrubBrief(`${systemId}:${cursor.briefVersion}`, b.brief as unknown as SystemBrief),
    };
  }

  const blobOid = new Map<string, string>(); // content sha256 → git blob oid
  let revDone = cursor.revision;
  let briefDone = cursor.briefVersion;
  for (;;) {
    const events = mergePage(
      await pendingRevisions(q, systemId, revDone),
      await pendingBriefs(q, systemId, briefDone),
    );
    if (events.length === 0) break;
    for (const e of events) {
      if (e.kind === "revision") {
        spec = e.spec;
        manifest = await manifestOf(blobs, e.manifestSha);
        revDone = e.version;
        baseRevision = 0;
      } else {
        await loadBase();
        brief = { version: e.version, brief: scrubBrief(`${systemId}:${e.version}`, e.brief) };
        briefDone = e.version;
      }
      const objects: StoredObject[] = [];
      const sourcePaths = Object.keys(manifest)
        .filter((p) => isRepoPath(p) && !isGeneratedPath(p))
        .sort();
      const unknown = sourcePaths.map((p) => manifest[p] as string).filter((s) => !blobOid.has(s));
      for (const [s, oid] of await blobOidsByContent(q, systemId, unknown)) blobOid.set(s, oid);
      const files = new Map<string, { oid: string }>();
      for (const p of sourcePaths) {
        const s = manifest[p] as string;
        let oid = blobOid.get(s);
        if (!oid) {
          const blob = makeObject("blob", await blobs.get(s));
          objects.push({ ...blob, contentSha256: s });
          oid = blob.oid;
          blobOid.set(s, oid);
        }
        files.set(p, { oid });
      }
      for (const [p, bytes] of generatedFiles({
        // The name of the revision, not today's: a replayed commit is the same commit.
        systemName: (spec as AppSpec | null)?.app.name ?? system.name,
        spec,
        brief,
        sourcePaths,
      })) {
        const blob = makeObject("blob", bytes);
        objects.push(blob);
        files.set(p, { oid: blob.oid });
      }
      const { root, trees } = buildTrees(files);
      objects.push(...trees);
      const { subject, message } = commitMessage(e, brief?.version ?? null);
      const sig: Signature = { ...COMMIT_AUTHOR, time: Math.floor(e.at.getTime() / 1000), tz: TZ };
      const commit = makeObject(
        "commit",
        encodeCommit({ tree: root, parents: head ? [head] : [], author: sig, committer: sig, message }),
      );
      objects.push(commit);
      await putObjects(q, systemId, objects);
      seq += 1;
      await insertCommitRow(q, systemId, {
        seq,
        oid: commit.oid,
        revision: e.kind === "revision" ? e.version : null,
        briefVersion: brief?.version ?? null,
        subject,
        authorUserId: e.userId,
        committedAt: e.at,
      });
      head = commit.oid;
      written += 1;
    }
  }
  if (head && written > 0) await setRef(q, systemId, MAIN_REF, head);
  return { commits: written, head };
}

function warn(systemId: string, e: unknown): void {
  process.emitWarning(
    `git of system ${systemId}: ${e instanceof Error ? e.message : String(e)}`,
    "WizardGit",
  );
}

/**
 * Hook of the revision transaction (services/revisions.ts insertRevision): the revision just inserted becomes a
 * commit in the same transaction. Best effort under a savepoint — a failure never loses the revision; the next
 * revision or a read of the repository catches the commit up.
 */
export async function commitInTransaction(
  trx: Q,
  blobs: BlobStore | undefined,
  systemId: string,
): Promise<void> {
  if (!blobs) return;
  await sql`savepoint wizard_git`.execute(trx);
  try {
    await syncRepo(trx, blobs, systemId);
    await sql`release savepoint wizard_git`.execute(trx);
  } catch (e) {
    await sql`rollback to savepoint wizard_git`.execute(trx);
    warn(systemId, e);
  }
}

/** Is the repository behind the system (a revision or a brief version without its commit)? */
export async function repoBehind(q: Q, systemId: string): Promise<boolean> {
  const { rows } = await sql<{
    draft_revision: number;
    brief: number | null;
    rev_done: number | null;
    brief_done: number | null;
  }>`
    select s.draft_revision,
           (select max(b.version) from platform.system_briefs as b where b.system_id = s.id) as brief,
           (select max(c.revision) from platform.system_git_commits as c where c.system_id = s.id) as rev_done,
           (select max(c.brief_version) from platform.system_git_commits as c where c.system_id = s.id) as brief_done
      from platform.systems as s
     where s.id = ${systemId}`.execute(q);
  const r = rows[0];
  if (!r) return false;
  return r.draft_revision > Number(r.rev_done ?? 0) || Number(r.brief ?? 0) > Number(r.brief_done ?? 0);
}

/** Catches the repository up before a read (under the systems row lock); true while it is still behind. */
export async function ensureRepo(db: Kysely<DB>, blobs: BlobStore, systemId: string): Promise<boolean> {
  if (!(await repoBehind(db, systemId))) return false;
  try {
    await db.transaction().execute(async (trx) => {
      await sql`select s.id from platform.systems as s where s.id = ${systemId} for no key update`.execute(
        trx,
      );
      await syncRepo(trx, blobs, systemId);
    });
  } catch (e) {
    warn(systemId, e);
  }
  return repoBehind(db, systemId);
}
