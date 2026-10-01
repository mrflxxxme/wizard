// Shared fakes of the worker tests: a router that writes llm_calls like the real one and scripted executors whose
// build makes several LLM steps (build_code#i), each followed by a file commit.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteOutput, Router, RouterOptions, UsageRecord } from "@wizard/llm";
import type { BuildHost, BuildParams, RunExecutors } from "@wizard/platform-api";
import { fakeInterview, passingReport, ROOT } from "../../platform-api/test/helpers.js";

/** Text no log line and no dbos.* row may contain (L3-08, L3-09). */
export const LLM_CANARY = "LLMКАНАРЕЙКА";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
      { once: true },
    );
  });

/** Router writing one usage row per call (as DbUsageSink does in production); the answer depends on the step. */
export function recordingRouter(
  o: {
    delayMs?: number;
    creditsMilli?: number;
    /** fixture: replayed calls are re-routed with usage muted to advance the fixture order (RunEngine). */
    mode?: "live" | "fixture";
    trace?: (step: string) => void;
  } = {},
) {
  return (opts: RouterOptions): Router => ({
    mode: o.mode ?? "live",
    registry: {} as Router["registry"],
    async route(input): Promise<RouteOutput> {
      o.trace?.(input.ctx.step ?? input.callType);
      const signal = (input as { signal?: AbortSignal }).signal;
      if (o.delayMs) await sleep(o.delayMs, signal);
      const step = input.ctx.step ?? input.callType;
      const creditsMilli = o.creditsMilli ?? 100;
      await opts.sink?.write({
        id: randomUUID(),
        runId: input.ctx.runId ?? null,
        orgId: input.ctx.orgId,
        systemId: input.ctx.systemId ?? null,
        step,
        callType: input.callType as UsageRecord["callType"],
        agentRole: "builder",
        tier: "T0",
        provider: "fixture",
        modelId: "fixture",
        attempt: 1,
        status: "ok",
        errorCode: null,
        routeReason: "default_T0",
        fallbackFrom: null,
        policyVersion: "test",
        scrubbed: false,
        piiCategoriesCount: {},
        inputTokens: 10,
        cachedTokens: 0,
        outputTokens: 5,
        toolCalls: 0,
        latencyMs: o.delayMs ?? 0,
        ttftMs: null,
        costRub: 0,
        creditsMilli,
        billable: true,
        mode: "fixture",
        requestHash: "test",
        createdAt: new Date().toISOString(),
      });
      return {
        tier: "T0",
        model: "fixture",
        result: { text: `ответ ${step} ${LLM_CANARY}`, toolCalls: [], finishReason: "stop" },
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        creditsCharged: creditsMilli / 1000,
        creditsMilli,
        routeReason: "default_T0",
        scrubbed: false,
        ruFallback: false,
      };
    },
  });
}

export const CODE_STEPS = 6;

/** Build: getSpec → one applyOps → CODE_STEPS × (llm build_code#i → write ui/Page<i>.tsx → commit) → G0. */
export async function scriptedBuild(host: BuildHost, p: BuildParams) {
  await host.emit("plan_ready", { steps: [{ id: "P1", kind: "code", title: "Экраны" }] });
  const lib = (await import(join(ROOT, "tools/fixtures/lib/spec-to-ops.mjs"))) as {
    specToOps(spec: unknown, o: { author: string }): unknown[];
    batchOps(ops: unknown[]): unknown[][];
  };
  const spec = JSON.parse(readFileSync(join(ROOT, "specs/appspec/examples/forum.json"), "utf8"));
  const batches = p.mode === "create" ? lib.batchOps(lib.specToOps(spec, { author: "agent" })) : [];
  for (const [i, ops] of batches.entries()) {
    const { version } = await host.store.getSpec();
    const r = await host.store.applyOps(ops, version, `${host.run.id}:ops_${i}:1`);
    if (!r.ok) throw new Error(`ops failed: ${JSON.stringify(r.errors)}`);
  }
  for (let i = 0; i < CODE_STEPS; i++) {
    await host.emit("step_started", { step: `code#${i}`, label_ru: `Экран ${i}`, attempt: 1 });
    const out = await host.route({
      callType: "build_code",
      messages: [{ role: "user", content: `экран ${i}` }],
      step: `build_code#${i}`,
    });
    const text = out.result.text ?? "";
    await host.store.writeFile(`ui/Page${i}.tsx`, `export const t = ${JSON.stringify(text)};\n`);
    await host.store.commitFiles();
    await host.emit("step_finished", { step: `code#${i}`, durationMs: 1 });
  }
  const report = await host.runGates("G0");
  if (!report.passed) throw new Error("G0 failed");
  return { summary_ru: "Система собрана" };
}

export function scriptedExecutors(build = scriptedBuild): RunExecutors {
  return {
    interviewTurn: fakeInterview,
    build: (host, p) => build(host, p),
    gates: async (level, ctx) => passingReport(level, ctx.specVersion),
    onG0Passed: async (a) => ({ bundleKey: `${a.systemKey}/${a.revision}` }),
  };
}
