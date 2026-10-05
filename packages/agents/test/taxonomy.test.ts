// fork_taxonomy mirror, S3_select_forks and the estimate (orchestrator.yaml#fork_taxonomy, #algorithm, #estimation).
import { createRegistry } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import {
  type Analysis,
  analysisSchema,
  cardDraftSchema,
  estimateCard,
  FORK_IDS,
  FORK_LABELS,
  FORKS,
  forkOptions,
  priceBlended,
  selectForks,
  tokensExpected,
} from "../src/orchestrator/index.js";
import { fixtureLines, loadYaml, OPEN_POLICY } from "./helpers.js";

type YamlFork = { id: string; impact: number; q: string; options: string[]; rec: string };
const taxonomy = (loadYaml("specs/agents/orchestrator.yaml") as { fork_taxonomy: Record<string, unknown> })
  .fork_taxonomy as Record<string, YamlFork[] | string[]>;

const forumAnalysis = (): Analysis =>
  analysisSchema.parse(fixtureLines()[0]?.response.toolCalls[0]?.args) satisfies Analysis;

describe("fork_taxonomy mirrors the spec", () => {
  test("groups, ids, impact, question, options, rec", () => {
    const fromYaml = Object.entries(taxonomy)
      .filter(([g]) => g !== "rules")
      .flatMap(([group, forks]) =>
        (forks as YamlFork[]).map((f) => ({
          group,
          id: f.id,
          impact: f.impact,
          q: f.q,
          // YAML 1.1: bare `no` parses as false (F-INVENTORY option "no").
          options: f.options.map((o) => (o === (false as unknown) ? "no" : o)),
          rec: f.rec,
        })),
      );
    expect(
      FORKS.map((f) => ({
        group: f.group,
        id: f.id,
        impact: f.impact,
        q: f.q,
        options: [...f.options],
        rec: f.rec,
      })),
    ).toEqual(fromYaml);
    expect([...FORK_IDS]).toEqual(fromYaml.map((f) => f.id));
  });

  test("free plan: no phone variants of F-LOGIN (F4)", () => {
    expect(forkOptions("F-LOGIN", { plan: "free" })).toEqual(["email", "telegram", "email_or_telegram"]);
    expect(forkOptions("F-LOGIN", { plan: "start" })).toContain("phone");
  });

  test("FU-4: every fork has a short Russian title and every option a label", () => {
    for (const f of FORKS) {
      const l = FORK_LABELS[f.id as keyof typeof FORK_LABELS];
      expect(l?.title, f.id).toMatch(/^[А-ЯЁ]/);
      expect(Object.keys(l?.options ?? {}).sort(), f.id).toEqual([...f.options].sort());
    }
  });
});

