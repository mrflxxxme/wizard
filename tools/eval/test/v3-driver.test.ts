// V3-18 step 0 of the ladder (agents/builder-v3.md §4): the v3 measurement driver end to end against a local platform
// on recorded answers — no network, no money. The pilot's settings: modules for clients, v3 for eval orgs
// (WIZARD_BUILD_PIPELINE_ORGS=eval), sessions, G2 at publication and the founder's review. The eval account is seeded
// by seed.mjs over psql as on the server; the driver goes the owner's way through the real routes: the grill interview
// (an option by the brief's stem, «Решите за меня», an own text) → three directions and «Решите за меня» → «Собрать» →
// the build of the harness v3 followed by its v3_progress snapshots over SSE → G0–G2 → the first publication up to the
// founder's review; collect (v3 lines) → the checkpoint report (Markdown + JSON). The ТЗ upload goes through the real
// route too. Needs psql (as the release operator uses it).

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createAgentExecutors } from "../../../apps/platform-api/src/agents/executors.ts";
import { OutboxMailer } from "../../../apps/platform-api/src/auth/mailer.ts";
import { buildPipelineOrgsOf } from "../../../apps/platform-api/src/config.ts";
import { createTestDb, startApi, type TestApi } from "../../../apps/platform-api/test/helpers.ts";
import { MemoryMailer, ORIGIN } from "../../../apps/platform-api/test/session.ts";
import { closeExecutors } from "../../../apps/runtime/src/index.ts";
import { DENTAL_SCRIPT, type ScriptedAnswer } from "../../../packages/agents/test/interview-v3/helpers.ts";
import { fakeComposer } from "../../../packages/agents/test/v3-harness-fixtures.ts";
import {
  LlmError,
  type RouteInput,
  type RouteOutput,
  type Router,
  type RouterOptions,
  type UsageRecord,
} from "../../../packages/llm/src/index.ts";
import { loadBriefs } from "../lib/briefs.mjs";
import { platformClient } from "../server/client.mjs";
import {
  collectSql,
  evalCredits,
  newEvalSession,
  newRunId,
  parseCollectOutput,
  parseSeedOutput,
  revokeSql,
  seedSql,
} from "../server/seed.mjs";
import { fillOwnerOperator, ownerGates, runV3Eval, V3_DEFAULTS, V3_TEST_OPERATOR, v3EvalOptions } from "../server/v3.mjs";
import { criticReview } from "../server/seed.mjs";
import { checkpointName, criticReviewLines, renderV3Report } from "../server/v3-report.mjs";

const hasPsql = spawnSync("psql", ["--version"]).status === 0;

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", [url, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-1", "-f", "-"], {
    input: sql,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout;
}

/**
 * Recorded answers of the platform's model calls: interview_v3 — the dental dialog of V3-03 (without its search turn),
 * page_compose — a page headline; everything else (directions texts, the art director, the techreview's reviewer,
 * brief_extract) has no record, so the platform takes its way without a model. Every answer is written to the usage
 * sink of the router (platform.llm_calls), as the gateway does.
 */
