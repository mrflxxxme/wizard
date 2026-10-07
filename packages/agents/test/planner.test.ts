// B2-20: goal interview → planner → plan awaiting approval, on scripted model answers (no network, no money).
import { SECTION_CATALOG } from "@wizard/appspec";
import { MODULES } from "@wizard/modules";
import { describe, expect, test } from "vitest";
import {
  applyPlanEdits,
  availableModules,
  createGoalInterview,
  type GoalOutput,
  newGoalSession,
  planSketch,
} from "../src/planner/index.js";
import { CTX, OPEN_POLICY, scriptedRoute, toolResult } from "./helpers.js";
import { DENTAL_BRIEF, dentalAnalysis, dentalPlan, plannerRegistry } from "./planner-helpers.js";

const registry = plannerRegistry();

function interview(results: Parameters<typeof scriptedRoute>[0]) {
  const s = scriptedRoute(results);
  let n = 0;
  const gi = createGoalInterview({
    route: s.route,
    orgPolicy: OPEN_POLICY,
    ctx: CTX,
    registry,
    appName: "Улыбка",
    newId: () => `m${++n}`,
  });
  return { gi, inputs: s.inputs };
}

const ofKind = <K extends GoalOutput["kind"]>(outs: GoalOutput[], kind: K) =>
  outs.find((o): o is Extract<GoalOutput, { kind: K }> => o.kind === kind);

describe("catalog availability", () => {
  test("a ready module that needs a draft one is not available; with the dependency ready it is", () => {
    const draftNotify = {
      modules: MODULES.map((d) =>
        d.manifest.id === "notify" ? { ...d, manifest: { ...d.manifest, status: "draft" as const } } : d,
      ),
    };
    expect(availableModules(draftNotify).has("leads")).toBe(false);
    expect(availableModules(draftNotify).has("landing")).toBe(true);
    expect([...availableModules(registry)]).toEqual(expect.arrayContaining(["landing", "leads", "notify"]));
  });
});