describe("S3_select_forks", () => {
  test("forum: top forks by score, ties by id; resolved and confident defaults are not asked", () => {
    const sel = selectForks(forumAnalysis());
    expect(sel.asked).toEqual([
      { forkId: "F-EV-CHECKIN", score: 4 },
      { forkId: "F-LOGIN", score: 4 },
      { forkId: "F-RETENTION", score: 4 },
      { forkId: "F-PAYMENT", score: 3 },
      { forkId: "F-STAFF", score: 3 },
    ]);
    const decided = Object.fromEntries(sel.decided.map((d) => [d.forkId, d.source]));
    expect(decided["F-EV-TICKETS"]).toBe("brief");
    expect(decided["F-VISIBILITY"]).toBe("default"); // depends on F-STAFF, which is being asked
    expect(decided["F-STATUSES"]).toBe("default"); // impact 2, not unknown
  });

  test("at most 7 questions; overflow is decided by recommendation", () => {
    const a = forumAnalysis();
    const many: Analysis = {
      ...a,
      resolved: [],
      unknowns: [
        "F-LOGIN",
        "F-EV-CHECKIN",
        "F-RETENTION",
        "F-STATUSES",
        "F-NOTIFY",
        "F-EV-PROGRAM",
        "F-EV-SPEAKERS",
      ],
    };
    const sel = selectForks(many);
    expect(sel.asked).toHaveLength(7);
    expect(sel.decided.some((d) => d.source === "default")).toBe(true);
    const scores = sel.asked.map((x) => x.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });

  test("bakery: the golden fixture asks exactly the selected forks (FU-2)", () => {
    const lines = fixtureLines("bakery");
    const a = analysisSchema.parse(lines[0]?.response.toolCalls[0]?.args);
    const args = lines[1]?.response.toolCalls[0]?.args as { questions: { forkId: string }[] } | undefined;
    const asked = args?.questions ?? [];
    expect(asked.length).toBeGreaterThan(0);
    const sel = selectForks(a);
    expect(sel.asked.map((x) => x.forkId).sort()).toEqual(asked.map((q) => q.forkId).sort());
    // «остаток — при готовности» is the rest of the payment, not stock.
    expect(sel.decided.map((d) => d.forkId)).not.toContain("F-INVENTORY");
    expect(sel.decided.find((d) => d.forkId === "F-VISIBILITY")).toMatchObject({ source: "default" });
  });

  test("F-INVENTORY applies to stock, not to the remainder of a payment", () => {
    const inv = FORKS.find((f) => f.id === "F-INVENTORY");
    const a = (constraints: string[]): Analysis => ({ ...forumAnalysis(), constraints });
    expect(inv?.applies(a(["Предоплата 50%, остаток — при готовности"]))).toBe(false);
    expect(inv?.applies(a(["Учитывать остатки товара"]))).toBe(true);
    expect(inv?.applies(a(["Вести учёт остатков"]))).toBe(true);
    expect(inv?.applies(a(["Товар на складе"]))).toBe(true);
  });

  test("horizontal segment takes only horizontal forks; nothing to ask → 0 forks", () => {
    const a: Analysis = {
      goals: ["Вести список заявок"],
      segment: "horizontal",
      skeleton: ["application"],
      roles: [{ name: "owner", label: "Владелец", access: "login", isStaff: true, evidence: "" }],
      entities: [{ name: "request", label: "Заявка", keyFields: ["title"], containsPii: false }],
      integrations: [],
      constraints: [],
      resolved: [{ forkId: "F-APPROVAL", optionId: "auto", evidence: "" }],
      unknowns: [],
      outOfScope: [],
      complexity: "small",
    };
    const sel = selectForks(a);
    expect(sel.asked).toEqual([]);
    expect(sel.decided.every((d) => FORKS.find((f) => f.id === d.forkId)?.group === "horizontal")).toBe(true);
  });
});

describe("estimation", () => {
  const card = () => cardDraftSchema.parse(fixtureLines()[2]?.response.toolCalls[0]?.args);

  test("tokens_expected formula on the forum card", () => {
    // E=8, F=53, S=4, W=3, I=4, R=7, A=8
    expect(tokensExpected(card())).toBe(
      110_000 + 18_000 * 8 + 1_000 * 53 + 20_000 * 4 + 12_000 * 3 + 20_000 * 4 + 5_000 * 7 + 5_000 * 8,
    );
  });

  test("T1 build route (glm-5.3): expected, range, cap, minutes", () => {
    const reg = createRegistry();
    expect(priceBlended(reg, "T1")).toBeCloseTo(0.8 * 162 + 0.2 * 510, 6);
    const est = estimateCard(card(), { orgPolicy: OPEN_POLICY });
    expect(est.tier).toBe("T1");
    const expected = Math.ceil((578_000 * (0.8 * 162 + 0.2 * 510)) / 1e6 / 5);
    expect(est.estimate.credits).toEqual({
      min: Math.ceil(0.6 * expected),
      expected,
      max: Math.ceil(1.6 * expected),
    });
    expect(est.cap.credits).toBe(Math.max(10, Math.ceil(2 * expected)));
    expect(est.estimate.minutes).toEqual({
      min: Math.ceil(578_000 / 60_000),
      max: Math.ceil(578_000 / 25_000),
    });
  });

  test("ruOnly / restricted org → T0 prices, still within the forum target [12, 35]", () => {
    for (const orgPolicy of [{ ruOnly: true, t1Restricted: false }, null]) {
      const est = estimateCard(card(), { orgPolicy });
      expect(est.tier).toBe("T0");
      expect(est.estimate.credits.expected).toBeGreaterThanOrEqual(12);
      expect(est.estimate.credits.expected).toBeLessThanOrEqual(35);
    }
  });

  test("change mini-card: cap = max(3, ceil(2·expected))", () => {
    const est = estimateCard({ data: [], screens: [{}] }, { orgPolicy: OPEN_POLICY, kind: "change" });
    expect(est.cap.credits).toBe(Math.max(3, Math.ceil(2 * est.estimate.credits.expected)));
  });
});