function recordedRouter(queue: ScriptedAnswer[], calls: string[]): (opts: RouterOptions) => Router {
  return (opts) => ({
    mode: "fixture",
    registry: {} as Router["registry"],
    async route(input: RouteInput): Promise<RouteOutput> {
      calls.push(input.callType);
      let a: ScriptedAnswer | undefined;
      if (input.callType === "interview_v3") a = queue.shift() ?? "нет ответа";
      else if (input.callType === "page_compose")
        a = [{ name: "submit_page", args: { headline: "Запись к врачу онлайн" } }];
      // As the fixture router answers a miss: the steps with a way without a model take it.
      else throw new LlmError("FIXTURE_MISS", `Нет записанного ответа модели для шага «${input.callType}».`);
      if (a instanceof Error) throw a;
      const tier = input.callType === "interview_v3" ? "T1" : "T0";
      const record: UsageRecord = {
        id: randomUUID(),
        runId: input.ctx.runId ?? null,
        orgId: input.ctx.orgId,
        systemId: input.ctx.systemId ?? null,
        step: input.ctx.step ?? null,
        callType: input.callType as UsageRecord["callType"],
        agentRole: "builder",
        tier,
        provider: "fixture",
        modelId: input.callType === "interview_v3" ? "glm-5.3" : "kimi-k2.6",
        attempt: 1,
        status: "ok",
        errorCode: null,
        routeReason: tier === "T1" ? "default_T1" : "default_T0",
        fallbackFrom: null,
        policyVersion: "test",
        scrubbed: true,
        piiCategoriesCount: {},
        inputTokens: 1200,
        cachedTokens: 0,
        outputTokens: 300,
        toolCalls: Array.isArray(a) ? a.length : 0,
        latencyMs: 40,
        ttftMs: null,
        costRub: 0.4,
        creditsMilli: 80,
        billable: true,
        mode: "fixture",
        requestHash: "0".repeat(64),
        createdAt: new Date().toISOString(),
      };
      // The composer's own context (orgId «host») is not a platform org: such a record is not the measurement's.
      await Promise.resolve(opts.sink?.write(record)).catch(() => {});
      return {
        tier,
        model: record.modelId,
        result: Array.isArray(a)
          ? {
              toolCalls: a.map((c, i) => ({
                id: `c${calls.length}_${i}`,
                name: c.name,
                args: c.args as Record<string, unknown>,
              })),
              finishReason: "tool-calls",
            }
          : { toolCalls: [], text: a, finishReason: "stop" },
        usage: { inputTokens: 1200, cachedTokens: 0, outputTokens: 300 },
        creditsCharged: 0.08,
        creditsMilli: 80,
        routeReason: record.routeReason,
        scrubbed: true,
        ruFallback: false,
      };
    },
  });
}

/** fetch into the in-process app; an aborted read cancels the response stream as the network does (SSE windows). */
function bridge(api: TestApi) {
  return async (url: string, init: RequestInit = {}) => {
    const res = await api.fetch(
      new Request(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), host: "localhost:4000" },
      }),
    );
    const signal = init.signal;
    if (!signal || !res.body) return res;
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const { done, value } = await reader.read();
        if (done) ctrl.close();
        else ctrl.enqueue(value);
      },
      cancel: () => reader.cancel(),
    });
    signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
    return new Response(body, { status: res.status, headers: res.headers });
  };
}

describe("V3-18: the driver acts as the owner before publishing (the operator of personal data)", () => {
  const sys = (blockers: string[]) => ({ system: { draftRevision: 7 }, publishBlockers: blockers });
  function fakeClient(blockers: string[]) {
    const puts: { path: string; body: Record<string, unknown> }[] = [];
    return {
      puts,
      client: {
        get: async () => ({ status: 200, body: sys(blockers) }),
        put: async (path: string, body: Record<string, unknown>) => {
          puts.push({ path, body });
          return { status: 200, body: { revision: { version: 8 } } };
        },
      },
    };
  }

  test("OPERATOR_* blockers → setCompliance with clearly fake but valid owner data; nothing asked → nothing sent", async () => {
    const said: string[] = [];
    const { client, puts } = fakeClient(["OPERATOR_NAME_REQUIRED", "OPERATOR_ADDRESS_REQUIRED", "GATES_FAILED"]);
    const out = await fillOwnerOperator(client, "s1", (m: string) => said.push(m));
    expect(out).toEqual({
      filled: true,
      revision: 8,
      blockers: ["OPERATOR_NAME_REQUIRED", "OPERATOR_ADDRESS_REQUIRED"],
    });
    expect(puts).toEqual([
      {
        path: "/systems/s1/compliance",
        body: {
          expectedVersion: 7,
          operatorName: "ИП Тестов Т. Т.",
          operatorContact: "operator@test.example",
          operatorAddress: V3_TEST_OPERATOR.operatorAddress,
          operatorInn: V3_TEST_OPERATOR.operatorInn,
        },
      },
    ]);
    // The values pass setCompliance (operatorName ≥ 3 chars, an e-mail contact) and say they are a test.
    expect(V3_TEST_OPERATOR.operatorContact).toMatch(/^[^\s@]+@[^\s@]+\.[a-z]+$/);
    expect(V3_TEST_OPERATOR.operatorAddress).toMatch(/тестов/i);
    expect(said.join("\n")).toContain("ревизия 8");
    // A shop asks for the seller's requisites (the offer): the same step, with an INN that passes the checksum.
    const shop = fakeClient(["SELLER_REQUISITES_REQUIRED"]);
    expect((await fillOwnerOperator(shop.client, "s1")).blockers).toEqual(["SELLER_REQUISITES_REQUIRED"]);
    expect(shop.puts).toHaveLength(1);
    const d = [...V3_TEST_OPERATOR.operatorInn].map(Number);
    const check = (w: number[]) => (w.reduce((sum, k, i) => sum + k * (d[i] as number), 0) % 11) % 10;
    expect([check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]), check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8])]).toEqual([d[10], d[11]]);
    const none = fakeClient(["FOUNDER_REVIEW_PENDING"]);
    expect(await fillOwnerOperator(none.client, "s1")).toEqual({ filled: false, revision: null, blockers: [] });
    expect(none.puts).toEqual([]);
  });

  test("a build G2 older than the owner's data: G2-PII-06 is the owner's action, not a blocker of the system", () => {
    const pii = { id: "G2-PII-06", status: "fail", severity: "blocker", message_ru: "Не указано: название оператора ПДн" };
    const latest = (g2Revision: number, checks = [pii]) => ({
      revision: g2Revision,
      reports: [
        { level: "G0", passed: true, specVersion: 5, checks: [] },
        { level: "G1", passed: true, specVersion: 5, checks: [] },
        { level: "G2", passed: false, specVersion: g2Revision, checks },
      ],
    });
    const filled = { filled: true, revision: 6 };
    expect(ownerGates(latest(5), filled).G2).toMatchObject({ blockers: [], ownerActions: [{ id: "G2-PII-06" }] });
    // The publication's G2 on the owner's revision still failing on it is a real blocker.
    expect(ownerGates(latest(6), filled).G2?.blockers).toEqual([{ id: "G2-PII-06", message: pii.message_ru }]);
    // Nothing filled: the gates as they are.
    expect(ownerGates(latest(5), null).G2?.blockers).toHaveLength(1);
  });
});

