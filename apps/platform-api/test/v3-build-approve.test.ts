// V3-06: «Собрать» of a v3 system — POST /systems/:id/brief/approve on startV3Build (V3-11): editor starts the build by
// the brief version he saw with the cap of a v3 build (100 credits = 500 ₽), a viewer gets 403, another org 404, a
// newer brief 412, no brief 409; the repeat with the same Idempotency-Key is the same answer and one run, a second
// start while the build runs is 409 SYSTEM_LOCKED. /fix of a failed v3 build takes the cap of a v3 build too.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dentalBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { V3_BUILD_CAP_CREDITS } from "../src/builds-v3/host.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { RunFailure } from "../src/runs/types.js";
import { createTestDb, fakeExecutors, startApi, type TestApi, waitFor, waitRun } from "./helpers.js";

const EDITOR = { "x-wizard-dev-user": "editor-approve@example.test" };
const VIEWER = { "x-wizard-dev-user": "viewer-approve@example.test" };
const STRANGER = { "x-wizard-dev-user": "stranger-approve@example.test" };

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
/** The fake v3 build waits for the test, then fails (so /fix has something to fix); a fix fails at once. */
let release: () => void = () => {};
let started = false;

beforeAll(async () => {
  tdb = await createTestDb("v3approve");
  api = await startApi(tdb.url, {
    executors: {
      ...fakeExecutors(),
      build: async (_host, params) => {
        if (params.mode !== "fix")
          await new Promise<void>((r) => {
            release = r;
            started = true;
          });
        throw new RunFailure("GATES_FAILED", "Проверки не пройдены", false);
      },
    },
  });
  for (const h of [EDITOR, VIEWER, STRANGER])
    expect((await api.req("GET", "/me", { headers: h })).status).toBe(200);
  await api.deps.pg`update platform.memberships set role = 'viewer' where user_id =
    (select id from platform.users where email = 'viewer-approve@example.test')`;
  await api.deps.pg`delete from platform.memberships where user_id =
    (select id from platform.users where email = 'stranger-approve@example.test')`;
}, 60_000);

afterAll(async () => {
  release();
  await api?.dispose();
  await tdb?.drop();
});

