// Acceptance M0-13: runBuild on demo/forum (golden fixture, offline) and demo/bakery (scripted from the example)
// reaches G0=passed without intervention. Forum runs end to end with the real QA agent (M0-14, its golden
// qa_generate line) and the real G1 on apps/runtime; bakery keeps the G1/QA fakes.
import { type AppSpec, applyOps, OWNER_ONLY_COMPLIANCE_FIELDS } from "@wizard/appspec";
import { runGates } from "@wizard/gates";
import { createRouter, MemoryUsageSink } from "@wizard/llm";
import { afterAll, describe, expect, test } from "vitest";
import { type BuildOutcome, createMemoryHost, executeBuild, type MemoryHost } from "../src/builder/index.js";
import { createQaAgent } from "../src/qa/index.js";
import {
  cardFor,
  connect,
  eventProblems,
  exampleFiles,
  expectedSpec,
  g1Stub,
  golden,
  startSpec,
  stop,
  tc,
  turn,
  uniqueKey,
  unordered,
} from "./builder-helpers.js";
import { fixtureLines, scriptedRoute } from "./helpers.js";
import { demoRouter, g1Harness, g1SchemaCount } from "./qa-helpers.js";

const db = connect();
afterAll(() => db.end());

describe("forum: golden fixture replay", async () => {
  const g = await golden("forum");
  const sink = new MemoryUsageSink();
  const router = createRouter({ mode: "fixture", fixture: { suite: "demo", name: "forum" }, sink, env: {} });
  const h = await g1Harness();
  afterAll(async () => {
    expect(await g1SchemaCount(h.db, "m013")).toBe(0);
    await h.close();
  });
  // QA has its own router over the same fixture: its credits stay out of the builder ledger checked below (M0-26
  // routes QA through the host).
  const qaRoute = demoRouter("forum");
  const qa = createQaAgent({ route: qaRoute.route });
  let qaCalls = 0;
  const explained: unknown[] = [];
  // The owner/platform fill compliance (operator, consentText from the template — author=system) before G1;
  // without consentText no consent can be given and every pii write gets 422 CONSENT_REQUIRED.
  const c = (g.buildSpec.compliance ?? {}) as Record<string, unknown>;
  const owner = Object.fromEntries(OWNER_ONLY_COMPLIANCE_FIELDS.filter((k) => k in c).map((k) => [k, c[k]]));
  const mem: MemoryHost = createMemoryHost({
    spec: startSpec(g.spec),
    route: router,
    db: h.db,
    runtime: h.rt,
    runtimeRole: h.role,
    systemKey: uniqueKey(),
    gates: {
      G1: (ctx) =>
        runGates("G1", { ...ctx, spec: { ...ctx.spec, compliance: { ...ctx.spec.compliance, ...owner } } }),
    },
    qa: {
      generate: async (input) => {
        qaCalls += 1;
        return qa.generate(input);
      },
      explain: async (input) => {
        const e = await qa.explain(input);
        explained.push(...e);
        return e;
      },
    },
  });
  const cap = 41;
  let out: BuildOutcome;

  test("build replays offline to G0 passed and succeeds", async () => {
    out = await executeBuild(mem, { card: g.card, cap, mode: "create" });
    expect(out).toMatchObject({ status: "succeeded" });
    const g0 = mem.events.filter((e) => e.type === "gate_result" && e.payload.level === "G0");
    expect(g0.length).toBe(1);
    expect(g0[0]?.payload.passed).toBe(true);
    const g1 = mem.events.filter((e) => e.type === "gate_result" && e.payload.level === "G1");
    expect(
      g1.map((e) => e.payload.passed),
      JSON.stringify(g1.map((e) => e.payload.failedChecks)),
    ).toEqual([true]);
    expect(g1[0]?.payload.totalChecks).toBeGreaterThan(10);
    expect(qaCalls).toBe(1);
    expect(qaRoute.calls).toEqual(["qa_generate"]);
    expect(explained).toEqual([]);
    const checks = qa.lastChecks();
    for (const ac of ["AC1", "AC2", "AC3", "AC4", "AC7", "AC8"])
      expect(
        checks.some((c) => c.acId === ac && c.level === "G1"),
        ac,
      ).toBe(true);
  }, 180_000);

  test("final spec equals the golden spec", () => {
    const { spec } = mem.state();
    expect(unordered(spec)).toEqual(unordered(expectedSpec(g)));
    // Same as applying the golden batches directly, including order.
    let direct: AppSpec = startSpec(g.spec);
    for (const [i, ops] of g.batches.entries()) {
      const r = applyOps(direct, ops, i, { currentVersion: i, author: "agent" });
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      direct = r.spec;
    }
    expect(spec).toEqual(direct);
    expect(spec.acceptance).toEqual(g.card.acceptance);
  });

  test("all golden files are written, functions before ui", () => {
    const { files } = mem.state();
    expect([...files.keys()].sort()).toEqual(g.files.map((f) => f.path).sort());
    for (const f of g.files) expect(files.get(f.path)).toBe(f.content);
    const written = mem.events.filter((e) => e.type === "file_written").map((e) => String(e.payload.path));
    expect(written.findIndex((p) => p.startsWith("ui/"))).toBeGreaterThan(
      written.findLastIndex((p) => p.startsWith("functions/")),
    );
  });

  test("every builder line of the fixture is consumed, in order", () => {
    const want = fixtureLines("forum")
      .filter((l) => ["plan", "build_ops", "build_code", "fix"].includes(l.callType))
      .map((l) => l.callType);
    expect(mem.calls.map((c) => c.callType)).toEqual(want);
    for (const c of mem.calls) {
      expect(c.upperBoundCredits).toBeGreaterThan(0);
      expect(c.step).toMatch(/^(plan|ops|code|fix)#\d+$/);
    }
    // Prompt prefix (system static + session) is identical between steps of a phase.
    const code = mem.calls.filter((c) => c.callType === "build_code");
    for (const c of code.slice(1)) expect(c.messages.slice(0, 2)).toEqual(code[0]?.messages.slice(0, 2));
  });

  test("events follow workflows.yaml#events", () => {
    expect(eventProblems(mem.events)).toEqual([]);
    const types = mem.events.map((e) => e.type);
    expect(types[0]).toBe("run_started");
    expect(types.at(-1)).toBe("run_finished");
    expect(types.indexOf("plan_ready")).toBeLessThan(types.indexOf("ops_applied"));
    const steps = mem.events.filter((e) => e.type === "step_started").map((e) => e.payload.step);
    expect(steps).toEqual(["plan", "ops", "code", "verify", "verify"]);
    const plan = mem.events.find((e) => e.type === "plan_ready")?.payload.steps as unknown[];
    expect(plan).toHaveLength(6);
    const ops = mem.events.filter((e) => e.type === "ops_applied");
    expect(ops.map((e) => e.payload.opsCount)).toEqual(g.batches.map((b) => b.length));
    for (const e of ops) expect((e.payload.summary_ru as string[]).length).toBeGreaterThan(0);
    const budget = mem.events.filter((e) => e.type === "budget_update");
    expect(budget.length).toBe(mem.calls.length);
    const last = budget.at(-1)?.payload as { used: number; cap: number };
    expect(last.cap).toBe(cap);
    expect(last.used).toBeLessThanOrEqual(cap);
    expect(out.status === "succeeded" && out.creditsUsed).toBe(last.used);
    // Ledger = sum of usage records of the fixture calls.
    const milli = sink.records.reduce((s, r) => s + r.creditsMilli, 0);
    expect(Math.round(last.used * 1000)).toBe(milli);
  });
});

describe("bakery: scripted from the reference example", async () => {
  const lib = (await import(
    new URL("../../../tools/fixtures/lib/spec-to-ops.mjs", import.meta.url).href
  )) as {
    specToOps(spec: unknown, o: { author: string }): unknown[];
    batchOps(ops: unknown[]): unknown[][];
  };
  const { readFileSync } = await import("node:fs");
  const bakery = JSON.parse(
    readFileSync(new URL("../../../specs/appspec/examples/bakery.json", import.meta.url), "utf8"),
  ) as AppSpec;
  // Two known gaps of the M0-22 reference (docs/reviews/impl-notes/M0-13.md): product.photo (type=file, no pii)
  // counts as pii=basic, so selfSignup customer read fails G0-SPEC-05; ui/components/format.ts is not a path
  // write_file accepts (^ui/…\.tsx$), so the builder writes it as .tsx (imports resolve either way).
  const photo = bakery.entities.find((e) => e.name === "product")?.fields.find((f) => f.name === "photo");
  if (photo) photo.pii = "none";
  const batches = lib.batchOps(lib.specToOps(bakery, { author: "agent" }));
  const files = exampleFiles("bakery").map((f) =>
    /^ui\/.*\.ts$/.test(f.path) ? { ...f, path: `${f.path}x` } : f,
  );

  test("runBuild reaches G0 passed without intervention", async () => {
    const script = [
      turn(
        tc("submit_plan", {
          steps: [
            { id: "P1", kind: "ops", title: "Данные, роли и права", targets: ["entities"], acRefs: [] },
            { id: "P2", kind: "code", title: "Функции и экраны", targets: ["functions/", "ui/"], acRefs: [] },
          ],
        }),
      ),
      ...batches.map((ops, i) => turn(tc("apply_ops", { ops, expectedVersion: i }))),
      stop("Спека собрана."),
    ];
    for (let i = 0; i < files.length; i += 4) {
      const chunk = files
        .slice(i, i + 4)
        .map((f) => tc("write_file", { path: f.path, content: f.content }, f.path));
      script.push(turn(...chunk));
    }
    script.push(stop("Код записан."));
    const { route } = scriptedRoute(script);
    const mem = createMemoryHost({
      spec: startSpec(bakery),
      route,
      db,
      systemKey: uniqueKey(),
      gates: { G1: g1Stub },
    });
    const card = cardFor(bakery);
    const out = await executeBuild(mem, { card, cap: 40, mode: "create" });
    const g0 = mem.events.find((e) => e.type === "gate_result" && e.payload.level === "G0");
    expect(g0?.payload.failedChecks).toEqual([]);
    expect(out.status).toBe("succeeded");
    expect(eventProblems(mem.events)).toEqual([]);
    const want = structuredClone(bakery) as unknown as Record<string, Record<string, unknown>>;
    for (const k of [
      "operatorName",
      "operatorContact",
      "operatorInn",
      "operatorAddress",
      "consentText",
      "retentionWaiver",
    ])
      delete want.compliance?.[k];
    expect(unordered(mem.state().spec)).toEqual(unordered(want));
  }, 180_000);
});