describe("dental brief → goals interview → plan", () => {
  test("questions as buttons with a recommendation, the interview sketch, then a valid compiled plan", async () => {
    const { gi, inputs } = interview([
      toolResult("submit_goals", dentalAnalysis()),
      toolResult("submit_plan", dentalPlan()),
    ]);
    const r1 = await gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    expect(r1.failure).toBeUndefined();
    expect(r1.session.state).toBe("asking");
    const q = ofKind(r1.outputs, "questions");
    expect(q?.questions.map((x) => x.id)).toEqual(["q1", "q2"]);
    for (const x of q?.questions ?? []) expect(x.options.filter((o) => o.recommended)).toHaveLength(1);
    expect(q?.sketch.stage).toBe("interview");
    expect(q?.sketch.goals.map((g) => g.id)).toEqual(["leads", "attract"]);
    expect(q?.sketch.goals[0]?.modules).toEqual(["leads"]);
    expect(q?.sketch.modules.find((m) => m.id === "booking")?.status).toBe(
      registry.modules.find((d) => d.manifest.id === "booking")?.manifest.status === "ready"
        ? "available"
        : "soon",
    );
    expect(inputs[0]?.callType).toBe("interview");

    const r2 = await gi.answer(r1.session, [{ questionId: "q1", optionId: "phone" }], {
      restByRecommendation: true,
    });
    expect(r2.failure).toBeUndefined();
    expect(r2.session.state).toBe("planned");
    expect(r2.session.answers.map((a) => [a.questionId, a.byRecommendation])).toEqual([
      ["q1", false],
      ["q2", true],
    ]);
    const p = ofKind(r2.outputs, "plan");
    expect(p?.errors).toEqual([]);
    expect(p?.plan.modules.map((m) => [m.id, m.version])).toEqual([
      ["landing", 1],
      ["leads", 1],
      ["notify", 1],
    ]);
    expect(p?.sketch.stage).toBe("plan");
    expect(p?.sketch.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(p?.sketch.screens.map((s) => s.route)).toEqual(expect.arrayContaining(["/", "/cabinet"]));
    expect(p?.sketch.entities.map((e) => e.name)).toContain("lead");
    expect(p?.sketch.metrics.map((m) => m.id)).toEqual(expect.arrayContaining(["leads_count"]));
    expect(p?.sketch.outOfScope.map((o) => o.category)).toEqual(["other", "payments"]);
    // The planner: its own call type (reasoning high), the answers in the prompt, one call without repairs.
    expect(inputs.map((i) => i.callType)).toEqual(["interview", "system_plan"]);
    const user = inputs[1]?.messages.find((m) => m.role === "user");
    expect(String(user?.content)).toContain(
      "Какой контакт пациента обязателен в заявке? [leads.contact] — Телефон",
    );
    expect(String(user?.content)).toContain("(по рекомендации)");
  });

  test("a brief that answers everything goes straight to the plan in one turn", async () => {
    const { gi, inputs } = interview([
      toolResult("submit_goals", dentalAnalysis({ questions: [] })),
      toolResult("submit_plan", dentalPlan()),
    ]);
    const r = await gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    expect(r.session.state).toBe("planned");
    expect(ofKind(r.outputs, "plan")?.errors).toEqual([]);
    expect(inputs).toHaveLength(2);
  });

  test("a wish in words re-plans with the previous plan", async () => {
    const changed = dentalPlan();
    changed.modules[2] = { id: "notify", params: { channels: ["email", "telegram"] } };
    const { gi, inputs } = interview([
      toolResult("submit_goals", dentalAnalysis({ questions: [] })),
      toolResult("submit_plan", dentalPlan()),
      toolResult("submit_plan", changed),
    ]);
    const r1 = await gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    const r2 = await gi.revise(r1.session, "Уведомления ещё и в Telegram");
    expect(ofKind(r2.outputs, "plan")?.plan.modules[2]?.params).toEqual({ channels: ["email", "telegram"] });
    const user = String(inputs[2]?.messages.find((m) => m.role === "user")?.content);
    expect(user).toContain("## Предыдущий план");
    expect(user).toContain("Уведомления ещё и в Telegram");
  });
});

describe("planner repairs", () => {
  test("validation errors go back to the model as the tool result; the next answer is accepted", async () => {
    const bad = dentalPlan();
    bad.modules.push({ id: "crm_pro" });
    const sections = bad.landing?.sections ?? [];
    sections[1] = { ...(sections[1] as (typeof sections)[number]), variant: "slider" };
    const { gi, inputs } = interview([
      toolResult("submit_goals", dentalAnalysis({ questions: [] })),
      toolResult("submit_plan", bad),
      toolResult("submit_plan", dentalPlan()),
    ]);
    const r = await gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    expect(r.failure).toBeUndefined();
    expect(ofKind(r.outputs, "plan")?.errors).toEqual([]);
    expect(inputs.map((i) => i.callType)).toEqual(["interview", "system_plan", "system_plan"]);
    const toolMsg = inputs[2]?.messages.find((m) => m.role === "tool");
    const content = toolMsg?.content as
      | { error: { issues: { code: string; message: string }[] } }
      | undefined;
    const issues = content?.error.issues ?? [];
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(["UNKNOWN_MODULE"]));
    expect(issues.some((i) => /не реализован|ещё не реализован|варианта/i.test(i.message))).toBe(true);
  });

  test("compilation errors (FIELD_NAME_CONFLICT) go back once more; the fixed plan compiles", async () => {
    const clash = dentalPlan();
    clash.modules[1] = {
      id: "leads",
      params: { contact: "phone", extra_fields: [{ name: "status", label: "Статус", type: "string" }] },
      goals: ["leads"],
    };
    const { gi, inputs } = interview([
      toolResult("submit_goals", dentalAnalysis({ questions: [] })),
      toolResult("submit_plan", clash),
      toolResult("submit_plan", dentalPlan()),
    ]);
    const r = await gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    expect(ofKind(r.outputs, "plan")?.errors).toEqual([]);
    expect(inputs).toHaveLength(3);
    const last = inputs[2]?.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(String(last?.content)).toContain("План не собирается");
    expect(String(last?.content)).toContain("status");
  });

  test("compilation errors after the last repair: the plan comes with its errors (the client sees them)", async () => {
    const clash = dentalPlan();
    clash.modules[1] = {
      id: "leads",
      params: { extra_fields: [{ name: "status", label: "Статус", type: "string" }] },
      goals: ["leads"],
    };
    const { gi } = interview([
      toolResult("submit_goals", dentalAnalysis({ questions: [] })),
      toolResult("submit_plan", clash),
      toolResult("submit_plan", clash),
    ]);
    const r = await gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    const p = ofKind(r.outputs, "plan");
    expect(p?.errors.map((e) => e.code)).toContain("FIELD_NAME_CONFLICT");
    expect(p?.sketch.fingerprint).toBeNull();
  });

  test("three invalid plans → ORCH_INVALID_OUTPUT, no plan", async () => {
    const bad = { ...dentalPlan(), goals: [] };
    const { gi, inputs } = interview([
      toolResult("submit_goals", dentalAnalysis({ questions: [] })),
      toolResult("submit_plan", bad),
      toolResult("submit_plan", bad),
      toolResult("submit_plan", bad),
    ]);
    const r = await gi.submitBrief(newGoalSession(), DENTAL_BRIEF);
    expect(r.failure?.code).toBe("ORCH_INVALID_OUTPUT");
    expect(r.outputs.some((o) => o.kind === "plan")).toBe(false);
    expect(inputs).toHaveLength(4);
  });
});

