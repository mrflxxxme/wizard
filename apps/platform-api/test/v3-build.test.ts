// V3-11 acceptance, platform part: a build by the system brief behind WIZARD_BUILD_PIPELINE=v3 (agents/executors.ts →
// builds-v3/host.ts → the harness v3) on recorded answers (packages/agents/test/v3-harness-fixtures.ts, no network, no
// money) with the real G0–G2 and the in-process G1 runtime: «Собрать» (startV3Build) → the skeleton preview (G0 →
// preview revision) with no model call before it → scenarios one by one, each checked by G0 + G1 → final gates →
// checkpoints in platform.system_build_checkpoints → the ready notice by e-mail. A repeated build reuses everything and
// pays nothing. Events match workflows.yaml#events.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefNiche } from "@wizard/agents/builder";
import { systemBriefSchema } from "@wizard/appspec";
import { createRouter, type Router, type RouterOptions } from "@wizard/llm";
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
import { isV3Build, V3_BUILD_CAP_CREDITS, v3PipelineOn } from "../src/builds-v3/host.js";
import { startV3Build } from "../src/builds-v3/start.js";
import { DEFAULT_ORG_ID, DEV_USER_EMAIL, DEV_USER_ID, json } from "../src/db/index.js";
import { listEvents } from "../src/runs/events.js";
import { loadEventSchemas } from "./event-schemas.js";
import { createTestDb, startApi, type TestApi, waitRun } from "./helpers.js";

const schemas = loadEventSchemas();

/** The clinic brief cut to two «must» scenarios and one «should» one (G0 + G1 per scenario keep the test short). */
function smallBrief() {
  const b = clinicBrief();
  return {
    ...b,
    scenarios: (b.scenarios ?? []).filter((s) => ["s_book", "s_lead", "s_doctors"].includes(s.id)),
  };
}

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let outboxDir: string;
let fixtureDir: string;
const composer = fakeComposer();

