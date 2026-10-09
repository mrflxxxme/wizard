// V3-17, platform part: the live progress of a build by the brief (workflows.yaml#events.schemas.v3_progress). The host
// adds a full structured snapshot to build_stage, step_started and step_finished — scenario states, spent and cap in ₽,
// elapsed and expected seconds against the 30 min cap, the revision of the live preview — without parsing the harness
// text (agent_message stays as it was). Unit: the tracker on scripted harness calls (fresh build, a failed and a stopped
// scenario, a repeat that takes scenarios from checkpoints, a stats failure). Integration: the real harness on recorded
// answers with the real gates (one scenario breaks G0), every snapshot valid by the schema; the repeat build's snapshots
// say what came from checkpoints and what it cost before; the events read again from seq 1 end on the same state.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  briefNiche,
  milliRub,
  type PageComposer,
  V3_STAGES,
  type V3Checkpoint,
  type V3Host,
} from "@wizard/agents/builder";
import { type SystemBrief, systemBriefSchema } from "@wizard/appspec";
import { createRegistry, createRouter, type Router, type RouterOptions } from "@wizard/llm";
import { closeExecutors } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  clinicBrief,
  fakeComposer,
  pageComposeMessages,
  v3Lines,
  writeFixture,
} from "../../../packages/agents/test/v3-harness-fixtures.js";
import { createAgentExecutors } from "../src/agents/executors.js";
import { OutboxMailer } from "../src/auth/mailer.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import {
  V3_PROGRESS_EVENTS,
  type V3BuildProgress,
  V3ProgressTracker,
  withLiveProgress,
} from "../src/builds-v3/progress.js";
import { startV3Build } from "../src/builds-v3/start.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { listEvents } from "../src/runs/events.js";
import { loadEventSchemas } from "./event-schemas.js";
import { createTestDb, startApi, type TestApi, waitRun } from "./helpers.js";

const schemas = loadEventSchemas();
const RPC = createRegistry().rubPerCredit;

/** The clinic brief cut to two «must» scenarios and one «should» one (as in v3-build.test.ts). */
function smallBrief() {
  const b = clinicBrief();
  return {
    ...b,
    scenarios: (b.scenarios ?? []).filter((s) => ["s_book", "s_lead", "s_doctors"].includes(s.id)),
  };
}
const brief = (): SystemBrief => systemBriefSchema.parse(smallBrief());

/** A whole RunEvent (envelope and payload) by the schemas of workflows.yaml; null — valid. */
const valid = (type: string, payload: Record<string, unknown>) => {
  const event = { runId: randomUUID(), seq: 1, type, ts: new Date().toISOString(), payload };
  return schemas.validate(event);
};

const cp = (key: string, data: Record<string, unknown>, costMilli = 0): V3Checkpoint => ({
  key,
  fingerprint: key,
  data,
  costMilli,
  durationMs: 1,
  runId: "r0",
});

const statuses = (p: V3BuildProgress) => Object.fromEntries(p.scenarios.map((s) => [s.id, s.status]));