async function addSystem(): Promise<string> {
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `a-${key}`,
      schema_key: key,
      name: "Стоматология",
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

const runRow = (id: string) =>
  api.deps.db
    .selectFrom("platform.runs")
    .select(["kind", "mode", "status", "credits_cap_milli", "input", "started_by"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

describe("POST /systems/:id/brief/approve", () => {
  test("no brief 409; a viewer 403, another org 404; a newer brief 412", async () => {
    const id = await addSystem();
    const none = await api.req("POST", `/systems/${id}/brief/approve`, {
      body: { version: 1 },
      headers: EDITOR,
    });
    expect(none.status).toBe(409);
    expect(none.body.code).toBe("NO_PLAN");
    await saveBriefVersion(api.deps.db, { systemId: id, brief: dentalBrief(), author: "agent" });
    await saveBriefVersion(api.deps.db, {
      systemId: id,
      brief: { ...dentalBrief(), audience: "Жители района" },
      author: "agent",
    });
    const viewer = await api.req("POST", `/systems/${id}/brief/approve`, {
      body: { version: 2 },
      headers: VIEWER,
    });
    expect(viewer.status).toBe(403);
    const stranger = await api.req("POST", `/systems/${id}/brief/approve`, {
      body: { version: 2 },
      headers: STRANGER,
    });
    expect(stranger.status).toBe(404);
    expect(
      (await api.req("POST", `/systems/${randomUUID()}/brief/approve`, { body: { version: 1 } })).status,
    ).toBe(404);
    const stale = await api.req("POST", `/systems/${id}/brief/approve`, {
      body: { version: 1 },
      headers: EDITOR,
    });
    expect(stale.status).toBe(412);
    expect(stale.body).toMatchObject({ code: "VERSION_CONFLICT", details: { version: 2 } });
    expect(
      (await api.req("POST", `/systems/${id}/brief/approve`, { body: {}, headers: EDITOR })).status,
    ).toBe(400);
    const runs = await api.deps.db
      .selectFrom("platform.runs")
      .select("id")
      .where("system_id", "=", id)
      .execute();
    expect(runs).toEqual([]);
  });

  test("editor starts the v3 build (cap 100 credits); the same key replays it; a second start is locked; /fix of v3 takes the v3 cap", async () => {
    const id = await addSystem();
    await saveBriefVersion(api.deps.db, { systemId: id, brief: dentalBrief(), author: "agent" });
    const key = randomUUID();
    const headers = { ...EDITOR, "idempotency-key": key };
    const r = await api.req("POST", `/systems/${id}/brief/approve`, { body: { version: 1 }, headers });
    expect(r.status, r.text).toBe(202);
    expect(r.body.capCredits).toBe(V3_BUILD_CAP_CREDITS);
    expect(V3_BUILD_CAP_CREDITS).toBe(100);
    const row = await runRow(r.body.run.id);
    expect(row).toMatchObject({ kind: "build", mode: "create", input: { pipeline: "v3", briefVersion: 1 } });
    expect(Number(row.credits_cap_milli)).toBe(100_000);
    const sys = await api.deps.db
      .selectFrom("platform.systems")
      .select("stage")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(sys.stage).toBe("building");

    const again = await api.req("POST", `/systems/${id}/brief/approve`, { body: { version: 1 }, headers });
    expect(again.status).toBe(202);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.body.run.id).toBe(r.body.run.id);
    const locked = await api.req("POST", `/systems/${id}/brief/approve`, {
      body: { version: 1 },
      headers: EDITOR,
    });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe("SYSTEM_LOCKED");
    const builds = await api.deps.db
      .selectFrom("platform.runs")
      .select("id")
      .where("system_id", "=", id)
      .where("kind", "=", "build")
      .execute();
    expect(builds).toHaveLength(1);

    // The build fails → «Исправить» repeats it by the brief with the cap of a v3 build, not 3 credits.
    await waitFor(async () => started);
    release();
    await waitRun(api, r.body.run.id, ["failed"]);
    const fix = await api.req("POST", `/systems/${id}/fix`, { body: {}, headers: EDITOR });
    expect(fix.status, fix.text).toBe(202);
    const fixRow = await runRow(fix.body.run.id);
    expect(fixRow).toMatchObject({ mode: "fix", input: { pipeline: "v3", briefVersion: 1 } });
    expect(Number(fixRow.credits_cap_milli)).toBe(V3_BUILD_CAP_CREDITS * 1000);
    await waitRun(api, fix.body.run.id, ["failed"]);
  });
});

describe("V3-18: a built v3 system the techreview blocked", () => {
  test("GET /systems/:id gives the techreview's reasons; «Исправить» starts the v3 build; the run report names its kind", async () => {
    const id = await addSystem();
    await saveBriefVersion(api.deps.db, { systemId: id, brief: dentalBrief(), author: "agent" });
    // The build that left revision 1 as the draft succeeded, but its techreview found a blocker (checkpoints of one run).
    const prev = await api.deps.db
      .insertInto("platform.runs")
      .values({
        org_id: DEFAULT_ORG_ID,
        system_id: id,
        kind: "build",
        mode: "create",
        status: "succeeded",
        input: json({ pipeline: "v3", briefVersion: 1 }),
        started_by: DEV_USER_ID,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await api.deps.db
      .insertInto("platform.revisions")
      .values({
        system_id: id,
        version: 1,
        kind: "files",
        author: "agent",
        run_id: prev.id,
        spec: json({ entities: [], roles: [] }),
        files_manifest_sha: "0".repeat(64),
        bundle_key: "bundles/1",
        g0_passed: true,
      })
      .execute();
    await api.deps.db
      .updateTable("platform.systems")
      .set({ stage: "ready", draft_revision: 1, preview_revision: 1 })
      .where("id", "=", id)
      .execute();
    const blocker = "Права: Посетитель без входа видит чужие записи на приём";
    const cp = (data: unknown) => JSON.stringify({ runId: prev.id, data });
    await api.deps
      .pg`insert into platform.system_build_checkpoints (system_id, key, checkpoint, run_id) values
      (${id}, 'techreview', cast(cast(${cp({ status: "done", blockers: [blocker] })} as text) as jsonb), ${prev.id}),
      (${id}, 'draft', cast(cast(${cp({ revision: 1 })} as text) as jsonb), ${prev.id})`;

    const g = await api.req("GET", `/systems/${id}`, { headers: EDITOR });
    expect(g.status, g.text).toBe(200);
    expect(g.body.publishBlockers).toContain("GATES_FAILED");
    expect(g.body.techreviewBlockers).toEqual([blocker]);

    // Before V3-18 the last build had succeeded and no gate report failed: /fix answered NO_GATE_FAILURE.
    const fix = await api.req("POST", `/systems/${id}/fix`, { body: {}, headers: EDITOR });
    expect(fix.status, fix.text).toBe(202);
    expect(await runRow(fix.body.run.id)).toMatchObject({
      mode: "fix",
      input: { pipeline: "v3", briefVersion: 1 },
    });
    await waitRun(api, fix.body.run.id, ["failed"]);
    const reports = await api.deps.db
      .selectFrom("platform.messages")
      .select(["run_id", "payload"])
      .where("system_id", "=", id)
      .where("kind", "=", "run_report")
      .execute();
    expect(reports).toEqual([
      { run_id: fix.body.run.id, payload: { runId: fix.body.run.id, status: "failed", kind: "build" } },
    ]);
  });
});
