// V3-30 acceptance (D77_v3 (2)–(3), db.yaml#system_git_commits): every system has a git repository in the platform
// storage; a revision is a commit (in the revision's own transaction), a brief version is a commit too; the tree is
// brief, spec, ui (+ design tokens), functions, tests and AGENTS.md; the owner reads commits, the commit of a revision,
// the diff and the zip of a tree; the repository goes with the system. A real `git` (when the machine has one) is the
// oracle of the format: fsck, log, cat-file, numstat and `git apply` of our patches.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { emptySpec, type SystemBrief, systemBriefSchema } from "@wizard/appspec";
import { MemoryFileStorage } from "@wizard/runtime";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dentalBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { ensureRepo, syncRepo } from "../src/git/commit.js";
import { unifiedHunks } from "../src/git/diff.js";
import { AGENTS_FILE, BRIEF_FILE, SCENARIOS_FILE, SPEC_FILE } from "../src/git/layout.js";
import {
  buildTrees,
  encodeTree,
  hashObject,
  inflateObject,
  makeObject,
  parseCommit,
  parseTrailers,
  parseTree,
} from "../src/git/objects.js";
import { findCommitRow, readObject, readTreeFlat } from "../src/git/store.js";
import { purgeDeletedSystems } from "../src/privacy/delete-system.js";
import { type TxCtx, withTx } from "../src/runs/events.js";
import { applyOpsRevision, commitFilesRevision, revertRevision } from "../src/services/revisions.js";
import { createTestDb, fakeExecutors, ROOT, startApi, type TestApi } from "./helpers.js";
import { expectContract } from "./session.js";

const VIEWER = { "x-wizard-dev-user": "viewer-git@example.test" };
const STRANGER = { "x-wizard-dev-user": "stranger-git@example.test" };
const PHONE = "+7 916 123-45-67";
const HAS_GIT = spawnSync("git", ["--version"]).status === 0;

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;

beforeAll(async () => {
  tdb = await createTestDb("v3git");
  api = await startApi(tdb.url, { executors: fakeExecutors() });
  for (const h of [VIEWER, STRANGER]) expect((await api.req("GET", "/me", { headers: h })).status).toBe(200);
  await api.deps.pg`update platform.memberships set role = 'viewer' where user_id =
    (select id from platform.users where email = 'viewer-git@example.test')`;
  await api.deps.pg`delete from platform.memberships where user_id =
    (select id from platform.users where email = 'stranger-git@example.test')`;
});

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

const tx = <T>(fn: (t: TxCtx) => Promise<T>) => withTx(api.deps.db, api.deps.bus, fn);

async function addSystem(name = "Стоматология «Улыбка»"): Promise<{ id: string; slug: string }> {
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `g-${key}`,
      schema_key: key,
      name,
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning(["id", "slug"])
    .executeTakeFirstOrThrow();
  return row;
}

