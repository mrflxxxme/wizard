// B2-21 acceptance through the API on the recorded answers (tools/fixtures/demo/b2, no network, no money): brief →
// goal interview → plan → approveSystemPlan → builder v2 (texts, design, compile, gates G0–G2 with the real agents
// executors and the in-process G1 runtime). The build fails on the design stage (models unavailable), «Исправить»
// continues from the checkpoints without paying for the texts again; a clean build costs ≤ 15 ₽ and ≤ 5 min.
import { dirname, join } from "node:path";
import { createRouter, LlmError, type Router, type RouterOptions } from "@wizard/llm";
import { closeExecutors, createFileStorage } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fixtureLines } from "../../../packages/agents/test/build-v2-fixtures.js";
import { B2_CUSTOM_SCENARIOS, B2_SCENARIOS } from "../../../packages/agents/test/build-v2-scenarios.js";
import { listEvents } from "../src/runs/events.js";
import { loadSpec } from "../src/services/revisions.js";
import { loadEventSchemas } from "./event-schemas.js";
import { createTestDb, startApi, type TestApi, waitRun } from "./helpers.js";

const schemas = loadEventSchemas();

/** Fixture router of a scenario; failDesignOnce — the first build_design call fails as if every model were down. */
function routerFactory(name: string, o: { failDesignOnce?: boolean } = {}): (opts: RouterOptions) => Router {
  let failed = !o.failDesignOnce;
  return (opts) => {
    const r = createRouter({
      ...opts,
      mode: "fixture",
      fixture: { suite: "demo", name: `b2/${name}` },
      env: {},
    });
    return {
      mode: r.mode,
      registry: r.registry,
      route: async (input) => {
        if (!failed && input.callType === "build_design") {
          failed = true;
          throw new LlmError("LLM_UNAVAILABLE", "все модели недоступны");
        }
        return r.route(input);
      },
    };
  };
}

let tdb: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  tdb = await createTestDb("b2build", { migrator: true });
});
afterAll(async () => {
  await closeExecutors();
  await tdb?.drop();
});

async function events(api: TestApi, runId: string) {
  const list = await listEvents(api.deps.db, runId, 0);
  expect(list.map((e) => schemas.validate(e)).filter(Boolean)).toEqual([]);
  return list;
}

/** brief → interview (no questions) → plan revision 1 → approve → the build run. */
async function planAndApprove(api: TestApi, brief: string) {
  const created = await api.req("POST", "/systems", { body: { prompt: brief } });
  expect(created.status).toBe(201);
  const systemId: string = created.body.system.id;
  const turn = await waitRun(api, created.body.run.id, ["succeeded", "failed"], 30_000);
  expect(turn.status, JSON.stringify(turn.failure)).toBe("succeeded");
  const plan = await api.req("GET", `/systems/${systemId}/plan`);
  expect(plan.body.plan).toMatchObject({ revision: 1, status: "awaiting_approval", errors: [] });
  const ap = await api.req("POST", `/systems/${systemId}/plan/approve`, { body: { revision: 1 } });
  expect(ap.status).toBe(202);
  return { systemId, buildRunId: ap.body.run.id as string };
}

async function llmCalls(api: TestApi, runId: string) {
  return api.deps.db
    .selectFrom("platform.llm_calls")
    .select(["call_type", "status"])
    .where("run_id", "=", runId)
    .execute();
}

async function credits(api: TestApi, runId: string): Promise<number> {
  const r = await api.deps.db
    .selectFrom("platform.runs")
    .select("credits_used_milli")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  return Number(r.credits_used_milli);
}

