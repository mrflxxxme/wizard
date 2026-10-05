// Harness v2 (agents/builder.yaml#harness): the architect's brief, executors per task in waves (one routeBatch per wave,
// stable order), the per-file check, the task file restriction, the reviewer → fix round and build_metrics.
import { LlmError, type LlmResult, type RouteInput, type RouteOutput } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import { type BriefTask, briefIssues, runWave } from "../../src/builder/harness.js";
import { createMemoryHost, executeBuild, type RouteBatchItem } from "../../src/builder/index.js";
import { pageStub } from "../../src/builder/scaffold.js";
import { cardFor, eventProblems, g1Stub, report, stop, tc, turn } from "../builder-helpers.js";
import { cheatsheetFunctions, leadSpec } from "./lead-fixture.js";

const spec = leadSpec();
const card = cardFor(spec);
const fnCode = new Map(cheatsheetFunctions());
const pageCode = new Map(
  (spec.pages ?? []).map((p) => [p.file, pageStub(p).split("\n").slice(1).join("\n")]),
);
const code = (file: string) => fnCode.get(file) ?? pageCode.get(file) ?? "";

const brief: BriefTask[] = [
  ...(spec.functions ?? []).map((f) => ({
    kind: "function" as const,
    file: f.file,
    title: `Функция ${f.name}`,
    goal: `Функция ${f.name}.`,
    details: [],
    uses: ["lead"],
    acRefs: [],
  })),
  ...(spec.pages ?? []).map((p) => ({
    kind: "page" as const,
    file: p.file,
    title: p.title,
    goal: `Страница «${p.title}».`,
    details: ["Первый экран с формой заявки"],
    uses: ["leadCreate"],
    acRefs: [],
  })),
].map((t, i) => ({ id: `T${i + 1}`, ...t }));

const out = (result: LlmResult): RouteOutput => ({
  tier: "T1",
  model: "glm-5.3",
  result,
  usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 50 },
  creditsCharged: 0.01,
  creditsMilli: 10,
  routeReason: "default_T1",
  scrubbed: true,
  ruFallback: false,
});

const taskFile = (input: RouteInput) =>
  /Твоя задача T\d+ — \S+(?: \S+)? ((?:ui|functions)\/\S+):/.exec(
    String(input.messages.at(1)?.content),
  )?.[1] ?? "";

/** A model that plays every role of the harness; `opts` bends one behaviour per test. */
function responder(
  opts: { wrongFirstWrite?: boolean; criticalOn?: string; failTaskOnce?: string; reviewThrows?: Error } = {},
) {
  const inputs: RouteInput[] = [];
  const reviewed = new Set<string>();
  let wrongDone = false;
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    inputs.push(input);
    switch (input.callType) {
      case "build_ops":
        return out(stop("Спека готова."));
      case "plan":
        return out(turn(tc("submit_brief", { tasks: brief })));
      case "build_code":
      case "fix": {
        const file = taskFile(input);
        if (opts.failTaskOnce === file && input.callType === "build_code") {
          opts.failTaskOnce = undefined;
          throw new LlmError("LLM_UNAVAILABLE", "Модели сейчас недоступны.");
        }
        if (opts.wrongFirstWrite && !wrongDone && input.callType === "build_code") {
          wrongDone = true;
          return out(turn(tc("write_file", { path: "ui/pages/Other.tsx", content: code(file) })));
        }
        return out(turn(tc("write_file", { path: file, content: code(file) })));
      }
      case "audit": {
        if (opts.reviewThrows) throw opts.reviewThrows;
        const file = /страница (ui\/\S+):/.exec(String(input.messages.at(1)?.content))?.[1] ?? "";
        const critical = file === opts.criticalOn && !reviewed.has(file);
        reviewed.add(file);
        return out(
          turn(
            tc(
              "submit_review",
              critical
                ? { verdict: "fix", issues: [{ severity: "critical", text: "Нет формы заявки из задачи." }] }
                : { verdict: "ok", issues: [{ severity: "minor", text: "Можно короче заголовок." }] },
            ),
          ),
        );
      }
      default:
        throw new Error(`unexpected callType ${input.callType}`);
    }
  };
  return { route, inputs };
}

function host(opts: Parameters<typeof responder>[0] = {}, batch = false) {
  const r = responder(opts);
  const mem = createMemoryHost({
    spec,
    version: 1,
    route: r.route,
    gates: { G0: async () => report("G0", true), G1: g1Stub },
    qa: { generate: async () => [], explain: async () => [] },
  });
  const batches: string[][] = [];
  if (batch)
    mem.host.routeBatch = async (inputs) => {
      batches.push(inputs.map((i) => String(i.step)));
      return Promise.all(
        inputs.map((i) => mem.host.route(i).then((o): RouteBatchItem => ({ ok: true, out: o }))),
      );
    };
  return { mem, inputs: r.inputs, batches };
}

