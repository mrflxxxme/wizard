// Acceptance M0-26: the golden demo fixtures through the API with the real agents — orchestrator, builder, QA
// (through host.route), gates G0/G1 (G1 on an in-process runtime), migrate_draft/seed_draft/bundle_and_reload —
// and the draft served by a runtime reading platform.deployments (DbRegistry).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CardShape, estimateCard } from "@wizard/agents/orchestrator";
import { createRouter } from "@wizard/llm";
import { closeExecutors, createRuntimeApp, DbRegistry } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MIGRATOR_ROLE } from "../src/agents/draft.js";
import { createAgentExecutors } from "../src/agents/executors.js";
import { listEvents } from "../src/runs/events.js";
import type { RunExecutors } from "../src/runs/types.js";
import { loadManifest, loadSpec } from "../src/services/revisions.js";
import { loadEventSchemas } from "./event-schemas.js";
import { createTestDb, loadYaml, ROOT, startApi, type TestApi, waitRun } from "./helpers.js";

const schemas = loadEventSchemas();
const forbiddenT1 = (loadYaml("specs/agents/models.yaml") as { pii_forbidden_for_T1: { always: string[] } })
  .pii_forbidden_for_T1.always;

/** First user message of the recorded interview (the brief of the golden transcript). */
function brief(name: "forum" | "bakery"): string {
  const first = readFileSync(join(ROOT, `tools/fixtures/demo/${name}.jsonl`), "utf8").split("\n")[0] ?? "{}";
  return (JSON.parse(first) as { request: { messages: { content: string }[] } }).request.messages[0]
    ?.content as string;
}

/**
 * demo/bakery's interview lines were recorded for a fork list the orchestrator no longer selects (docs/reviews/
 * impl-notes/M0-26.md), so its interview is replayed from the recording: golden questions, then the recorded
 * submit_card with the estimate the orchestrator would add. The build runs the real agents on the fixture.
 */
const recordedInterview =
  (name: "bakery"): RunExecutors["interviewTurn"] =>
  async (host) => {
    const g = loadYaml(`tools/fixtures/golden/${name}.yaml`) as { questions: Record<string, unknown>[] };
    if (host.context.trigger === "create")
      return { kind: "questions", text: "Есть вопросы", questions: g.questions };
    const line = readFileSync(join(ROOT, `tools/fixtures/demo/${name}.jsonl`), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { callType: string; response: { toolCalls: { args: unknown }[] } })
      .find((l) => l.callType === "card");
    const card = line?.response.toolCalls[0]?.args as Record<string, unknown>;
    const est = estimateCard(card as unknown as CardShape, { orgPolicy: host.context.org.policy });
    return { kind: "card", text: "Карточка готова", card: { ...card, estimate: est.estimate, cap: est.cap } };
  };

let tdb: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  tdb = await createTestDb("golden", { migrator: true });
});
afterAll(async () => {
  await closeExecutors();
  await tdb?.drop();
});

function problems(events: { type: string; payload: unknown; seq: number }[]): string[] {
  const out = events.map((e) => schemas.validate(e)).filter((x): x is string => x !== null);
  if (events.some((e, i) => e.seq !== i + 1)) out.push("seq gap");
  const terminal = events.filter((e) => e.type === "run_finished" || e.type === "run_failed");
  if (terminal.length !== 1 || events.at(-1) !== terminal[0]) out.push("terminal event is not single/last");
  return out;
}

async function goldenRun(api: TestApi, name: "forum" | "bakery", finals: string[]) {
  const created = await api.req("POST", "/systems", { body: { prompt: brief(name) } });
  expect(created.status).toBe(201);
  const systemId: string = created.body.system.id;
  const r0 = await waitRun(api, created.body.run.id, ["succeeded", "failed"], 20_000);
  expect(r0.status, JSON.stringify(r0.failure)).toBe("succeeded");
  const q = await api.req("GET", `/systems/${systemId}`);
  expect(q.body.pendingQuestions.length).toBeGreaterThanOrEqual(3);
  const ans = await api.req("POST", `/systems/${systemId}/answers`, { body: { restByRecommendation: true } });
  expect(ans.status).toBe(202);
  await waitRun(api, ans.body.run.id, ["succeeded"], 20_000);
  const card = await api.req("GET", `/systems/${systemId}`);
  expect(card.body.system.stage).toBe("card");
  const ap = await api.req("POST", `/systems/${systemId}/card/approve`, {
    body: { cardVersion: card.body.card.cardVersion },
  });
  expect(ap.status).toBe(202);
  const buildRunId: string = ap.body.run.id;
  const run = await waitRun(api, buildRunId, finals, 240_000);
  return { systemId, runIds: [created.body.run.id, ans.body.run.id, buildRunId], buildRunId, run };
}

async function gateResults(api: TestApi, runId: string) {
  return (await listEvents(api.deps.db, runId, 0))
    .filter((e) => e.type === "gate_result")
    .map((e) => e.payload as { level: string; passed: boolean; failedChecks: unknown[] });
}