describe("modules pipeline: a failure on a stage → «Исправить» continues from the checkpoint", () => {
  let api: TestApi;
  const sc = B2_SCENARIOS.find((s) => s.name === "dental");
  beforeAll(async () => {
    api = await startApi(tdb.url, {
      config: { buildPipeline: "modules", unsafeLocalExec: true },
      createRouter: routerFactory("dental", { failDesignOnce: true }),
    });
  });
  afterAll(async () => {
    await api?.dispose();
  });

  test("design fails (models down) → run_failed retryable; fix reuses plan and texts, pays once, G0–G2 pass", async () => {
    if (!sc) throw new Error("dental");
    const { systemId, buildRunId } = await planAndApprove(api, sc.brief);
    const failed = await waitRun(api, buildRunId, ["succeeded", "failed"], 120_000);
    expect(failed.status).toBe("failed");
    expect(failed.failure).toMatchObject({ code: "LLM_UNAVAILABLE" });
    const ev1 = await events(api, buildRunId);
    expect(ev1.at(-1)).toMatchObject({
      type: "run_failed",
      payload: { code: "LLM_UNAVAILABLE", retryable: true },
    });
    const stage1 = ev1
      .filter((e) => e.type === "build_stage")
      .map((e) => `${e.payload.stage}:${e.payload.status}`);
    expect(stage1).toEqual(["plan:started", "plan:done", "texts:started", "texts:done", "design:started"]);
    const row = await api.deps.db
      .selectFrom("platform.system_plans")
      .select("checkpoints")
      .where("system_id", "=", systemId)
      .where("revision", "=", 1)
      .executeTakeFirstOrThrow();
    expect(Object.keys(row.checkpoints).sort()).toEqual(["plan", "texts"]);
    expect((await llmCalls(api, buildRunId)).map((c) => c.call_type)).toEqual(["build_texts"]);

    const sys1 = await api.req("GET", `/systems/${systemId}`);
    expect(sys1.body.system.stage).toBe("failed");
    const fix = await api.req("POST", `/systems/${systemId}/fix`, { body: {} });
    expect(fix.status).toBe(202);
    const done = await waitRun(api, fix.body.run.id, ["succeeded", "failed"], 240_000);
    const ev2 = await events(api, fix.body.run.id);
    const gates = ev2.filter((e) => e.type === "gate_result").map((e) => e.payload);
    expect(done.status, JSON.stringify({ failure: done.failure, gates })).toBe("succeeded");
    const stage2 = ev2
      .filter((e) => e.type === "build_stage")
      .map((e) => `${e.payload.stage}:${e.payload.status}`);
    expect(stage2.slice(0, 2)).toEqual(["plan:reused", "texts:reused"]);
    expect(stage2).toContain("design:done");
    expect(stage2).toContain("custom:skipped");
    // G2: only the operator of personal data is missing — the owner fills it before the publication (not a build
    // blocker; publish runs its own G2).
    expect(gates.map((g) => g.level)).toEqual(["G0", "G1", "G2"]);
    expect(gates.slice(0, 2).every((g) => g.passed === true)).toBe(true);
    expect(
      ((gates[2]?.failedChecks ?? []) as { id: string }[]).every((c) => c.id === "G2-PII-06"),
      JSON.stringify(gates[2]),
    ).toBe(true);
    const finished = ev2.find((e) => e.type === "run_finished")?.payload as { summary_ru: string };
    expect(finished.summary_ru).toContain("данные оператора персональных данных");
    // The texts were paid by the failed run only; the fix paid for the design only.
    expect((await llmCalls(api, fix.body.run.id)).map((c) => c.call_type)).toEqual(["build_design"]);
    const sys2 = await api.req("GET", `/systems/${systemId}`);
    expect(sys2.body.system.stage).toBe("ready");
    expect(sys2.body.system.previewRevision).not.toBeNull();
    const home = await api.req("GET", `/systems/${systemId}/files/ui/pages/Home.tsx`);
    expect(home.text).toContain("Лечим зубы бережно и без боли");
  }, 400_000);
});