describe("plan without PII", () => {
  test("names and phones the model copies from the brief never reach the plan, the questions or the sketch", async () => {
    const brief = `${DENTAL_BRIEF} Главный врач Иван Петров, телефон +7 916 123-45-67, пишите на ivan.petrov@example.ru.`;
    const leaky = dentalPlan();
    leaky.goals[0] = { id: "leads", statement: "Заявки сразу Ивану Петрову на +7 916 123-45-67" };
    const sections = leaky.landing?.sections ?? [];
    sections[1] = {
      type: "hero",
      variant: "split",
      content: { title: "Лечим зубы без боли", subtitle: "Звоните +7 916 123-45-67", cta: "Позвонить" },
    };
    const analysis = dentalAnalysis();
    analysis.goals[0] = { id: "leads", statement: "Пишите ivan.petrov@example.ru" };
    const { gi } = interview([toolResult("submit_goals", analysis), toolResult("submit_plan", leaky)]);
    const r1 = await gi.submitBrief(newGoalSession(), brief);
    expect(r1.outputs[0]?.kind).toBe("notice");
    const r2 = await gi.answer(r1.session, [], { restByRecommendation: true });
    const dump = JSON.stringify([
      r1.outputs.filter((o) => o.kind !== "notice"),
      r2.outputs,
      r2.session.plan,
      r2.session.analysis,
    ]);
    for (const leak of ["916", "123-45-67", "ivan.petrov@example.ru", "Петров"])
      expect(dump).not.toContain(leak);
    expect(ofKind(r2.outputs, "plan")?.errors).toEqual([]);
  });
});