describe("tracker of a v3 build (scripted harness calls)", () => {
  const live = { runSpentRub: 12.5, elapsedSec: 100, previewRevision: null };

  test("fresh build: pending → running → passed / failed / stopped with reasons; time and money; schema", () => {
    const t = new V3ProgressTracker({ rubPerCredit: RPC });
    t.loaded([]);
    t.brief(brief());
    let p = t.snapshot(live, 0);
    expect(p.scenarios.map((s) => [s.id, s.priority, s.status])).toEqual([
      ["s_book", "must", "pending"],
      ["s_lead", "must", "pending"],
      ["s_doctors", "should", "pending"],
    ]);
    expect(p).toMatchObject({ stage: null, spentRub: 12.5, reusedRub: 0, capRub: 500, capSec: 1800 });
    expect(p.scenarios[0]?.title).toMatch(/^Когда .+ — система /);
    // Fresh: brief 1 + design 20 + backend 3 + skeleton 60 + 3 × 90 + gates 120 (hooks absent → skipped).
    expect(p.remainingSec).toBe(1 + 20 + 3 + 60 + 270 + 120);
    expect(
      valid("build_stage", { stage: "brief", status: "started", label_ru: "x", progress: p }),
    ).toBeNull();

    for (const st of ["brief", "design", "backend", "skeleton"]) {
      t.event("build_stage", { stage: st, status: "started" }, 0);
      t.event("build_stage", { stage: st, status: "done" }, 0);
    }
    t.event("build_stage", { stage: "scenarios", status: "started" }, 1000);
    p = t.snapshot({ ...live, previewRevision: 3 }, 1000, {
      type: "build_stage",
      payload: { stage: "scenarios", status: "started" },
    });
    expect(p.stage).toBe("scenarios");
    expect(p.previewRevision).toBe(3);

    t.event("step_started", { step: "scenario:s_book" }, 1000);
    expect(statuses(t.snapshot(live, 1000))).toEqual({
      s_book: "running",
      s_lead: "pending",
      s_doctors: "pending",
    });
    t.saved({ ...cp("scenario:s_book", { status: "passed" }, 2000), runId: "r1" });
    t.event("step_finished", { step: "scenario:s_book" }, 61_000);
    // The preview advances when a scenario lands, not on every gate in between.
    expect(
      t.snapshot({ ...live, previewRevision: 4 }, 61_000, {
        type: "step_finished",
        payload: { step: "scenario:s_book" },
      }).previewRevision,
    ).toBe(4);
    expect(t.snapshot({ ...live, previewRevision: 5 }, 61_000).previewRevision).toBe(4);

    t.event("step_started", { step: "scenario:s_lead" }, 61_000);
    t.saved(cp("scenario:s_lead", { status: "failed", problems: ["Страница «/lead» не открылась"] }));
    t.event("step_finished", { step: "scenario:s_lead" }, 121_000);
    p = t.snapshot(live, 121_000);
    expect(p.scenarios[1]).toMatchObject({
      status: "failed",
      reason: "не прошёл проверку в браузере: Страница «/lead» не открылась",
    });
    // Two scenarios took 60 s each: one left × 60 + gates 120.
    expect(p.remainingSec).toBe(60 + 120);
    // The final list of the loop is authoritative (the harness's reasons).
    t.saved(
      cp("scenarios", {
        scenarios: [
          { id: "s_book", title: "a", priority: "must", status: "passed", costRub: 1 },
          { id: "s_lead", title: "b", priority: "must", status: "failed", reason: "не прошёл", costRub: 1 },
          {
            id: "s_doctors",
            title: "c",
            priority: "should",
            status: "stopped",
            reason: "не успели: вышло время сборки",
            costRub: 0,
          },
        ],
      }),
    );
    t.event("build_stage", { stage: "scenarios", status: "done" }, 121_000);
    for (const st of ["critic", "template_gate", "techreview"])
      t.event("build_stage", { stage: st, status: "skipped" }, 121_000);
    t.event("build_stage", { stage: "gates", status: "started" }, 121_000);
    p = t.snapshot({ ...live, elapsedSec: 1750 }, 121_000);
    expect(p.scenarios[2]).toMatchObject({ status: "stopped", reason: "не успели: вышло время сборки" });
    // Never more than what the 30 min cap leaves.
    expect(p.remainingSec).toBe(50);
    t.event("build_stage", { stage: "gates", status: "done" }, 200_000);
    p = t.snapshot(live, 200_000);
    expect(p.remainingSec).toBe(0);
    expect(p.stages.map((s) => s.status)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
      "skipped",
      "skipped",
      "skipped",
      "done",
    ]);
    expect(p.checkpoints).toEqual({ saved: 3, reused: 0 });
    expect(valid("step_finished", { step: "x", progress: p })).toBeNull();
    expect(valid("step_started", { step: "x", label_ru: "x", progress: p })).toBeNull();
  });

  test("repeat build: reused stages and scenarios count what they cost before; a «should» put off for the target", () => {
    const t = new V3ProgressTracker({ rubPerCredit: RPC });
    t.loaded([
      cp("brief", {}, 0),
      cp("design", {}, 1000),
      cp("skeleton", {}, 0),
      cp("scenario:s_book", { status: "passed" }, 3000),
      cp("scenario:s_lead", { status: "failed" }, 2000),
    ]);
    t.brief(brief());
    t.event("build_stage", { stage: "design", status: "reused" }, 0);
    t.event("build_stage", { stage: "design", status: "reused" }, 0);
    // s_book was taken from the checkpoint (no event); the loop starts at s_lead.
    t.event("step_started", { step: "scenario:s_lead" }, 0);
    let p = t.snapshot({ runSpentRub: 0, elapsedSec: 5, previewRevision: 7 }, 0);
    expect(statuses(p)).toEqual({ s_book: "passed", s_lead: "running", s_doctors: "pending" });
    expect(p.scenarios[0]?.reused).toBe(true);
    expect(p.reusedRub).toBe(milliRub(4000, RPC));
    expect(p.spentRub).toBe(milliRub(4000, RPC));
    expect(p.checkpoints.reused).toBe(2);
    // A rebuild starts from the preview the system already has.
    expect(p.previewRevision).toBe(7);

    // A later scenario starts while a «should» one before it never ran: put off for the target (no event of its own).
    const t2 = new V3ProgressTracker({ rubPerCredit: RPC });
    const b = brief();
    t2.brief({
      ...b,
      scenarios: [
        ...b.scenarios,
        { ...(b.scenarios[0] as object), id: "s_extra", priority: "should" } as never,
      ],
    });
    t2.event("step_started", { step: "scenario:s_extra" }, 0);
    p = t2.snapshot({ runSpentRub: 0, elapsedSec: 0, previewRevision: null }, 0);
    expect(p.scenarios.find((s) => s.id === "s_doctors")).toMatchObject({
      status: "stopped",
      reason: "желательный сценарий — отложен, чтобы уложиться в целевой бюджет",
    });
    // The schema holds: an unknown scenario state is refused.
    const bad = { ...p, scenarios: [{ ...(p.scenarios[0] as object), status: "almost" }] };
    expect(valid("build_stage", { stage: "brief", status: "done", label_ru: "x", progress: bad })).toMatch(
      /progress\/scenarios\/0\/status/,
    );
  });

  test("a stats failure never fails the build: the event goes out without the snapshot", async () => {
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    const host = {
      emit: (type: string, payload: Record<string, unknown>) => {
        sent.push({ type, payload });
      },
      brief: async () => ({ version: 1, brief: brief() }),
      checkpoints: { load: async () => [], save: async () => {} },
      hooks: { critic: async () => ({ status: "skipped" as const }) },
    } as unknown as V3Host;
    let fail = true;
    const live = withLiveProgress(host, {
      rubPerCredit: RPC,
      stats: async () => {
        if (fail) throw new Error("db down");
        return { runSpentRub: 1, elapsedSec: 2, previewRevision: null };
      },
      now: () => 0,
    });
    await live.brief();
    await live.emit("build_stage", { stage: "brief", status: "started", label_ru: "x" });
    fail = false;
    await live.emit("build_stage", { stage: "brief", status: "done", label_ru: "x" });
    await live.emit("agent_message", { agent: "builder", messageId: "m", text: "потрачено 1 ₽ из 500 ₽" });
    expect(sent.map((e) => "progress" in e.payload)).toEqual([false, true, false]);
    const p = sent[1]?.payload.progress as V3BuildProgress;
    // The critic hook is given: its 120 s count in what is left.
    expect(p.remainingSec).toBe(20 + 3 + 60 + 270 + 120 + 120);
    expect(sent[2]?.payload).toEqual({ agent: "builder", messageId: "m", text: "потрачено 1 ₽ из 500 ₽" });
  });
});

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let outboxDir: string;
let fixtureDir: string;