describe("modules pipeline on the recorded answers: ≤ 15 ₽ and ≤ 5 min without custom code", () => {
  let api: TestApi;
  const sc = B2_SCENARIOS.find((s) => s.name === "barber");
  beforeAll(async () => {
    api = await startApi(tdb.url, {
      config: { buildPipeline: "modules", unsafeLocalExec: true },
      createRouter: routerFactory("barber"),
    });
  });
  afterAll(async () => {
    await api?.dispose();
  });

  test("barber: a clean build passes G0–G2; cost by the models.yaml prices and time with the recorded latencies", async () => {
    if (!sc) throw new Error("barber");
    const { systemId, buildRunId } = await planAndApprove(api, sc.brief);
    const t0 = Date.now();
    const run = await waitRun(api, buildRunId, ["succeeded", "failed"], 300_000);
    const wallMs = Date.now() - t0;
    const ev = await events(api, buildRunId);
    expect(
      run.status,
      JSON.stringify({ failure: run.failure, gates: ev.filter((e) => e.type === "gate_result") }),
    ).toBe("succeeded");
    const types = ev.map((e) => e.type);
    for (const t of [
      "build_stage",
      "step_started",
      "file_written",
      "gate_started",
      "gate_result",
      "budget_update",
    ])
      expect(types).toContain(t);
    // ≤ 15 ₽: the build run (credits × 5 ₽) + the interview turn and the planner before it.
    const runs = await api.deps.db
      .selectFrom("platform.runs")
      .select(["id", "credits_used_milli"])
      .where("system_id", "=", systemId)
      .execute();
    const totalRub = (runs.reduce((s, r) => s + Number(r.credits_used_milli), 0) / 1000) * 5;
    expect(totalRub).toBeGreaterThan(0);
    expect(totalRub).toBeLessThanOrEqual(15);
    expect(await credits(api, buildRunId)).toBeLessThanOrEqual(3000);
    // ≤ 5 min: the measured build (compile, gates — no models here) + the recorded model latencies of the build.
    const recordedMs = fixtureLines(sc)
      .filter((l) => l.callType === "build_texts" || l.callType === "build_design")
      .reduce((s, l) => s + l.latencyMs, 0);
    expect(wallMs + recordedMs).toBeLessThanOrEqual(5 * 60_000);
    const metrics = (
      await api.deps.db
        .selectFrom("platform.run_events")
        .select("payload")
        .where("run_id", "=", buildRunId)
        .where("type", "=", "build_metrics")
        .executeTakeFirstOrThrow()
    ).payload as { stages: Record<string, unknown> };
    expect(metrics.stages).toMatchObject({ pipeline: "modules", status: "succeeded", planRevision: 1 });
    // B2-44: the system named after its brief («Барбершоп в Самаре») takes the plan's short name — in the cabinet
    // list and in the compiled draft (site header, <title>, e-mails).
    const sys = await api.req("GET", `/systems/${systemId}`);
    expect(sys.body.system.name).toBe("Барбершоп");
    const spec = await loadSpec(api.deps.db, { id: systemId, name: "" }, sys.body.system.draftRevision);
    expect(spec.app.name).toBe("Барбершоп");
    // B2-38: the photos stage (stock fixtures, no network) put stock photos into the landing; the copies are in the
    // shared photo library, the source, author and licence of each are in the compiled system.
    const photosMetric = metrics.stages.photos as { status: string; note: string; costRub: number };
    expect(photosMetric).toMatchObject({ status: "done", costRub: 0 });
    expect(photosMetric.note).toMatch(/^фото со стока: [1-9]\d* из \d+/);
    const helper = (await api.req("GET", `/systems/${systemId}/files/ui/pages/SitePhotos.tsx`)).text;
    const files = [...helper.matchAll(/"file":"([0-9a-f-]{36})"/g)].map((m) => m[1] as string);
    expect(files.length).toBeGreaterThan(0);
    expect(helper).toContain('"license":"Лицензия Pexels"');
    const library = createFileStorage(process.env, {
      defaultDir: join(dirname(api.artifactsDir), "files"),
    });
    for (const f of files) expect((await library.head(`wz_photos/${f}`))?.image, f).toBeDefined();
  }, 400_000);
});

async function capOf(api: TestApi, runId: string): Promise<number> {
  const r = await api.deps.db
    .selectFrom("platform.runs")
    .select("credits_cap_milli")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  return Number(r.credits_cap_milli);
}

async function fileOf(api: TestApi, systemId: string, path: string) {
  return api.req("GET", `/systems/${systemId}/files/${path}`);
}

