// M1-09 (agents/qa.yaml#seed.rules MAY): qa_generate may attach seed hints to a scenario — plausible non-personal
// values for pii=none fields that G1's generateSeed puts into rows of the shared seed. Invalid hints (pii fields,
// values outside the field, look-alike personal data) go back to the model in the single repeat.
// G1-RENDER-01 failures are explained deterministically as a code fix of the page file.
import { describe, expect, test } from "vitest";
import type { BuildCard } from "../src/builder/index.js";
import {
  classify,
  createQaAgent,
  GENERATE_SYSTEM,
  memoryQaCache,
  submitChecksTool,
} from "../src/qa/index.js";
import { scriptedRoute, toolResult } from "./helpers.js";
import { goldenBuild } from "./qa-helpers.js";

describe("seed hints from qa_generate", async () => {
  const { spec, card } = await goldenBuild("forum");
  const one: BuildCard = { ...card, acceptance: card.acceptance.filter((a) => a.id === "AC3") };
  const base = {
    id: "SC-AC3",
    acId: "AC3",
    title: "Спикер видит свою заявку в потоке из seed",
    actors: { s1: { role: "speaker" } },
    steps: [
      { as: "s1" },
      {
        create: {
          entity: "speaker_application",
          data: { full_name: "Спикер 1", topic: "Тема", stream: "$seed.stream[0].id" },
          save: "a1",
        },
        consent: true,
      },
      { read: { entity: "speaker_application", id: "$a1.id" } },
      { expect: { status: "ok" } },
    ],
  };
  const hints = [
    { entity: "stream", field: "name", values: ["Ритейл-технологии", "Логистика"] },
    { entity: "stream", field: "capacity", values: [200] },
  ];

  test("valid hints stay on the scenario of the check and in the cache", async () => {
    const scripted = scriptedRoute([
      toolResult("submit_checks", { checks: [{ ...base, seedHints: hints }] }),
    ]);
    const cache = memoryQaCache();
    const qa = createQaAgent({ route: scripted.route, cache });
    const checks = await qa.generate({ card: one, spec, specVersion: 1 });
    expect(checks.find((c) => c.id === "SC-AC3")?.scenario?.seedHints).toEqual(hints);
    const again = await qa.generate({ card: one, spec, specVersion: 1 });
    expect(scripted.inputs).toHaveLength(1);
    expect(again.find((c) => c.id === "SC-AC3")?.scenario?.seedHints).toEqual(hints);
  });

  test("a hint on a pii field or with personal-looking values → one repeat with the errors", async () => {
    const bad = [
      { entity: "speaker_application", field: "full_name", values: ["Пётр Настоящий"] },
      { entity: "stream", field: "description", values: ["Пишите на boss@corp.ru"] },
    ];
    const scripted = scriptedRoute([
      toolResult("submit_checks", { checks: [{ ...base, seedHints: bad }] }),
      toolResult("submit_checks", { checks: [{ ...base, seedHints: hints }] }),
    ]);
    const checks = await createQaAgent({ route: scripted.route }).generate({
      card: one,
      spec,
      specVersion: 1,
    });
    expect(scripted.inputs).toHaveLength(2);
    const toolMsg = scripted.inputs[1]?.messages.find((m) => m.role === "tool");
    const issues = JSON.stringify(toolMsg?.content);
    expect(issues).toContain("seedHints speaker_application.full_name");
    expect(issues).toContain("SEED_PII");
    expect(issues).not.toContain("boss@corp.ru");
    expect(checks.find((c) => c.id === "SC-AC3")?.scenario?.seedHints).toEqual(hints);
  });

  test("more than 10 values per hint fail the tool schema", async () => {
    const many = [
      { entity: "stream", field: "name", values: Array.from({ length: 11 }, (_, i) => `Поток ${i}`) },
    ];
    const scripted = scriptedRoute([
      toolResult("submit_checks", { checks: [{ ...base, seedHints: many }] }),
      toolResult("submit_checks", { checks: [base] }),
    ]);
    const checks = await createQaAgent({ route: scripted.route }).generate({
      card: one,
      spec,
      specVersion: 1,
    });
    expect(scripted.inputs).toHaveLength(2);
    expect(JSON.stringify(scripted.inputs[1]?.messages.find((m) => m.role === "tool")?.content)).toContain(
      "seedHints",
    );
    expect(checks.find((c) => c.id === "SC-AC3")?.scenario?.seedHints).toBeUndefined();
  });

  test("the prompt explains seedHints; the tool schema offers them", () => {
    expect(GENERATE_SYSTEM).toContain("seedHints");
    expect(GENERATE_SYSTEM).toContain("values[i] попадёт в строку i");
    expect(JSON.stringify(submitChecksTool.definition.parameters)).toContain("seedHints");
  });
});

describe("G1-RENDER-01 explanations", async () => {
  const { spec } = await goldenBuild("forum");
  test("a page failure → function_error, code fix of the page file, owner builder; an environment error → qa", () => {
    const ctx = { spec, acs: [], checks: new Map(), invalid: new Map() };
    const fail = classify(
      {
        id: "G1-RENDER-01",
        status: "fail",
        severity: "blocker",
        message_ru: "Страница «Мой билет» (/ticket/:id) для роли participant падает при отрисовке",
        file: "ui/MyTicket.tsx",
        path: "/pages/2",
        evidence: "TypeError: Cannot read properties of undefined (reading 'status')",
        fixHint: "Исправьте ui/MyTicket.tsx: страница должна отрисовываться и пока данные загружаются",
      },
      ctx,
    );
    expect(fail).toMatchObject({
      category: "function_error",
      owner: "builder",
      fix: { kind: "code", target: "ui/MyTicket.tsx" },
    });
    expect(fail?.fix.suggestion).toContain("пока данные загружаются");
    const env = classify(
      {
        id: "G1-RENDER-01",
        status: "error",
        severity: "blocker",
        message_ru: "Не удалось проверить: превышено время G1 (120 с)",
      },
      ctx,
    );
    expect(env).toMatchObject({ category: "check_invalid", owner: "qa" });
  });
});
