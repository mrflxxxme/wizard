// V3-06 (D77 (9)): the session feed of a system — interviews, builds and edits of the brief — from runs and brief
// versions without a table of its own: the grouping rules of buildSessions and GET /systems/:id/sessions with access
// checks (viewer reads, another org gets 404).
import { randomUUID } from "node:crypto";
import { briefDiff, systemBriefSchema } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dentalBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import { buildSessions, SESSION_GAP_MS, type SystemSession } from "../src/briefs/sessions.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { createTestDb, fakeExecutors, startApi, type TestApi } from "./helpers.js";

const T0 = Date.UTC(2026, 9, 8, 9, 0);
const at = (min: number) => new Date(T0 + min * 60_000);

type Run = Parameters<typeof buildSessions>[0][number];
type Version = Parameters<typeof buildSessions>[1][number];

function run(id: string, kind: string, start: number, end: number | null, o: Partial<Run> = {}): Run {
  return {
    id,
    kind,
    mode: kind === "build" ? "create" : null,
    status: end === null ? "running" : "succeeded",
    input: {},
    failure_message_ru: null,
    result_revision: null,
    started_at: at(start),
    finished_at: end === null ? null : at(end),
    created_at: at(start),
    ...o,
  };
}
const version = (
  v: number,
  author: "agent" | "owner",
  min: number,
  runId: string | null,
  lines = 1,
): Version => ({
  version: v,
  author,
  run_id: runId,
  created_at: at(min),
  diff: Array.from({ length: lines }, (_, i) => ({
    field: "goals",
    op: "added",
    text_ru: `Изменение ${v}.${i + 1}`,
  })),
});
const shape = (ss: SystemSession[]) =>
  ss.map((s) => [s.kind, s.source, s.status, s.runIds.length, s.briefVersions.join(",")].join(" "));

describe("buildSessions", () => {
  test("interview turns in a row are one interview; a build; a panel edit; words after the build are an edit", () => {
    const ss = buildSessions(
      [
        run("i1", "interview_turn", 0, 1),
        run("i2", "interview_turn", 3, 4),
        run("i3", "interview_turn", 6, 7),
        run("b1", "build", 10, 22, { status: "failed", failure_message_ru: "Кончилось время" }),
        run("i4", "interview_turn", 40, 41),
        run("b2", "build", 50, null, { mode: "change" }),
        run("p1", "publish", 60, 61),
      ],
      [
        version(1, "agent", 7, "i3", 9),
        version(2, "owner", 30, null, 2),
        version(3, "agent", 41, "i4"),
        version(4, "agent", 55, "b2"),
      ],
    );
    expect(shape(ss)).toEqual([
      "build  running 1 4",
      "edit chat done 1 3",
      "edit panel done 0 2",
      "build  failed 1 ",
      "interview  done 3 1",
    ]);
    const interview = ss.at(-1) as SystemSession;
    expect(interview.startedAt).toBe(at(0).toISOString());
    expect(interview.finishedAt).toBe(at(7).toISOString());
    expect(interview.changes).toHaveLength(6);
    expect(interview.changesTotal).toBe(9);
    expect(ss[0]?.finishedAt).toBeNull();
    expect(ss[0]?.build).toEqual({ mode: "change", revision: null, failure: null });
    expect(ss[3]?.build?.failure).toBe("Кончилось время");
    expect(ss[2]?.id).toBe("brief:2");
  });

  test("a long pause or a panel edit splits the interview; an edit intent is an edit before any build", () => {
    const gap = SESSION_GAP_MS / 60_000 + 5;
    const ss = buildSessions(
      [
        run("i1", "interview_turn", 0, 1),
        run("i2", "interview_turn", 1 + gap, 2 + gap),
        run("i3", "interview_turn", 4 + gap, 5 + gap, { input: { intent: "brief_edit" } }),
        run("i4", "interview_turn", 20 + gap, 21 + gap, { status: "needs_input", finished_at: null }),
        run("i5", "interview_turn", 30 + gap, null),
      ],
      [version(1, "owner", 25 + gap, null)],
    );
    expect(shape(ss)).toEqual([
      "interview  running 1 ",
      "edit panel done 0 1",
      "interview  waiting 1 ",
      "edit chat done 1 ",
      "interview  done 1 ",
      "interview  done 1 ",
    ]);
  });

  test("an agent's version without its run joins the latest session before it, or becomes an interview", () => {
    expect(shape(buildSessions([], [version(1, "agent", 0, null)]))).toEqual(["interview  done 0 1"]);
    const ss = buildSessions(
      [run("i1", "interview_turn", 0, 1), run("b1", "build", 10, 20)],
      [version(1, "agent", 2, null), version(2, "agent", 15, "gone")],
    );
    expect(shape(ss)).toEqual(["build  done 1 2", "interview  done 1 1"]);
  });
});