beforeAll(async () => {
  tdb = await createTestDb("v3build", { migrator: true });
  outboxDir = mkdtempSync(join(tmpdir(), "wz-v3-outbox-"));
  const brief = systemBriefSchema.parse(smallBrief());
  fixtureDir = writeFixture(
    "clinic",
    v3Lines({
      brief: { goals: brief.goals, audience: brief.audience },
      niche: briefNiche(brief),
      seed: "x",
      pages: 10,
      prompt: pageComposeMessages({ brief, design: {} as never }, brief.scenarios[0] as never),
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
        v3: { enabled: true, composer, mailer: new OutboxMailer(outboxDir) },
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
      slug: `v3-${key}`,
      schema_key: key,
      name,
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function events(runId: string) {
  const list = await listEvents(api.deps.db, runId, 0);
  expect(list.map((e) => schemas.validate(e)).filter(Boolean)).toEqual([]);
  return list;
}

const llmCalls = (runId: string) =>
  api.deps.db.selectFrom("platform.llm_calls").select("call_type").where("run_id", "=", runId).execute();

describe("platform: a build by the brief on the harness v3 (WIZARD_BUILD_PIPELINE=v3)", () => {
  test("pipeline switch: WIZARD_BUILD_PIPELINE=v3; a card or plan build stays on its pipeline", async () => {
    expect(v3PipelineOn({ WIZARD_BUILD_PIPELINE: "v3" })).toBe(true);
    expect(v3PipelineOn({ WIZARD_BUILD_PIPELINE: "modules" })).toBe(false);
    expect(V3_BUILD_CAP_CREDITS).toBe(100);
    const id = await addSystem("Без брифа");
    const base = { card: {}, mode: "create" as const };
    expect(await isV3Build(api.deps.db, id, base, true)).toBe(false);
    await saveBriefVersion(api.deps.db, { systemId: id, brief: smallBrief(), author: "agent" });
    expect(await isV3Build(api.deps.db, id, base, true)).toBe(true);
    expect(await isV3Build(api.deps.db, id, base, false)).toBe(false);
    expect(await isV3Build(api.deps.db, id, { ...base, card: { title: "x" } }, true)).toBe(false);
    expect(await isV3Build(api.deps.db, id, { ...base, plan: { revision: 1, plan: {} } }, true)).toBe(false);
  });

  test("«Собрать» → preview, scenarios with G0 + G1, final gates, checkpoints, the e-mail; the repeat pays nothing", async () => {
    const systemId = await addSystem("Клиника «Улыбка»");
    await saveBriefVersion(api.deps.db, { systemId, brief: smallBrief(), author: "agent" });
    const run = await startV3Build(api.deps, { systemId, userId: DEV_USER_ID });
    expect(run.credits_cap_milli).toBe(String(V3_BUILD_CAP_CREDITS * 1000));
    const done = await waitRun(api, run.id, ["succeeded", "failed"], 240_000);
    const ev = await events(run.id);
    const gates = ev.filter((e) => e.type === "gate_result").map((e) => e.payload);
    expect(done.status, JSON.stringify({ failure: done.failure, gates })).toBe("succeeded");

    // Stages of the harness v3 for the canvas; critic and template gate skipped until V3-13, V3-14; the techreview runs.
    const stages = ev
      .filter((e) => e.type === "build_stage")
      .map((e) => `${e.payload.stage}:${e.payload.status}`);
    expect(stages).toEqual([
      "brief:started",
      "brief:done",
      "design:started",
      "design:done",
      "backend:started",
      "backend:done",
      "skeleton:started",
      "skeleton:done",
      "scenarios:started",
      "scenarios:done",
      "critic:skipped",
      "template_gate:skipped",
      "techreview:started",
      "techreview:done",
      "gates:started",
      "gates:done",
    ]);
    // The preview right after the skeleton (G0 bundles it), before any model call; then G0 + G1 per scenario; the final
    // gates skip G0 of the revision the last scenario's check passed (V3-15: nothing changed since), then G1 and G2.
    expect(gates.map((g) => g.level)).toEqual(["G0", "G0", "G1", "G0", "G1", "G0", "G1", "G1", "G2"]);
    const firstCall = ev.findIndex((e) => e.type === "budget_update");
    const firstGate = ev.findIndex((e) => e.type === "gate_result");
    expect(firstGate).toBeLessThan(firstCall);
    expect(gates.slice(0, 8).every((g) => g.passed === true)).toBe(true);
    const sys = await api.deps.db
      .selectFrom("platform.systems")
      .select(["stage", "preview_revision", "draft_revision"])
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
    expect(sys.stage).toBe("ready");
    expect(sys.preview_revision).not.toBeNull();
    expect((await llmCalls(run.id)).map((c) => c.call_type)).toEqual(Array(3).fill("page_compose"));
    // Checkpoints of every stage and scenario with the fingerprints; the summary names the scenarios done.
    const cps = await api.deps.pg<{ key: string }[]>`
      select key from platform.system_build_checkpoints where system_id = ${systemId} order by key`;
    // Sorted in JS: `order by key` follows the database collation ("scenarios" vs "scenario:…" differ between C and ICU).
    expect(cps.map((c) => c.key).sort()).toEqual(
      [
        "backend",
        "brief",
        "critic",
        "design",
        "draft",
        "gates",
        "questions",
        "scenario:s_book",
        "scenario:s_doctors",
        "scenario:s_lead",
        "scenarios",
        "skeleton",
        "techreview",
        "template_gate",
      ].sort(),
    );
    const finished = ev.find((e) => e.type === "run_finished")?.payload as { summary_ru: string };
    expect(finished.summary_ru).toContain("готово 3 из 3 сценариев");
    // The ready notice by e-mail to the one who pressed «Собрать», with the link to the system.
    const letters = new OutboxMailer(outboxDir).list(DEV_USER_EMAIL);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ kind: "notice", subject: "Система «Клиника «Улыбка»» собрана" });
    expect(letters[0]?.text).toContain(`/s/${systemId}`);

    // «Собрать» again on the same brief: every step from the checkpoints — no model call, no letter twice per run.
    const again = await startV3Build(api.deps, { systemId, userId: DEV_USER_ID });
    const done2 = await waitRun(api, again.id, ["succeeded", "failed"], 240_000);
    expect(done2.status, JSON.stringify(done2.failure)).toBe("succeeded");
    const ev2 = await events(again.id);
    expect(
      ev2
        .filter((e) => e.type === "build_stage" && e.payload.status === "reused")
        .map((e) => e.payload.stage),
    ).toEqual(["brief", "design", "skeleton", "techreview", "gates"]);
    // No new revision, no gate run: the draft is where the first build left it.
    expect(ev2.filter((e) => e.type === "gate_result" || e.type === "file_written")).toEqual([]);
    const after = await api.deps.db
      .selectFrom("platform.systems")
      .select("draft_revision")
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
    expect(after.draft_revision).toBe(sys.draft_revision);
    expect(await llmCalls(again.id)).toEqual([]);
    expect(new OutboxMailer(outboxDir).list(DEV_USER_EMAIL)).toHaveLength(2);
  }, 480_000);
});