describe("B2-23 custom code through the API on the recorded answers, real G0–G2", () => {
  let api: TestApi;
  const sc = B2_CUSTOM_SCENARIOS.find((s) => s.name === "dental_custom");
  beforeAll(async () => {
    api = await startApi(tdb.url, {
      config: { buildPipeline: "modules", unsafeLocalExec: true },
      createRouter: routerFactory("dental_custom", { failDesignOnce: true }),
    });
  });
  afterAll(async () => {
    await api?.dispose();
  });

  test("the cap of the build and of «Исправить» covers the custom stage; the parts pass the real gates", async () => {
    if (!sc) throw new Error("dental_custom");
    const { systemId, buildRunId } = await planAndApprove(api, sc.brief);
    // 15 ₽ + 20 ₽ of the custom stage = 7 credits.
    expect(await capOf(api, buildRunId)).toBe(7000);
    const failed = await waitRun(api, buildRunId, ["succeeded", "failed"], 120_000);
    expect(failed.failure).toMatchObject({ code: "LLM_UNAVAILABLE" });
    const fix = await api.req("POST", `/systems/${systemId}/fix`, { body: {} });
    expect(fix.status).toBe(202);
    expect(await capOf(api, fix.body.run.id)).toBe(7000);
    const done = await waitRun(api, fix.body.run.id, ["succeeded", "failed"], 300_000);
    const ev = await events(api, fix.body.run.id);
    const gates = ev.filter((e) => e.type === "gate_result").map((e) => e.payload);
    expect(done.status, JSON.stringify({ failure: done.failure, gates })).toBe("succeeded");
    expect((await llmCalls(api, fix.body.run.id)).map((c) => c.call_type)).toEqual([
      "build_design",
      "build_custom",
    ]);
    // The custom stage checks its revision (G0–G2), then the gates stage checks it again.
    expect(gates.map((g) => g.level)).toEqual(["G0", "G1", "G2", "G0", "G1", "G2"]);
    expect(gates.filter((g) => g.level !== "G2").every((g) => g.passed === true)).toBe(true);
    expect((await fileOf(api, systemId, "ui/custom/CustomPriceQuiz.tsx")).text).toContain("Подбор лечения");
    expect((await fileOf(api, systemId, "functions/custom/leads_month.ts")).status).toBe(200);
    const finished = ev.find((e) => e.type === "run_finished")?.payload as { summary_ru: string };
    expect(finished.summary_ru).toContain("Дописано под вашу задачу: «Подбор лечения», «Заявки за месяц».");
    expect(await credits(api, fix.body.run.id)).toBeLessThanOrEqual(7000);
  }, 600_000);
});

describe("B2-23: a custom part that never passes G0 → the system comes out without it, the request is recorded", () => {
  let api: TestApi;
  const sc = B2_CUSTOM_SCENARIOS.find((s) => s.name === "dental_custom_broken");
  beforeAll(async () => {
    api = await startApi(tdb.url, {
      config: { buildPipeline: "modules", unsafeLocalExec: true },
      createRouter: routerFactory("dental_custom_broken"),
    });
  });
  afterAll(async () => {
    await api?.dispose();
  });

  test("3 answers (1 + 2 rounds of fixes), the function rolled back, the screen kept, «Запросы на развитие»", async () => {
    if (!sc) throw new Error("dental_custom_broken");
    const { systemId, buildRunId } = await planAndApprove(api, sc.brief);
    const run = await waitRun(api, buildRunId, ["succeeded", "failed"], 400_000);
    const ev = await events(api, buildRunId);
    const gates = ev.filter((e) => e.type === "gate_result").map((e) => e.payload);
    expect(run.status, JSON.stringify({ failure: run.failure, gates })).toBe("succeeded");
    const calls = (await llmCalls(api, buildRunId)).map((c) => c.call_type);
    expect(calls.filter((c) => c === "build_custom")).toHaveLength(3);
    // The real G0 finds the guessed API in the function file each round.
    const g0 = gates.filter((g) => g.level === "G0" && g.passed === false);
    expect(g0).toHaveLength(3);
    expect(JSON.stringify(g0[0])).toContain("functions/custom/leads_month.ts");
    expect((await fileOf(api, systemId, "functions/custom/leads_month.ts")).status).toBe(404);
    expect((await fileOf(api, systemId, "ui/custom/CustomPriceQuiz.tsx")).status).toBe(200);
    const requests = await api.deps.db
      .selectFrom("platform.development_requests")
      .select(["category", "quote", "offered", "run_id"])
      .where("system_id", "=", systemId)
      .execute();
    // B2-41: the plan's out-of-scope items are recorded at approval; the custom part that failed comes on top.
    const custom = requests.filter((r) => r.quote.includes("Заявки за месяц"));
    expect(requests.length - custom.length).toBe(2);
    expect(custom).toEqual([
      expect.objectContaining({
        category: "other",
        run_id: buildRunId,
        quote: expect.stringContaining("Заявки за месяц"),
        offered: expect.stringContaining("Пока пользуйтесь разделом «Заявки»"),
      }),
    ]);
    const finished = ev.find((e) => e.type === "run_finished")?.payload as { summary_ru: string };
    expect(finished.summary_ru).toContain("«Заявки за месяц» не прошло автоматическую проверку");
    expect(finished.summary_ru).toContain("Мы записали это в запросы на развитие.");
    const sys = await api.req("GET", `/systems/${systemId}`);
    expect(sys.body.system.stage).toBe("ready");
  }, 600_000);
});