describe.skipIf(!hasPsql)("v3 measurement on a local platform (fixtures)", () => {
  let tdb: Awaited<ReturnType<typeof createTestDb>>;
  let api: TestApi;
  let outbox: string;
  const calls: string[] = [];
  const queue = DENTAL_SCRIPT.slice(1) as ScriptedAnswer[];
  const session = newEvalSession();
  let seed: { orgId: string; email: string };

  beforeAll(async () => {
    tdb = await createTestDb("v3drv", { migrator: true });
    outbox = mkdtempSync(join(tmpdir(), "wz-v3drv-"));
    api = await startApi(tdb.url, {
      config: {
        authMode: "session",
        registration: "invite",
        prodG2Required: true,
        founderReviewRequired: true,
        unsafeLocalExec: true,
        runConcurrency: 4,
        // The pilot before the checkpoint is accepted: clients on modules, measurement orgs on v3.
        buildPipeline: "modules",
        buildPipelineOrgs: buildPipelineOrgsOf("eval"),
      },
      mailer: new MemoryMailer(),
      creditsCronMs: 0,
      createRouter: recordedRouter(queue, calls),
      executors: ({ pg, config }) =>
        createAgentExecutors({
          pg,
          config,
          research: null,
          v3: { composer: fakeComposer(), mailer: new OutboxMailer(outbox) },
        }),
      publish: { smoke: async () => ({ ok: true }), lockRetryDelaysMs: [10, 10, 10] },
    });
    seed = parseSeedOutput(
      psql(
        tdb.url,
        seedSql({
          runid: newRunId(),
          tokenHash: session.tokenHash,
          csrfHash: session.csrfHash,
          credits: evalCredits(500),
          label: "V3",
        }),
      ),
    );
  }, 60_000);

  afterAll(async () => {
    await api?.dispose();
    await closeExecutors();
    await tdb?.drop();
    rmSync(outbox, { recursive: true, force: true });
  });

  test("brief v3-02 → interview → directions → «Собрать» → build v3 → G0–G2 → review; collect; the report", async () => {
    const [brief] = loadBriefs("v3-02-dental-booking");
    const client = platformClient({ base: ORIGIN, session, fetch: bridge(api), sleep: async () => {} });
    const lines: string[] = [];
    const doc = await runV3Eval({
      client,
      briefs: [brief],
      orgId: seed.orgId,
      ownerEmail: seed.email,
      runId: "local-v3",
      maxCostRub: 500,
      pollMs: 150,
      log: (s: string) => lines.push(s),
      // No browser in the CI job: the hook's output is what the report lays out.
      screenshot: async (r: { id: string }) => [
        { label: "телефон, 390 px", src: `shots/${r.id}-390.png` },
        { label: "компьютер, 1280 px", src: `shots/${r.id}-1280.png` },
      ],
    });
    const r = doc.results[0];
    expect(doc.kind).toBe("v3");
    expect(r.error, lines.join("\n")).toBeNull();
    // The interview: the recommended option by the stem «время», «Решите за меня», an own text; then the ready brief.
    expect(r.interview).toMatchObject({
      questions: 3,
      restAt: null,
      by: { recommended: 1, delegate: 1, text: 1 },
    });
    expect(r.pipeline).toBe("modules");
    expect(r.brief.version).toBeGreaterThanOrEqual(4);
    expect(r.brief.roles).toBe(3);
    expect(r.coverage.score).toBeGreaterThan(0.5);
    // Directions: «Решите за меня» — the system's first direction, not pinned.
    expect(r.direction).toMatchObject({ n: null, pinned: false });
    expect(r.direction.names).toHaveLength(3);
    // The build of the harness v3, followed by its snapshots: stages with times, the live preview, the scenarios.
    expect(r.build.status, JSON.stringify(r.build.failure)).toBe("succeeded");
    expect(r.build.stages.map((s: { id: string }) => s.id)).toEqual(
      expect.arrayContaining(["brief", "design", "backend", "skeleton", "scenarios", "techreview", "gates"]),
    );
    expect(r.build.previewMinutes).not.toBeNull();
    expect(r.build.minutes).toBeGreaterThanOrEqual(r.build.previewMinutes);
    // The time targets run from the ready brief: the interview is the owner's time.
    expect(r.fromBriefMinutes).toBeGreaterThanOrEqual(r.build.minutes);
    expect(r.fromBriefMinutes).toBeLessThanOrEqual(r.minutes);
    expect(r.build.scenarios.total).toBeGreaterThan(0);
    expect(r.build.scenarios.passed).toBe(r.build.scenarios.total);
    expect(r.build.capRub).toBe(500);
    expect(r.techreview).toMatchObject({ blocked: false });
    // G0–G2 and the first publication: it waits for the founder's review; nothing reaches prod.
    expect(r.gates.G0.passed && r.gates.G1.passed).toBe(true);
    expect(r.publish.status).toBe("review_pending");
    expect(r).toMatchObject({ status: "ready", ready: true });
    // The owner's step before publishing: the operator's data the system asked for, through setCompliance.
    expect(r.owner.operator).toMatchObject({ filled: true });
    expect(r.owner.operator.blockers).toContain("OPERATOR_NAME_REQUIRED");
    expect(
      psql(
        tdb.url,
        `select r.spec -> 'compliance' ->> 'operatorName' from platform.revisions r where r.system_id = '${r.systemId}' and r.version = ${Number(r.owner.operator.revision)}`,
      ).trim(),
    ).toBe(V3_TEST_OPERATOR.operatorName);
    const after = (await client.get(`/systems/${r.systemId}`)).body.publishBlockers ?? [];
    expect(after.filter((b: string) => b.startsWith("OPERATOR_"))).toEqual([]);
    expect(lines.some((l) => /владелец указал данные оператора ПДн/.test(l))).toBe(true);
    expect(lines.some((l) => /живое превью готово/.test(l))).toBe(true);
    expect(calls.filter((c) => c === "interview_v3")).toHaveLength(4);

    // The ТЗ file through the real upload route (multipart of the client).
    const up = await client.upload(`/systems/${r.systemId}/brief/upload`, {
      name: "tz.md",
      type: "text/markdown",
      data: new TextEncoder().encode(loadBriefs("v3-03-cleaning-crm")[0].tz.text),
    });
    expect([200, 201]).toContain(up.status);
    expect(up.body.source).toMatchObject({ kind: "file", method: "heuristic" });

    // Collect over psql with the v3 lines, the report, the revoke.
    const db = parseCollectOutput(psql(tdb.url, collectSql({ orgId: seed.orgId, v3: true })));
    expect(db.v3.t1Forbidden).toBe(0);
    const types = db.v3.calls[r.systemId].map((c: { callType: string }) => c.callType);
    expect(types).toContain("interview_v3");
    // Every attempt row carries its failures (none here): the SQL of the failed attempts runs on Postgres.
    for (const c of db.v3.calls[r.systemId]) expect(c.failures).toEqual([]);
    expect(db.v3.events[r.systemId].some((e: { type: string }) => e.type === "build_stage")).toBe(true);
    expect(Object.keys(db.v3.hooks[r.systemId] ?? {})).toEqual(
      expect.arrayContaining(["skeleton", "techreview"]),
    );
    expect(db.costs[r.systemId].rub).toBeGreaterThan(0);
    const { text, summary } = renderV3Report(doc, db, {
      platform: "локальный стенд (записанные ответы)",
      date: "2026-10-09",
    });
    expect(summary).toMatchObject({ total: 1, ready: 1, passed: true, costExact: true });
    expect(text).toContain("# Чекпоинт 1 волны A: замер v3 на сервере — 2026-10-09");
    expect(text).toContain("| v3-02-dental-booking | услуги и запись | ✅ готова |");
    expect(text).toMatch(/Время \(D77 \(10\)\): превью — до [\d.]+ мин ✅/);
    expect(text).toContain("| interview_v3 | 4 из 4 | glm-5.3 | T1 |");
    expect(text).toContain("«Решите за меня» 1");
    expect(text).toContain("## Сетка скриншотов");
    expect(text).toContain("![телефон, 390 px](shots/v3-02-dental-booking-390.png)");
    expect(checkpointName("2026-10-09T10:00:00Z")).toBe("v3-a-checkpoint1-2026-10-09");
    // The report files as the pilot writes them (WIZARD_V3_DRY_OUT keeps them for a look; else a temporary folder).
    const dir = process.env.WIZARD_V3_DRY_OUT || join(outbox, "report");
    mkdirSync(dir, { recursive: true });
    const name = checkpointName(doc.startedAt);
    writeFileSync(join(dir, `${name}.md`), text);
    writeFileSync(join(dir, `${name}.json`), `${JSON.stringify({ ...doc, db }, null, 2)}\n`);
    expect(existsSync(join(dir, `${name}.md`))).toBe(true);
    expect(psql(tdb.url, revokeSql({ tokenHash: session.tokenHash }))).toMatch(/revoked=/);
  }, 420_000);
});

