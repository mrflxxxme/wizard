// Publication after the merge (V3-31, D77 (3)): while a system is connected to a repository (active, or stopped by an
// error of the provider), a revision is published only when the default branch has it — its PR (or a later one) was
// merged, it came from the repository, or it went straight into an empty repository. A paused link does not hold
// publication (the owner's way out when the provider is down for long). Used by routes/publish.ts and the publish run.
import { type Kysely, sql } from "kysely";
import type { DB } from "../db/index.js";
import { linkOfSystem, orgTx, prsOf } from "./store.js";
import { syncRu } from "./texts.js";

export interface RepoPublishBlock {
  message_ru: string;
  /** URL of the PR to merge, when there is one. */
  pr: string | null;
}

/** null — the revision may be published as far as the repository is concerned. */
export async function repoPublishBlock(
  db: Kysely<DB>,
  systemId: string,
  revision: number,
): Promise<RepoPublishBlock | null> {
  const { rows } = await sql<{
    org_id: string;
  }>`select s.org_id from platform.systems as s where s.id = ${systemId}`.execute(db);
  const orgId = rows[0]?.org_id;
  if (!orgId) return null;
  return orgTx(db, orgId, async (trx) => {
    const l = await linkOfSystem(trx, systemId);
    if (!l || (l.status !== "active" && l.status !== "error")) return null;
    const prs = await prsOf(trx, l.id, { limit: 50 });
    const merged = Math.max(
      l.remote_head_revision ?? 0,
      ...prs.filter((p) => p.state === "merged" || p.state === "direct").map((p) => p.revision),
    );
    if (revision <= merged) return null;
    const pr =
      prs.find((p) => p.revision >= revision && p.state === "open") ??
      prs.find((p) => p.state === "open") ??
      null;
    return { message_ru: syncRu.publishBlocked(pr, l.repo_path ?? ""), pr: pr?.url ?? null };
  });
}
