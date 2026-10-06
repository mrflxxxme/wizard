// agents/qa.yaml#checks: PC matrix and G1 selection, permission AC 1:1, qa_generate validation with one repeat,
// determinism cache, milestone rule, sub-path export and the generated assets.
import { readFileSync } from "node:fs";
import { g1Checks, type QaCheck, validateScenario } from "@wizard/gates";
import { describe, expect, test } from "vitest";
import type { BuildCard } from "../src/builder/index.js";
import {
  createQaAgent,
  functionArgs,
  memoryQaCache,
  qaDigest,
  qaValidateScenario,
  submitChecksTool,
} from "../src/qa/index.js";
import { REPO } from "./builder-helpers.js";
import { scriptedRoute, toolResult } from "./helpers.js";
import { demoRouter, goldenBuild } from "./qa-helpers.js";

const firstLine = (content: unknown) => String(content ?? "").split("\n")[0];
const byKind = (cs: QaCheck[], kind: QaCheck["kind"]) => cs.filter((c) => c.kind === kind);

describe("forum (golden fixture)", async () => {
  const { spec, card, files } = await goldenBuild("forum");

  test("PC matrix = |roles|×|entities|×4 + row/hidden/ro/consent; G1 selection per qa.yaml, the rest G2", async () => {
    const { route } = demoRouter("forum");
    const checks = await createQaAgent({ route }).generate({ card, spec, specVersion: 1 });
    const pc = checks.filter((c) => c.id.startsWith("PC-"));
    const matrix = pc.filter((c) => c.probe?.kind === "op");
    expect(matrix).toHaveLength(spec.roles.length * spec.entities.length * 4);
    expect(pc.length).toBeGreaterThan(matrix.length);
    const g1 = new Set(pc.filter((c) => c.level === "G1").map((c) => c.id));
    expect(g1.has("PC-visitor-ticket-read")).toBe(true); // AC7 + public role
    expect(g1.has("PC-moderator-speaker_application-update")).toBe(true); // AC8
    expect(g1.has("PC-organizer-ticket-delete")).toBe(false);
    expect([...g1].some((id) => id.endsWith("-row"))).toBe(true);
    for (const c of pc.filter((x) => x.level === "G2")) expect(c.role).not.toBe("visitor");
  });

  test("≥1 SC per scenario/constraint AC ≤ M0 (AC1–AC4), permission AC → SC 1:1, later milestones absent", async () => {
    const { route, calls } = demoRouter("forum");
    const checks = await createQaAgent({ route }).generate({ card, spec, specVersion: 1 });
    expect(calls).toEqual(["qa_generate"]);
    const sc = checks.filter((c) => c.id.startsWith("SC-"));
    expect(sc.map((c) => c.id).sort()).toEqual(["SC-AC1", "SC-AC2", "SC-AC3", "SC-AC4", "SC-AC7", "SC-AC8"]);
    for (const c of byKind(sc, "scenario")) {
      expect(c.scenario?.acId).toBe(c.acId);
      expect(validateScenario(spec, c.scenario as NonNullable<QaCheck["scenario"]>)).toEqual([]);
    }
    expect(sc.find((c) => c.id === "SC-AC7")).toMatchObject({
      kind: "permission",
      role: "visitor",
      entity: "ticket",
      probe: { kind: "op", op: "read", expect: "deny" },
    });
    // G1 runs the QA scenarios for the ACs without steps in the spec.
    const run = g1Checks(spec, checks).filter((c) => c.acId);
    expect(new Set(run.map((c) => c.acId))).toEqual(new Set(["AC1", "AC2", "AC3", "AC4", "AC7", "AC8"]));
  });

  test("repeated G1 without AC change does not call the LLM (cache by specVersion, AC id, sha256(text))", async () => {
    const { route, calls } = demoRouter("forum");
    const cache = memoryQaCache();
    const qa = createQaAgent({ route, cache });
    const first = await qa.generate({ card, spec, specVersion: 5 });
    const again = await qa.generate({ card, spec, specVersion: 5 });
    expect(again).toEqual(first);
    // A fresh agent over the same (persisted) cache: still no call.
    const other = await createQaAgent({ route, cache }).generate({ card, spec, specVersion: 5 });
    expect(other).toEqual(first);
    expect(calls).toEqual(["qa_generate"]);
    expect(cache.size()).toBe(4);
  });

  test("changed AC text → only that AC is regenerated", async () => {
    const cache = memoryQaCache();
    const { route } = demoRouter("forum");
    await createQaAgent({ route, cache }).generate({ card, spec, specVersion: 5 });
    const edited: BuildCard = {
      ...card,
      acceptance: card.acceptance.map((a) => (a.id === "AC2" ? { ...a, text: `${a.text}!` } : a)),
    };
    const scripted = scriptedRoute([toolResult("submit_checks", { checks: [goldenScenario("AC2")] })]);
    const checks = await createQaAgent({ route: scripted.route, cache }).generate({
      card: edited,
      spec,
      specVersion: 5,
    });
    expect(scripted.inputs).toHaveLength(1);
    expect(firstLine(scripted.inputs[0]?.messages[1]?.content)).toBe("Критерии для сценариев: AC2");
    expect(checks.filter((c) => c.acId === "AC2" && c.scenario)).toHaveLength(1);
  });

  test("the prompt carries the AC texts, the spec digest with function args and the DSL", async () => {
    const { route } = demoRouter("forum");
    const inputs: Parameters<typeof route>[0][] = [];
    await createQaAgent({
      route: (i) => {
        inputs.push(i);
        return route(i);
      },
    }).generate({ card, spec, specVersion: 1, files });
    const [sys, user] = inputs[0]?.messages ?? [];
    expect(sys?.content).toContain("# DSL сценариев");
    expect(user?.content).toContain("AC1 [scenario, роль participant, сущность ticket]: Билет нельзя купить");
    expect(user?.content).toContain("registerTicket mutation");
    expect(user?.content).toContain("holderEmail:email");
    expect(inputs[0]?.tools?.map((t) => t.name)).toEqual(["submit_checks"]);
    expect(inputs[0]?.toolChoice).toBe("required");
  });

  test("milestone M1 includes AC6 (constraint) into the request", async () => {
    const scripted = scriptedRoute([toolResult("submit_checks", { checks: [] })]);
    await createQaAgent({ route: scripted.route, milestone: "M1" })
      .generate({ card, spec, specVersion: 1 })
      .catch(() => {});
    expect(firstLine(scripted.inputs[0]?.messages[1]?.content)).toBe(
      "Критерии для сценариев: AC1, AC2, AC3, AC4, AC6",
    );
  });
});

