// M2-77 (D34, D73): report_capability_gap in the interview and the build — honest answer, the closest replacement and
// «Написать команде»; the request is recorded through the optional host method with the quote scrubbed of PII; a gap
// never stops what the platform can do.
import { describe, expect, test } from "vitest";
import { createMemoryHost, runBuild } from "../src/builder/index.js";
import {
  type CapabilityGap,
  type DevelopmentRequestInput,
  gapMessage,
  reportCapabilityGapTool,
  SUPPORT_BUTTON,
} from "../src/index.js";
import {
  type Analysis,
  analysisSchema,
  createOrchestrator,
  forkOptions,
  getFork,
  type OrchestratorDeps,
  selectForks,
} from "../src/orchestrator/index.js";
import { g1Stub, golden, report, startSpec, stop, tc, turn } from "./builder-helpers.js";
import { CTX, fixtureLines, OPEN_POLICY, scriptedRoute, toolResult } from "./helpers.js";

const BRIEF =
  "Делаем стрижки. Нужно приложение в App Store и оплата криптовалютой, а клиенты пусть записываются к мастеру. Звоните +7 912 345-67-89.";

const ANALYSIS: Analysis = analysisSchema.parse({
  goals: ["Запись клиентов к мастерам"],
  segment: "booking",
  skeleton: ["application", "process"],
  roles: [
    { name: "owner", label: "Владелец", access: "login", isStaff: true, evidence: "" },
    { name: "master", label: "Мастер", access: "login", isStaff: true, evidence: "" },
    { name: "client", label: "Клиент", access: "public", isStaff: false, evidence: "" },
  ],
  entities: [
    { name: "service", label: "Услуга", keyFields: ["название"], containsPii: false },
    { name: "booking", label: "Запись", keyFields: ["время"], containsPii: true },
  ],
  integrations: [],
  constraints: [],
  resolved: [],
  unknowns: [],
  outOfScope: [],
  complexity: "small",
});

const MOBILE = {
  category: "mobile",
  quote: "приложение в App Store",
  missing: "приложения в App Store и Google Play",
  offered: "веб-приложение, которое ставится на телефон с сайта",
};
const CRYPTO = {
  category: "payments",
  quote: "оплата криптовалютой, звоните +7 912 345-67-89",
  missing: "приём оплаты на сайте, в том числе криптовалютой",
  offered: "сумма в записи, оплата в салоне",
};

function questionsFor(a: Analysis) {
  return selectForks(a).asked.map((x, i) => {
    const f = getFork(x.forkId);
    const options = forkOptions(x.forkId, { plan: "free" }).slice(0, 4);
    return {
      id: `q${i + 1}`,
      forkId: x.forkId,
      text: f?.q ?? "",
      whyItMatters: "От ответа зависит, как будет устроена запись.",
      options: options.map((o, j) => ({ id: o, label: o, recommended: j === 0 })),
    };
  });
}

/** The forum card from the golden fixture: valid for checkCard; its outOfScope is cleared. */
const card = () => {
  const c = structuredClone(fixtureLines()[2]?.response.toolCalls[0]?.args) as Record<string, unknown>;
  c.outOfScope = [];
  return c;
};

function interview(extra: Partial<OrchestratorDeps> = {}) {
  const { route, inputs } = scriptedRoute([
    {
      toolCalls: [
        { id: "a", name: "submit_analysis", args: ANALYSIS },
        { id: "g1", name: "report_capability_gap", args: MOBILE },
        { id: "g2", name: "report_capability_gap", args: CRYPTO },
      ],
      finishReason: "tool-calls",
    },
    toolResult("ask_questions", { questions: questionsFor(ANALYSIS) }),
    // The model repeats a known gap with the card: it is not recorded twice.
    {
      toolCalls: [
        { id: "c", name: "submit_card", args: card() },
        { id: "g3", name: "report_capability_gap", args: CRYPTO },
      ],
      finishReason: "tool-calls",
    },
  ]);
  const orch = createOrchestrator({ route, orgPolicy: OPEN_POLICY, ctx: CTX, ...extra });
  return { orch, inputs };
}

