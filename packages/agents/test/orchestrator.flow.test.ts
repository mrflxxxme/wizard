// Orchestrator flows beyond the golden path: PII notice, validation repairs, edits, approval, change requests.
import { LlmError } from "@wizard/llm";
import { detect } from "@wizard/pii";
import { describe, expect, test } from "vitest";
import { AgentError } from "../src/core/index.js";
import {
  type Analysis,
  buildMessages,
  checkCard,
  checkQuestions,
  createOrchestrator,
  isStyleOnly,
  type OrchestratorDeps,
  type OrchSession,
  type SystemCard,
  staticPrompt,
} from "../src/orchestrator/index.js";
import {
  CTX,
  fixtureLines,
  forumBrief,
  forumRouter,
  OPEN_POLICY,
  scriptedRoute,
  toolResult,
} from "./helpers.js";

const lines = fixtureLines();
const argsOf = (i: number) =>
  structuredClone(lines[i]?.response.toolCalls[0]?.args) as Record<string, unknown>;
const ANALYSIS = () => argsOf(0) as Analysis;
const QUESTIONS = () => argsOf(1);
const CARD = () => argsOf(2);

function make(route: OrchestratorDeps["route"], extra: Partial<OrchestratorDeps> = {}) {
  const emitted: { type: string; payload: Record<string, unknown> }[] = [];
  const orch = createOrchestrator({
    route,
    orgPolicy: OPEN_POLICY,
    ctx: CTX,
    emit: (type, payload) => {
      emitted.push({ type, payload });
    },
    ...extra,
  });
  return { orch, emitted };
}

async function toCard(route: OrchestratorDeps["route"]) {
  const { orch, emitted } = make(route);
  const r1 = await orch.submitBrief(orch.newSession(), forumBrief());
  const r2 = await orch.restByRecommendation(r1.session);
  return { orch, emitted, session: r2.session };
}

describe("S1_dlp / pii_notice", () => {
  test("brief with a phone: exactly one notice kind=notice payload.type=pii; interview goes to T0", async () => {
    const { router, sink } = forumRouter();
    const { orch, emitted } = make((i) => router.route(i));
    const brief = `${forumBrief()} Вопросы по форуму — по телефону +7 912 345-67-89.`;
    const r1 = await orch.submitBrief(orch.newSession(), brief);
    const notices = r1.outputs.filter((o) => o.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ role: "system", payload: { type: "pii", categories: ["phone"] } });
    expect(notices[0]?.text).toContain("телефон");
    expect(notices[0]?.text).not.toContain("912");
    expect(r1.session.piiInBrief).toBe(true);
    expect(emitted[0]).toEqual({
      type: "chat_output",
      payload: { kind: "notice", messageId: notices[0]?.id },
    });
    expect(sink.records.filter((r) => r.callType === "interview").map((r) => r.routeReason)).toEqual([
      "pii_detected_interview",
      "pii_detected_interview",
    ]);
    // custom answer with PII: the notice is not repeated
    const r2 = await orch.answer(r1.session, { questionId: "q1", text: "Пишите на org@example.ru" });
    expect(r2.outputs.filter((o) => o.kind === "notice")).toHaveLength(0);
    const r3 = await orch.restByRecommendation(r2.session);
    expect(r3.session.state).toBe("awaiting_approval");
    expect(JSON.stringify(r3.session.card)).not.toContain("912");
    expect((r3.session.card as SystemCard).forkAnswers[0]).toEqual({
      questionId: "q1",
      forkId: "F-LOGIN",
      text: "Пишите на org@example.ru",
      byRecommendation: false,
    });
  });

  test("static prompt: no PII findings and within 6k tokens", () => {
    expect(detect(staticPrompt())).toEqual([]);
    expect(staticPrompt().length / 3.2).toBeLessThanOrEqual(6000);
    const msgs = buildMessages({ org: { plan: "free" }, brief: "Форум", task: "x" });
    expect(msgs[0]).toEqual({ role: "system", content: staticPrompt() });
  });
});