describe("demo/forum through the API", () => {
  let api: TestApi;
  let g: Awaited<ReturnType<typeof goldenRun>>;
  beforeAll(async () => {
    api = await startApi(tdb.url, {
      config: { unsafeLocalExec: true },
      createRouter: (o) =>
        createRouter({ ...o, mode: "fixture", fixture: { suite: "demo", name: "forum" }, env: {} }),
    });
    g = await goldenRun(api, "forum", ["succeeded", "failed", "cancelled", "needs_input"]);
  }, 300_000);
  afterAll(async () => {
    await api?.dispose();
  });

  test("POST /systems → answers → approve → run_finished succeeded; G0 and G1 passed", async () => {
    const gates = await gateResults(api, g.buildRunId);
    expect(g.run.status, JSON.stringify({ failure: g.run.failure, gates })).toBe("succeeded");
    expect(gates.filter((x) => x.level === "G0").at(-1)?.passed).toBe(true);
    expect(
      gates.filter((x) => x.level === "G1").map((x) => x.passed),
      JSON.stringify(gates),
    ).toEqual([true]);
    const reports = await api.deps.db
      .selectFrom("platform.gate_reports")
      .select(["level", "passed"])
      .where("run_id", "=", g.buildRunId)
      .execute();
    expect(reports.filter((r) => r.level === "G1")).toEqual([{ level: "G1", passed: true }]);
  });

  test("every event of the three runs is valid per workflows.yaml#events (ajv)", async () => {
    for (const id of g.runIds) expect(problems(await listEvents(api.deps.db, id, 0)), id).toEqual([]);
    const types = (await listEvents(api.deps.db, g.buildRunId, 0)).map((e) => e.type);
    for (const t of ["plan_ready", "ops_applied", "file_written", "budget_update", "gate_started"])
      expect(types).toContain(t);
  });

  test("draft schema has the seed and dev users; /_wizard/health reports revision = preview_revision", async () => {
    const sys = await api.deps.db
      .selectFrom("platform.systems")
      .select(["schema_key", "slug", "preview_revision"])
      .where("id", "=", g.systemId)
      .executeTakeFirstOrThrow();
    expect(sys.preview_revision).not.toBeNull();
    const schema = `app_${sys.schema_key}_draft`;
    const pg = api.deps.pg;
    const users = await pg.unsafe(`select role, email from "${schema}".users order by email`);
    expect(users.map((u) => u.email)).toEqual(
      expect.arrayContaining(["dev-organizer@dev.localhost", "dev-participant@dev.localhost"]),
    );
    expect(users.some((u) => /^user\d+@example\.test$/.test(String(u.email)))).toBe(true);
    const [{ n } = { n: 0 }] = await pg.unsafe(`select count(*)::int as n from "${schema}".ticket`);
    expect(n).toBeGreaterThan(0);

    const [dep] = await pg`select * from platform.deployments where system_id = ${sys.schema_key}`;
    const manifest = JSON.parse(
      readFileSync(
        join(api.artifactsDir, sys.schema_key, String(sys.preview_revision), "manifest.json"),
        "utf8",
      ),
    ) as { specHash: string; bundleKey: string };
    expect(manifest).toMatchObject({ specHash: dep?.spec_hash, bundleKey: dep?.bundle_key });

    const rt = createRuntimeApp({
      db: pg,
      registry: new DbRegistry(pg),
      artifactsRoot: api.artifactsDir,
      env: {
        authModeDev: true,
        devLogin: true,
        unsafeLocalExec: false,
        publicScheme: "http",
        platformOrigin: "http://localhost:5173",
        systemsDomain: "localhost",
        nodeEnv: "test",
        kubernetes: false,
      },
    });
    const host = `${sys.slug}--draft.localhost:4100`;
    const res = await rt.fetch(new Request(`http://${host}/_wizard/health`, { headers: { host } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      system: sys.slug,
      env: "draft",
      revision: sys.preview_revision,
    });
    // The consent text the platform filled from the lawyer's template (a marked draft so far) reaches the preview.
    const spec = await rt.fetch(new Request(`http://${host}/_wizard/spec`, { headers: { host } }));
    expect(spec.status).toBe(200);
    const body = (await spec.json()) as { compliance?: { consentText?: string } };
    expect(body.compliance?.consentText).toMatch(/^ЧЕРНОВИК — требует согласования юристом/);
    // …while revisions keep owner-only fields owner-only: nothing wrote consentText into the stored spec.
    const revs =
      await pg`select spec->'compliance' as c from platform.revisions where system_id = ${g.systemId}`;
    for (const r of revs) expect((r.c as Record<string, unknown> | null)?.consentText).toBeUndefined();
  });

  test("draft migrations run as the migrator: not a superuser, no rights on platform; it owns the draft schema", async () => {
    const pg = api.deps.pg;
    const [role] = await pg`
      select rolsuper, rolbypassrls, has_schema_privilege(${MIGRATOR_ROLE}, 'platform', 'USAGE') as usage,
             has_schema_privilege(${MIGRATOR_ROLE}, 'platform', 'CREATE') as create
      from pg_roles where rolname = ${MIGRATOR_ROLE}`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, usage: false, create: false });
    const [platformOwner] =
      await pg`select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'platform'`;
    expect(platformOwner?.owner).not.toBe(MIGRATOR_ROLE);
    const sys = await api.deps.db
      .selectFrom("platform.systems")
      .select("schema_key")
      .where("id", "=", g.systemId)
      .executeTakeFirstOrThrow();
    const [ns] =
      await pg`select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = ${`app_${sys.schema_key}_draft`}`;
    expect(ns?.owner).toBe(MIGRATOR_ROLE);
    // G1 pinned systems are unloaded and their ephemeral schemas dropped.
    const [{ n } = { n: 0 }] =
      await pg`select count(*)::int as n from pg_namespace where nspname like ${`app\\_${sys.schema_key}\\_g1\\_%`}`;
    expect(n).toBe(0);
  });

  test("usage journal: the QA call is billed to the build run; no T1 record of pii_forbidden_for_T1.always", async () => {
    const calls = await api.deps.db
      .selectFrom("platform.llm_calls")
      .select(["call_type", "tier", "run_id"])
      .where("system_id", "=", g.systemId)
      .execute();
    expect(calls.filter((c) => c.tier === "T1" && forbiddenT1.includes(c.call_type))).toEqual([]);
    expect(calls.filter((c) => c.call_type === "qa_generate").map((c) => c.run_id)).toEqual([g.buildRunId]);
  });

  test("G2 through the platform executors: the permission matrix runs on the G1 runtime and role (publish wiring)", async () => {
    const s = await api.deps.db
      .selectFrom("platform.systems")
      .selectAll()
      .where("id", "=", g.systemId)
      .executeTakeFirstOrThrow();
    const rev = s.preview_revision as number;
    const manifest = await loadManifest(api.deps.db, api.deps.blobs, s.id, rev);
    const files = new Map<string, string>();
    for (const [p, sha] of Object.entries(manifest))
      files.set(p, (await api.deps.blobs.get(sha)).toString("utf8"));
    // Same executors as the platform (the API's own instance shares the module-level function processes).
    const ex = createAgentExecutors({ pg: api.deps.pg, config: api.deps.config });
    const report = await ex.gates?.("G2", {
      spec: await loadSpec(api.deps.db, s, rev),
      prevSpec: null,
      specVersion: rev,
      files,
      env: "draft",
      systemKey: s.schema_key,
      db: api.deps.pg,
      milestone: "M1",
    });
    const matrix = (report?.checks ?? []).filter((c) => /^G2-PERM-0[1-4]$/.test(c.id));
    expect(new Set(matrix.map((c) => c.id))).toEqual(
      new Set(["G2-PERM-01", "G2-PERM-02", "G2-PERM-03", "G2-PERM-04"]),
    );
    expect(matrix.filter((c) => c.status !== "pass" && c.status !== "skip")).toEqual([]);
    // The G2 ephemeral schema is dropped after the gate.
    const [{ n } = { n: 0 }] = await api.deps
      .pg`select count(*)::int as n from pg_namespace where nspname like ${`app\\_${s.schema_key}\\_g2\\_%`}`;
    expect(n).toBe(0);
  }, 300_000);
});