/** The fake composer of V3-12 whose «s_doctors» page does not compile: G0 fails, the scenario goes to the requests. */
function breakingComposer(): PageComposer {
  const inner = fakeComposer();
  return {
    skeleton: (ctx) => inner.skeleton(ctx),
    scenario: async (ctx, s) => {
      const r = await inner.scenario(ctx, s);
      if (s.id !== "s_doctors") return r;
      const files = new Map(r.files);
      for (const [path] of files)
        if (path.endsWith(".tsx")) files.set(path, "export default function Broken( {\n  return <main>\n");
      return { ...r, files };
    },
  };
}

beforeAll(async () => {
  tdb = await createTestDb("v3events", { migrator: true });
  outboxDir = mkdtempSync(join(tmpdir(), "wz-v3ev-outbox-"));
  const b = brief();
  fixtureDir = writeFixture(
    "clinic",
    v3Lines({
      brief: { goals: b.goals, audience: b.audience },
      niche: briefNiche(b),
      seed: "x",
      pages: 10,
      prompt: pageComposeMessages({ brief: b, design: {} as never }, b.scenarios[0] as never),
    }),
  );
  api = await startApi(tdb.url, {
    config: { unsafeLocalExec: true },
    createRouter: (opts: RouterOptions): Router =>
      createRouter({
        ...opts,
        mode: "fixture",
        fixture: { suite: "demo", name: "v3/clinic", dir: fixtureDir },
        env: {},
      }),
    executors: ({ pg, config }) =>
      createAgentExecutors({
        pg,
        config,
        v3: { enabled: true, composer: breakingComposer(), mailer: new OutboxMailer(outboxDir) },
      }),
  });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await closeExecutors();
  await tdb?.drop();
  rmSync(outboxDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

async function addSystem(name: string): Promise<string> {
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `v3e-${key}`,
      schema_key: key,
      name,
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function snapshots(runId: string) {
  const list = await listEvents(api.deps.db, runId, 0);
  expect(list.map((e) => schemas.validate(e)).filter(Boolean)).toEqual([]);
  const carriers = list.filter((e) => V3_PROGRESS_EVENTS.has(e.type));
  // Every build_stage and step event of the harness v3 carries the snapshot.
  expect(carriers.filter((e) => !e.payload.progress).map((e) => e.type)).toEqual([]);
  return { list, snaps: carriers.map((e) => e.payload.progress as V3BuildProgress) };
}

/** The distinct states a scenario went through, in order. */
const path = (snaps: V3BuildProgress[], id: string) =>
  snaps
    .map((p) => p.scenarios.find((s) => s.id === id)?.status)
    .filter((x, i, xs) => x !== undefined && x !== xs[i - 1]);

describe("platform: progress snapshots of a build by the brief", () => {
  test("states, money, time and the growing preview; the repeat says what came from checkpoints", async () => {
    const systemId = await addSystem("Клиника «Улыбка»");
    await saveBriefVersion(api.deps.db, { systemId, brief: smallBrief(), author: "agent" });
    const run = await startV3Build(api.deps, { systemId, userId: DEV_USER_ID });
    const done = await waitRun(api, run.id, ["succeeded", "failed"], 240_000);
    expect(done.status, JSON.stringify(done.failure)).toBe("succeeded");
    const { list, snaps } = await snapshots(run.id);

    expect(path(snaps, "s_book")).toEqual(["pending", "running", "passed"]);
    expect(path(snaps, "s_lead")).toEqual(["pending", "running", "passed"]);
    expect(path(snaps, "s_doctors")).toEqual(["pending", "running", "failed"]);
    const last = snaps.at(-1) as V3BuildProgress;
    expect(last.scenarios.find((s) => s.id === "s_doctors")?.reason).toMatch(
      /^не прошёл проверку в браузере: /,
    );
    // Without the process browser the critic and the template gate are skipped; the techreview (V3-15) always runs.
    expect(last.stages.map((s) => `${s.id}:${s.status}`)).toEqual(
      V3_STAGES.map((s) => (["critic", "template_gate"].includes(s) ? `${s}:skipped` : `${s}:done`)),
    );
    expect(last.remainingSec).toBe(0);
    // Money: this run's credits in ₽ (nothing reused on the first build), under the cap of a v3 build.
    const finished = list.find((e) => e.type === "run_finished")?.payload as { creditsUsed: number };
    expect(last.spentRub).toBeCloseTo(milliRub(finished.creditsUsed * 1000, RPC), 2);
    expect(last.spentRub).toBeGreaterThan(0);
    expect(last).toMatchObject({ reusedRub: 0, capRub: 500, capSec: 1800 });
    // Time goes forward and never past the cap.
    for (let i = 1; i < snaps.length; i++)
      expect(snaps[i]?.elapsedSec).toBeGreaterThanOrEqual(snaps[i - 1]?.elapsedSec as number);
    for (const p of snaps) expect(p.elapsedSec + p.remainingSec).toBeLessThanOrEqual(p.capSec);
    // The growing system: no preview before the skeleton, then it only moves forward, ending on the system's.
    const previews = snaps.map((p) => p.previewRevision);
    const firstPreview = previews.findIndex((x) => x !== null);
    const stageAt = snaps[firstPreview]?.stage;
    expect(stageAt).toBe("scenarios");
    expect(previews.slice(0, firstPreview).every((x) => x === null)).toBe(true);
    const grown = previews.slice(firstPreview) as number[];
    for (let i = 1; i < grown.length; i++) expect(grown[i]).toBeGreaterThanOrEqual(grown[i - 1] as number);
    const sys = await api.deps.db
      .selectFrom("platform.systems")
      .select(["preview_revision"])
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
    expect(last.previewRevision).toBe(sys.preview_revision);
    expect(new Set(grown).size).toBeGreaterThanOrEqual(3);
    // The harness text for people is unchanged.
    const lines = list.filter((e) => e.type === "agent_message").map((e) => String(e.payload.text));
    expect(lines.some((t) => /Сейчас потрачено \d+ ₽ из 500 ₽\./.test(t))).toBe(true);
    expect(list.filter((e) => e.type === "agent_message").some((e) => "progress" in e.payload)).toBe(false);

    // «Собрать» again: brief, design and skeleton from checkpoints, s_book and s_lead too — what they cost before
    // is shown as reused; the broken scenario runs again and fails again.
    const cps = await api.deps.pg<{ checkpoint: V3Checkpoint }[]>`
      select c.checkpoint from platform.system_build_checkpoints c where c.system_id = ${systemId}`;
    const cost = new Map(cps.map((r) => [r.checkpoint.key, r.checkpoint.costMilli]));
    const again = await startV3Build(api.deps, { systemId, userId: DEV_USER_ID });
    const done2 = await waitRun(api, again.id, ["succeeded", "failed"], 240_000);
    expect(done2.status, JSON.stringify(done2.failure)).toBe("succeeded");
    const r2 = await snapshots(again.id);
    const reusedStages = r2.list
      .filter((e) => e.type === "build_stage" && e.payload.status === "reused")
      .map((e) => String(e.payload.stage));
    expect(reusedStages).toEqual(expect.arrayContaining(["brief", "design", "skeleton"]));
    const at = r2.list.findIndex((e) => e.type === "step_started" && e.payload.step === "scenario:s_doctors");
    const atStart = r2.list[at]?.payload.progress as V3BuildProgress;
    expect(statuses(atStart)).toEqual({ s_book: "passed", s_lead: "passed", s_doctors: "running" });
    expect(atStart.scenarios.filter((s) => s.reused).map((s) => s.id)).toEqual(["s_book", "s_lead"]);
    const end = r2.snaps.at(-1) as V3BuildProgress;
    const priorMilli = [...reusedStages, "scenario:s_book", "scenario:s_lead"].reduce(
      (s, k) => s + (cost.get(k) ?? 0),
      0,
    );
    expect(end.reusedRub).toBe(milliRub(priorMilli, RPC));
    expect(end.reusedRub).toBeGreaterThan(0);
    const finished2 = r2.list.find((e) => e.type === "run_finished")?.payload as { creditsUsed: number };
    expect(end.spentRub).toBeCloseTo(end.reusedRub + milliRub(finished2.creditsUsed * 1000, RPC), 2);
    expect(end.checkpoints.reused).toBe(reusedStages.length + 2);
    // Read again from seq 1 (the page opened anew): the last snapshot is the same state.
    const replay = await snapshots(again.id);
    expect(replay.snaps.at(-1)).toEqual(end);
  }, 480_000);
});
