// M1 exit criterion «Прогон переживает рестарт воркера (тест с kill -9)», workflows.yaml#execution.M1.durability:
// kill -9 of the worker during build_code → after a restart the run continues from the next unfinished step; no
// finished LLM step runs again; settlement is written once; events stay gap-free with one terminal event.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { listEvents } from "../../platform-api/src/runs/events.js";
import { loadManifest } from "../../platform-api/src/services/revisions.js";
import { loadEventSchemas } from "../../platform-api/test/event-schemas.js";
import { startBuild } from "../../platform-api/test/flow.js";
import { createTestDb, startApi, type TestApi, waitFor, waitRun } from "../../platform-api/test/helpers.js";
import { ENTRY, type Proc, start, stopProc, waitOut } from "./proc.js";
import { CODE_STEPS, LLM_CANARY, scriptedExecutors } from "./support.js";

const schemas = loadEventSchemas();
let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let env: Record<string, string>;
const procs: Proc[] = [];
const dirs: string[] = [];

const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

beforeAll(async () => {
  tdb = await createTestDb("kill");
  const config = {
    dbUrl: tdb.url,
    artifactsDir: tmp("wz-kill-art-"),
    stepsDir: tmp("wz-kill-steps-"),
    secretsFile: join(tmp("wz-kill-sec-"), "secrets.enc"),
    authMode: "dev",
  };
  api = await startApi(tdb.url, { engine: "dbos", config, executors: scriptedExecutors() });
  env = {
    WIZARD_DB_URL: tdb.url,
    WZ_ARTIFACTS: config.artifactsDir,
    WZ_STEPS: config.stepsDir,
    WZ_SECRETS: config.secretsFile,
    WZ_DELAY_MS: "250",
    // A fixture router answers by order: replayed steps must advance it (without new llm_calls rows).
    WZ_ROUTER_MODE: "fixture",
  };
}, 60_000);

afterAll(async () => {
  for (const p of procs) await stopProc(p, "SIGKILL");
  await api?.dispose();
  await tdb?.drop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function worker(): Promise<Proc> {
  const p = start(ENTRY, env);
  procs.push(p);
  await waitOut(p, '"msg":"ready"');
  return p;
}

const llmSteps = async (runId: string) =>
  (
    await api.deps.pg<{ step: string }[]>`
      select step from platform.llm_calls where run_id = ${runId} order by created_at`
  ).map((r) => r.step);

describe("kill -9 of the worker (M1-01)", () => {
  test("the run resumes from the next unfinished step, completes once, is charged once", async () => {
    const w1 = await worker();
    const b = await startBuild(api, "Форум на 600 человек");
    const runId = b.buildRunId;
    // Mid build_code: at least two code steps have called the model.
    await waitFor(async () => (await llmSteps(runId)).length >= 3, 30_000);
    w1.child.kill("SIGKILL");
    await w1.exited;
    const before = await llmSteps(runId);
    const evBefore = await listEvents(api.deps.db, runId, 0);
    expect((await api.req("GET", `/runs/${runId}`)).body.status).toBe("running");
    expect(before.length).toBeLessThan(CODE_STEPS);

    const w2 = await worker();
    await waitRun(api, runId, ["succeeded"], 60_000);

    // No finished LLM step ran again; only the one in flight at the kill may repeat.
    const after = await llmSteps(runId);
    const expected = Array.from({ length: CODE_STEPS }, (_, i) => `build_code#${i}`);
    expect([...new Set(after)].sort()).toEqual(expected.sort());
    const repeated = after.filter((s, i) => after.indexOf(s) !== i);
    expect(repeated.length).toBeLessThanOrEqual(1);
    for (const s of before.slice(0, -1)) {
      expect(after.filter((x) => x === s)).toHaveLength(1);
      // …but the restarted worker re-routed it muted, so the fixture order stays aligned.
      expect(w2.out()).toContain(`{"msg":"route","step":"${s}"}`);
    }

    // Events: gap-free, schema-valid, one terminal event; nothing checkpointed before the kill was written twice.
    const ev = await listEvents(api.deps.db, runId, 0);
    expect(ev.map((e) => schemas.validate(e)).filter(Boolean)).toEqual([]);
    expect(ev.map((e) => e.seq)).toEqual(ev.map((_, i) => i + 1));
    expect(ev.filter((e) => e.type === "run_finished")).toHaveLength(1);
    expect(ev.at(-1)?.type).toBe("run_finished");
    expect(ev.filter((e) => e.type === "run_started")).toHaveLength(1);
    expect(ev.slice(0, evBefore.length)).toEqual(evBefore);
    const started = ev.filter((e) => e.type === "step_started").map((e) => String(e.payload.step));
    expect(started.filter((s, i) => started.indexOf(s) !== i).length).toBeLessThanOrEqual(1);

    // billing.yaml#run_charging exactly once: one hold, its release, a charge of the billable calls.
    const ledger = await api.deps.pg<{ kind: string; key: string; amount: string }[]>`
      select kind, idempotency_key as key, amount_milli::text as amount from platform.credit_ledger
      where run_id = ${runId} order by id`;
    const sum = (k: string) => ledger.filter((l) => l.kind === k).reduce((a, l) => a + Number(l.amount), 0);
    const billed = (
      await api.deps.pg`select coalesce(sum(credits_milli), 0)::int as n from platform.llm_calls
        where run_id = ${runId} and billable`
    )[0]?.n as number;
    expect(sum("hold")).toBe(-sum("release"));
    expect(sum("charge")).toBe(-billed);
    expect(new Set(ledger.map((l) => l.key)).size).toBe(ledger.length);
    expect(ledger.filter((l) => l.kind === "charge").every((l) => l.key.startsWith(`charge:${runId}`))).toBe(
      true,
    );

    // Every page carries its own model answer: replayed steps returned the original outputs.
    const sys = await api.deps.db
      .selectFrom("platform.systems")
      .select("draft_revision")
      .where("id", "=", b.systemId)
      .executeTakeFirstOrThrow();
    const manifest = await loadManifest(api.deps.db, api.deps.blobs, b.systemId, sys.draft_revision);
    for (let i = 0; i < CODE_STEPS; i++) {
      const sha = manifest[`ui/Page${i}.tsx`] as string;
      expect((await api.deps.blobs.get(sha)).toString("utf8")).toContain(`build_code#${i}`);
    }
    const wf = await waitFor(async () => {
      const [w] = await api.deps.pg`
        select status, recovery_attempts from dbos.workflow_status where workflow_uuid = ${runId}`;
      return w?.status === "SUCCESS" ? w : undefined;
    });
    expect(Number(wf?.recovery_attempts)).toBeGreaterThanOrEqual(1);
    const leaks = await api.deps.pg`
      select count(*)::int as n from dbos.operation_outputs where output like ${`%${LLM_CANARY}%`}`;
    expect(leaks[0]?.n).toBe(0);
    // Step outputs are dropped once the workflow has ended (worker sweep).
    await waitFor(async () => !existsSync(join(env.WZ_STEPS as string, runId)), 10_000);
    await stopProc(w2);
  }, 120_000);
});
