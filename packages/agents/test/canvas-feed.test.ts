// B2-25: the sketch fields of the canvas (business colour, automation chains, who sees data, retention, screen → module)
// and the recorded feed «клиника» of the platform-web canvas e2e (apps/platform-web/test/fixtures/feeds/clinic.json):
// the goal-interview sketch and the plan sketch come from the real planner and module catalog, so the canvas is tested
// on what the server sends. The file is generated here: WIZARD_UPDATE_FEEDS=1 rewrites it, otherwise it must match.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SystemPlan } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { remainingSec, STAGE_LABELS, V2_STAGES } from "../src/builder/index.js";
import { type GoalsAnalysis, interviewSketch, viewPlan } from "../src/planner/index.js";
import { plannerRegistry } from "./planner-helpers.js";

const registry = plannerRegistry();
const FEED = join(import.meta.dirname, "../../../apps/platform-web/test/fixtures/feeds/clinic.json");

const BRIEF =
  "Стоматология «Светлая»: хотим, чтобы пациенты сами записывались онлайн к врачу и не забывали о визите. " +
  "На сайте — услуги с ценами. Оплату лечения на сайте пока не нужно.";
const NAME = "Клиника «Светлая»";

const ANALYSIS: GoalsAnalysis = {
  niche: "стоматологическая клиника",
  goals: [
    { id: "fill_schedule", statement: "Пациенты сами записываются онлайн" },
    { id: "reduce_no_shows", statement: "Неявок меньше 5%" },
    { id: "show_offer", statement: "Пациент видит услуги и цены" },
  ],
  roles: ["Администратор"],
  resources: ["услуги", "врачи"],
  modules: [
    { id: "landing", why: "страница клиники" },
    { id: "catalog", why: "услуги и цены" },
    { id: "booking", why: "онлайн-запись к врачу" },
    { id: "notify", why: "напоминания пациентам" },
    { id: "client_card", why: "история пациента" },
    { id: "reports", why: "панель цели" },
  ],
  outOfScope: [{ request: "Оплата лечения на сайте", category: "payments" }],
  questions: [
    {
      id: "q1",
      topic: "params",
      module: "booking",
      param: "with_specialists",
      text: "Сколько врачей ведут приём?",
      whyItMatters: "Пациент выберет врача при записи, у каждого — своё расписание",
      options: [
        { id: "one", label: "Один", recommended: false },
        { id: "many", label: "Несколько", recommended: true },
      ],
      allowCustom: false,
    },
    {
      id: "q2",
      topic: "params",
      module: "notify",
      param: "channels",
      text: "Как напоминать пациентам о визите?",
      whyItMatters: "Напоминание за сутки и за 2 часа уменьшает неявки",
      options: [
        { id: "email", label: "Письмом", recommended: false },
        { id: "both", label: "Письмом и в Телеграме", recommended: true },
      ],
      allowCustom: false,
    },
    {
      id: "q3",
      topic: "params",
      module: "booking",
      param: "day_end",
      text: "До скольки идёт приём?",
      whyItMatters: "Так на сайте будут только реальные окна для записи",
      options: [
        { id: "18", label: "До 18:00", recommended: false },
        { id: "21", label: "До 21:00", recommended: true },
      ],
      allowCustom: true,
    },
  ],
};

const PLAN: SystemPlan = {
  version: 1,
  niche: "стоматологическая клиника",
  goals: ANALYSIS.goals,
  modules: [
    { id: "landing" },
    { id: "catalog", params: { with_duration: true }, goals: ["show_offer"] },
    {
      id: "booking",
      params: { with_specialists: true, specialist_label: "Врач", day_end: "21:00", slot_minutes: 30 },
      goals: ["fill_schedule"],
    },
    {
      id: "notify",
      params: { channels: ["email", "telegram"], second_reminder_hours: 2 },
      goals: ["reduce_no_shows"],
    },
    { id: "client_card", params: { client_label: "Пациент" } },
    { id: "reports" },
  ],
  landing: {
    sections: [
      { type: "header", variant: "bar", content: { cta: "Записаться" } },
      {
        type: "hero",
        variant: "split",
        content: {
          title: "Спокойное лечение без очередей",
          subtitle: "Приём с 9 до 21. Выберите время онлайн, а накануне мы напомним.",
          cta: "Выбрать время",
        },
      },
      { type: "services", variant: "list", content: { title: "Услуги и цены" } },
      {
        type: "steps",
        variant: "numbered",
        content: {
          title: "Как записаться",
          items: ["Выберите услугу и врача", "Отметьте свободное время", "Получите напоминание накануне"],
        },
      },
      { type: "cta", variant: "band", content: { title: "Запишитесь на удобное время", cta: "Записаться" } },
      { type: "footer", variant: "simple", content: { text: NAME } },
    ],
  },
  design: {
    direction: { mood: ["спокойствие", "доверие"], rhythm: "airy" },
    theme: "calm",
    accent: "#0F766E",
    fontPair: { heading: "Manrope", body: "Inter Tight" },
    photoStyle: "светлые кабинеты, дневной свет",
  },
  outOfScope: [
    {
      request: "Оплата лечения на сайте",
      replacement: "Оплата в клинике после приёма",
      category: "payments",
    },
  ],
  custom: [],
} as unknown as SystemPlan;