describe("S2/S4/S5 validation", () => {
  test("invalid analysis 3 times → run_failed ORCH_INVALID_OUTPUT, state failed", async () => {
    const bad = toolResult("submit_analysis", { goals: [] });
    const { route, inputs } = scriptedRoute([bad, bad, bad]);
    const { orch, emitted } = make(route);
    const r = await orch.submitBrief(orch.newSession(), "Нужна запись клиентов");
    expect(inputs).toHaveLength(3);
    expect(r.session.state).toBe("failed");
    expect(r.failure?.code).toBe("ORCH_INVALID_OUTPUT");
    expect(emitted.at(-1)).toMatchObject({
      type: "run_failed",
      payload: { code: "ORCH_INVALID_OUTPUT", retryable: true },
    });
    // Internal orch_invalid right before run_failed: what did not parse, for diagnose.
    const inv = emitted.at(-2) as { type: string; payload: { issues: { path: string; message: string }[] } };
    expect(inv.type).toBe("orch_invalid");
    expect(inv.payload.issues.length).toBeGreaterThan(0);
    expect(inv.payload.issues.every((i) => typeof i.path === "string" && i.message.length <= 160)).toBe(true);
  });

  test("questions outside the selected forks are repaired", async () => {
    const q = QUESTIONS() as { questions: { forkId: string; options: { id: string }[] }[] };
    const wrong = structuredClone(q);
    (wrong.questions[0] as { forkId: string }).forkId = "F-REPORTS";
    const { route, inputs } = scriptedRoute([
      toolResult("submit_analysis", ANALYSIS()),
      toolResult("ask_questions", wrong),
      toolResult("ask_questions", q),
    ]);
    const { orch } = make(route);
    const r = await orch.submitBrief(orch.newSession(), forumBrief());
    expect(r.session.state).toBe("asking");
    const repair = JSON.stringify(inputs[2]?.messages.at(-1));
    expect(repair).toContain("F-REPORTS");
    // the prompt lists the forks with the plan-filtered options
    const user = inputs[1]?.messages[1]?.content as string;
    expect(user).toContain("F-LOGIN: Как входить? Варианты: email, telegram, email_or_telegram.");
  });

  test("checkQuestions: phone on free plan, duplicate forks, missing forks", () => {
    const q = (QUESTIONS() as { questions: never[] }).questions;
    const phone = structuredClone(q) as { options: { id: string; label: string; recommended: boolean }[] }[];
    phone[0]?.options.push({ id: "phone", label: "По телефону", recommended: false });
    const codes = checkQuestions(
      phone as never,
      ["F-LOGIN", "F-EV-CHECKIN", "F-PAYMENT", "F-STAFF", "F-RETENTION", "F-IMPORT"],
      {
        plan: "free",
      },
    ).map((i) => i.message);
    expect(codes.some((m) => m.includes("phone"))).toBe(true);
    expect(codes.some((m) => m.includes("F-IMPORT"))).toBe(true);
    expect(
      checkQuestions(phone as never, ["F-LOGIN", "F-EV-CHECKIN", "F-PAYMENT", "F-STAFF", "F-RETENTION"], {
        plan: "business",
      }),
    ).toEqual([]);
  });

  test("checkCard: semantics and F4", () => {
    const card = CARD() as Record<string, unknown> & {
      roles: { name: string; loginMethods?: string[] }[];
      acceptance: { id: string; check: { role?: string; entity?: string } }[];
    };
    const ok = checkCard(card as never, { plan: "free" });
    expect(ok).toEqual([]);
    const bad = structuredClone(card);
    bad.roles[0]?.loginMethods?.push("phone_otp");
    (bad.acceptance[0] as { id: string }).id = "AC9";
    (bad.acceptance[1] as { check: { entity?: string } }).check.entity = "ghost";
    bad.acceptance = bad.acceptance.filter((a) => a.check.role !== "moderator");
    const msgs = checkCard(bad as never, { plan: "free" }).map((i) => i.message);
    expect(msgs).toEqual(
      expect.arrayContaining([
        "Вход по телефону недоступен на бесплатном тарифе.",
        "Ожидался id AC1: нумерация AC1..ACn.",
        "Данных ghost нет в карточке.",
        "Нет ни одного критерия для роли moderator (check.role).",
      ]),
    );
    expect(checkCard(bad as never, { plan: "start" }).map((i) => i.message)).not.toContain(
      "Вход по телефону недоступен на бесплатном тарифе.",
    );
  });

  test("card with personal data is sent back to the model", async () => {
    const leaky = CARD() as { summary: string };
    leaky.summary = "Главный организатор — Иван Петров, звонить +7 912 345-67-89.";
    const { route, inputs } = scriptedRoute([
      toolResult("submit_analysis", ANALYSIS()),
      toolResult("ask_questions", QUESTIONS()),
      toolResult("submit_card", leaky),
      toolResult("submit_card", CARD()),
    ]);
    const { session } = await toCard(route);
    expect(session.state).toBe("awaiting_approval");
    expect(JSON.stringify(inputs[3]?.messages.at(-1))).toContain("PII_IN_OUTPUT");
  });

  test("0 forks → straight to the card (≤ 2 LLM calls)", async () => {
    const a = ANALYSIS();
    a.resolved = [];
    a.unknowns = [];
    a.segment = "horizontal";
    a.skeleton = ["catalog"];
    a.roles = [{ name: "owner", label: "Владелец", access: "login", isStaff: true, evidence: "" }];
    a.integrations = [];
    a.entities = [{ name: "item", label: "Позиция", keyFields: ["title"], containsPii: false }];
    a.goals = ["Показывать каталог"];
    a.constraints = [];
    const { route, inputs } = scriptedRoute([
      toolResult("submit_analysis", a),
      toolResult("submit_card", CARD()),
    ]);
    const { orch } = make(route);
    const r = await orch.submitBrief(orch.newSession(), "Каталог");
    expect(r.session.selection?.asked).toEqual([]);
    expect(r.session.state).toBe("awaiting_approval");
    expect(inputs.map((i) => i.callType)).toEqual(["interview", "card"]);
    expect(inputs[1]?.messages[1]?.content).toContain("Решено по умолчанию");
  });
});

