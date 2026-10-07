// B2-41: a crooked model answer never ends the goal interview — recorded broken submit_goals / submit_plan answers →
// tolerant reading or repairs → success; unfixable → deterministic questions and plan without a model. No network.
import { readdirSync, readFileSync } from "node:fs";
import { CATALOG, type ModuleRegistry } from "@wizard/modules";
import { describe, expect, test } from "vitest";
import { looseJson } from "../src/core/index.js";
import {
  checkGoalsAnalysis,
  createGoalInterview,
  fallbackAnalysis,
  fallbackPlan,
  type GoalOutput,
  goalsAnalysisSchema,
  newGoalSession,
} from "../src/planner/index.js";
import { CTX, OPEN_POLICY, ROOT, scriptedRoute, toolResult } from "./helpers.js";
import { DENTAL_BRIEF, dentalAnalysis, dentalPlan, plannerRegistry } from "./planner-helpers.js";

const registry = plannerRegistry();

function interview(results: Parameters<typeof scriptedRoute>[0], reg: ModuleRegistry = registry) {
  const s = scriptedRoute(results);
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  let n = 0;
  const gi = createGoalInterview({
    route: s.route,
    orgPolicy: OPEN_POLICY,
    ctx: CTX,
    registry: reg,
    appName: "Улыбка",
    newId: () => `m${++n}`,
    emit: async (type, payload) => {
      events.push({ type, payload: payload as Record<string, unknown> });
    },
  });
  return { gi, inputs: s.inputs, events };
}

const ofKind = <K extends GoalOutput["kind"]>(outs: GoalOutput[], kind: K) =>
  outs.find((o): o is Extract<GoalOutput, { kind: K }> => o.kind === kind);

const textAnswer = (text: string) => ({ text, toolCalls: [], finishReason: "stop" });

/** The dental analysis with the slips open models make (all fixable in code). */
function crookedAnalysis(): Record<string, unknown> {
  const a = dentalAnalysis() as unknown as Record<string, unknown>;
  return {
    ...a,
    extra: "лишнее поле",
    niche: "стоматологическая клиника",
    roles: "Администратор, Врач",
    resources: JSON.stringify(["услуги", "врачи"]),
    modules: ["landing", "leads", "notify", "crm_pro"],
    questions: [
      {
        id: "1",
        topic: "budget",
        text: "Какой контакт пациента обязателен в заявке?",
        whyItMatters: "Администратор сможет перезвонить",
        module: "leads",
        param: "contact",
        options: [
          { id: "phone", label: "Телефон" },
          { id: "email", label: "Почта" },
        ],
      },
      {
        id: "q2",
        topic: "params",
        module: "leads",
        param: "no_such_param",
        text: "Что важнее всего в первый месяц?",
        options: ["Больше заявок", "Рассказать о клинике", "Онлайн-запись", "Отзывы", "Цены"],
        recommended: "Рассказать о клинике",
      },
      {
        id: "q3",
        topic: "goals",
        text: "Нужна ли запись онлайн?",
        whyItMatters: "Запись заполняет расписание",
        options: [
          { id: "yes", label: "Да", recommended: true },
          { id: "no", label: "Нет", recommended: true },
        ],
      },
      { id: "q4", topic: "roles", text: "Один вариант — не вопрос", options: [{ id: "a", label: "А" }] },
      ...[5, 6].map((k) => ({
        id: `q${k}`,
        topic: "niche",
        text: `Вопрос ${k}`,
        whyItMatters: "Зачем",
        options: [
          { id: "a", label: "А", recommended: true },
          { id: "b", label: "Б", recommended: false },
        ],
      })),
    ],
  };
}

describe("tolerant reading of submit_goals (no repair call)", () => {
  test("strings instead of lists, unknown module and topic, recommendation not marked or doubled, extra questions", async () => {
    const { gi, inputs, events } = interview([toolResult("submit_goals", crookedAnalysis())]);
    const r = await gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    expect(r.failure).toBeUndefined();
    expect(inputs).toHaveLength(1);
    expect(events).toEqual([]);
    const a = r.session.analysis;
    expect(a?.roles).toEqual(["Администратор", "Врач"]);
    expect(a?.resources).toEqual(["услуги", "врачи"]);
    expect(a?.modules.map((m) => m.id)).toEqual(["landing", "leads", "notify"]);
    const q = ofKind(r.outputs, "questions")?.questions ?? [];
    expect(q.map((x) => x.id)).toEqual(["q1", "q2", "q3", "q4"]);
    expect(q.map((x) => x.topic)).toEqual(["params", "goals", "goals", "niche"]);
    for (const x of q) expect(x.options.filter((o) => o.recommended)).toHaveLength(1);
    expect(q[0]?.options.find((o) => o.recommended)?.id).toBe("phone");
    expect(q[1]?.options).toHaveLength(4);
    expect(q[1]?.options.find((o) => o.recommended)?.label).toBe("Рассказать о клинике");
    expect(q[1]?.module).toBeUndefined();
    expect(q[2]?.options.find((o) => o.recommended)?.id).toBe("yes");
  });

  test("arguments as invalid JSON text (fenced, trailing comma) and as a text answer without a tool call", async () => {
    const json = JSON.stringify(dentalAnalysis(), null, 1).replace(/\n]/, ",\n]");
    const a = interview([toolResult("submit_goals", `\`\`\`json\n${json}\n\`\`\``)]);
    const r1 = await a.gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    expect(r1.failure).toBeUndefined();
    expect(r1.session.state).toBe("asking");
    expect(a.inputs).toHaveLength(1);

    const b = interview([textAnswer(`Вот анализ:\n\`\`\`json\n${JSON.stringify(dentalAnalysis())}\n\`\`\``)]);
    const r2 = await b.gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    expect(r2.failure).toBeUndefined();
    expect(ofKind(r2.outputs, "questions")?.questions).toHaveLength(2);
    expect(b.inputs).toHaveLength(1);
  });

  test("arguments cut off by the token limit: complete questions are kept", async () => {
    const full = JSON.stringify(dentalAnalysis());
    const cut = full.slice(0, full.indexOf('"id":"q2"') + 12);
    const { gi, inputs } = interview([toolResult("submit_goals", cut)]);
    const r = await gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    expect(r.failure).toBeUndefined();
    expect(inputs).toHaveLength(1);
    expect(ofKind(r.outputs, "questions")?.questions.map((q) => q.id)).toEqual(["q1"]);
  });
});