describe("demo/bakery through the API", () => {
  let api: TestApi;
  let g: Awaited<ReturnType<typeof goldenRun>>;
  beforeAll(async () => {
    api = await startApi(tdb.url, {
      config: { unsafeLocalExec: true },
      executors: (d) => ({ ...createAgentExecutors(d), interviewTurn: recordedInterview("bakery") }),
      createRouter: (o) =>
        createRouter({ ...o, mode: "fixture", fixture: { suite: "demo", name: "bakery" }, env: {} }),
    });
    g = await goldenRun(api, "bakery", ["succeeded", "failed", "cancelled", "needs_input"]);
    if (g.run.status === "needs_input") await api.req("POST", `/runs/${g.buildRunId}/cancel`, { body: {} });
  }, 300_000);
  afterAll(async () => {
    await api?.dispose();
  });

  test("reaches G0 = passed; events are valid", async () => {
    const gates = await gateResults(api, g.buildRunId);
    expect(
      gates.some((x) => x.level === "G0" && x.passed),
      JSON.stringify(gates),
    ).toBe(true);
    await waitRun(api, g.buildRunId, ["succeeded", "failed", "cancelled"]);
    // Beyond the criterion: the bakery build also passes G1 and succeeds.
    expect(g.run.status).toBe("succeeded");
    expect(gates.filter((x) => x.level === "G1").at(-1)?.passed).toBe(true);
    for (const id of g.runIds) expect(problems(await listEvents(api.deps.db, id, 0)), id).toEqual([]);
  });

  test("usage journal: no T1 record with a callType of pii_forbidden_for_T1.always", async () => {
    const calls = await api.deps.db
      .selectFrom("platform.llm_calls")
      .select(["call_type", "tier"])
      .where("system_id", "=", g.systemId)
      .execute();
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.filter((c) => c.tier === "T1" && forbiddenT1.includes(c.call_type))).toEqual([]);
  });
});
