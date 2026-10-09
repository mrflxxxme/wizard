// /systems/:id/repo* (V3-30, D77_v3 (2)–(3)): the internal git repository of a system for its owner — refs and head,
// commits newest first, the commit of a revision, the diff of a commit and the zip of its tree. Reading needs viewer,
// as the revisions and files it is made of (GET /systems/:id/revisions, /files/*); another org's system is 404.
// Before a read the repository catches up with revisions and brief versions it has not committed yet.
import { Hono } from "hono";
import { z } from "zod";
import { invalid, notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid } from "../http/auth.js";
import { type Deps, parseQuery } from "../http/util.js";
import { ensureRepo } from "./commit.js";
import { OID_RE } from "./objects.js";
import { commitArchive, commitDiff, commitInfos } from "./read.js";
import { type CommitRow, findCommitRow, listCommitRows } from "./store.js";

const listQ = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.number().int().min(2).optional(),
});
const targetQ = z.object({
  revision: z.coerce.number().int().min(1).optional(),
  commit: z.string().regex(OID_RE).optional(),
});

interface RepoSystem {
  id: string;
  slug: string;
  preview_revision: number | null;
  prod_revision: number | null;
}

export function repoRoutes(d: Pick<Deps, "db" | "blobs">): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  async function loadSystem(
    user: AuthUser,
    id: string | undefined,
  ): Promise<RepoSystem & { behind: boolean }> {
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .select(["id", "org_id", "slug", "preview_revision", "prod_revision"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(user, s.org_id, "viewer", "Система");
    return { ...s, behind: await ensureRepo(d.db, d.blobs, s.id) };
  }

  /** ?revision=N or ?commit=<oid>; neither — the head of main. */
  async function target(s: RepoSystem, q: z.infer<typeof targetQ>): Promise<CommitRow> {
    if (q.revision !== undefined && q.commit !== undefined)
      throw invalid("Укажите либо ревизию, либо коммит");
    const row = await findCommitRow(d.db, s.id, {
      ...(q.revision !== undefined ? { revision: q.revision } : {}),
      ...(q.commit !== undefined ? { oid: q.commit } : {}),
    });
    if (!row) throw notFound("Коммит");
    return row;
  }

  const ref = async (s: RepoSystem, revision: number | null) => {
    if (revision === null) return null;
    const row = await findCommitRow(d.db, s.id, { revision });
    return row ? { oid: row.oid, revision } : null;
  };

  // Head, refs (main — every revision and brief version, preview and prod — the commits of those revisions), count.
  r.get("/systems/:id/repo", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"));
    const head = await findCommitRow(d.db, s.id, {});
    return c.json({
      head: head ? (await commitInfos(d.db, s.id, [head]))[0] : null,
      refs: {
        main: head ? { oid: head.oid, revision: head.revision } : null,
        preview: await ref(s, s.preview_revision),
        prod: await ref(s, s.prod_revision),
      },
      commits: head?.seq ?? 0,
      behind: s.behind,
    });
  });

  // Commits newest first; ?before=<seq> — the next page.
  r.get("/systems/:id/repo/commits", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"));
    const q = parseQuery(c, listQ);
    const rows = await listCommitRows(d.db, s.id, q);
    const last = rows.at(-1);
    return c.json({
      commits: await commitInfos(d.db, s.id, rows),
      nextBefore: rows.length === q.limit && last && last.seq > 1 ? last.seq : null,
    });
  });

  // Revision ↔ commit.
  r.get("/systems/:id/repo/revisions/:v", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"));
    const v = Number(c.req.param("v"));
    if (!Number.isInteger(v) || v < 1) throw invalid("Номер ревизии — целое число от 1");
    const row = await findCommitRow(d.db, s.id, { revision: v });
    if (!row) throw notFound("Коммит ревизии");
    return c.json({ revision: v, commit: (await commitInfos(d.db, s.id, [row]))[0] });
  });

  // Diff of a commit against its parent: changed files with `git diff` patches.
  r.get("/systems/:id/repo/diff", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"));
    const row = await target(s, parseQuery(c, targetQ));
    return c.json(await commitDiff(d.db, s.id, row));
  });

  // The tree of a commit as a zip archive.
  r.get("/systems/:id/repo/archive", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"));
    const row = await target(s, parseQuery(c, targetQ));
    const name = row.revision !== null ? `${s.slug}-r${row.revision}` : `${s.slug}-${row.oid.slice(0, 7)}`;
    const zip = await commitArchive(d.db, s.id, row, name);
    return new Response(new Uint8Array(zip), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${name}.zip"`,
        "cache-control": "private, no-store",
      },
    });
  });

  return r;
}