const EDITOR = { "x-wizard-dev-user": "editor-sessions@example.test" };
const VIEWER = { "x-wizard-dev-user": "viewer-sessions@example.test" };
const STRANGER = { "x-wizard-dev-user": "stranger-sessions@example.test" };

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;

beforeAll(async () => {
  tdb = await createTestDb("v3sessions");
  api = await startApi(tdb.url, { executors: fakeExecutors() });
  for (const h of [EDITOR, VIEWER, STRANGER])
    expect((await api.req("GET", "/me", { headers: h })).status).toBe(200);
  await api.deps.pg`update platform.memberships set role = 'viewer' where user_id =
    (select id from platform.users where email = 'viewer-sessions@example.test')`;
  await api.deps.pg`delete from platform.memberships where user_id =
    (select id from platform.users where email = 'stranger-sessions@example.test')`;
});

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

describe("GET /systems/:id/sessions", () => {
  test("runs and brief versions of the system become the feed, newest first; viewer reads, a stranger gets 404", async () => {
    const key = randomUUID().replace(/-/g, "").slice(0, 12);
    const { id } = await api.deps.db
      .insertInto("platform.systems")
      .values({
        org_id: DEFAULT_ORG_ID,
        slug: `s-${key}`,
        schema_key: key,
        name: "Стоматология",
        pending_questions: json([]),
        created_by: DEV_USER_ID,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const insertRun = async (kind: string, min: number, o: { status?: string; input?: unknown } = {}) => {
      const rid = randomUUID();
      await api.deps.db
        .insertInto("platform.runs")
        .values({
          id: rid,
          org_id: DEFAULT_ORG_ID,
          system_id: id,
          kind,
          mode: kind === "build" ? "create" : null,
          status: o.status ?? "succeeded",
          input: JSON.stringify(o.input ?? {}) as never,
          result_revision: kind === "build" ? 1 : null,
          started_at: at(min),
          finished_at: at(min + 2),
          created_at: at(min),
        })
        .execute();
      return rid;
    };
    const i1 = await insertRun("interview_turn", 0);
    const i2 = await insertRun("interview_turn", 3);
    await insertRun("build", 10);
    const i3 = await insertRun("interview_turn", 40);
    const v1 = dentalBrief();
    await saveBriefVersion(api.deps.db, { systemId: id, brief: v1, author: "agent", runId: i2 });
    const v2 = { ...v1, audience: "Жители района" };
    expect(
      (await api.req("PUT", `/systems/${id}/brief`, { body: { baseVersion: 1, brief: v2 }, headers: EDITOR }))
        .status,
    ).toBe(200);
    const v3 = { ...v2, audience: "Жители района и гости" };
    await saveBriefVersion(api.deps.db, { systemId: id, brief: v3, author: "agent", runId: i3 });
    await api.deps
      .pg`update platform.system_briefs set created_at = ${at(5)} where system_id = ${id} and version = 1`;
    await api.deps
      .pg`update platform.system_briefs set created_at = ${at(30)} where system_id = ${id} and version = 2`;
    await api.deps
      .pg`update platform.system_briefs set created_at = ${at(41)} where system_id = ${id} and version = 3`;

    const r = await api.req("GET", `/systems/${id}/sessions`, { headers: VIEWER });
    expect(r.status).toBe(200);
    const ss = r.body.sessions as SystemSession[];
    expect(shape(ss)).toEqual([
      "edit chat done 1 3",
      "edit panel done 0 2",
      "build  done 1 ",
      "interview  done 2 1",
    ]);
    expect(ss[3]?.runIds).toEqual([i1, i2]);
    expect(ss[1]?.changes).toEqual(
      briefDiff(systemBriefSchema.parse(v1), systemBriefSchema.parse(v2)).map((c) => c.text_ru),
    );
    expect(ss[2]?.build).toEqual({ mode: "create", revision: 1, failure: null });
    expect(ss[3]?.changesTotal).toBe(briefDiff(null, systemBriefSchema.parse(v1)).length);

    const limited = await api.req("GET", `/systems/${id}/sessions?limit=2`, { headers: VIEWER });
    expect((limited.body.sessions as SystemSession[]).map((s) => s.kind)).toEqual(["edit", "edit"]);
    expect((await api.req("GET", `/systems/${id}/sessions?limit=0`)).status).toBe(400);
    expect((await api.req("GET", `/systems/${id}/sessions`, { headers: STRANGER })).status).toBe(404);
    expect((await api.req("GET", "/systems/not-a-uuid/sessions")).status).toBe(404);
    expect((await api.req("GET", `/systems/${randomUUID()}/sessions`)).status).toBe(404);
    const empty = await api.req("GET", `/systems/${id}/sessions`);
    expect(empty.status).toBe(200);
  });
});