/** A scenario of the golden forum qa_generate line. */
function goldenScenario(acId: string) {
  const line = readFileSync(`${REPO}tools/fixtures/demo/forum.jsonl`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (l) =>
        JSON.parse(l) as { callType: string; response: { toolCalls: { args: { checks: unknown[] } }[] } },
    )
    .find((l) => l.callType === "qa_generate");
  return line?.response.toolCalls[0]?.args.checks.find((c) => (c as { acId: string }).acId === acId);
}

describe("validation and the single repeat", async () => {
  const { spec, card } = await goldenBuild("forum");
  const one: BuildCard = { ...card, acceptance: card.acceptance.filter((a) => a.id === "AC3") };
  const good = {
    id: "SC-AC3",
    acId: "AC3",
    title: "Спикер не видит чужие заявки",
    actors: { s1: { role: "speaker" }, s2: { role: "speaker" } },
    steps: [
      { as: "s1" },
      {
        create: {
          entity: "speaker_application",
          data: { full_name: "Спикер 1", email: "user1@example.test", topic: "Тема", abstract: "Кейс" },
          save: "a1",
        },
        consent: true,
      },
      { as: "s2" },
      { read: { entity: "speaker_application", id: "$a1.id" } },
      { expect: { status: "not_found" } },
    ],
  };
  const noConsent = structuredClone(good);
  delete (noConsent.steps[1] as { consent?: true }).consent;

  test("invalid first answer → one repeat with the errors; the valid repeat is taken", async () => {
    const bad = { ...good, steps: [{ actors: { x: { role: "speaker" } } }, ...good.steps.slice(0, 4)] };
    const scripted = scriptedRoute([
      toolResult("submit_checks", { checks: [bad] }),
      toolResult("submit_checks", { checks: [good] }),
    ]);
    const checks = await createQaAgent({ route: scripted.route }).generate({
      card: one,
      spec,
      specVersion: 1,
    });
    expect(scripted.inputs).toHaveLength(2);
    const retry = scripted.inputs[1]?.messages ?? [];
    const toolMsg = retry.find((m) => m.role === "tool") as { content: { error: { issues: unknown[] } } };
    expect(JSON.stringify(toolMsg.content.error.issues)).toContain("actors");
    expect(retry.at(-1)?.content).toContain("AC3");
    expect(checks.find((c) => c.id === "SC-AC3")?.scenario?.steps).toEqual(good.steps);
  });

  test("invalid twice → check_invalid: G1 reports it as error, explain says owner=qa", async () => {
    const scripted = scriptedRoute([
      toolResult("submit_checks", { checks: [noConsent] }),
      toolResult("submit_checks", { checks: [{ ...good, steps: good.steps.slice(0, 4) }] }),
    ]);
    const qa = createQaAgent({ route: scripted.route });
    const checks = await qa.generate({ card: one, spec, specVersion: 1 });
    const sc = checks.find((c) => c.id === "SC-AC3");
    expect(sc?.scenario?.steps).toEqual([]);
    expect(validateScenario(spec, sc?.scenario as NonNullable<QaCheck["scenario"]>).length).toBeGreaterThan(
      0,
    );
    const ex = await qa.explain({
      card: one,
      spec,
      report: {
        level: "G1",
        passed: false,
        specVersion: 1,
        startedAt: new Date(0).toISOString(),
        durationMs: 1,
        checks: [
          {
            id: "SC-AC3",
            acId: "AC3",
            status: "error",
            severity: "blocker",
            message_ru: "Не удалось проверить автоматически: сценарий проверки составлен с ошибкой",
            evidence: "check_invalid: В сценарии должно быть от 1 до 40 шагов",
          },
        ],
        summary: { pass: 0, fail: 0, warn: 0, skip: 0, error: 1 },
      },
    });
    expect(ex[0]).toMatchObject({ category: "check_invalid", owner: "qa", fix: { kind: "none" } });
    expect(ex[0]?.actual).toContain("В сценарии нет ни одного expect");
    expect(scripted.inputs).toHaveLength(2);
    // The reasons ride on the check (the builder's metrics), and the failure is not cached.
    expect(sc?.invalid?.some((r) => r.includes("expect"))).toBe(true);
  });

  test("a failed generate is not cached: the next generate asks QA again and takes the valid answer", async () => {
    const cache = memoryQaCache();
    const scripted = scriptedRoute([
      toolResult("submit_checks", { checks: [noConsent] }),
      toolResult("submit_checks", { checks: [noConsent] }),
      toolResult("submit_checks", { checks: [good] }),
    ]);
    const qa = createQaAgent({ route: scripted.route, cache });
    const first = await qa.generate({ card: one, spec, specVersion: 1 });
    expect(first.find((c) => c.id === "SC-AC3")?.scenario?.steps).toEqual([]);
    expect(cache.size()).toBe(0);
    const second = await qa.generate({ card: one, spec, specVersion: 1 });
    expect(second.find((c) => c.id === "SC-AC3")?.scenario?.steps.length).toBeGreaterThan(0);
    expect(scripted.inputs).toHaveLength(3);
    expect(cache.size()).toBe(1);
  });

  test("QA rules on top of the DSL validation: consent for pii writes, ≥1 expect, constraint needs a negative branch", () => {
    const ac3 = one.acceptance[0] as BuildCard["acceptance"][number];
    expect(qaValidateScenario(spec, good as never, ac3)).toEqual([]);
    expect(qaValidateScenario(spec, noConsent as never, ac3).join()).toContain("без consent: true");
    const constraint = { ...ac3, check: { ...ac3.check, type: "constraint" as const } };
    expect(qaValidateScenario(spec, good as never, constraint)).toEqual([]);
    const positive = { ...good, steps: [...good.steps.slice(0, 4), { expect: { status: "ok" } }] };
    expect(qaValidateScenario(spec, positive as never, constraint).join()).toContain("негативная ветка");
    const wrongAc = { ...good, id: "SC-AC9", acId: "AC9" };
    expect(qaValidateScenario(spec, wrongAc as never, ac3).length).toBe(2);
  });
});

