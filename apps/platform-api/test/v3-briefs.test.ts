// V3-02 acceptance, platform part (builder-v3.md §3 C1, db.yaml#system_briefs): every edit of the system brief — by the
// agent or by the owner — is a new version with its diff by fields; the build stages read the latest version before each
// stage; /systems/:id/brief* serve the brief with its diagrams, the history and the owner's edit with access checks.
import { randomUUID } from "node:crypto";
import { briefDiff, type SystemBrief, systemBriefSchema } from "@wizard/appspec";
import { MemoryFileStorage } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dentalBrief, shopBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import {
  BriefConflictError,
  BriefInvalidError,
  getLatestBrief,
  listBriefVersions,
  saveBriefVersion,
} from "../src/briefs/store.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { purgeDeletedSystems } from "../src/privacy/delete-system.js";
import { createTestDb, fakeExecutors, startApi, type TestApi } from "./helpers.js";

const EDITOR = { "x-wizard-dev-user": "editor-brief@example.test" };
const VIEWER = { "x-wizard-dev-user": "viewer-brief@example.test" };
const STRANGER = { "x-wizard-dev-user": "stranger-brief@example.test" };
const CYRILLIC = /[а-яё]/i;

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;

beforeAll(async () => {
  tdb = await createTestDb("v3brief");
  api = await startApi(tdb.url, { executors: fakeExecutors() });
  // The dev user owns the default org; new dev users join it as editors: one becomes a viewer, one leaves.
  for (const h of [EDITOR, VIEWER, STRANGER])
    expect((await api.req("GET", "/me", { headers: h })).status).toBe(200);
  await api.deps.pg`update platform.memberships set role = 'viewer' where user_id =
    (select id from platform.users where email = 'viewer-brief@example.test')`;
  await api.deps.pg`delete from platform.memberships where user_id =
    (select id from platform.users where email = 'stranger-brief@example.test')`;
});

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