/** Build of the modules pipeline as the builder v2 reports it (build_stage: its labels and estimates) plus run events. */
function buildEvents(): { type: string; payload: Record<string, unknown> }[] {
  const out: { type: string; payload: Record<string, unknown> }[] = [
    {
      type: "run_started",
      payload: { kind: "build", mode: "create", baseRevision: 0, credits: { estimate: 2, cap: 3 } },
    },
  ];
  V2_STAGES.forEach((stage, i) => {
    const base = { stage, index: i + 1, total: V2_STAGES.length, label_ru: STAGE_LABELS[stage] };
    if (stage === "custom") {
      out.push({
        type: "build_stage",
        payload: { ...base, status: "skipped", remainingSec: remainingSec(V2_STAGES, i + 1, false) },
      });
      return;
    }
    out.push({
      type: "build_stage",
      payload: { ...base, status: "started", remainingSec: remainingSec(V2_STAGES, i, false) },
    });
    out.push({ type: "step_started", payload: { step: stage, label_ru: STAGE_LABELS[stage], attempt: 1 } });
    if (stage === "gates")
      out.push({
        type: "gate_result",
        payload: { level: "G0", passed: true, revision: 1, totalChecks: 14, failedChecks: [] },
      });
    out.push({ type: "step_finished", payload: { step: stage, durationMs: 1000 } });
    out.push({
      type: "build_stage",
      payload: { ...base, status: "done", remainingSec: remainingSec(V2_STAGES, i + 1, false) },
    });
  });
  out.push({
    type: "run_finished",
    payload: {
      status: "succeeded",
      resultRevision: 1,
      creditsUsed: 2,
      summary_ru: "Система собрана: сайт с записью, кабинет и напоминания.",
    },
  });
  return out;
}

function feed() {
  const view = viewPlan(PLAN, registry, { appName: NAME });
  if (!view.sketch) throw new Error("no sketch");
  return {
    name: "clinic",
    brief: BRIEF,
    system: { name: NAME, slug: "svetlaya" },
    interview: {
      text: "Есть 3 вопроса, чтобы составить план системы.",
      questions: ANALYSIS.questions,
      sketch: interviewSketch(ANALYSIS, registry),
    },
    plan: {
      text: "План системы готов: цели, модули и что не входит. Проверьте и утвердите — сборка начнётся только после этого.",
      plan: view.compiled.ok ? view.compiled.plan : PLAN,
      sketch: view.sketch,
    },
    build: buildEvents(),
  };
}

describe("B2-25: sketch of the canvas", () => {
  const view = viewPlan(PLAN, registry, { appName: NAME });
  const sk = view.sketch;

  test("the clinic plan compiles; the sketch carries the business colour and screen modules", () => {
    expect(view.errors).toEqual([]);
    expect(sk?.accent).toBe("#0F766E");
    expect(sk?.screens.find((s) => s.route === "/booking")?.module).toBe("booking");
    expect(sk?.screens.find((s) => s.route === "/clients")?.module).toBe("client_card");
  });

  test("automation chains: trigger, steps with channel and recipient, module of the chain", () => {
    const created = sk?.automations.find((a) => a.trigger.type === "on_create" && a.module === "booking");
    expect(created?.trigger.entityLabel).toBe("Запись");
    expect(created?.steps.some((s) => s.channel === "telegram" && s.to === "owner")).toBe(true);
    const offsets = sk?.automations.flatMap((a) =>
      a.trigger.offsetMinutes ? [a.trigger.offsetMinutes] : [],
    );
    expect(offsets).toEqual(expect.arrayContaining([-1440, -120]));
  });

  test("who sees data (all / some rows) and how long it is kept", () => {
    expect(sk?.access).toContainEqual(
      expect.objectContaining({ role: "owner", entity: "booking", scope: "all" }),
    );
    expect(sk?.access).toContainEqual(
      expect.objectContaining({ role: "guest", entity: "service", scope: "some" }),
    );
    expect(sk?.retention).toContainEqual({
      entity: "booking",
      entityLabel: "Запись",
      days: 365,
      mode: "anonymize",
    });
  });

  test("the interview sketch has no compiled parts yet", () => {
    const s = interviewSketch(ANALYSIS, registry);
    expect(s).toMatchObject({ stage: "interview", accent: null, automations: [], access: [], retention: [] });
  });

  test("the recorded feed «клиника» of platform-web matches the planner (WIZARD_UPDATE_FEEDS=1 rewrites it)", () => {
    const text = `${JSON.stringify(feed(), null, 1)}\n`;
    if (process.env.WIZARD_UPDATE_FEEDS === "1") writeFileSync(FEED, text);
    expect(readFileSync(FEED, "utf8")).toBe(text);
  });
});