describe("package", () => {
  test("@wizard/agents/qa is a sub-path export", async () => {
    const pkg = JSON.parse(readFileSync(`${REPO}packages/agents/package.json`, "utf8")) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports["./qa"]).toBe("./src/qa/index.ts");
    const mod = (await import("@wizard/agents/qa")) as { createQaAgent: unknown };
    expect(mod.createQaAgent).toBe(createQaAgent);
  });

  test("assets/qa.json is fresh (node packages/agents/scripts/gen-qa-assets.mjs)", async () => {
    const gen = (await import(`${REPO}packages/agents/scripts/gen-qa-assets.mjs`)) as {
      buildAssets(): string;
      ASSET_PATH: string;
    };
    expect(JSON.parse(readFileSync(gen.ASSET_PATH, "utf8"))).toEqual(JSON.parse(gen.buildAssets()));
  });

  test("submit_checks schema is JSON Schema; digest helpers", async () => {
    expect(submitChecksTool.definition.parameters).toMatchObject({ type: "object" });
    expect(
      functionArgs(
        "export default query({ args: { a: v.id('x'), b: v.optional(v.string({ max: 3 })) }, handler })",
      ),
    ).toEqual(["a:id", "b?:string"]);
    const { spec } = await goldenBuild("bakery");
    expect(qaDigest(spec)).toContain("Сущности");
  });
});