describe("interview", () => {
  test("App Store + crypto payments: honest answer with replacements and the team button; two requests recorded", async () => {
    const recorded: DevelopmentRequestInput[] = [];
    const { orch, inputs } = interview({
      recordDevelopmentRequest: async (r) => {
        recorded.push(r);
      },
    });
    const r1 = await orch.submitBrief(orch.newSession(), BRIEF);
    expect(r1.failure).toBeUndefined();
    expect(inputs[0]?.tools?.map((t) => t.name)).toEqual(["submit_analysis", "report_capability_gap"]);
    expect(recorded.map((r) => r.category)).toEqual(["mobile", "payments"]);
    expect(recorded[1]?.quote).not.toContain("912");
    expect(recorded[1]?.offered).toBe(CRYPTO.offered);
    const q = r1.outputs.find((o) => o.kind === "questions");
    expect(q?.text).toContain("Пока не умеем: приложения в App Store");
    expect(q?.text).toContain("Можно сделать так: веб-приложение");
    expect(q?.text).toContain(`«${SUPPORT_BUTTON}»`);
    expect(q?.kind === "questions" && q.payload.gaps?.length).toBe(2);
    // The gap does not stop the interview: questions about what the platform can build are asked.
    expect(r1.session.state).toBe("asking");

    const r2 = await orch.restByRecommendation(r1.session);
    expect(r2.session.state).toBe("awaiting_approval");
    expect(recorded).toHaveLength(2);
    const c = r2.outputs.find((o) => o.kind === "card");
    if (c?.kind !== "card") throw new Error("no card");
    const outOfScope = c.card.outOfScope ?? [];
    expect(outOfScope.filter((x) => x.startsWith("Пока не войдёт:"))).toHaveLength(2);
    expect(outOfScope.join("\n")).not.toContain("912");
    expect(r2.session.gaps).toHaveLength(2);
  });

  test("no host method: nothing is recorded, the answer is still honest; a failing host does not break the turn", async () => {
    const a = interview();
    const r = await a.orch.submitBrief(a.orch.newSession(), BRIEF);
    expect(r.outputs.find((o) => o.kind === "questions")?.text).toContain(`«${SUPPORT_BUTTON}»`);
    const b = interview({
      recordDevelopmentRequest: async () => {
        throw new Error("db down");
      },
    });
    const rb = await b.orch.submitBrief(b.orch.newSession(), BRIEF);
    expect(rb.failure).toBeUndefined();
    expect(rb.session.gaps).toHaveLength(2);
  });
});

describe("build", () => {
  test("a gap during the build is recorded, the owner gets an agent message, the build goes on", async () => {
    const g = await golden("forum");
    const recorded: DevelopmentRequestInput[] = [];
    const { route } = scriptedRoute([
      turn(
        tc("submit_plan", {
          steps: [{ id: "P1", kind: "ops", title: "Правки", targets: [], acRefs: ["AC1"] }],
        }),
      ),
      turn(
        tc("report_capability_gap", {
          category: "messaging",
          quote: "SMS-напоминание участникам",
          missing: "SMS",
          offered: "письмо-напоминание",
        }),
      ),
      stop(),
      stop(),
    ]);
    const mem = createMemoryHost({
      spec: startSpec(g.buildSpec),
      version: 1,
      route,
      gates: { G0: async () => report("G0", true), G1: g1Stub },
      recordDevelopmentRequest: async (r) => {
        recorded.push(r);
      },
    });
    const out = await runBuild(mem.host, { card: g.card, cap: 100, mode: "create" });
    expect(out.status).toBe("succeeded");
    expect(recorded).toEqual([
      { category: "messaging", quote: "SMS-напоминание участникам", offered: "письмо-напоминание" },
    ]);
    const said = mem.events.filter((e) => e.type === "agent_message").map((e) => String(e.payload.text));
    expect(said.some((t) => t.includes("Пока не умеем: SMS") && t.includes(`«${SUPPORT_BUTTON}»`))).toBe(
      true,
    );
  });
});

describe("answer text", () => {
  const gaps: CapabilityGap[] = [MOBILE, CRYPTO].map((g) => ({ ...g })) as CapabilityGap[];

  test("plain: no exclamations, emoji, numbers, prices or deadlines of third parties", () => {
    const text = gapMessage(gaps);
    expect(text).not.toMatch(/[!\u{1F300}-\u{1FAFF}]/u);
    expect(text).not.toMatch(/\d|₽|руб|срок|дней|недел/);
    expect(gapMessage([])).toBe("");
  });

  test("report_capability_gap deduplicates by category and quote", async () => {
    const recorded: DevelopmentRequestInput[] = [];
    const tool = reportCapabilityGapTool({
      record: async (r) => {
        recorded.push(r);
      },
    });
    const call = { id: "x", name: "report_capability_gap", args: {} };
    await tool.run?.(MOBILE as CapabilityGap, call);
    const again = await tool.run?.({ ...MOBILE, quote: "Приложение в App Store " } as CapabilityGap, call);
    expect(recorded).toHaveLength(1);
    expect(again).toMatchObject({ ok: true, recorded: false });
  });
});
