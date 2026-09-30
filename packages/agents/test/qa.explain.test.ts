// agents/qa.yaml#explain: deterministic classification (no LLM), qa_explain for ambiguous failures, guardrails.
import type { Check, GateReport } from "@wizard/gates";
import { LlmError } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import { createQaAgent, type Explanation, guard } from "../src/qa/index.js";
import { scriptedRoute, toolResult } from "./helpers.js";
import { demoRouter, goldenBuild } from "./qa-helpers.js";

const { spec, card } = await goldenBuild("forum");
const idx = (role: string, entity: string) =>
  spec.permissions.findIndex((p) => p.role === role && p.entity === entity);

function report(checks: Partial<Check>[]): GateReport {
  const full = checks.map(
    (c) => ({ status: "fail", severity: "blocker", message_ru: "проверка", ...c }) as Check,
  );
  return {
    level: "G1",
    passed: false,
    specVersion: 1,
    startedAt: new Date(0).toISOString(),
    durationMs: 1,
    checks: [...full, { id: "G1-RENDER-01", status: "skip", severity: "blocker", message_ru: "позже" }],
    summary: { pass: 0, fail: full.length, warn: 0, skip: 1, error: 0 },
  };
}

/** QA agent that already generated the golden checks (no further LLM calls expected). */
async function agent(route = demoRouter("forum").route) {
  const qa = createQaAgent({ route: route as never });
  await qa.generate({ card, spec, specVersion: 1 });
  return qa;
}

describe("deterministic rules (no qa_explain call)", () => {
  test("a fixture with delete open for the participant → permission_too_broad, fix.kind ops", async () => {
    const card9 = {
      ...card,
      acceptance: [
        ...card.acceptance,
        {
          id: "AC9",
          text: "Участник не может удалить билет",
          check: {
            type: "permission" as const,
            role: "participant",
            entity: "ticket",
            op: "delete" as const,
            expect: "deny" as const,
          },
        },
      ],
    };
    const { route, calls } = demoRouter("forum");
    const qa = createQaAgent({ route });
    await qa.generate({ card: card9, spec, specVersion: 1 });
    const ex = await qa.explain({
      card: card9,
      spec,
      report: report([
        {
          id: "SC-AC9",
          acId: "AC9",
          message_ru: "Участник не должна удалять Билет, но система это разрешает",
          evidence: "delete: ожидался отказ 401/403, получено HTTP 200",
        },
      ]),
    });
    expect(ex).toEqual([
      expect.objectContaining({
        checkId: "SC-AC9",
        acId: "AC9",
        category: "permission_too_broad",
        fix: expect.objectContaining({ kind: "ops", target: `/permissions/${idx("participant", "ticket")}` }),
        owner: "builder",
      }),
    ]);
    expect(calls).toEqual(["qa_generate"]);
  });

  test("PC probes and scenario evidence map to the qa.yaml categories", async () => {
    const qa = await agent();
    const fnFile = spec.functions?.find((f) => f.name === "registerTicket")?.file;
    const ex = (await qa.explain({
      card,
      spec,
      report: report([
        { id: "PC-visitor-ticket-read", evidence: "read: ожидался отказ 401/403, получено HTTP 200" },
        { id: "SC-AC8", acId: "AC8", evidence: "update: ожидался успех, получено HTTP 403 FORBIDDEN" },
        { id: "PC-participant-ticket-row", evidence: "пользователь A, запись пользователя B: read HTTP 200" },
        { id: "SC-AC1", acId: "AC1", evidence: "шаг 5: ожидалось ok/created, получено HTTP 500 INTERNAL" },
        { id: "SC-AC3", acId: "AC3", evidence: "шаг 7: ожидалось status=not_found, получено HTTP 200" },
        {
          id: "SC-AC2",
          acId: "AC2",
          evidence: "шаг 4: ожидалось ok/created, получено HTTP 422 UNKNOWN_FIELD",
        },
        {
          id: "G1-FN-01",
          severity: "warning",
          file: "functions/partnerQuota.ts",
          evidence: "роль partner: HTTP 500",
        },
        { id: "G1-AC-COVER", path: "/acceptance/1", message_ru: "Критерий AC2 не проверяется автоматически" },
        {
          id: "SC-AC4",
          acId: "AC4",
          status: "error",
          message_ru: "Не удалось проверить: нет запущенного runtime",
        },
      ]),
    })) as Explanation[];
    const got = Object.fromEntries(
      ex.map((e) => [e.checkId, [e.category, e.fix.kind, e.fix.target, e.owner]]),
    );
    expect(got).toEqual({
      // No visitor/ticket permission in the spec: the target is the permissions list.
      "PC-visitor-ticket-read": ["permission_too_broad", "ops", "/permissions", "builder"],
      "SC-AC8": [
        "permission_too_narrow",
        "ops",
        `/permissions/${idx("moderator", "speaker_application")}`,
        "builder",
      ],
      "PC-participant-ticket-row": [
        "permission_too_broad",
        "ops",
        `/permissions/${idx("participant", "ticket")}`,
        "builder",
      ],
      "SC-AC1": ["function_error", "code", fnFile, "builder"],
      "SC-AC3": [
        "permission_too_broad",
        "ops",
        `/permissions/${idx("speaker", "speaker_application")}`,
        "builder",
      ],
      "SC-AC2": ["missing_entity_or_field", "ops", expect.stringMatching(/^\/entities\/\d+$/), "builder"],
      "G1-FN-01": ["function_error", "code", "functions/partnerQuota.ts", "builder"],
      "G1-AC-COVER": ["check_invalid", "none", "", "qa"],
      "SC-AC4": ["check_invalid", "none", "", "qa"],
    });
    expect(ex.find((e) => e.checkId === "G1-AC-COVER")?.acId).toBe("AC2");
    for (const e of ex) {
      expect(e.expected.length).toBeLessThanOrEqual(200);
      expect(e.actual.length).toBeLessThanOrEqual(300);
      expect(e.likelyCause.length).toBeLessThanOrEqual(300);
    }
  });
});

