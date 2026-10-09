// V3-03, platform part: the v3 pipeline (WIZARD_BUILD_PIPELINE=v3) end to end on a scripted interview_v3 model (no
// network, no money) with the real executors — the dental description → one question per turn (messages
// kind=questions with the step, the cap and the brief version; pending_questions with the reserved «Решите за меня»)
// → every turn a new brief version (author agent) → the owner's edit in the panel is kept by the next turn → the
// ready brief: a short text in the chat, no pending question, stage card (D7). «Остальное по рекомендациям» is
// «Дальше решай сам». The build queue and the monthly «не умею» share for /admin are read from the database.
import type { RouteInput, RouteOutput, Router, RouterOptions } from "@wizard/llm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  DENTAL_SCRIPT,
  finish,
  PROMPTS,
  question,
  type ScriptedAnswer,
  update,
} from "../../../packages/agents/test/interview-v3/helpers.js";
import { createAgentExecutors } from "../src/agents/executors.js";
import { capabilityShareByMonth, loadBuildQuestions } from "../src/agents/interview-v3-store.js";
import { listBriefVersions } from "../src/briefs/store.js";
import { buildPipelineOf } from "../src/config.js";
import { listEvents } from "../src/runs/events.js";
import { loadEventSchemas } from "./event-schemas.js";
import { createTestDb, startApi, type TestApi, waitRun } from "./helpers.js";

const schemas = loadEventSchemas();

/** Router answering interview_v3 calls from a queue of scripted answers (tool calls or text). */
function queuedRouter(queue: ScriptedAnswer[], calls: RouteInput[]): (opts: RouterOptions) => Router {
  return () => ({
    mode: "fixture",
    registry: {} as Router["registry"],
    async route(input: RouteInput): Promise<RouteOutput> {
      calls.push(input);
      const a = queue.shift() ?? "нет ответа";
      if (a instanceof Error) throw a;
      return {
        tier: "T1",
        model: "fixture",
        result: Array.isArray(a)
          ? {
              toolCalls: a.map((c, i) => ({
                id: `c${calls.length}_${i}`,
                name: c.name,
                args: c.args as Record<string, unknown>,
              })),
              finishReason: "tool-calls",
            }
          : { toolCalls: [], text: a, finishReason: "stop" },
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        creditsCharged: 0.01,
        creditsMilli: 10,
        routeReason: "default_T1",
        scrubbed: true,
        ruFallback: false,
      };
    },
  });
}

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
const calls: RouteInput[] = [];
// The dental dialog without its search turn (the platform test runs without web tools).
const queue: ScriptedAnswer[] = DENTAL_SCRIPT.slice(1) as ScriptedAnswer[];

beforeAll(async () => {
  tdb = await createTestDb("v3iv");
  api = await startApi(tdb.url, {
    config: { buildPipeline: "v3" },
    createRouter: queuedRouter(queue, calls),
    executors: (d) => createAgentExecutors({ pg: d.pg, config: d.config, research: null }),
  });
});

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

async function events(runId: string) {
  const list = await listEvents(api.deps.db, runId, 0);
  expect(list.map((e) => schemas.validate(e)).filter(Boolean)).toEqual([]);
  return list;
}

const system = async (id: string) => (await api.req("GET", `/systems/${id}`)).body;

describe("WIZARD_BUILD_PIPELINE=v3", () => {
  test("the flag (D78): v3 by default; modules and legacy only when named", () => {
    expect(buildPipelineOf("v3")).toBe("v3");
    expect(buildPipelineOf(" V3 ")).toBe("v3");
    expect(buildPipelineOf("modules")).toBe("modules");
    expect(buildPipelineOf(" Legacy ")).toBe("legacy");
    expect(buildPipelineOf("")).toBe("v3");
    expect(buildPipelineOf(undefined)).toBe("v3");
    expect(buildPipelineOf("v4")).toBe("v3");
  });
});