describe("LLM failures", () => {
  test("LLM_UNAVAILABLE and BUDGET_EXCEEDED → failed", async () => {
    for (const [err, code] of [
      [new LlmError("LLM_UNAVAILABLE", "x"), "LLM_UNAVAILABLE"],
      [new LlmError("BUDGET_EXCEEDED", "x"), "BUDGET_STOPPED"],
    ] as const) {
      const { route } = scriptedRoute([err]);
      const { orch, emitted } = make(route);
      const r = await orch.submitBrief(orch.newSession(), "Бриф");
      expect(r.session.state).toBe("failed");
      expect(r.failure?.code).toBe(code);
      expect(emitted.at(-1)?.type).toBe("run_failed");
    }
  });
});

describe("S6 edits, approval, idempotency, invalid transitions", () => {
  const cards = (n: number) => Array.from({ length: n }, () => toolResult("submit_card", CARD()));

  test("up to 5 card versions, then offer to start over", async () => {
    const { route } = scriptedRoute([
      toolResult("submit_analysis", ANALYSIS()),
      toolResult("ask_questions", QUESTIONS()),
      ...cards(5),
    ]);
    const { orch, session } = await toCard(route);
    let s: OrchSession = session;
    for (let v = 2; v <= 5; v++) {
      const r = await orch.editCard(s, "Добавьте поле «Должность» в билет");
      s = r.session;
      expect(s.cardVersion).toBe(v);
      expect(r.outputs.find((o) => o.kind === "card")?.payload).toEqual({ cardVersion: v });
    }
    expect(s.edits).toHaveLength(4);
    const r6 = await orch.editCard(s, "Ещё правка");
    expect(r6.session.state).toBe("awaiting_approval");
    expect(r6.session.cardVersion).toBe(5);
    expect(r6.outputs[0]).toMatchObject({ kind: "text", payload: { hint: "restart" } });
  });

  test("approve checks balance (M1+) and hands off once", async () => {
    const { route } = scriptedRoute([
      toolResult("submit_analysis", ANALYSIS()),
      toolResult("ask_questions", QUESTIONS()),
      ...cards(1),
    ]);
    const { orch, session } = await toCard(route);
    const cap = session.card?.cap.credits ?? 0;
    const low = await orch.approve(session, { balanceCredits: cap - 1 });
    expect(low.insufficientCredits).toBe(true);
    expect(low.session.state).toBe("awaiting_approval");
    const ok = await orch.approve(session, { balanceCredits: cap });
    expect(ok.handoff).toMatchObject({ cardVersion: 1, cap, mode: "create" });
    await expect(orch.approve(ok.session)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const started = await orch.dispatch(ok.session, { type: "BUILD_STARTED" });
    expect(started.session.state).toBe("building");
    const cancelled = await orch.cancel(started.session);
    expect(cancelled.session.state).toBe("cancelled");
  });

  test("same idempotencyKey: no new LLM calls, no state change", async () => {
    const { route, inputs } = scriptedRoute([
      toolResult("submit_analysis", ANALYSIS()),
      toolResult("ask_questions", QUESTIONS()),
    ]);
    const { orch } = make(route);
    const r1 = await orch.submitBrief(orch.newSession(), forumBrief(), { idempotencyKey: "msg-1" });
    const r2 = await orch.submitBrief(r1.session, forumBrief(), { idempotencyKey: "msg-1" });
    expect(r2.session).toBe(r1.session);
    expect(r2.outputs).toEqual([]);
    expect(inputs).toHaveLength(2);
  });

  test("invalid event → INVALID_TRANSITION without side effects", async () => {
    const { route, inputs } = scriptedRoute([]);
    const { orch, emitted } = make(route);
    const s = orch.newSession();
    const before = structuredClone(s);
    await expect(orch.restByRecommendation(s)).rejects.toBeInstanceOf(AgentError);
    await expect(orch.editCard(s, "x")).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(s).toEqual(before);
    expect(inputs).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });
});

describe("change_requests", () => {
  const current = {
    specDigest: "Форум: билеты, потоки, заявки спикеров",
    roles: ["participant", "organizer"],
    entities: ["ticket"],
  };

  async function doneSession(orch: ReturnType<typeof make>["orch"]) {
    let s = orch.newSession();
    s = { ...s, state: "done", card: null };
    return s;
  }

  test("classifier: style_only by code", () => {
    expect(isStyleOnly("Сделайте кнопки синими и шрифт крупнее")).toBe(true);
    expect(isStyleOnly("Хочу тёмную тему")).toBe(true);
    expect(isStyleOnly("Добавьте поле «Цвет футболки» в заявку")).toBe(false);
  });

  test("style_only: hint to «Стиль», no LLM call, no run", async () => {
    const { route, inputs } = scriptedRoute([]);
    const { orch, emitted } = make(route);
    const r = await orch.requestChange(await doneSession(orch), "Поменяйте цвет фона на бежевый", current);
    expect(r.changeKind).toBe("style_only");
    expect(r.session.state).toBe("done");
    expect(r.outputs[0]).toMatchObject({ kind: "text", payload: { hint: "style" } });
    expect(inputs).toHaveLength(0);
    expect(emitted[0]?.payload.kind).toBe("answer");
  });

  test("small_edit: mini-card kind=change with cap ≥ 3, change_proposal event", async () => {
    const { route, inputs } = scriptedRoute([
      toolResult("submit_change", { kind: "small_edit", summary: "Добавить поле «Должность» в билет" }),
      toolResult("submit_change_card", {
        summary: "В билете появится поле «Должность»",
        data: [
          { name: "ticket", label: "Билет", fields: [{ label: "Должность", kind: "text" }], pii: "none" },
        ],
      }),
    ]);
    const { orch, emitted } = make(route);
    const r = await orch.requestChange(await doneSession(orch), "Добавьте поле «Должность» в билет", current);
    expect(r.changeKind).toBe("small_edit");
    expect(r.session.state).toBe("awaiting_approval");
    const card = r.session.card as {
      kind: string;
      cap: { credits: number };
      estimate: { credits: { expected: number } };
    };
    expect(card.kind).toBe("change");
    expect(card.cap.credits).toBe(Math.max(3, Math.ceil(2 * card.estimate.credits.expected)));
    expect(emitted.map((e) => e.payload.kind)).toEqual(["change_proposal"]);
    expect(inputs[0]?.messages[1]?.content).toContain("# Текущая система\nФорум");
    const ok = await orch.approve(r.session);
    expect(ok.handoff?.mode).toBe("change");
  });

  test("small_edit with ≤ 2 questions → asking, then the mini-card", async () => {
    const q = (QUESTIONS() as { questions: unknown[] }).questions[2];
    const { route } = scriptedRoute([
      toolResult("submit_change", { kind: "small_edit", summary: "Оплата", questions: [q] }),
      toolResult("submit_change_card", { summary: "Оплата онлайн" }),
    ]);
    const { orch } = make(route);
    const r1 = await orch.requestChange(await doneSession(orch), "Хочу принимать оплату за билеты", current);
    expect(r1.session.state).toBe("asking");
    const r2 = await orch.answer(r1.session, { questionId: "q1", optionId: "yookassa_full" });
    expect(r2.session.state).toBe("awaiting_approval");
  });

  test("big_change: full S2–S6 with the current spec as context", async () => {
    const { route, inputs } = scriptedRoute([
      toolResult("submit_change", {
        kind: "big_change",
        summary: "Добавить выездную программу с расселением",
      }),
      toolResult("submit_analysis", ANALYSIS()),
      toolResult("ask_questions", QUESTIONS()),
    ]);
    const { orch } = make(route);
    const r = await orch.requestChange(
      await doneSession(orch),
      "Добавьте выездную программу с расселением",
      current,
    );
    expect(r.changeKind).toBe("big_change");
    expect(r.session.state).toBe("asking");
    expect(inputs[1]?.messages[1]?.content).toContain("# Текущая система");
  });
});