describe("repairs of submit_goals", () => {
  test("what code cannot guess goes back to the model as the tool result; the repaired answer is accepted", async () => {
    const bad = {
      ...dentalAnalysis(),
      niche: undefined,
      goals: [{ id: "get_rich", statement: "Разбогатеть" }],
    };
    const { gi, inputs, events } = interview([
      toolResult("submit_goals", bad),
      toolResult("submit_goals", dentalAnalysis()),
    ]);
    const r = await gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    expect(r.failure).toBeUndefined();
    expect(r.session.state).toBe("asking");
    expect(inputs.map((i) => i.callType)).toEqual(["interview", "interview"]);
    const tool = inputs[1]?.messages.find((m) => m.role === "tool")?.content as {
      error: { code: string; issues: { path: string }[] };
    };
    expect(tool.error.code).toBe("INVALID_ARGS");
    expect(tool.error.issues.map((i) => i.path)).toEqual(["niche", "goals.0.id"]);
    expect(events).toEqual([]);
  });

  test("unfixable after 2 repairs → fallback questions, no failure, orch_invalid {interview, questions}", async () => {
    const { gi, inputs, events } = interview([
      textAnswer("Я не могу вызвать инструмент."),
      toolResult("submit_goals", { niche: "x" }),
      toolResult("submit_goals", "{не json"),
    ]);
    const r = await gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    expect(r.failure).toBeUndefined();
    expect(inputs).toHaveLength(3);
    expect(r.session.state).toBe("asking");
    const q = ofKind(r.outputs, "questions");
    expect(q?.questions.length).toBeGreaterThanOrEqual(2);
    expect(q?.questions.length).toBeLessThanOrEqual(3);
    for (const x of q?.questions ?? []) expect(x.options.filter((o) => o.recommended)).toHaveLength(1);
    expect(q?.sketch.stage).toBe("interview");
    expect(r.session.analysis?.niche).toBe("стоматологическая клиника");
    expect(r.session.analysis?.goals.map((g) => g.id)).toContain("leads");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "orch_invalid",
      payload: { step: "interview", fallback: "questions" },
    });
    expect((events[0]?.payload.issues as unknown[] | undefined)?.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.outputs)).not.toContain("Попробуйте ещё раз");
  });
});