const metricsOf = (events: { type: string; payload: Record<string, unknown> }[]) =>
  events.find((e) => e.type === "build_metrics")?.payload.stages as Record<string, Record<string, unknown>>;

describe("harness v2: brief", () => {
  const scope = { spec, card, mode: "create" as const, existing: new Set<string>() };

  test("the brief of the fixture is valid", () => {
    expect(briefIssues(brief, scope)).toEqual([]);
  });

  test("coverage, declared files, shared modules, uses and AC are checked by code", () => {
    const codes = (tasks: BriefTask[]) => briefIssues(tasks, scope).map((i) => i.code);
    expect(codes(brief.slice(0, 4))).toEqual(["BRIEF_COVERAGE"]);
    expect(codes([...brief, { ...brief[0], id: "T6", file: "functions/nope.ts" } as BriefTask])).toEqual([
      "BRIEF_FILE",
    ]);
    const lib = {
      id: "T6",
      kind: "lib" as const,
      file: "functions/lib/format.ts",
      title: "Формат",
      goal: "Общий формат.",
      details: [],
      uses: [],
      acRefs: [],
    };
    expect(codes([...brief, lib])).toEqual([]);
    expect(codes([...brief, { ...lib, file: "functions/leadList.ts" }])).toContain("BRIEF_FILE");
    const withUse = brief.map((t) => (t.kind === "page" ? { ...t, uses: ["functions/lib/format.ts"] } : t));
    expect(codes([...withUse, lib])).toEqual([]);
    expect(codes(brief.map((t, i) => (i === 3 ? { ...t, uses: ["nope"] } : t)))).toEqual(["BRIEF_USES"]);
    expect(codes(brief.map((t, i) => (i === 0 ? { ...t, id: "T9" } : t)))).toEqual(["BRIEF_ID"]);
    const withAc = {
      ...scope,
      card: {
        ...card,
        acceptance: [{ id: "AC1", text: "Гость оставляет заявку", check: { type: "scenario" as const } }],
      },
    };
    expect(briefIssues(brief, withAc).map((i) => i.code)).toEqual(["BRIEF_AC"]);
    // change: files that already hold code need no task.
    const change = { ...scope, mode: "change" as const, existing: new Set(brief.map((t) => t.file)) };
    expect(briefIssues(brief.slice(0, 1), change)).toEqual([]);
  });
});

describe("harness v2: waves", () => {
  test("a batch goes out when every live job waits or has finished, always in job order", async () => {
    const log: string[][] = [];
    const delays = [30, 0, 15];
    const settled = await runWave(
      delays.map((d, j) => async (route) => {
        const answers: string[] = [];
        for (let k = 0; k < (j === 1 ? 1 : 2); k++) {
          await new Promise((r) => setTimeout(r, d));
          const o = await route({
            callType: "build_code",
            messages: [{ role: "user", content: `${j}:${k}` }],
          } as RouteInput);
          answers.push(String(o.result.text));
        }
        return answers;
      }),
      async (inputs) => {
        log.push(inputs.map((i) => String(i.messages[0]?.content)));
        return inputs.map((i) => ({
          ok: true as const,
          out: out(stop(`ok ${String(i.messages[0]?.content)}`)),
        }));
      },
    );
    expect(log).toEqual([
      ["0:0", "1:0", "2:0"],
      ["0:1", "2:1"],
    ]);
    expect(settled.map((s) => (s.status === "fulfilled" ? s.value : null))).toEqual([
      ["ok 0:0", "ok 0:1"],
      ["ok 1:0"],
      ["ok 2:0", "ok 2:1"],
    ]);
  });

  test("an error of one call rejects only its job", async () => {
    const settled = await runWave(
      [0, 1].map(
        (j) => (route) =>
          route({ callType: "build_code", messages: [{ role: "user", content: `${j}` }] } as RouteInput),
      ),
      async () => [
        { ok: true as const, out: out(stop()) },
        { ok: false as const, error: new Error("модель недоступна") },
      ],
    );
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "rejected"]);
  });
});