describe("qa_explain for ambiguous failures", () => {
  const ambiguous = report([
    { id: "SC-AC4", acId: "AC4", evidence: "шаг 12: ожидалось status=duplicate, получено status=ok" },
    { id: "PC-visitor-ticket-read", evidence: "read: ожидался отказ 401/403, получено HTTP 200" },
  ]);

  test("one call for the ambiguous ones only; the answer is validated and guarded", async () => {
    const fixture = demoRouter("forum");
    const scripted = scriptedRoute([
      toolResult("submit_explanations", {
        explanations: [
          {
            checkId: "SC-AC4",
            category: "wrong_status_flow",
            expected: "второй проход по билету отклоняется",
            actual: "второй проход принят",
            likelyCause: "checkin не проверяет, что билет уже использован, звонить user1@example.test",
            fix: { kind: "code", target: "functions/checkin.ts", suggestion: "Проверять статус used" },
            owner: "builder",
          },
          { checkId: "SC-AC1", category: "nonsense" },
        ],
      }),
    ]);
    let n = 0;
    const qa = await agent(((i: never) => (n++ === 0 ? fixture.route(i) : scripted.route(i))) as never);
    const ex = await qa.explain({ card, spec, report: ambiguous });
    expect(scripted.inputs).toHaveLength(1);
    const input = scripted.inputs[0];
    expect(input?.callType).toBe("qa_explain");
    expect(input?.tools?.map((t) => t.name)).toEqual(["submit_explanations"]);
    const user = input?.messages[1]?.content as string;
    expect(user).toContain("SC-AC4");
    expect(user).not.toContain("PC-visitor-ticket-read");
    expect(ex.map((e) => e.checkId)).toEqual(["SC-AC4", "PC-visitor-ticket-read"]);
    expect(ex[0]).toMatchObject({ acId: "AC4", category: "wrong_status_flow", fix: { kind: "code" } });
    expect(ex[0]?.likelyCause).not.toContain("user1@example.test");
  });

  test("LLM failure → a generic explanation instead of an exception; BUDGET_EXCEEDED propagates", async () => {
    const fixture = demoRouter("forum");
    const fail = (e: Error) => {
      let n = 0;
      return ((i: never) => (n++ === 0 ? fixture.route(i) : Promise.reject(e))) as never;
    };
    const qa = await agent(fail(new LlmError("LLM_UNAVAILABLE", "down")));
    const ex = await qa.explain({ card, spec, report: ambiguous });
    expect(ex[0]).toMatchObject({ checkId: "SC-AC4", category: "wrong_status_flow", owner: "builder" });
    const fixture2 = demoRouter("forum");
    let m = 0;
    const qa2 = createQaAgent({
      route: ((i: never) =>
        m++ === 0 ? fixture2.route(i) : Promise.reject(new LlmError("BUDGET_EXCEEDED", "cap"))) as never,
    });
    await qa2.generate({ card, spec, specVersion: 1 });
    await expect(qa2.explain({ card, spec, report: ambiguous })).rejects.toThrow(LlmError);
  });
});

describe("guardrails", () => {
  const e: Explanation = {
    checkId: "SC-AC7",
    acId: "AC7",
    category: "permission_too_narrow",
    expected: "x",
    actual: "y",
    likelyCause: "z",
    fix: { kind: "ops", target: "/acceptance/6", suggestion: "Удалить критерий AC7" },
    owner: "builder",
  };
  test("never removes or weakens an AC: owner=qa, no fix", () => {
    expect(guard(e)).toMatchObject({ owner: "qa", fix: { kind: "none", target: "" } });
    expect(
      guard({ ...e, fix: { kind: "ops", target: "/permissions/1", suggestion: "ослабить критерий" } }),
    ).toMatchObject({ owner: "qa" });
  });
  test("check_invalid and seed_problem are owned by QA; lengths are clipped", () => {
    const long = "а".repeat(1000);
    const g = guard({ ...e, category: "seed_problem", expected: long, actual: long, likelyCause: long });
    expect(g.owner).toBe("qa");
    expect(g.expected.length).toBe(200);
    expect(g.actual.length).toBe(300);
  });
});
