// V3-03: the whole interview on recorded model answers through the fixture router (suite unit: the request key of
// every call must match the real prompt, so the dialog is reproducible to the byte). The lines are recorded from a
// scripted model by build-v2-fixtures.ts fixtureLine (profile interview_v3) and replayed by @wizard/llm createRouter
// in fixture mode; the search answers are the recorded exchanges of V3-05. Two dialogs: to the end with a button,
// «Решите за меня» and an own answer; and «Дальше решай сам» at the second question.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, createRouter, type RouteInput, type RouteOutput } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import {
  blockingGaps,
  createInterviewV3,
  type InterviewV3Result,
  newInterviewV3Session,
} from "../../src/interview-v3/index.js";
import { fixtureLine } from "../build-v2-fixtures.js";
import { recordedResearch } from "../research/helpers.js";
import {
  DENTAL_ANSWERS,
  DENTAL_SCRIPT,
  finish,
  PROMPTS,
  type ScriptStep,
  scriptedRoute,
  update,
} from "./helpers.js";

const llm = createRegistry({ buildDefaultTier: "T1" });
const ORG = { ruOnly: false, t1Restricted: false };

type Answer = { optionId?: string; delegate?: boolean; text?: string; finish?: boolean };

async function dialog(route: (i: RouteInput) => Promise<RouteOutput>, answers: readonly Answer[]) {
  let n = 0;
  const iv = createInterviewV3({
    route,
    orgPolicy: ORG,
    ctx: { orgId: "org" },
    research: recordedResearch().research,
    newId: () => `m${++n}`,
  });
  const turns: InterviewV3Result[] = [await iv.start(newInterviewV3Session(), { prompt: PROMPTS.dental })];
  for (const a of answers) {
    const last = turns.at(-1) as InterviewV3Result;
    const q = last.session.current;
    if (!q) throw new Error("no pending question");
    turns.push(await iv.answer(last.session, { questionId: q.id, ...a }));
  }
  return turns;
}

/** Records the scripted dialog as fixture lines, replays it through the fixture router; both runs must agree. */
async function recordAndReplay(name: string, script: readonly ScriptStep[], answers: readonly Answer[]) {
  const rec = scriptedRoute(script);
  const recorded = await dialog(rec.route, answers);
  const dir = mkdtempSync(join(tmpdir(), "wz-iv3-"));
  mkdirSync(join(dir, "unit"), { recursive: true });
  const lines = rec.recorded.map((r) => fixtureLine("interview_v3", r.messages, r.tools, r.calls));
  writeFileSync(join(dir, "unit", `${name}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const router = createRouter({
    mode: "fixture",
    fixture: { suite: "unit", name, dir },
    registry: llm,
    sink: { write: async () => {} },
    env: {},
  });
  const scrubbed: boolean[] = [];
  let milli = 0;
  const replayed = await dialog(async (input) => {
    const out = await router.route({ ...input, orgPolicy: ORG, ctx: { orgId: "org" } } as RouteInput);
    scrubbed.push(out.scrubbed);
    milli += out.creditsMilli;
    return out;
  }, answers);
  return { recorded, replayed, scrubbed, rub: (milli / 1000) * llm.rubPerCredit, lines };
}

describe("interview v3 on recorded answers (fixture router)", () => {
  test("the dental dialog to the end: 3 questions, brief ready, the same brief as recorded; everything to T1 scrubbed", async () => {
    const r = await recordAndReplay("interview-v3-dental", DENTAL_SCRIPT, DENTAL_ANSWERS);
    expect(r.lines.map((l) => l.callType)).toEqual(Array(5).fill("interview_v3"));
    const last = r.replayed.at(-1) as InterviewV3Result;
    expect(last.session.state).toBe("ready");
    expect(last.session.brief).toEqual((r.recorded.at(-1) as InterviewV3Result).session.brief);
    expect(r.replayed.map((t) => t.outputs.map((o) => o.kind))).toEqual([
      ["question"],
      ["question"],
      ["question"],
      ["brief"],
    ]);
    expect(blockingGaps(last.session.brief)).toEqual([]);
    expect(last.session.brief.qa.map((x) => x.chosen)).toEqual(["recommended", "delegated", "custom"]);
    expect(r.scrubbed).toEqual(Array(5).fill(true));
    expect(r.rub).toBeGreaterThan(0);
    console.info(`V3-03 интервью на записанных ответах (3 вопроса, 5 вызовов): ${r.rub.toFixed(2)} ₽`);
  });

  test("«Дальше решай сам» at the second question: the rest becomes explicit assumptions of the brief", async () => {
    const script: ScriptStep[] = [
      ...DENTAL_SCRIPT.slice(0, 3),
      [
        update({
          data: [
            {
              entity: "Записи",
              fields: [{ name: "Имя" }, { name: "Телефон" }, { name: "Время" }],
              retention: "пока нужны для работы",
            },
          ],
          assumptions: [{ text: "Записи хранятся, пока нужны для работы" }],
        }),
        finish,
      ],
    ];
    const r = await recordAndReplay("interview-v3-dental-skip", script, [
      { optionId: "o1" },
      { finish: true },
    ]);
    const last = r.replayed.at(-1) as InterviewV3Result;
    const done = last.outputs.find((o) => o.kind === "brief");
    expect(done?.kind === "brief" && done.reason).toBe("owner_skip");
    const b = last.session.brief;
    expect(blockingGaps(b)).toEqual([]);
    expect(b.qa.map((x) => x.chosen)).toEqual(["recommended", "delegated"]);
    expect(b.assumptions).toEqual([
      {
        text: "Какие данные пациента нужны для записи? — Имя и телефон (решили за вас)",
        source: "owner_skip",
      },
      { text: "Записи хранятся, пока нужны для работы", source: "owner_skip" },
      { text: "Роли и доступы: Я, администратор и сотрудники (решили за вас)", source: "owner_skip" },
    ]);
    expect(b.roles.map((x) => x.id)).toEqual(["owner", "admin", "staff"]);
    expect(last.session.asked).toBe(2);
    expect(b).toEqual((r.recorded.at(-1) as InterviewV3Result).session.brief);
  });
});