describe("harness v2: build", () => {
  test("ops → brief → one fresh-context executor per task → gates → reviewer; build_metrics", async () => {
    const { mem, inputs } = host();
    const res = await executeBuild(mem, { card, cap: 100, mode: "create" });
    expect(res.status).toBe("succeeded");
    expect(inputs.map((i) => i.callType)).toEqual([
      "build_ops",
      "plan",
      "build_code",
      "build_code",
      "build_code",
      "build_code",
      "build_code",
      "audit",
      "audit",
    ]);
    // Each executor: the static system prefix + its own task; functions before pages.
    const code = inputs.filter((i) => i.callType === "build_code");
    expect(code.map(taskFile)).toEqual(brief.map((t) => t.file));
    expect(code.every((c) => c.messages.length === 2 && c.messages[0]?.role === "system")).toBe(true);
    expect(code.map((c) => (c.tools ?? []).map((t) => t.name).sort())[0]).toEqual(
      ["get_capability", "get_sdk_docs", "get_ui_kit_docs", "list_files", "read_file", "write_file"].sort(),
    );
    for (const [file, content] of [...fnCode, ...pageCode]) expect(mem.state().files.get(file)).toBe(content);
    const plan = mem.events.find((e) => e.type === "plan_ready")?.payload.steps as { id: string }[];
    expect(plan.map((s) => s.id)).toEqual(brief.map((t) => t.id));
    expect(metricsOf(mem.events)).toMatchObject({
      brief: { tasks: 5, retries: 0, fallback: false },
      tasks: { total: 5, firstPass: 5, passed: 5, failed: 0, calls: 5 },
      verify: { g0Runs: 1, g1Runs: 1, fixTasks: 0 },
      review: { pages: 2, ok: 2, critical: 0, minor: 2, skipped: false },
    });
    expect(eventProblems(mem.events)).toEqual([]);
  });

  test("with routeBatch: one batch per wave (3 functions, 2 pages, 2 reviews), steps in task order", async () => {
    const { mem, batches } = host({}, true);
    const res = await executeBuild(mem, { card, cap: 100, mode: "create" });
    expect(res.status).toBe("succeeded");
    expect(batches.map((b) => b.length)).toEqual([3, 2, 2]);
    expect(batches[0]?.map((s) => s.replace(/#\d+$/, ""))).toEqual(
      brief.slice(0, 3).map((t) => `task:${t.id}:${t.file}`),
    );
    expect(batches[2]?.every((s) => s.startsWith("review:"))).toBe(true);
  });

  test("an executor may write only its own file", async () => {
    const { mem, inputs } = host({ wrongFirstWrite: true });
    const res = await executeBuild(mem, { card, cap: 100, mode: "create" });
    expect(res.status).toBe("succeeded");
    const first = inputs.filter((i) => i.callType === "build_code" && taskFile(i) === brief[0]?.file);
    expect(first).toHaveLength(2);
    expect(JSON.stringify(first[1]?.messages)).toContain("TASK_FILE_ONLY");
    expect(mem.state().files.has("ui/pages/Other.tsx")).toBe(false);
    // firstPass = the first successful write passed: the refused write does not count; leadNotify calls leadList,
    // whose file came a turn late, so its own check catches the type error and its second write fixes it.
    expect(metricsOf(mem.events)).toMatchObject({ tasks: { total: 5, firstPass: 4, passed: 5, failed: 0 } });
  });

  test("a critical review sends the page to one fix task and the gates run again", async () => {
    const home = "ui/pages/Home.tsx";
    const { mem, inputs } = host({ criticalOn: home });
    const res = await executeBuild(mem, { card, cap: 100, mode: "create" });
    expect(res.status).toBe("succeeded");
    const fix = inputs.filter((i) => i.callType === "fix");
    expect(fix.map(taskFile)).toEqual([home]);
    expect(String(fix[0]?.messages.at(1)?.content)).toContain("Рецензент: Нет формы заявки из задачи.");
    expect(inputs.filter((i) => i.callType === "audit")).toHaveLength(2);
    expect(metricsOf(mem.events)).toMatchObject({
      verify: { g0Runs: 2, g1Runs: 2, fixTasks: 1 },
      review: { pages: 2, ok: 1, critical: 1 },
    });
  });

  test("a model failure of one task fails that task only; verify sends its file to a fix task", async () => {
    const home = "ui/pages/Home.tsx";
    let n = 0;
    const { mem, inputs } = host({ failTaskOnce: home });
    // G0 sees the stub left by the failed task once (G0-SPEC-03 on its file), then passes.
    mem.host.runGates = async (level) =>
      level === "G0" && ++n === 1
        ? report("G0", false, [
            { id: "G0-SPEC-03", status: "fail", message_ru: "осталась заготовкой", file: home },
          ])
        : report(level, true);
    const res = await executeBuild(mem, { card, cap: 100, mode: "create" });
    expect(res.status).toBe("succeeded");
    expect(inputs.filter((i) => i.callType === "fix").map(taskFile)).toEqual([home]);
    expect(metricsOf(mem.events)).toMatchObject({
      tasks: { total: 5, passed: 4, failed: 1 },
      verify: { fixTasks: 1 },
    });
  });

  test("a cancel during the review is never a success", async () => {
    const { mem } = host({ reviewThrows: new Error("run cancelled") });
    await expect(executeBuild(mem, { card, cap: 100, mode: "create" })).rejects.toThrow("run cancelled");
    expect(mem.events.some((e) => e.type === "run_finished")).toBe(false);
    expect(metricsOf(mem.events)).toBeDefined();
  });

  test("an unavailable reviewer is skipped: the build succeeds, metrics say so", async () => {
    const { mem } = host({ reviewThrows: new LlmError("LLM_UNAVAILABLE", "нет") });
    const res = await executeBuild(mem, { card, cap: 100, mode: "create" });
    expect(res.status).toBe("succeeded");
    expect(metricsOf(mem.events)).toMatchObject({ review: { skipped: true } });
  });
});
