// Acceptance M0-12: offline deterministic replay of demo/forum interview → card through @wizard/llm (fixture mode).
import { detect } from "@wizard/pii";
import { describe, expect, test } from "vitest";
import {
  createOrchestrator,
  FORK_IDS,
  type OrchOutput,
  type OrchSession,
  systemCardSchema,
} from "../src/orchestrator/index.js";
import { CTX, forumBrief, forumRouter, OPEN_POLICY } from "./helpers.js";

async function replay() {
  const { router, sink } = forumRouter();
  const emitted: { type: string; payload: Record<string, unknown> }[] = [];
  let n = 0;
  const orch = createOrchestrator({
    route: (i) => router.route(i),
    orgPolicy: OPEN_POLICY,
    ctx: CTX,
    org: { plan: "free" },
    emit: (type, payload) => {
      emitted.push({ type, payload });
    },
    newId: () => `m${++n}`,
  });
  const s0 = orch.newSession();
  const r1 = await orch.submitBrief(s0, forumBrief());
  const r2 = await orch.answer(r1.session, { questionId: "q1", optionId: "email_or_telegram" });
  const r3 = await orch.answer(r2.session, { questionId: "q2", optionId: "qr_offline_scanner" });
  const r4 = await orch.restByRecommendation(r3.session);
  return { orch, sink, emitted, r1, r2, r3, r4 };
}

const questionsOf = (outs: OrchOutput[]) => {
  const q = outs.find((o) => o.kind === "questions");
  if (q?.kind !== "questions") throw new Error("no questions output");
  return q;
};

describe("demo/forum replay", () => {
  test("brief → 3–7 questions, 2–4 options, exactly one recommended, forkId ∈ fork_taxonomy", async () => {
    const { r1 } = await replay();
    expect(r1.failure).toBeUndefined();
    expect(r1.session.state).toBe("asking");
    expect(r1.outputs.filter((o) => o.kind === "notice")).toHaveLength(0);
    const q = questionsOf(r1.outputs);
    expect(q.questions.length).toBeGreaterThanOrEqual(3);
    expect(q.questions.length).toBeLessThanOrEqual(7);
    for (const question of q.questions) {
      expect(FORK_IDS).toContain(question.forkId);
      expect(question.options.length).toBeGreaterThanOrEqual(2);
      expect(question.options.length).toBeLessThanOrEqual(4);
      expect(question.options.filter((o) => o.recommended)).toHaveLength(1);
    }
    expect(q.payload.questionIds).toEqual(["q1", "q2", "q3", "q4", "q5"]);
  });

  test("deterministic fork selection matches the golden interview", async () => {
    const { r1 } = await replay();
    const asked = r1.session.selection?.asked.map((x) => x.forkId);
    expect(asked).toEqual(["F-EV-CHECKIN", "F-LOGIN", "F-RETENTION", "F-PAYMENT", "F-STAFF"]);
    expect(new Set(questionsOf(r1.outputs).questions.map((q) => q.forkId))).toEqual(new Set(asked));
    const summary = questionsOf(r1.outputs).payload.analysis;
    expect(summary?.forks.filter((f) => f.status === "resolved").map((f) => f.forkId)).toEqual(
      expect.arrayContaining(["F-EV-TICKETS", "F-ACCESS", "F-NOTIFY"]),
    );
    expect(summary?.forks.find((f) => f.forkId === "F-VISIBILITY")?.status).toBe("pending");
    // FU-4: the panel shows human titles, never raw ids; decided forks carry the option label.
    for (const f of summary?.forks ?? []) expect(f.title).not.toMatch(/^F-/);
    expect(summary?.forks.find((f) => f.forkId === "F-EV-TICKETS")).toMatchObject({
      title: "Типы билетов",
      choice: expect.any(String),
    });
  });

  test("answers → card valid by SystemCard, credits.expected ∈ [12, 35], ≤ 3 LLM calls", async () => {
    const { r2, r3, r4, sink } = await replay();
    expect(r2.session.state).toBe("asking");
    expect(r3.session.state).toBe("asking");
    expect(r4.failure).toBeUndefined();
    expect(r4.session.state).toBe("awaiting_approval");
    const out = r4.outputs.find((o) => o.kind === "card");
    if (out?.kind !== "card") throw new Error("no card");
    const card = systemCardSchema.parse(out.card);
    expect(card.cardVersion).toBe(1);
    expect(card.estimate.credits.expected).toBeGreaterThanOrEqual(12);
    expect(card.estimate.credits.expected).toBeLessThanOrEqual(35);
    expect(card.estimate.credits.min).toBeLessThanOrEqual(card.estimate.credits.expected);
    expect(card.estimate.credits.max).toBeGreaterThanOrEqual(card.estimate.credits.expected);
    expect(card.cap.credits).toBe(Math.max(10, Math.ceil(2 * card.estimate.credits.expected)));
    expect(card.forkAnswers.map((a) => [a.forkId, a.optionId, a.byRecommendation])).toEqual([
      ["F-LOGIN", "email_or_telegram", false],
      ["F-EV-CHECKIN", "qr_offline_scanner", false],
      ["F-PAYMENT", "yookassa_full", true],
      ["F-STAFF", "admin_manager_moderator", true],
      ["F-RETENTION", "d30_after_event", true],
    ]);
    expect(r4.session.llmCalls).toBe(3);
    expect(sink.records.map((r) => r.callType)).toEqual(["interview", "interview", "card"]);
    // forum brief has no personal data: default T1 route for every call
    expect(sink.records.every((r) => r.routeReason === "default_T1")).toBe(true);
  });

  test("DLP over the card and the analysis = 0 findings", async () => {
    const { r4 } = await replay();
    const s = r4.session as OrchSession;
    expect(detect(JSON.stringify(s.card))).toEqual([]);
    expect(detect(JSON.stringify(s.analysis))).toEqual([]);
  });

  test("replay is deterministic", async () => {
    const a = await replay();
    const b = await replay();
    expect(b.r4.session).toEqual(a.r4.session);
    expect(b.emitted).toEqual(a.emitted);
  });

  test("chat_output events for questions and card; approve hands off {card, cardVersion, cap}", async () => {
    const { orch, emitted, r4 } = await replay();
    expect(emitted).toEqual([
      { type: "chat_output", payload: { kind: "questions", messageId: "m1" } },
      { type: "chat_output", payload: { kind: "card", messageId: "m2", cardVersion: 1 } },
    ]);
    const ok = await orch.approve(r4.session);
    expect(ok.session.state).toBe("approved");
    expect(ok.handoff?.cardVersion).toBe(1);
    expect(ok.handoff?.cap).toBe(r4.session.card?.cap.credits);
    expect(ok.handoff?.mode).toBe("create");
  });
});