describe("v3 grill interview through the platform", () => {
  let systemId = "";

  test("description → the first question with the reserved «Решите за меня», brief version 1 by the agent", async () => {
    const r = await api.req("POST", "/systems", { body: { prompt: PROMPTS.dental } });
    expect(r.status).toBe(201);
    systemId = r.body.system.id;
    await waitRun(api, r.body.run.id, ["succeeded"]);
    const s = await system(systemId);
    expect(s.system.stage).toBe("interview");
    // The canvas screen (api.yaml knows legacy and modules; the executor state says v3).
    expect(s.pipeline).toBe("modules");
    expect(s.pendingQuestions).toHaveLength(1);
    const q = s.pendingQuestions[0];
    expect(q).toMatchObject({
      id: "q1",
      topic: "scenarios",
      step: 1,
      max: 15,
      allowDelegate: true,
      allowCustom: true,
    });
    expect(q.recommendation.length).toBeGreaterThan(0);
    expect(q.options.map((o: { id: string }) => o.id)).toEqual(["o1", "o2", "o3", "delegate"]);
    expect(q.options.at(-1)).toMatchObject({ label: "Решите за меня", recommended: false, delegate: true });
    expect(s.messages.at(-1)).toMatchObject({
      role: "assistant",
      kind: "questions",
      text: q.text,
      payload: { questionIds: ["q1"], interview: { step: 1, max: 15, topic: "scenarios", briefVersion: 1 } },
    });
    const brief = await api.req("GET", `/systems/${systemId}/brief`);
    expect(brief.body.brief).toMatchObject({ version: 1, author: "agent" });
    expect(brief.body.brief.brief.goals[0]).toMatchObject({ id: "fill_schedule" });
    expect(brief.body.diagrams.journey).toBeDefined();
    const ev = await events(r.body.run.id);
    expect(ev.find((e) => e.type === "chat_output")?.payload).toMatchObject({ kind: "questions" });
    expect(calls.map((c) => c.callType)).toEqual(["interview_v3"]);
  });

  test("a button, then «Решите за меня» (the reserved option): each answer — a new brief version with the journal", async () => {
    const a1 = await api.req("POST", `/systems/${systemId}/answers`, {
      body: { answers: [{ questionId: "q1", optionId: "o1" }] },
    });
    expect(a1.status).toBe(202);
    await waitRun(api, a1.body.run.id, ["succeeded"]);
    let s = await system(systemId);
    expect(s.pendingQuestions[0]).toMatchObject({ id: "q2", topic: "data", step: 2 });
    const a2 = await api.req("POST", `/systems/${systemId}/answers`, {
      body: { answers: [{ questionId: "q2", optionId: "delegate" }] },
    });
    await waitRun(api, a2.body.run.id, ["succeeded"]);
    s = await system(systemId);
    expect(s.pendingQuestions[0]).toMatchObject({ id: "q3", topic: "roles", step: 3 });
    // The owner's answers line in the chat says what was pressed.
    expect(s.messages.filter((m: { kind: string }) => m.kind === "answers").at(-1)?.text).toContain(
      "Решите за меня",
    );
    const versions = await listBriefVersions(api.deps.db, systemId);
    expect(versions.map((v) => [v.version, v.author])).toEqual([
      [3, "agent"],
      [2, "agent"],
      [1, "agent"],
    ]);
    const latest = (await api.req("GET", `/systems/${systemId}/brief`)).body.brief.brief;
    expect(latest.qa.map((x: { chosen: string }) => x.chosen)).toEqual(["recommended", "delegated"]);
    expect(latest.assumptions[0]).toMatchObject({ source: "default" });
  });

  test("the owner edits the brief in the panel; the next turn keeps the edit; the ready brief → short text, stage card", async () => {
    const cur = (await api.req("GET", `/systems/${systemId}/brief`)).body.brief;
    const edit = await api.req("PUT", `/systems/${systemId}/brief`, {
      body: { baseVersion: cur.version, brief: { ...cur.brief, audience: "Пациенты клиники и их родители" } },
    });
    expect(edit.status).toBe(200);
    expect(edit.body.brief).toMatchObject({ version: 4, author: "owner" });
    const a3 = await api.req("POST", `/systems/${systemId}/answers`, {
      body: {
        answers: [{ questionId: "q3", text: "Администратор и два врача, врачи видят только свои записи" }],
      },
    });
    await waitRun(api, a3.body.run.id, ["succeeded"]);
    const s = await system(systemId);
    expect(s.system.stage).toBe("card");
    expect(s.pendingQuestions).toEqual([]);
    const last = s.messages.at(-1);
    expect(last).toMatchObject({
      role: "assistant",
      kind: "text",
      payload: { interview: { ready: true, reason: "clear", briefVersion: 5 } },
    });
    expect(last.text).toContain("Бриф готов");
    expect(last.payload.interview.buildQuestions).toHaveLength(1);
    const latest = (await api.req("GET", `/systems/${systemId}/brief`)).body.brief;
    expect(latest).toMatchObject({ version: 5, author: "agent" });
    expect(latest.brief.audience).toBe("Пациенты клиники и их родители");
    expect(latest.brief.roles.map((r: { id: string }) => r.id)).toEqual(["owner", "admin", "doctor"]);
    expect(latest.brief.capability.map((c: { level: string }) => c.level)).toEqual(["modules", "modules"]);
    const ev = await events(a3.body.run.id);
    expect(ev.find((e) => e.type === "chat_output")?.payload).toMatchObject({ kind: "answer" });
    // The build queue and the /admin share are read from the database.
    expect(await loadBuildQuestions(api.deps.db, systemId)).toEqual([
      {
        topic: "content",
        text: "Какие услуги и цены показать на сайте?",
        assumption: "Покажем список услуг без цен",
      },
    ]);
    const month = new Date().toISOString().slice(0, 7);
    expect(await capabilityShareByMonth(api.deps.db)).toEqual([
      { month, briefs: 1, requirements: 2, notYet: 0, share: 0 },
    ]);
  });

  test("«Остальное по рекомендациям» is «Дальше решай сам»: the rest becomes owner_skip assumptions, stage card", async () => {
    queue.push(
      [
        update({ goals: [{ text: "Продавать чай с сайта", success: "Заказы приходят" }] }),
        question("scenarios", "Что покупатель делает на сайте?"),
      ],
      [
        update({
          scenarios: [
            {
              actor: "visitor",
              when: "покупатель смотрит каталог",
              // biome-ignore lint/suspicious/noThenProperty: scenario field of the brief (builder-v3.md §3 C1)
              then: ["показывает товары с ценами"],
              moduleHint: "catalog",
            },
            {
              actor: "visitor",
              when: "покупатель кладёт товар в корзину и оплачивает онлайн",
              // biome-ignore lint/suspicious/noThenProperty: scenario field of the brief (builder-v3.md §3 C1)
              then: ["оформляет заказ"],
            },
          ],
        }),
        finish,
      ],
    );
    const r = await api.req("POST", "/systems", { body: { prompt: PROMPTS.shop } });
    await waitRun(api, r.body.run.id, ["succeeded"]);
    const id = r.body.system.id;
    const a = await api.req("POST", `/systems/${id}/answers`, { body: { restByRecommendation: true } });
    expect(a.status).toBe(202);
    await waitRun(api, a.body.run.id, ["succeeded"]);
    const s = await system(id);
    expect(s.system.stage).toBe("card");
    expect(s.messages.at(-1).payload.interview).toMatchObject({ ready: true, reason: "owner_skip" });
    // The shop's cart and online payment: «пока не умею» → «Запросы на развитие» and the gap in the message.
    expect(s.messages.at(-1).payload.gaps.map((g: { category: string }) => g.category)).toEqual(["payments"]);
    const brief = (await api.req("GET", `/systems/${id}/brief`)).body.brief.brief;
    expect(brief.assumptions.length).toBeGreaterThanOrEqual(3);
    expect(brief.assumptions.every((x: { source: string }) => x.source === "owner_skip")).toBe(true);
    expect(brief.capability.map((c: { level: string }) => c.level)).toEqual(["modules", "not_yet"]);
    const requests = await api.deps
      .pg`select category from platform.development_requests where system_id = ${id}`;
    expect(requests.map((x) => x.category)).toEqual(["payments"]);
    const month = new Date().toISOString().slice(0, 7);
    expect(await capabilityShareByMonth(api.deps.db)).toEqual([
      { month, briefs: 2, requirements: 4, notYet: 1, share: 0.25 },
    ]);
  });
});