async function buildRun(systemId: string, mode: "create" | "change"): Promise<string> {
  const row = await api.deps.db
    .insertInto("platform.runs")
    .values({
      org_id: DEFAULT_ORG_ID,
      system_id: systemId,
      kind: "build",
      mode,
      status: "succeeded",
      input: json({}),
      started_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The forum example as the builder's ops batches (tools/fixtures/lib/spec-to-ops.mjs). */
async function forumBatches(): Promise<unknown[][]> {
  const lib = (await import(join(ROOT, "tools/fixtures/lib/spec-to-ops.mjs"))) as {
    specToOps(spec: unknown, o: { author: string }): unknown[];
    batchOps(ops: unknown[]): unknown[][];
  };
  const spec = JSON.parse(await readFile(join(ROOT, "specs/appspec/examples/forum.json"), "utf8"));
  return lib.batchOps(lib.specToOps(spec, { author: "agent" }));
}

const example = (p: string) => readFile(join(ROOT, "specs/runtime/examples", p), "utf8");
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

async function commits(systemId: string) {
  return api.deps.pg<
    { seq: number; oid: string; revision: number | null; brief_version: number | null; subject: string }[]
  >`
    select seq, oid, revision, brief_version, subject from platform.system_git_commits
     where system_id = ${systemId} order by seq`;
}

async function treeAt(systemId: string, oid: string) {
  const c = await readObject(api.deps.db, systemId, oid);
  if (!c) throw new Error("no commit");
  const data = parseCommit(c.body);
  return { commit: data, files: await readTreeFlat(api.deps.db, systemId, data.tree) };
}

async function fileAt(systemId: string, oid: string, path: string): Promise<string> {
  const { files } = await treeAt(systemId, oid);
  const f = files.get(path);
  if (!f) throw new Error(`no ${path}`);
  return ((await readObject(api.deps.db, systemId, f.oid))?.body ?? Buffer.alloc(0)).toString("utf8");
}

/** A system through an interview brief, a build (ops + files), an owner's edit, a revert and a later brief edit. */
async function scenarioSystem() {
  const sys = await addSystem();
  const brief = dentalBrief() as SystemBrief;
  brief.qa = [
    ...brief.qa,
    { q: "Телефон для записи?", a: `Звоните ${PHONE}`, recommended: "—", chosen: "custom" },
  ];
  await saveBriefVersion(api.deps.db, { systemId: sys.id, brief, author: "agent" });
  const run = await buildRun(sys.id, "create");
  let version = 0;
  for (const [i, ops] of (await forumBatches()).entries()) {
    const r = await tx((t) =>
      applyOpsRevision(t, api.deps.blobs, {
        systemId: sys.id,
        ops,
        expectedVersion: version,
        kind: "ops",
        author: "agent",
        runId: run,
        idempotencyKey: `${run}:ops_${i}`,
      }),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    version = r.version;
  }
  const landing0 = await example("ui/Landing.tsx");
  const fn = await example("functions/registerTicket.ts");
  const files = await tx((t) =>
    commitFilesRevision(t, api.deps.blobs, {
      systemId: sys.id,
      runId: run,
      author: "agent",
      changes: [
        { path: "ui/Landing.tsx", content: Buffer.from(landing0) },
        { path: "functions/registerTicket.ts", content: Buffer.from(fn) },
        {
          path: "ui/design.css",
          content: Buffer.from(":root {\n  --color-accent: oklch(0.6 0.15 250);\n}\n"),
        },
        { path: "assets/logo.png", content: PNG },
      ],
      summaryRu: "Экраны и функции",
    }),
  );
  const landing = (await example("ui/Landing.tsx")).replace(
    "export default",
    "// Правка владельца\nexport default",
  );
  const edit = await tx((t) =>
    commitFilesRevision(t, api.deps.blobs, {
      systemId: sys.id,
      author: "user",
      authorUserId: DEV_USER_ID,
      changes: [{ path: "ui/Landing.tsx", content: Buffer.from(landing) }],
    }),
  );
  const revert = await tx((t) =>
    revertRevision(t, {
      systemId: sys.id,
      toVersion: files.version,
      authorUserId: DEV_USER_ID,
      blobs: api.deps.blobs,
    }),
  );
  return { ...sys, run, opsVersions: version, files: files.version, edit: edit.version, revert, landing };
}

describe("revision = commit; the repository layout", () => {
  let s: Awaited<ReturnType<typeof scenarioSystem>>;
  beforeAll(async () => {
    s = await scenarioSystem();
  }, 60_000);

  test("one commit per revision in the revision's transaction, the brief version before them; main = the last", async () => {
    const rows = await commits(s.id);
    const revs = await api.deps.pg<{ version: number }[]>`
      select version from platform.revisions where system_id = ${s.id} order by version`;
    expect(revs.length).toBe(s.revert);
    // Brief v1 (interview) first, then every revision in order — nothing caught up by a read yet.
    expect(rows[0]).toMatchObject({ seq: 1, revision: null, brief_version: 1 });
    expect(rows.slice(1).map((r) => r.revision)).toEqual(revs.map((r) => r.version));
    expect(rows.every((r) => r.seq === rows.indexOf(r) + 1)).toBe(true);
    const [main] = await api.deps.pg<{ oid: string }[]>`
      select oid from platform.system_git_refs where system_id = ${s.id} and name = 'refs/heads/main'`;
    expect(main?.oid).toBe(rows.at(-1)?.oid);
    // Each commit's parent is the previous one: a single line of history.
    for (const [i, r] of rows.entries()) {
      const { commit } = await treeAt(s.id, r.oid);
      expect(commit.parents).toEqual(i === 0 ? [] : [rows[i - 1]?.oid]);
    }
  });

  test("messages: «Бриф», «Сборка», «Правка», «Возврат»; author Wizard, acting user in a trailer", async () => {
    const rows = await commits(s.id);
    const byRev = (v: number) => rows.find((r) => r.revision === v);
    expect(rows[0]?.subject).toMatch(/^Бриф: версия 1/);
    expect(byRev(1)?.subject).toMatch(/^Сборка: /);
    expect(byRev(s.files)?.subject).toBe("Сборка: Экраны и функции");
    expect(byRev(s.edit)?.subject).toBe("Правка: Файлы: ui/Landing.tsx");
    expect(byRev(s.revert)?.subject).toBe(`Возврат: к ревизии ${s.files}`);
    const { commit } = await treeAt(s.id, byRev(1)?.oid as string);
    expect(commit.author).toMatchObject({ name: "Wizard", email: "noreply@borntobuild.ru", tz: "+0300" });
    expect(commit.committer.name).toBe("Wizard");
    expect(parseTrailers(commit.message)).toEqual({
      "Wizard-Revision": "1",
      "Wizard-Brief-Version": "1",
      "Wizard-Run": s.run,
      "Wizard-User": DEV_USER_ID,
    });
    const created = await api.deps.pg<{ created_at: Date }[]>`
      select created_at from platform.revisions where system_id = ${s.id} and version = 1`;
    expect(commit.author.time).toBe(Math.floor(new Date(created[0]?.created_at ?? 0).getTime() / 1000));
  });

  test("tree: brief, spec, ui with tokens, functions, assets, tests, AGENTS.md — the stored files byte for byte", async () => {
    const row = await findCommitRow(api.deps.db, s.id, { revision: s.edit });
    const { files } = await treeAt(s.id, row?.oid as string);
    expect([...files.keys()].sort()).toEqual(
      [
        AGENTS_FILE,
        "assets/logo.png",
        BRIEF_FILE,
        "functions/registerTicket.ts",
        SPEC_FILE,
        SCENARIOS_FILE,
        "tests/acceptance.json",
        "ui/Landing.tsx",
        "ui/design.css",
      ].sort(),
    );
    expect(await fileAt(s.id, row?.oid as string, "ui/Landing.tsx")).toBe(s.landing);
    const logo = await readObject(api.deps.db, s.id, files.get("assets/logo.png")?.oid as string);
    expect(Buffer.compare(logo?.body as Buffer, PNG)).toBe(0);
    const [rev] = await api.deps.pg<{ spec: unknown }[]>`
      select spec from platform.revisions where system_id = ${s.id} and version = ${s.edit}`;
    expect(JSON.parse(await fileAt(s.id, row?.oid as string, SPEC_FILE))).toEqual(rev?.spec);
    const scenarios = JSON.parse(await fileAt(s.id, row?.oid as string, SCENARIOS_FILE));
    expect(scenarios).toMatchObject({ source: "brief", briefVersion: 1 });
    expect(scenarios.scenarios.map((x: { id: string }) => x.id)).toEqual(
      dentalBrief().scenarios?.map((x) => x.id),
    );
    // The revert has the files of the reverted-to revision.
    const back = await findCommitRow(api.deps.db, s.id, { revision: s.revert });
    expect(await fileAt(s.id, back?.oid as string, "ui/Landing.tsx")).toBe(await example("ui/Landing.tsx"));
  });

  test("no personal data and no secrets: the brief is scrubbed, AGENTS.md is Russian structure only", async () => {
    const head = (await commits(s.id)).at(-1)?.oid as string;
    const brief = await fileAt(s.id, head, BRIEF_FILE);
    expect(brief).not.toContain("916");
    expect(JSON.parse(brief).qa.at(-1).a).toMatch(/^Звоните \[/);
    const agents = await fileAt(s.id, head, AGENTS_FILE);
    // The name of the revision's spec (set_app), not the platform row: a replayed commit stays the same.
    expect(agents).toMatch(/^# Форум «Северный ритейл»\n/);
    for (const part of [
      "## Как устроен репозиторий",
      "`brief/brief.json`",
      "`spec/appspec.json`",
      "`ui/design.css`",
      "`functions/`",
      "`tests/scenarios.json`",
      "## Как запускать проверки",
      "secret://",
    ])
      expect(agents).toContain(part);
    expect(agents).not.toContain("916");
    const all = await api.deps.pg<{ data: Buffer }[]>`
      select data from platform.system_git_objects where system_id = ${s.id}`;
    for (const o of all) expect(inflateObject(o.data).body.toString("utf8")).not.toContain("916 123");
  });

  test("a brief edit after the build is a commit «Бриф: версия 2» once the owner reads the repository", async () => {
    const edited = { ...(dentalBrief() as SystemBrief), audience: "Жители района и соседних улиц" };
    await saveBriefVersion(api.deps.db, {
      systemId: s.id,
      brief: edited,
      author: "owner",
      authorUserId: DEV_USER_ID,
    });
    const before = (await commits(s.id)).length;
    const repo = await api.req("GET", `/systems/${s.id}/repo`);
    expect(repo.status, repo.text).toBe(200);
    expectContract("getSystemRepo", repo);
    expect(repo.body.behind).toBe(false);
    const rows = await commits(s.id);
    expect(rows.length).toBe(before + 1);
    const last = rows.at(-1);
    expect(last).toMatchObject({ revision: null, brief_version: 2 });
    expect(last?.subject).toMatch(/^Бриф: версия 2 — /);
    expect(JSON.parse(await fileAt(s.id, last?.oid as string, BRIEF_FILE)).audience).toBe(edited.audience);
    // The spec and the files stay those of the last revision.
    const prev = rows.at(-2)?.oid as string;
    expect(await fileAt(s.id, last?.oid as string, SPEC_FILE)).toBe(await fileAt(s.id, prev, SPEC_FILE));
    expect(repo.body.head.oid).toBe(last?.oid);
    expect(repo.body.refs.main).toEqual({ oid: last?.oid, revision: null });
    expect(repo.body.commits).toBe(rows.length);
    // Idempotent: nothing more to commit.
    expect(await syncRepo(api.deps.db, api.deps.blobs, s.id)).toMatchObject({ commits: 0 });
  });

  test.skipIf(!HAS_GIT)(
    "git itself accepts the repository: fsck, log, cat-file, numstat, apply",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "wz-git-"));
      const work = await mkdtemp(join(tmpdir(), "wz-git-work-"));
      try {
        const objects = await api.deps.pg<{ oid: string; data: Buffer }[]>`
        select oid, data from platform.system_git_objects where system_id = ${s.id}`;
        for (const o of objects) {
          const p = join(dir, "objects", o.oid.slice(0, 2), o.oid.slice(2));
          await mkdir(dirname(p), { recursive: true });
          await writeFile(p, o.data);
        }
        const refs = await api.deps.pg<{ name: string; oid: string }[]>`
        select name, oid from platform.system_git_refs where system_id = ${s.id}`;
        for (const r of refs) {
          await mkdir(dirname(join(dir, r.name)), { recursive: true });
          await writeFile(join(dir, r.name), `${r.oid}\n`);
        }
        await writeFile(join(dir, "HEAD"), "ref: refs/heads/main\n");
        await writeFile(join(dir, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = true\n");
        const git = (args: string[], cwd?: string) => {
          const r = spawnSync("git", [`--git-dir=${dir}`, ...args], {
            encoding: "utf8",
            env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir, LC_ALL: "C" },
            ...(cwd ? { cwd } : {}),
          });
          expect(r.status, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
          return r.stdout;
        };
        git(["fsck", "--strict", "--full"]);
        const rows = await commits(s.id);
        expect(git(["log", "--format=%H %s", "main"]).trim().split("\n").reverse()).toEqual(
          rows.map((r) => `${r.oid} ${r.subject}`),
        );
        const head = rows.at(-1)?.oid as string;
        expect(git(["cat-file", "-p", `${head}:${SPEC_FILE}`])).toBe(await fileAt(s.id, head, SPEC_FILE));
        // Our diff of the owner's edit: the same counts as git's minimal diff, and git applies our patch.
        const edit = rows.find((r) => r.revision === s.edit)?.oid as string;
        const res = await api.req("GET", `/systems/${s.id}/repo/diff?commit=${edit}`);
        expect(res.status).toBe(200);
        const numstat = git(["diff", "--numstat", "--minimal", `${edit}~1`, edit]).trim();
        expect(numstat).toBe(
          res.body.files
            .map(
              (f: { additions: number; deletions: number; path: string }) =>
                `${f.additions}\t${f.deletions}\t${f.path}`,
            )
            .join("\n"),
        );
        await mkdir(join(work, "ui"), { recursive: true });
        await writeFile(join(work, "ui/Landing.tsx"), await example("ui/Landing.tsx"));
        await writeFile(join(work, "fix.patch"), res.body.files[0].patch);
        const applied = spawnSync("git", ["apply", "fix.patch"], {
          cwd: work,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            HOME: work,
            GIT_CEILING_DIRECTORIES: dirname(work),
          },
        });
        expect(applied.status, applied.stderr).toBe(0);
        expect(await readFile(join(work, "ui/Landing.tsx"), "utf8")).toBe(s.landing);
      } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
      }
    },
  );
});

describe("read API for the owner", () => {
  let s: Awaited<ReturnType<typeof scenarioSystem>>;
  beforeAll(async () => {
    s = await scenarioSystem();
  }, 60_000);

  test("commits newest first with paging; revision ↔ commit", async () => {
    const all = await commits(s.id);
    const page = await api.req("GET", `/systems/${s.id}/repo/commits?limit=2`);
    expect(page.status).toBe(200);
    expectContract("listSystemRepoCommits", page);
    expect(page.body.commits.map((c: { oid: string }) => c.oid)).toEqual([all.at(-1)?.oid, all.at(-2)?.oid]);
    expect(page.body.nextBefore).toBe(all.length - 1);
    const next = await api.req(
      "GET",
      `/systems/${s.id}/repo/commits?limit=100&before=${page.body.nextBefore}`,
    );
    expect(next.body.commits).toHaveLength(all.length - 2);
    expect(next.body.nextBefore).toBeNull();
    expect(page.body.commits[0]).toMatchObject({
      revision: s.revert,
      briefVersion: 1,
      author: { name: "Wizard" },
      userId: DEV_USER_ID,
    });

    const map = await api.req("GET", `/systems/${s.id}/repo/revisions/${s.edit}`);
    expect(map.status).toBe(200);
    expectContract("getSystemRepoRevisionCommit", map);
    expect(map.body.commit.oid).toBe(all.find((r) => r.revision === s.edit)?.oid);
    const none = await api.req("GET", `/systems/${s.id}/repo/revisions/999`);
    expect(none.status).toBe(404);
    expect(none.body.message_ru).toBe("Коммит ревизии не найден");
  });

  test("diff of a revision: changed files with git patches; the first commit against the empty tree", async () => {
    const res = await api.req("GET", `/systems/${s.id}/repo/diff?revision=${s.files}`);
    expect(res.status, res.text).toBe(200);
    expectContract("getSystemRepoDiff", res);
    const byPath = Object.fromEntries(res.body.files.map((f: { path: string }) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(
      [
        "AGENTS.md",
        "assets/logo.png",
        "functions/registerTicket.ts",
        "ui/Landing.tsx",
        "ui/design.css",
      ].sort(),
    );
    expect(byPath["assets/logo.png"]).toMatchObject({ status: "added", binary: true, patch: null });
    expect(byPath["ui/design.css"]).toMatchObject({ status: "added", additions: 3, deletions: 0 });
    expect(byPath["ui/design.css"].patch).toBe(
      "diff --git a/ui/design.css b/ui/design.css\nnew file mode 100644\n--- /dev/null\n+++ b/ui/design.css\n" +
        "@@ -0,0 +1,3 @@\n+:root {\n+  --color-accent: oklch(0.6 0.15 250);\n+}\n",
    );
    const edit = await api.req("GET", `/systems/${s.id}/repo/diff?revision=${s.edit}`);
    expect(edit.body.files).toHaveLength(1);
    expect(edit.body.files[0]).toMatchObject({
      path: "ui/Landing.tsx",
      status: "modified",
      additions: 1,
      deletions: 0,
    });
    expect(edit.body.files[0].patch).toContain("+// Правка владельца\n");
    const first = await api.req("GET", `/systems/${s.id}/repo/diff?commit=${(await commits(s.id))[0]?.oid}`);
    expect(first.body.parent).toBeNull();
    expect(first.body.files.map((f: { status: string }) => f.status)).toEqual(["added", "added", "added"]);
    const both = await api.req("GET", `/systems/${s.id}/repo/diff?revision=1&commit=${"a".repeat(40)}`);
    expect(both.status).toBe(400);
    const bad = await api.req("GET", `/systems/${s.id}/repo/diff?commit=xyz`);
    expect(bad.status).toBe(400);
    const missing = await api.req("GET", `/systems/${s.id}/repo/diff?commit=${"a".repeat(40)}`);
    expect(missing.status).toBe(404);
  });

  test("archive: zip of the tree of a revision (default — the head)", async () => {
    const res = await api.req("GET", `/systems/${s.id}/repo/archive?revision=${s.edit}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${s.slug}-r${s.edit}.zip"`);
    const raw = await api.fetch(
      new Request(`http://localhost:4000/api/v1/systems/${s.id}/repo/archive?revision=${s.edit}`, {
        headers: { host: "localhost:4000" },
      }),
    );
    const entries = unzipSync(new Uint8Array(await raw.arrayBuffer()));
    const prefix = `${s.slug}-r${s.edit}/`;
    expect(Object.keys(entries).every((k) => k.startsWith(prefix))).toBe(true);
    expect(Buffer.from(entries[`${prefix}ui/Landing.tsx`] as Uint8Array).toString("utf8")).toBe(s.landing);
    expect(Buffer.compare(Buffer.from(entries[`${prefix}assets/logo.png`] as Uint8Array), PNG)).toBe(0);
    expect(entries[`${prefix}AGENTS.md`]).toBeDefined();
    const head = await api.req("GET", `/systems/${s.id}/repo/archive`);
    expect(head.headers.get("content-disposition")).toBe(`attachment; filename="${s.slug}-r${s.revert}.zip"`);
  });

  test("access: viewer reads; another org's user and an unknown system get 404", async () => {
    expect((await api.req("GET", `/systems/${s.id}/repo/commits`, { headers: VIEWER })).status).toBe(200);
    for (const path of ["repo", "repo/commits", "repo/diff", "repo/archive", "repo/revisions/1"]) {
      const res = await api.req("GET", `/systems/${s.id}/${path}`, { headers: STRANGER });
      expect(res.status, path).toBe(404);
    }
    expect((await api.req("GET", `/systems/${randomUUID()}/repo`)).status).toBe(404);
  });
});

describe("catching up and resilience", () => {
  test("a system older than the repository: the first read commits its revisions and brief in write order", async () => {
    const sys = await addSystem("Старая система");
    // Revisions and a brief version written behind the hook's back (as before migration 0040): no commits.
    const spec = JSON.stringify(emptySpec("Старая система"));
    const emptyManifest = createHash("sha256").update("{}").digest("hex");
    for (const v of [1, 2])
      await api.deps.pg`
        insert into platform.revisions
          (system_id, version, parent_version, kind, author, spec, files_manifest_sha, summary_ru, created_at)
        values (${sys.id}, ${v}, ${v === 1 ? null : 1}, 'ops', 'agent', cast(cast(${spec} as text) as jsonb), ${emptyManifest},
                ${`Шаг ${v}`}, now() - make_interval(mins => ${10 - v}))`;
    await api.deps.pg`update platform.systems set draft_revision = 2 where id = ${sys.id}`;
    await api.deps.pg`
      insert into platform.system_briefs (system_id, version, brief, author, created_at)
      values (${sys.id}, 1, cast(cast(${JSON.stringify(systemBriefSchema.parse(dentalBrief()))} as text) as jsonb), 'agent',
              now() - interval '8 minutes 30 seconds')`;
    expect(await commits(sys.id)).toEqual([]);
    const repo = await api.req("GET", `/systems/${sys.id}/repo`);
    expect(repo.body.behind).toBe(false);
    expect((await commits(sys.id)).map((r) => [r.revision, r.brief_version])).toEqual([
      [1, null],
      [null, 1],
      [2, 1],
    ]);
    expect(repo.body.commits).toBe(3);
  });

  test("a failing commit never loses the revision; the repository catches up later", async () => {
    const sys = await addSystem("Сбой коммита");
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.message);
    process.on("warning", onWarning);
    try {
      const first = await tx((t) =>
        commitFilesRevision(t, api.deps.blobs, {
          systemId: sys.id,
          author: "agent",
          changes: [
            {
              path: "ui/Home.tsx",
              content: Buffer.from("export default function Home() { return null; }\n"),
            },
          ],
        }),
      );
      // The repository row of revision 1 is lost (e.g. a failed sync): revision 2 must still commit both.
      await api.deps.pg`delete from platform.system_git_commits where system_id = ${sys.id}`;
      await api.deps.pg`delete from platform.system_git_refs where system_id = ${sys.id}`;
      // Break the stored file of revision 1: the catch-up inside revision 2's transaction fails under its savepoint.
      const [m] = await api.deps.pg<{ sha: string }[]>`
        select files_manifest_sha as sha from platform.revisions where system_id = ${sys.id} and version = ${first.version}`;
      const manifest = JSON.parse((await api.deps.blobs.get(m?.sha as string)).toString("utf8"));
      const fileSha = manifest["ui/Home.tsx"] as string;
      await api.deps.pg`delete from platform.system_git_objects where system_id = ${sys.id}`;
      const path = join(api.deps.blobs.root, `blobs/${fileSha.slice(0, 2)}/${fileSha.slice(2)}`);
      const saved = await readFile(path);
      await writeFile(path, "испорчено");
      const second = await tx((t) =>
        commitFilesRevision(t, api.deps.blobs, {
          systemId: sys.id,
          author: "user",
          authorUserId: DEV_USER_ID,
          changes: [
            {
              path: "ui/About.tsx",
              content: Buffer.from("export default function About() { return null; }\n"),
            },
          ],
        }),
      );
      expect(second.version).toBe(first.version + 1);
      expect(await commits(sys.id)).toEqual([]);
      await new Promise((r) => setImmediate(r));
      expect(warnings.some((w) => w.includes(sys.id))).toBe(true);
      // The file is back: a read catches both revisions up.
      await writeFile(path, saved);
      expect(await ensureRepo(api.deps.db, api.deps.blobs, sys.id)).toBe(false);
      expect((await commits(sys.id)).map((r) => r.revision)).toEqual([1, 2]);
    } finally {
      process.off("warning", onWarning);
    }
  });
});

describe("object format", () => {
  test("blob, tree and commit ids are git's; trees sort directories as «name/»", () => {
    // `printf 'hello\n' | git hash-object --stdin` and the empty tree of git.
    expect(hashObject("blob", Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(buildTrees(new Map()).root).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    const blob = makeObject("blob", Buffer.from("x")).oid;
    const body = encodeTree([
      { mode: "100644", name: "a.b", oid: blob },
      { mode: "40000", name: "a", oid: buildTrees(new Map()).root },
      { mode: "100644", name: "a-c", oid: blob },
    ]);
    expect(parseTree(body).map((e) => e.name)).toEqual(["a-c", "a.b", "a"]);
    const { root, trees } = buildTrees(
      new Map([
        ["ui/a.tsx", { oid: blob }],
        ["ui/pages/b.tsx", { oid: blob }],
        ["AGENTS.md", { oid: blob }],
      ]),
    );
    expect(trees.at(-1)?.oid).toBe(root);
    expect(trees).toHaveLength(3);
  });

  test("myers hunks: context, line numbers, missing newline at the end", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `${i + 1}`);
    const a = `${lines.join("\n")}\n`;
    const b = `${lines.map((l) => (l === "4" ? "четыре" : l)).join("\n")}\n13`;
    expect(unifiedHunks(a, b)).toEqual({
      hunks:
        "@@ -1,7 +1,7 @@\n 1\n 2\n 3\n-4\n+четыре\n 5\n 6\n 7\n@@ -10,3 +10,4 @@\n 10\n 11\n 12\n+13\n" +
        "\\ No newline at end of file\n",
      additions: 2,
      deletions: 1,
    });
    // Context windows that touch (≤ 6 equal lines between changes) make one hunk, as in git; 7 lines — two.
    expect(unifiedHunks("1\n2\n3\n4\n5\n6\n", "0\n1\n2\n3\n4\n5\n6\n7\n").hunks).toBe(
      "@@ -1,6 +1,8 @@\n+0\n 1\n 2\n 3\n 4\n 5\n 6\n+7\n",
    );
    expect(unifiedHunks("1\n2\n3\n4\n5\n6\n7\n", "0\n1\n2\n3\n4\n5\n6\n7\n8\n").hunks).toBe(
      "@@ -1,3 +1,4 @@\n+0\n 1\n 2\n 3\n@@ -5,3 +6,4 @@\n 5\n 6\n 7\n+8\n",
    );
    expect(unifiedHunks("same\n", "same\n")).toEqual({ hunks: "", additions: 0, deletions: 0 });
    expect(unifiedHunks("a\nb\n", "")).toEqual({
      hunks: "@@ -1,2 +0,0 @@\n-a\n-b\n",
      additions: 0,
      deletions: 2,
    });
  });
});

describe("delete_system", () => {
  test("the repository (objects, refs, commits) goes with the system", async () => {
    const s = await scenarioSystem();
    expect((await commits(s.id)).length).toBeGreaterThan(0);
    await api.deps.pg`update platform.systems set deleted_at = now() - interval '31 days' where id = ${s.id}`;
    const purged = await purgeDeletedSystems({
      db: api.deps.db,
      pg: api.deps.pg,
      blobs: api.deps.blobs,
      config: api.deps.config,
      files: new MemoryFileStorage(),
    });
    expect(purged.map((p) => p.systemId)).toContain(s.id);
    for (const table of ["system_git_objects", "system_git_refs", "system_git_commits"]) {
      const [n] = await api.deps.pg.unsafe<{ n: number }[]>(
        `select count(*)::int as n from platform.${table} where system_id = $1`,
        [s.id],
      );
      expect(n?.n, table).toBe(0);
    }
  }, 60_000);
});
