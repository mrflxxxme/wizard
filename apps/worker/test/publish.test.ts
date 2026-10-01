// M1-01 × M1-04: publish and rollback runs execute as DBOS workflows of the worker with the same steps, events and
// prod migration as in-process (workflows.yaml#workflows.publish, #rollback).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@wizard/pii/log";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { listEvents } from "../../platform-api/src/runs/events.js";
import { loadEventSchemas } from "../../platform-api/test/event-schemas.js";
import { startBuild } from "../../platform-api/test/flow.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  startApi,
  type TestApi,
  waitRun,
} from "../../platform-api/test/helpers.js";
import { startWorker, type Worker } from "../src/index.js";

const schemas = loadEventSchemas();
let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let worker: Worker;
const dirs: string[] = [];
const smokes: number[] = [];

beforeAll(async () => {
  tdb = await createTestDb("wpub", { migrator: true });
  const tmp = (p: string) => {
    const d = mkdtempSync(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  const config = {
    dbUrl: tdb.url,
    artifactsDir: tmp("wz-wpub-art-"),
    stepsDir: tmp("wz-wpub-steps-"),
    secretsFile: join(tmp("wz-wpub-sec-"), "secrets.enc"),
    authMode: "dev",
  };
  api = await startApi(tdb.url, { engine: "dbos", config, executors: fakeExecutors({ spec: "forum" }) });
  worker = await startWorker({
    config,
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
    publish: {
      smoke: async (i) => {
        smokes.push(i.revision);
        return { ok: true };
      },
      lockRetryDelaysMs: [10, 10, 10],
    },
    sweepMs: 0,
    pollMs: 100,
    logger: createLogger({ svc: "worker", write: () => {} }),
  });
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await api?.dispose();
  await tdb?.drop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function expectValid(runId: string) {
  const ev = await listEvents(api.deps.db, runId, 0);
  expect(ev.map((e) => schemas.validate(e)).filter(Boolean)).toEqual([]);
  expect(ev.map((e) => e.seq)).toEqual(ev.map((_, i) => i + 1));
  expect(ev.filter((e) => e.type === "run_finished" || e.type === "run_failed")).toHaveLength(1);
  return ev;
}

async function compliance(systemId: string, name: string): Promise<number> {
  const s = await api.req("GET", `/systems/${systemId}`);
  const put = await api.req("PUT", `/systems/${systemId}/compliance`, {
    body: {
      expectedVersion: s.body.system.draftRevision,
      operatorName: name,
      operatorContact: "privacy@north-retail.example",
    },
  });
  expect(put.status, put.text).toBe(200);
  return put.body.revision.version;
}

async function publish(systemId: string, revision: number) {
  const res = await api.req("POST", `/systems/${systemId}/publish`, {
    body: { revision, confirmDiff: true },
  });
  expect(res.status, res.text).toBe(202);
  return waitRun(api, res.body.run.id, ["succeeded", "failed"], 30_000);
}

describe("publish and rollback in the worker", () => {
  test("publish → publish → rollback prod: same steps and events as in-process", async () => {
    const b = await startBuild(api, "Форум для публикации");
    await waitRun(api, b.buildRunId, ["succeeded"], 30_000);
    const rev1 = await compliance(b.systemId, "ООО «Северный ритейл»");
    const p1 = await publish(b.systemId, rev1);
    expect(p1.status, JSON.stringify(p1.failure)).toBe("succeeded");
    const ev = await expectValid(p1.id);
    const steps = ev.filter((e) => e.type === "step_started").map((e) => e.payload.step);
    expect(steps).toEqual(
      expect.arrayContaining(["plan_migration", "gate_G0_prod", "apply_migration", "switch", "smoke"]),
    );
    expect(ev.at(-1)?.payload).toMatchObject({ status: "succeeded", resultRevision: rev1 });
    const key = (await api.deps.pg`select schema_key from platform.systems where id = ${b.systemId}`)[0]
      ?.schema_key;
    const [schema] = await api.deps
      .pg`select 1 from information_schema.schemata where schema_name = ${`app_${key}_prod`}`;
    expect(schema).toBeDefined();

    const rev2 = await compliance(b.systemId, "ООО «Южный ритейл»");
    expect((await publish(b.systemId, rev2)).status).toBe("succeeded");
    const rb = await api.req("POST", `/systems/${b.systemId}/rollback`, {
      body: { env: "prod", toRevision: rev1 },
    });
    expect(rb.status, rb.text).toBe(202);
    const done = await waitRun(api, rb.body.run.id, ["succeeded", "failed"], 30_000);
    expect(done.status, JSON.stringify(done.failure)).toBe("succeeded");
    await expectValid(done.id);
    const [sys] = await api.deps.pg`select prod_revision from platform.systems where id = ${b.systemId}`;
    expect(sys?.prod_revision).toBe(rev1);
    expect(smokes).toEqual([rev1, rev2, rev1]);
    const pubs = await api.deps.pg<{ status: string }[]>`
      select status from platform.publications where system_id = ${b.systemId} order by created_at`;
    expect(pubs.map((p) => p.status)).toEqual(["superseded", "superseded", "live"]);
  });
});