describe("v3EvalOptions", () => {
  test("the v3 interview keeps its own turn limit (runEval's 8 of the v2 card cut a grill after «Дальше решай сам»)", () => {
    expect(v3EvalOptions({ briefs: [] }).maxTurns).toBe(V3_DEFAULTS.maxTurns);
    expect(V3_DEFAULTS.maxTurns).toBeGreaterThan(V3_DEFAULTS.restAfter + 2);
    expect(v3EvalOptions({ briefs: [], maxTurns: 5 }).maxTurns).toBe(5);
  });
});

describe("V3-40 critic diagnostics in the report", () => {
  test("the checkpoint's review is bounded; the report names the axes and the main findings of the last cycle", () => {
    const review = criticReview({
      stop: "no_gain",
      fixes: ["/: фирменная секция path → паттерн «Призыв» (C08)"],
      cycles: [
        { n: 1, score: 28, axes: { specificity: 2, first_screen: 3 }, polish: "draft", top: [] },
        {
          n: 2,
          score: 34,
          axes: { specificity: 2, first_screen: 3, typography: 3, color: 2, composition: 2, content: 3 },
          polish: "draft",
          top: [{ severity: "P1", sign: "x".repeat(400), where: "/@390#hero" }],
        },
      ],
    });
    expect(review.cycles[1]?.top[0]?.sign).toHaveLength(160);
    const lines = criticReviewLines(review);
    expect(lines[0]).toBe(
      "оси последнего круга (0–4): конкретность 2, первый экран 3, типографика 3, цвет 2, композиция 2, содержание 3; проработка: черновик",
    );
    expect(lines[1]).toMatch(/^P1 x{160} \(\/@390#hero\)$/);
    expect(criticReviewLines(null)).toEqual([]);
  });
});