describe("fallback of the plan turn", () => {
  test("planner fails 3 times after fallback questions → a plan from the interview, compiled, with the answers", async () => {
    const bad = { ...dentalPlan(), goals: [] };
    const { gi, inputs, events } = interview([
      toolResult("submit_goals", { broken: true }),
      toolResult("submit_goals", { broken: true }),
      toolResult("submit_goals", { broken: true }),
      toolResult("submit_plan", bad),
      toolResult("submit_plan", bad),
      toolResult("submit_plan", bad),
    ]);
    const r1 = await gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    const contact = r1.session.questions.find((q) => q.module === "leads" && q.param === "contact");
    expect(contact).toBeDefined();
    const r2 = await gi.answer(r1.session, [{ questionId: contact?.id ?? "", optionId: "email" }], {
      restByRecommendation: true,
    });
    expect(r2.failure).toBeUndefined();
    expect(inputs).toHaveLength(6);
    expect(r2.session.state).toBe("planned");
    const p = ofKind(r2.outputs, "plan");
    expect(p?.errors).toEqual([]);
    expect(p?.sketch.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const ids = p?.plan.modules.map((m) => m.id) ?? [];
    expect(ids).toEqual(expect.arrayContaining(["landing", "leads", "notify"]));
    expect(p?.plan.modules.find((m) => m.id === "leads")?.params).toMatchObject({ contact: "email" });
    const sections = p?.plan.landing?.sections.map((s) => s.type) ?? [];
    expect(sections[0]).toBe("header");
    expect(sections.at(-1)).toBe("footer");
    expect(sections).toEqual(expect.arrayContaining(["hero", "lead_form"]));
    expect(events.map((e) => [e.payload.step, e.payload.fallback])).toEqual([
      ["interview", "questions"],
      ["system_plan", "plan"],
    ]);
  });

  test("a wish the planner cannot apply keeps the previous plan; the wish is dropped", async () => {
    const bad = { ...dentalPlan(), goals: [] };
    const { gi, events } = interview([
      toolResult("submit_goals", dentalAnalysis({ questions: [] })),
      toolResult("submit_plan", dentalPlan()),
      toolResult("submit_plan", bad),
      toolResult("submit_plan", bad),
      toolResult("submit_plan", bad),
    ]);
    const r1 = await gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    const r2 = await gi.revise(r1.session, "Сделайте всё бесплатно");
    expect(r2.failure).toBeUndefined();
    const p = ofKind(r2.outputs, "plan");
    expect(p?.text).toMatch(/план остался прежним/);
    expect(p?.plan).toEqual(r1.session.plan);
    expect(r2.session.edits).toEqual([]);
    expect(events.map((e) => e.payload.fallback)).toEqual(["previous_plan"]);
  });

  test("no deterministic plan possible → one more planner run; it fails too → a clear retryable failure", async () => {
    const drafts: ModuleRegistry = {
      ...CATALOG,
      modules: CATALOG.modules.map((d) => ({ ...d, manifest: { ...d.manifest, status: "draft" as const } })),
    };
    const bad = { ...dentalPlan(), goals: [] };
    const { gi, inputs, events } = interview(
      [
        toolResult("submit_goals", dentalAnalysis({ questions: [] })),
        ...Array(6).fill(toolResult("submit_plan", bad)),
      ],
      drafts,
    );
    const r = await gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    expect(inputs).toHaveLength(7);
    expect(r.failure).toMatchObject({ code: "ORCH_INVALID_OUTPUT", retryable: true });
    expect(r.failure?.message_ru).toMatch(/Не получилось составить план/);
    expect(events.map((e) => [e.payload.step, e.payload.fallback])).toEqual([
      ["system_plan", "retry"],
      ["system_plan", "none"],
    ]);
  });

  test("a plan sent as JSON text is accepted without a repair", async () => {
    const { gi, inputs } = interview([
      toolResult("submit_goals", dentalAnalysis({ questions: [] })),
      textAnswer(JSON.stringify({ plan: dentalPlan() })),
    ]);
    const r = await gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    expect(r.failure).toBeUndefined();
    expect(ofKind(r.outputs, "plan")?.errors).toEqual([]);
    expect(inputs).toHaveLength(2);
  });
});

describe("fallback over the measurement briefs", () => {
  const dir = new URL("tools/eval/briefs/", ROOT);
  const briefs = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { id: string; text: string });

  test.each(briefs.map((b) => [b.id, b.text]))("%s: valid questions and a compiled plan", (_id, text) => {
    const a = fallbackAnalysis(text, registry);
    expect(goalsAnalysisSchema.safeParse(a).success).toBe(true);
    expect(checkGoalsAnalysis(a, registry)).toEqual([]);
    expect(a.questions.length).toBeGreaterThanOrEqual(2);
    expect(a.questions.length).toBeLessThanOrEqual(3);
    const answers = a.questions.map((q) => ({
      questionId: q.id,
      optionId: (q.options.find((o) => o.recommended) ?? q.options[0])?.id ?? "",
      byRecommendation: true,
    }));
    const p = fallbackPlan({ analysis: a, questions: a.questions, answers }, registry);
    expect(p?.compiled.ok).toBe(true);
  });
});

describe("fallback plan follows the answers", () => {
  test("the main goal the client picked comes first, with a module that closes it", () => {
    const a = fallbackAnalysis(DENTAL_BRIEF, registry);
    const q1 = a.questions[0];
    const picked = q1?.options.at(-1)?.id ?? "";
    expect(a.goals.map((g) => g.id)).not.toContain(picked);
    const p = fallbackPlan(
      {
        analysis: a,
        questions: a.questions,
        answers: [{ questionId: "q1", optionId: picked, byRecommendation: false }],
      },
      registry,
    );
    expect(p?.plan.goals[0]?.id).toBe(picked);
    const closing = registry.modules.filter((d) => (d.manifest.goals as readonly string[]).includes(picked));
    expect(p?.plan.modules.some((m) => closing.some((d) => d.manifest.id === m.id))).toBe(true);
  });
});

describe("looseJson", () => {
  test("fenced, lead-in, trailing commas, cut off", () => {
    expect(looseJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(looseJson('Ответ: {"a": [1, 2,], }')).toEqual({ a: [1, 2] });
    expect(looseJson('{"a": {"b": [1, 2, 3], "c": "обре')).toEqual({ a: { b: [1, 2, 3] } });
    expect(looseJson("нет JSON")).toBeUndefined();
  });
});