describe("deterministic plan edits (no model)", () => {
  const plan = () => {
    const r = applyPlanEdits(
      dentalPlan(),
      [{ op: "set_param", module: "leads", param: "contact", value: "phone" }],
      registry,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r;
  };

  test("a parameter change changes the plan and the sketch, the same way every time", () => {
    const base = plan();
    const sketch0 = planSketch(base.plan, base.compiled, registry);
    const edit = [{ op: "set_param" as const, module: "leads", param: "contact", value: "email" }];
    const a = applyPlanEdits(base.plan, edit, registry);
    const b = applyPlanEdits(structuredClone(base.plan), edit, registry);
    if (!a.ok || !b.ok) throw new Error("edit failed");
    expect(a.plan.modules[1]?.params).toEqual({ contact: "email" });
    const sa = planSketch(a.plan, a.compiled, registry);
    const sb = planSketch(b.plan, b.compiled, registry);
    expect(JSON.stringify(sa)).toBe(JSON.stringify(sb));
    expect(sa.fingerprint).not.toBe(sketch0.fingerprint);
    expect(sa.modules.find((m) => m.id === "leads")?.params.find((p) => p.name === "contact")?.value).toBe(
      "email",
    );
  });

  test("sections: change the hero title, add and move, remove; the sketch follows", () => {
    const base = plan().plan;
    const r = applyPlanEdits(
      base,
      [
        { op: "update_section", index: 1, content: { title: "Улыбка без боли", subtitle: null } },
        { op: "add_section", type: "steps" },
        { op: "move_section", from: 4, to: 2 },
      ],
      registry,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const s = planSketch(r.plan, r.compiled, registry);
    expect(s.sections.map((x) => x.type)).toEqual([
      "header",
      "hero",
      "steps",
      "features",
      "lead_form",
      "footer",
    ]);
    expect(s.sections[1]?.title).toBe("Улыбка без боли");
    expect(r.plan.landing?.sections[1]?.content.subtitle).toBeUndefined();
  });

  test("edits that break the plan are rejected with Russian reasons; the plan is untouched", () => {
    const base = plan().plan;
    const unknownParam = applyPlanEdits(
      base,
      [{ op: "set_param", module: "leads", param: "nope", value: 1 }],
      registry,
    );
    expect(unknownParam.ok).toBe(false);
    if (!unknownParam.ok) expect(unknownParam.errors[0]?.code).toBe("PARAMS_INVALID");
    const badValue = applyPlanEdits(
      base,
      [{ op: "set_param", module: "leads", param: "contact", value: "fax" }],
      registry,
    );
    expect(!badValue.ok && badValue.errors[0]?.code).toBe("PARAMS_INVALID");
    const uncovered = applyPlanEdits(base, [{ op: "remove_module", module: "leads" }], registry);
    expect(!uncovered.ok && uncovered.errors.map((e) => e.code)).toContain("GOAL_NOT_COVERED");
    // Since B2-35 every catalog variant is ready; a catalog extended later keeps new variants outside `ready`.
    const later = {
      ...registry,
      sections: SECTION_CATALOG.map((t) =>
        t.type === "hero" ? { ...t, ready: t.ready.filter((v) => v !== "collage") } : t,
      ),
    };
    const notImplemented = applyPlanEdits(
      base,
      [{ op: "update_section", index: 1, variant: "collage" }],
      later,
    );
    expect(!notImplemented.ok && notImplemented.errors[0]?.code).toBe("SECTION_NOT_IMPLEMENTED");
    expect(base.modules[1]?.params).toEqual({ contact: "phone" });
  });

  test("removing leads with its goal: the lead form section goes with the module", () => {
    const base = plan().plan;
    const r = applyPlanEdits(
      base,
      [
        { op: "set_goals", goals: [{ id: "attract", statement: "Посетитель понимает, чем клиника лучше" }] },
        { op: "remove_module", module: "leads" },
        { op: "remove_module", module: "notify" },
      ],
      registry,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.plan.modules.map((m) => m.id)).toEqual(["landing"]);
    expect(r.plan.landing?.sections.map((s) => s.type)).not.toContain("lead_form");
  });

  test("adding a module brings its required links; a typed phone in a section is scrubbed", () => {
    const only = applyPlanEdits(
      plan().plan,
      [
        { op: "remove_module", module: "notify" },
        { op: "remove_module", module: "leads" },
        { op: "set_goals", goals: [{ id: "attract", statement: "Посетитель понимает, чем клиника лучше" }] },
      ],
      registry,
    );
    if (!only.ok) throw new Error(JSON.stringify(only.errors));
    const r = applyPlanEdits(
      only.plan,
      [
        {
          op: "set_goals",
          goals: [
            { id: "attract", statement: "Понятно, чем лучше" },
            { id: "leads", statement: "Заявки не теряются" },
          ],
        },
        { op: "add_module", module: "leads" },
        { op: "add_section", type: "lead_form", content: { title: "Звоните +7 916 123-45-67" } },
      ],
      registry,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.plan.modules.map((m) => m.id)).toEqual(["landing", "leads", "notify"]);
    expect(JSON.stringify(r.plan)).not.toContain("123-45-67");
  });
});