async function addSystem(name = "Стоматология"): Promise<string> {
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `b-${key}`,
      schema_key: key,
      name,
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

const parse = (b: unknown): SystemBrief => systemBriefSchema.parse(b);

describe("store: versions with the diff by fields", () => {
  test("agent writes version 1, owner edits → version 2 with its diff; an equal brief adds no version", async () => {
    const id = await addSystem();
    expect(await getLatestBrief(api.deps.db, id)).toBeNull();
    const v1 = await saveBriefVersion(api.deps.db, { systemId: id, brief: dentalBrief(), author: "agent" });
    expect(v1.changed).toBe(true);
    expect(v1.version).toMatchObject({ version: 1, author: "agent", brief: parse(dentalBrief()) });
    expect(v1.version.diff).toEqual(briefDiff(null, parse(dentalBrief())));
    expect(v1.version.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    const same = await saveBriefVersion(api.deps.db, { systemId: id, brief: dentalBrief(), author: "owner" });
    expect(same).toEqual({ changed: false, version: v1.version });

    const edited = { ...dentalBrief(), audience: "Жители района и соседних улиц" };
    const v2 = await saveBriefVersion(api.deps.db, {
      systemId: id,
      brief: edited,
      author: "owner",
      authorUserId: DEV_USER_ID,
      baseVersion: 1,
    });
    expect(v2.version.version).toBe(2);
    expect(v2.version.diff).toEqual([
      {
        field: "audience",
        op: "changed",
        before: "Жители района 25–55 лет, семьи с детьми; записываются с телефона вечером",
        after: "Жители района и соседних улиц",
        text_ru: "Аудитория: изменено",
      },
    ]);
    expect((await getLatestBrief(api.deps.db, id))?.brief.audience).toBe("Жители района и соседних улиц");
    const history = await listBriefVersions(api.deps.db, id);
    expect(history.map((h) => [h.version, h.author, h.diff.length])).toEqual([
      [2, "owner", 1],
      [1, "agent", v1.version.diff.length],
    ]);
    expect(history[0]).not.toHaveProperty("brief");
    const rows = await api.deps.pg<{ version: number; author_user_id: string | null }[]>`
      select version, author_user_id from platform.system_briefs where system_id = ${id} order by version`;
    expect(rows).toEqual([
      { version: 1, author_user_id: null },
      { version: 2, author_user_id: DEV_USER_ID },
    ]);
  });

  test("an invalid brief is rejected with Russian errors and writes nothing; a stale baseVersion conflicts", async () => {
    const id = await addSystem();
    const bad = { ...dentalBrief(), goals: [{ id: "g", text: "", success: "Успех" }] };
    const err = await saveBriefVersion(api.deps.db, { systemId: id, brief: bad, author: "agent" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(BriefInvalidError);
    expect((err as BriefInvalidError).errors[0]).toMatchObject({ path: "/goals/0/text" });
    expect((err as BriefInvalidError).errors[0]?.message_ru).toMatch(CYRILLIC);
    expect(await getLatestBrief(api.deps.db, id)).toBeNull();

    await saveBriefVersion(api.deps.db, {
      systemId: id,
      brief: shopBrief(),
      author: "agent",
      baseVersion: 0,
    });
    const stale = await saveBriefVersion(api.deps.db, {
      systemId: id,
      brief: dentalBrief(),
      author: "owner",
      baseVersion: 0,
    }).catch((e) => e);
    expect(stale).toBeInstanceOf(BriefConflictError);
    expect((stale as BriefConflictError).latest).toBe(1);
  });

  test("concurrent writers get consecutive versions", async () => {
    const id = await addSystem();
    const saved = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        saveBriefVersion(api.deps.db, {
          systemId: id,
          brief: { ...shopBrief(), audience: `Аудитория ${i}` },
          author: "agent",
        }),
      ),
    );
    expect(saved.map((s) => s.version.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    const history = await listBriefVersions(api.deps.db, id, { limit: 2, before: 5 });
    expect(history.map((h) => h.version)).toEqual([4, 3]);
  });

  test("build stages read the latest brief before each stage: edits made during the build reach the next stage", async () => {
    const id = await addSystem();
    await saveBriefVersion(api.deps.db, { systemId: id, brief: dentalBrief(), author: "agent" });
    // C6 stages; between them the owner edits in the panel and the agent records the answer to a build question.
    const stages = [
      "brief",
      "design",
      "skeleton",
      "scenarios",
      "critic",
      "template_gate",
      "techreview",
      "gates",
    ];
    const seen: { stage: string; version: number; audience: string; qa: number }[] = [];
    for (const stage of stages) {
      const brief = await getLatestBrief(api.deps.db, id);
      if (!brief) throw new Error("no brief");
      seen.push({ stage, version: brief.version, audience: brief.brief.audience, qa: brief.brief.qa.length });
      if (stage === "design") {
        const r = await api.req("PUT", `/systems/${id}/brief`, {
          body: { baseVersion: brief.version, brief: { ...brief.brief, audience: "Семьи с детьми" } },
        });
        expect(r.status).toBe(200);
      }
      if (stage === "critic") {
        const qa = [
          ...brief.brief.qa,
          { q: "Показывать цены на сайте?", a: "Да", recommended: "Да", chosen: "recommended" as const },
        ];
        await saveBriefVersion(api.deps.db, { systemId: id, brief: { ...brief.brief, qa }, author: "agent" });
      }
    }
    expect(seen.map((s) => [s.stage, s.version])).toEqual([
      ["brief", 1],
      ["design", 1],
      ["skeleton", 2],
      ["scenarios", 2],
      ["critic", 2],
      ["template_gate", 3],
      ["techreview", 3],
      ["gates", 3],
    ]);
    expect(seen[2]?.audience).toBe("Семьи с детьми");
    expect(seen.at(-1)).toMatchObject({ audience: "Семьи с детьми", qa: 3 });
  });
});

describe("/systems/:id/brief*", () => {
  test("read before the interview, the owner's first edit, an equal edit, the diagrams", async () => {
    const id = await addSystem();
    const none = await api.req("GET", `/systems/${id}/brief`);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ brief: null, diagrams: null });
    expect((await api.req("GET", `/systems/${id}/brief/versions`)).body).toEqual({
      versions: [],
      nextBefore: null,
    });

    const put = await api.req("PUT", `/systems/${id}/brief`, {
      body: { baseVersion: 0, brief: dentalBrief() },
    });
    expect(put.status).toBe(200);
    expect(put.body.changed).toBe(true);
    expect(put.body.brief).toMatchObject({ version: 1, author: "owner", brief: parse(dentalBrief()) });
    expect(Object.keys(put.body.diagrams)).toEqual(["journey", "dataRoles", "integrations"]);
    expect(
      put.body.diagrams.journey.nodes.filter((n: { kind: string }) => n.kind === "scenario"),
    ).toHaveLength(4);

    const again = await api.req("PUT", `/systems/${id}/brief`, {
      body: { baseVersion: 1, brief: dentalBrief() },
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ changed: false, brief: { version: 1 } });

    const got = await api.req("GET", `/systems/${id}/brief`);
    expect(got.body).toEqual({ brief: put.body.brief, diagrams: put.body.diagrams });
    // A minimal brief still gets its three diagrams (placeholders).
    const min = await api.req("PUT", `/systems/${id}/brief`, { body: { baseVersion: 1, brief: {} } });
    expect(min.status).toBe(200);
    expect(min.body.brief.version).toBe(2);
    expect(min.body.diagrams.journey.nodes).toEqual([
      { id: "empty", label: "Сценарии пока не описаны", kind: "empty" },
    ]);
    expect(min.body.brief.diff.every((c: { op: string }) => c.op === "removed")).toBe(true);
  });

  test("versions: a given version, history newest first with pages", async () => {
    const id = await addSystem();
    for (const [i, audience] of ["Первая", "Вторая", "Третья"].entries()) {
      const r = await api.req("PUT", `/systems/${id}/brief`, {
        body: { baseVersion: i, brief: { ...shopBrief(), audience } },
      });
      expect(r.status).toBe(200);
    }
    const v2 = await api.req("GET", `/systems/${id}/brief?version=2`);
    expect(v2.status).toBe(200);
    expect(v2.body.brief).toMatchObject({ version: 2, brief: { audience: "Вторая" } });
    expect(v2.body.brief.diff).toEqual([
      expect.objectContaining({ field: "audience", before: "Первая", after: "Вторая" }),
    ]);
    expect((await api.req("GET", `/systems/${id}/brief?version=9`)).status).toBe(404);
    expect((await api.req("GET", `/systems/${id}/brief?version=abc`)).status).toBe(400);
    const page1 = await api.req("GET", `/systems/${id}/brief/versions?limit=2`);
    expect(page1.body.versions.map((v: { version: number }) => v.version)).toEqual([3, 2]);
    expect(page1.body.versions[0]).not.toHaveProperty("brief");
    expect(page1.body.nextBefore).toBe(2);
    const page2 = await api.req("GET", `/systems/${id}/brief/versions?limit=2&before=2`);
    expect(page2.body).toMatchObject({ versions: [{ version: 1, author: "owner" }], nextBefore: null });
  });

  test("invalid edits: Russian errors with the place, stale version, bad body, too large", async () => {
    const id = await addSystem();
    await api.req("PUT", `/systems/${id}/brief`, { body: { baseVersion: 0, brief: dentalBrief() } });
    const invalid = await api.req("PUT", `/systems/${id}/brief`, {
      body: {
        baseVersion: 1,
        brief: { ...dentalBrief(), goals: Array(11).fill({ id: "g", text: "Ц", success: "У" }) },
      },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      code: "VALIDATION_FAILED",
      message_ru: "Цели: слишком много элементов: максимум 10",
    });
    expect(invalid.body.details.errors[0]).toMatchObject({ code: "LIMIT_EXCEEDED", path: "/goals" });
    const stale = await api.req("PUT", `/systems/${id}/brief`, {
      body: { baseVersion: 0, brief: shopBrief() },
    });
    expect(stale.status).toBe(412);
    expect(stale.body).toEqual({
      code: "VERSION_CONFLICT",
      message_ru: "Бриф изменился — посмотрите новую версию",
      details: { version: 1 },
    });
    for (const body of [{ brief: shopBrief() }, { baseVersion: 1 }, { baseVersion: -1, brief: {} }]) {
      const r = await api.req("PUT", `/systems/${id}/brief`, { body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.message_ru).toMatch(CYRILLIC);
    }
    const notJson = await api.req("PUT", `/systems/${id}/brief`, {
      body: "{",
      headers: { "content-type": "application/json" },
    });
    expect(notJson.status).toBe(400);
    const huge = await api.req("PUT", `/systems/${id}/brief`, {
      body: { baseVersion: 1, brief: { audience: "а".repeat(600_000) } },
    });
    expect(huge.status).toBe(413);
    expect(huge.body.code).toBe("PAYLOAD_TOO_LARGE");
    expect((await getLatestBrief(api.deps.db, id))?.version).toBe(1);
  });

  test("access: viewer reads, editor edits as the owner side, another org and deleted systems are 404", async () => {
    const id = await addSystem();
    await api.req("PUT", `/systems/${id}/brief`, { body: { baseVersion: 0, brief: shopBrief() } });
    expect((await api.req("GET", `/systems/${id}/brief`, { headers: VIEWER })).status).toBe(200);
    expect((await api.req("GET", `/systems/${id}/brief/versions`, { headers: VIEWER })).status).toBe(200);
    const denied = await api.req("PUT", `/systems/${id}/brief`, {
      headers: VIEWER,
      body: { baseVersion: 1, brief: dentalBrief() },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("FORBIDDEN");
    const byEditor = await api.req("PUT", `/systems/${id}/brief`, {
      headers: EDITOR,
      body: { baseVersion: 1, brief: dentalBrief() },
    });
    expect(byEditor.status).toBe(200);
    expect(byEditor.body.brief).toMatchObject({ version: 2, author: "owner" });
    const [row] = await api.deps.pg<{ email: string }[]>`
      select u.email from platform.system_briefs b join platform.users u on u.id = b.author_user_id
      where b.system_id = ${id} and b.version = 2`;
    expect(row?.email).toBe("editor-brief@example.test");
    for (const [m, p] of [
      ["GET", `/systems/${id}/brief`],
      ["GET", `/systems/${id}/brief/versions`],
      ["PUT", `/systems/${id}/brief`],
    ] as const) {
      const r = await api.req(m, p, {
        headers: STRANGER,
        body: m === "PUT" ? { baseVersion: 2, brief: {} } : undefined,
      });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    expect((await api.req("GET", "/systems/not-a-uuid/brief")).status).toBe(404);
    expect((await api.req("GET", `/systems/${randomUUID()}/brief`)).status).toBe(404);
    await api.deps.pg`update platform.systems set deleted_at = now() where id = ${id}`;
    expect((await api.req("GET", `/systems/${id}/brief`)).status).toBe(404);
    expect(
      (await api.req("PUT", `/systems/${id}/brief`, { body: { baseVersion: 2, brief: {} } })).status,
    ).toBe(404);
  });

  test("delete_system purges the brief versions with the system", async () => {
    const id = await addSystem();
    await api.req("PUT", `/systems/${id}/brief`, { body: { baseVersion: 0, brief: shopBrief() } });
    await api.deps.pg`update platform.systems set deleted_at = now() - interval '31 days' where id = ${id}`;
    const purged = await purgeDeletedSystems({
      db: api.deps.db,
      pg: api.deps.pg,
      blobs: api.deps.blobs,
      config: api.deps.config,
      files: new MemoryFileStorage(),
    });
    expect(purged.map((p) => p.systemId)).toContain(id);
    const [left] = await api.deps.pg<{ n: number }[]>`
      select count(*)::int as n from platform.system_briefs where system_id = ${id}`;
    expect(left?.n).toBe(0);
  });
});
