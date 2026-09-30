// Acceptance M0-15: a run with a fake builder emits events valid per workflows.yaml#events, they reach SSE
// (live, reconnect by Last-Event-ID, internal skipped); restart → WORKER_RESTARTED; lock waiting.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { listEvents } from "../src/runs/events.js";
import { loadEventSchemas } from "./event-schemas.js";
import { startBuild } from "./flow.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  parseSse,
  startApi,
  type TestApi,
  waitFor,
  waitRun,
} from "./helpers.js";

const schemas = loadEventSchemas();
let tdb: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  tdb = await createTestDb("events");
});
afterAll(async () => {
  await tdb?.drop();
});

async function allEvents(api: TestApi, runId: string) {
  return listEvents(api.deps.db, runId, 0);
}

function expectValid(events: { type: string; payload: unknown; seq: number }[]) {
  const errors = events.map((e) => schemas.validate(e)).filter(Boolean);
  expect(errors).toEqual([]);
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  const terminal = events.filter((e) => e.type === "run_finished" || e.type === "run_failed");
  expect(terminal).toHaveLength(1);
  expect(events.at(-1)).toBe(terminal[0]);
}

describe.each(["forum", "bakery"] as const)("fake build «%s»", (spec) => {
  let api: TestApi;
  let release!: () => void;
  beforeAll(async () => {
    const gate = new Promise<void>((r) => (release = r));
    api = await startApi(tdb.url, {
      executors: fakeExecutors({ spec, gate }),
      createRouter: fakeRouterFactory(),
    });
  });
  afterAll(async () => {
    release();
    await api?.dispose();
  });

  test("interview and build events are valid; SSE streams them live and resumes by Last-Event-ID", async () => {
    const b = await startBuild(
      api,
      spec === "forum" ? "Форум на 600 человек" : "Кондитерская с заказами тортов",
    );
    for (const e of [await allEvents(api, b.createRunId)]) expectValid(e);
    expect((await allEvents(api, b.createRunId)).map((e) => e.type)).toContain("chat_output");

    // Subscribe while the build is blocked before the gate: the tail arrives live.
    await waitFor(async () => (await allEvents(api, b.buildRunId)).some((e) => e.type === "file_written"));
    const res = await api.fetch(
      new Request(`http://localhost:4000/api/v1/runs/${b.buildRunId}/events`, {
        headers: { host: "localhost" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    setTimeout(release, 50);
    const frames = parseSse(await res.text()).filter((f) => f.data !== undefined);

    const run = await waitRun(api, b.buildRunId, ["succeeded"]);
    const db = await allEvents(api, b.buildRunId);
    expectValid(db);
    const types = db.map((e) => e.type);
    for (const t of [
      "run_started",
      "plan_ready",
      "ops_applied",
      "file_written",
      "gate_started",
      "gate_result",
    ])
      expect(types).toContain(t);
    expect(types).toContain("model_switched"); // journalled…
    const visible = db.filter((e) => !schemas.internal.has(e.type));
    expect(frames.map((f) => f.event)).not.toContain("model_switched"); // …but not streamed
    expect(frames.map((f) => Number(f.id))).toEqual(visible.map((e) => e.seq));
    expect(frames.map((f) => JSON.parse(f.data as string))).toEqual(visible);
    for (const f of frames) expect(f.event).toBe(JSON.parse(f.data as string).type);
    expect(frames.at(-1)?.event).toBe("run_finished");
    expect(run.resultRevision).toBeGreaterThan(0);
    expect(run.lastEventSeq).toBe(db.length);

    // Reconnect with Last-Event-ID=N → exactly N+1..
    const n = visible[Math.floor(visible.length / 2)]?.seq as number;
    const again = await api.fetch(
      new Request(`http://localhost:4000/api/v1/runs/${b.buildRunId}/events`, {
        headers: { host: "localhost", "last-event-id": String(n) },
      }),
    );
    const resumed = parseSse(await again.text()).filter((f) => f.data !== undefined);
    expect(resumed.map((f) => Number(f.id))).toEqual(visible.filter((e) => e.seq > n).map((e) => e.seq));
    const byQuery = await api.req("GET", `/runs/${b.buildRunId}/events?after=${n}`);
    expect(parseSse(byQuery.text).filter((f) => f.data).length).toBe(resumed.length);

    const sys = await api.req("GET", `/systems/${b.systemId}`);
    expect(sys.body.system.stage).toBe("ready");
    expect(sys.body.system.previewRevision).toBe(run.resultRevision);
  });
});

describe("restart and locks", () => {
  test("restart → run_failed WORKER_RESTARTED, stage building → failed", async () => {
    const never = new Promise<void>(() => {});
    const a = await startApi(tdb.url, {
      executors: fakeExecutors({ spec: "bakery", gate: never }),
      createRouter: fakeRouterFactory(),
      recover: false,
    });
    const b = await startBuild(a, "Кондитерская");
    await waitFor(async () => (await allEvents(a, b.buildRunId)).some((e) => e.type === "file_written"));
    // Simulated crash: the engine stops without finalizing the run.
    await a.dispose();
    const b2 = await startApi(tdb.url, {
      executors: fakeExecutors({ spec: "bakery" }),
      createRouter: fakeRouterFactory(),
    });
    try {
      const run = await b2.req("GET", `/runs/${b.buildRunId}`);
      expect(run.body.status).toBe("failed");
      expect(run.body.failure.code).toBe("WORKER_RESTARTED");
      const events = await allEvents(b2, b.buildRunId);
      expectValid(events);
      expect(events.at(-1)?.payload).toMatchObject({ code: "WORKER_RESTARTED", retryable: true });
      const sse = await b2.req("GET", `/runs/${b.buildRunId}/events`);
      expect(parseSse(sse.text).at(-1)?.event).toBe("run_failed");
      const sys = await b2.req("GET", `/systems/${b.systemId}`);
      expect(sys.body.system.stage).toBe("failed");
      const lock = await b2.deps.db
        .selectFrom("platform.locks")
        .selectAll()
        .where("system_id", "=", b.systemId)
        .execute();
      expect(lock).toEqual([]);
    } finally {
      await b2.dispose();
    }
  });

  test("second build of a system waits for the lock (lock_waiting), then runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const api = await startApi(tdb.url, {
      executors: fakeExecutors({ spec: "bakery", gate }),
      createRouter: fakeRouterFactory(),
      config: { runConcurrency: 4 },
    });
    try {
      const b = await startBuild(api, "Кондитерская два");
      await waitRun(api, b.buildRunId, ["running"]);
      const [second] = await api.deps.pg`
        insert into platform.runs (org_id, system_id, kind, mode, credits_cap_milli, input)
        select org_id, id, 'build', 'fix', 3000, '{}'::jsonb from platform.systems where id = ${b.systemId}
        returning id`;
      api.engine.enqueue({ id: second?.id, kind: "build", system_id: b.systemId });
      const waiting = await waitRun(api, second?.id, ["waiting_lock"]);
      expect(waiting.status).toBe("waiting_lock");
      const ev = await allEvents(api, second?.id);
      expect(ev.map((e) => e.type)).toEqual(["lock_waiting"]);
      expect(ev[0]?.payload).toMatchObject({ holderRunId: b.buildRunId, position: 1 });
      release();
      await waitRun(api, b.buildRunId, ["succeeded"]);
      await waitRun(api, second?.id, ["succeeded"]);
      expectValid(await allEvents(api, second?.id));
      expect((await allEvents(api, second?.id)).map((e) => e.type)).toContain("run_started");
    } finally {
      release();
      await api.dispose();
    }
  });
});
