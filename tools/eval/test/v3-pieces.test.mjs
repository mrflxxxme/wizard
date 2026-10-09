// V3-18: pieces of the v3 measurement driver and its report without a platform — the owner's answers to the grill
// interview, the coverage of the brief's expectations, the build trace from the v3_progress events, readiness, the
// report's numbers against D77_v3 (10)–(11); the driver against an in-memory client for the cases the end-to-end test
// does not reach: an org that is not on v3 (the measurement stops before more is spent), «Дальше решай сам» after
// rest_after answers, a refused ТЗ file and failed directions that do not stop the build.
import { describe, expect, test } from "vitest";
import { loadBriefs } from "../lib/briefs.mjs";
import {
  answerBody,
  briefCoverage,
  briefSummary,
  buildSummary,
  isReadyV3,
  newBuildTrace,
  newV3Result,
  runV3Eval,
  traceEvent,
  V3_FREE_TEXT,
  v3Answer,
} from "../server/v3.mjs";
import { criticOf, evaluateV3, renderV3Report, traceFromEvents } from "../server/v3-report.mjs";

const q = (topic, labels = ["Оставить заявку", "Выбрать время и записаться", "И то, и другое"]) => ({
  id: `q_${topic}`,
  topic,
  text: "Вопрос?",
  options: [
    ...labels.map((label, i) => ({ id: `o${i + 1}`, label, recommended: i === 0 })),
    { id: "delegate", label: "Решите за меня", recommended: false, delegate: true },
  ],
  allowDelegate: true,
  allowCustom: true,
});

describe("the owner's answers to the grill interview", () => {
  const brief = {
    answers: { scenarios: "время", data: "delegate", roles: { text: "Администратор и врачи" } },
    rest_after: 3,
  };
  test("a stem, «Решите за меня», an own text once per topic, the recommendation otherwise, «Дальше решай сам» after rest_after", () => {
    const st = { answered: 0, texts: new Set() };
    expect(v3Answer(q("scenarios"), brief, st)).toEqual({ kind: "option", optionId: "o2" });
    expect(v3Answer(q("data"), brief, st)).toEqual({ kind: "delegate", optionId: "delegate" });
    expect(v3Answer(q("roles"), brief, st)).toEqual({ kind: "text", text: "Администратор и врачи" });
    // A second question of the same topic: the text was given, now the recommendation.
    expect(v3Answer(q("roles"), brief, st)).toEqual({ kind: "recommended", optionId: "o1" });
    expect(v3Answer(q("goals"), brief, st)).toEqual({ kind: "recommended", optionId: "o1" });
    // A stem that names the recommended option counts as the recommendation; a stem that names nothing too.
    expect(v3Answer(q("scenarios"), { answers: { scenarios: "заявк" } })).toEqual({
      kind: "recommended",
      optionId: "o1",
    });
    expect(v3Answer(q("scenarios"), { answers: { scenarios: "корзин" } })).toEqual({
      kind: "recommended",
      optionId: "o1",
    });
    expect(v3Answer(q("goals"), brief, { answered: 3, texts: new Set() })).toEqual({
      kind: "rest",
      rest: true,
    });
    expect(v3Answer(q("goals"), {}, { answered: 6, texts: new Set() })).toEqual({ kind: "rest", rest: true });
    // A question without buttons: «Решите за меня», else a short text.
    expect(v3Answer({ id: "x", topic: "goals", options: [{ id: "delegate", delegate: true }] }, {})).toEqual({
      kind: "delegate",
      optionId: "delegate",
    });
    expect(v3Answer({ id: "x", topic: "goals", options: [] }, {})).toEqual({
      kind: "text",
      text: V3_FREE_TEXT,
    });
  });

  test("bodies of POST /systems/:id/answers", () => {
    const x = q("data");
    expect(answerBody(x, { rest: true })).toEqual({ restByRecommendation: true });
    expect(answerBody(x, { optionId: "delegate" })).toEqual({
      answers: [{ questionId: "q_data", optionId: "delegate" }],
    });
    expect(answerBody(x, { text: "Имя и телефон" })).toEqual({
      answers: [{ questionId: "q_data", text: "Имя и телефон" }],
    });
  });
});

describe("the brief: coverage of the expectations and the counts", () => {
  const sb = {
    goals: [{ id: "g", text: "Пациенты записываются сами", success: "без звонков" }],
    audience: "Пациенты",
    scenarios: [
      {
        id: "s1",
        actor: "client",
        when: "пациент выбирает врача и время",
        // biome-ignore lint/suspicious/noThenProperty: scenario field of the brief (builder-v3.md §3 C1)
        then: ["записывает"],
        priority: "must",
      },
      {
        id: "s2",
        actor: "system",
        when: "за день до приёма",
        // biome-ignore lint/suspicious/noThenProperty: scenario field of the brief (builder-v3.md §3 C1)
        then: ["напоминает пациенту"],
        priority: "should",
      },
    ],
    roles: [
      { id: "admin", name: "Администратор", can: [] },
      { id: "doctor", name: "Врач", can: ["видит только свои записи"] },
    ],
    data: [{ entity: "Записи", fields: [{ name: "Телефон", pii: true }], retention: "год" }],
    integrations: [],
    design: { references: [] },
    outOfScope: [],
    assumptions: [{ text: "Оплаты нет", source: "default" }],
    qa: [],
    capability: [
      { requirement: "запись", level: "modules" },
      { requirement: "1С", level: "not_yet" },
    ],
  };
  test("found and missing labels by part, the eval.yaml weights", () => {
    const [brief] = loadBriefs("v3-02-dental-booking");
    const c = briefCoverage(sb, brief.expected);
    expect(c.roles).toEqual({ total: 3, found: 2, missing: ["Пациент"] });
    expect(c.entities.found).toBe(1);
    // «свои запис» of the doctor's rights is the patient's cabinet stem: found.
    expect(c.features.missing).toEqual(["Перенос и отмена записи"]);
    // Acceptance in the scenarios, the goals and the roles' rights («только свои», «Администратор»).
    expect(c.acceptance).toMatchObject({ total: 2, found: 2 });
    expect(c.score).toBeCloseTo(0.2 * (2 / 3) + 0.3 * (1 / 3) + 0.3 * 0.75 + 0.2, 2);
  });
  test("counts of the system brief and the canaries it keeps", () => {
    expect(
      briefSummary({ version: 4, brief: { ...sb, audience: "Daniel Okoye-Varga" } }, [
        "Daniel Okoye-Varga",
        "@x",
      ]),
    ).toMatchObject({
      version: 4,
      scenarios: { must: 1, should: 1 },
      roles: 2,
      capability: { modules: 1, custom: 0, not_yet: 1 },
      canariesKept: 1,
    });
  });
});

/** Events of a v3 build as the platform writes them (workflows.yaml#events, v3_progress). */
function buildEvents(t0 = Date.parse("2026-10-09T10:00:00Z")) {
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const progress = (stage, preview, scenarios) => ({
    stage,
    stages: [],
    scenarios,
    spentRub: 120,
    reusedRub: 0,
    capRub: 500,
    elapsedSec: 0,
    capSec: 1800,
    remainingSec: 0,
    previewRevision: preview,
    checkpoints: { saved: 0, reused: 0 },
  });
  const sc = [
    { id: "s1", title: "Запись", priority: "must", status: "passed" },
    {
      id: "s2",
      title: "Напоминание",
      priority: "should",
      status: "stopped",
      reason: "не хватило бюджета сборки",
    },
  ];
  return [
    { seq: 1, type: "run_started", ts: at(0), payload: {} },
    {
      seq: 2,
      type: "build_stage",
      ts: at(1),
      payload: {
        stage: "skeleton",
        status: "started",
        label_ru: "Каркас",
        progress: progress("skeleton", null, []),
      },
    },
    {
      seq: 3,
      type: "build_stage",
      ts: at(150),
      payload: {
        stage: "skeleton",
        status: "done",
        label_ru: "Каркас",
        progress: progress("skeleton", 3, []),
      },
    },
    {
      seq: 4,
      type: "build_stage",
      ts: at(160),
      payload: { stage: "scenarios", status: "started", label_ru: "Сценарии" },
    },
    {
      seq: 5,
      type: "build_stage",
      ts: at(700),
      payload: {
        stage: "scenarios",
        status: "done",
        label_ru: "Сценарии",
        progress: progress("scenarios", 5, sc),
      },
    },
    {
      seq: 6,
      type: "build_stage",
      ts: at(701),
      payload: { stage: "critic", status: "skipped", label_ru: "Критик" },
    },
    { seq: 7, type: "run_finished", ts: at(900), payload: { status: "succeeded" } },
  ];
}

describe("the build trace from the v3_progress snapshots", () => {
  test("stage times, the first preview, the scenarios moved to «Запросы на развитие», the ₽ of the harness", () => {
    const t = newBuildTrace();
    const lines = buildEvents()
      .map((e) => traceEvent(t, e))
      .filter(Boolean);
    expect(lines).toEqual([
      "живое превью готово (ревизия 3)",
      "этап «Сценарии»: готов за 540 с",
      "этап «Критик»: пропущен",
    ]);
    const b = buildSummary(t, { id: "r1", status: "succeeded" });
    expect(b).toMatchObject({ minutes: 15, previewMinutes: 2.5, spentRub: 120, capRub: 500 });
    expect(b.stages.map((s) => [s.id, s.status, s.sec])).toEqual([
      ["skeleton", "done", 149],
      ["scenarios", "done", 540],
      ["critic", "skipped", 0],
    ]);
    expect(b.scenarios).toMatchObject({ total: 2, passed: 1, stopped: 1, toRequests: 1, mustNotPassed: 0 });
    expect(t.lastSeq).toBe(7);
    // The same from run_events of the database (collect), when the stream was not read.
    const db = traceFromEvents(
      buildEvents().map((e) => ({
        runId: "r1",
        seq: e.seq,
        ts: e.ts,
        type: e.type,
        stage: e.payload.stage ?? null,
        status: e.payload.status ?? null,
        label: e.payload.label_ru ?? null,
        preview: e.payload.progress?.previewRevision ?? null,
      })),
    );
    expect(db).toMatchObject({ minutes: 15, previewMinutes: 2.5 });
    expect(db.stages.map((s) => s.id)).toEqual(["skeleton", "scenarios", "critic"]);
  });

  test("readiness: the build, G0–G2, no techreview blocker, every «must» scenario passed", () => {
    const gates = {
      G0: { passed: true, blockers: [] },
      G1: { passed: true, blockers: [] },
      G2: { passed: false, blockers: [], ownerActions: [] },
    };
    const r = {
      build: { status: "succeeded", scenarios: { mustNotPassed: 0 } },
      gates,
      techreview: { blocked: false },
    };
    expect(isReadyV3(r, "publish")).toBe(true);
    expect(isReadyV3({ ...r, techreview: { blocked: true } }, "publish")).toBe(false);
    expect(
      isReadyV3({ ...r, build: { status: "succeeded", scenarios: { mustNotPassed: 1 } } }, "publish"),
    ).toBe(false);
    expect(isReadyV3({ ...r, build: { status: "failed", scenarios: { mustNotPassed: 0 } } }, "publish")).toBe(
      false,
    );
  });
});

describe("the report against D77_v3 (10)–(11)", () => {
  test("critic's note, the targets, the exact ₽ and the stages of build_metrics", () => {
    expect(criticOf("циклов 2, оценка 61→74, проверки 9→3, правок 5, 12 ₽, стоп target")).toEqual({
      cycles: 2,
      score: 74,
      scores: [61, 74],
    });
    expect(criticOf(null)).toEqual({ cycles: null, score: null, scores: [] });
    const mk = (id, minutes, preview, rub) => ({
      ...newV3Result({ id, title: id, class: "site" }),
      systemId: `sys-${id}`,
      status: "ready",
      ready: true,
      minutes,
      creditsUsed: rub / 5,
      costRubEstimate: rub,
      build: {
        status: "succeeded",
        minutes: minutes - 2,
        previewMinutes: preview,
        stages: [],
        scenarios: { total: 3, passed: 3, failed: 0, stopped: 0, toRequests: 0, mustNotPassed: 0, list: [] },
      },
      techreview: { status: "done", blocked: false },
      gates: { G0: { passed: true, blockers: [], ownerActions: [] } },
    });
    const doc = {
      kind: "v3",
      threshold: "v3",
      results: [mk("v3-01", 14, 3.5, 210), mk("v3-02", 33, 6, 520)],
      maxCostRub: 1400,
      concurrency: 2,
      startedAt: "2026-10-09T07:00:00Z",
    };
    const db = {
      costs: { "sys-v3-01": { rub: 205.5 } },
      metrics: {
        "sys-v3-01": {
          stages: {
            critic: { status: "done", costRub: 12, durationMs: 60000, note: "циклов 2, оценка 61→74" },
          },
        },
      },
      v3: {
        calls: {},
        hooks: {
          "sys-v3-01": {
            techreview: { status: "done", blockers: ["Права: врач видит чужие записи"], notes: [] },
          },
        },
        similarity: { "sys-v3-01": { similarity: 0.42 } },
        events: {},
        t1Forbidden: 0,
      },
      gaps: {},
    };
    const e = evaluateV3(doc, db);
    expect(e.items[0]).toMatchObject({
      costRub: 205.5,
      costExact: true,
      critic: { score: 74, cycles: 2 },
      template: { similarity: 0.42 },
    });
    expect(e.items[0].techreview).toMatchObject({
      verdict: "блокеры — без публикации",
      blockers: ["Права: врач видит чужие записи"],
    });
    expect(e.targets).toEqual({ preview: false, median: false, cap: false, avgRub: false, maxRub: false });
    expect(e).toMatchObject({
      maxPreviewMinutes: 6,
      medianMinutes: 23.5,
      maxMinutes: 33,
      avgRub: 362.75,
      maxRub: 520,
      costExact: false,
    });
    const { text } = renderV3Report(doc, db, { platform: "https://borntobuild.ru", date: "2026-10-09" });
    expect(text).toContain("превью — до 6 мин ❌ (цель ≤ 5)");
    expect(text).toContain("максимум 520 ₽ ❌ (потолок 500 ₽)");
    expect(text).toContain(
      "| v3-01 | сайт бизнеса | ✅ готова | 3.5 | 14 | 206 | 3/3 (0) | блокеры — без публикации | 74, циклов 2 | 42 % |",
    );
    expect(text).toContain("  - блокер: Права: врач видит чужие записи");
  });

  test("time from the ready brief (the interview apart) and the failed attempts of each call type", () => {
    const r = {
      ...newV3Result({ id: "v3-01", title: "v3-01", class: "site" }),
      systemId: "sys-1",
      status: "not_ready",
      minutes: 27,
      fromBriefMinutes: 16.5,
      interview: { questions: 3, turns: 4, minutes: 10.5 },
      costRubEstimate: 40,
      build: { status: "succeeded", minutes: 16.1, previewMinutes: 0.3, stages: [] },
      techreview: { status: "done", blocked: false },
    };
    const doc = { kind: "v3", threshold: "v3", results: [r], maxCostRub: 500, concurrency: 1 };
    const call = (o) => ({ tier: "T0", fallback: 0, scrubbed: false, rub: 0, inputTokens: 0, outputTokens: 0, ...o });
    const db = {
      costs: { "sys-1": { rub: 40.18 } },
      v3: {
        calls: {
          "sys-1": [
            call({ callType: "critic_visual", model: "kimi-k2.6", attempts: 1, ok: 0, failures: ["HTTP_4xx"], failureLatencyMs: 2000 }),
            call({ callType: "critic_visual", model: "qwen3.6-35b", attempts: 1, ok: 0, fallback: 1, failures: ["TIMEOUT"], failureLatencyMs: 180000 }),
            call({ callType: "techreview", model: "gpt-oss-120b", attempts: 3, ok: 1, rub: 0.1, failures: ["TIMEOUT", "TIMEOUT"], failureLatencyMs: 300000 }),
            call({ callType: "page_compose", model: "glm-5.3", tier: "T1", attempts: 7, ok: 7, rub: 9, latencyMs: 41_400 }),
          ],
        },
        hooks: {
          "sys-1": {
            critic: { status: "done", notes: ["Проверил сайт в браузере.", "Осталось поправить вручную: Контраст — / 390"] },
            techreview: { status: "done", blockers: [], notes: ["Мелкое: у формы нет подписи поля"] },
          },
        },
        similarity: {},
        events: {},
        t1Forbidden: 0,
      },
      gaps: {},
    };
    const e = evaluateV3(doc, db);
    expect(e).toMatchObject({ medianMinutes: 16.5, maxMinutes: 16.5, medianInterviewMinutes: 10.5 });
    expect(e.targets).toMatchObject({ median: true, cap: true });
    const { text } = renderV3Report(doc, db, { platform: "https://borntobuild.ru", date: "2026-10-09" });
    expect(text).toContain("интервью (время владельца, вне цели) — медиана 10.5 мин");
    expect(text).toContain("  - Осталось поправить вручную: Контраст — / 390");
    expect(text).toContain("  - Мелкое: у формы нет подписи поля");
    expect(text).toContain("| Тип вызова | Успешно из попыток | Модель | Уровень | ₽ | С на попытку | Отказы |");
    expect(text).toContain("| critic_visual | 0 из 2, резерв 1 | kimi-k2.6, qwen3.6-35b | T0 | 0 ₽ | — | kimi-k2.6: HTTP_4xx; qwen3.6-35b: TIMEOUT · ≈ 91 с |");
    expect(text).toContain("| techreview | 1 из 3 | gpt-oss-120b | T0 | 0,1 ₽ | — | gpt-oss-120b: TIMEOUT ×2 · ≈ 300 с |");
    expect(text).toContain("| page_compose | 7 из 7 | glm-5.3 | T1 | 9 ₽ | 41 | — |");
  });
});

/** In-memory client of a platform whose eval org is NOT on v3 (a goal interview of modules, no brief). */
function modulesClient() {
  const asked = [];
  const run = (status = "succeeded") => ({
    id: `run-${asked.length}`,
    kind: "interview_turn",
    status,
    credits: { used: 0.4 },
  });
  return {
    asked,
    base: "http://fake",
    async get(p) {
      asked.push(`GET ${p}`);
      if (p.endsWith("/brief")) return { status: 200, body: { brief: null, diagrams: null } };
      if (/^\/systems\/[^/]+$/.test(p))
        return {
          status: 200,
          body: {
            system: { stage: "interview" },
            pipeline: "modules",
            pendingQuestions: [{ id: "q1", options: [{ id: "a", label: "А", recommended: true }] }],
          },
        };
      if (p.startsWith("/runs/")) return { status: 200, body: run() };
      return { status: 200, body: { items: [] } };
    },
    async post(p, b) {
      asked.push(`POST ${p}`);
      if (p === "/systems") return { status: 201, body: { system: { id: "sys-1" }, run: run(), b } };
      return { status: 202, body: { run: run() } };
    },
    async upload() {
      throw new Error("not here");
    },
    async readEvents() {
      return [];
    },
  };
}

describe("the v3 driver on an in-memory platform", () => {
  test("an eval org that is not on v3: the brief stops after its first turn and the measurement with it", async () => {
    const client = modulesClient();
    const lines = [];
    const doc = await runV3Eval({
      client,
      briefs: loadBriefs("v3").slice(0, 3),
      orgId: "org",
      concurrency: 1,
      pollMs: 1,
      sleep: async () => {},
      log: (s) => lines.push(s),
    });
    expect(doc.results.map((r) => r.status)).toEqual(["interview_failed", "skipped", "skipped"]);
    expect(doc.results[0].error).toMatch(
      /не на конвейере v3: организация замера не включена в WIZARD_BUILD_PIPELINE_ORGS/,
    );
    expect(doc.stopped).toMatch(/WIZARD_BUILD_PIPELINE_ORGS/);
    // One system, one interview turn: nothing else was asked of the platform.
    expect(client.asked.filter((x) => x === "POST /systems")).toHaveLength(1);
    expect(client.asked.some((x) => x.includes("/answers"))).toBe(false);
  });

  test("«Дальше решай сам» after rest_after answers; a refused ТЗ and failed directions do not stop «Собрать»", async () => {
    let turn = 0;
    const posted = [];
    const run = (kind = "interview_turn") => ({
      id: `run-${kind}-${turn}`,
      kind,
      status: "succeeded",
      credits: { used: 0.2 },
    });
    const client = {
      base: "http://fake",
      async get(p) {
        if (p.endsWith("/brief"))
          return {
            status: 200,
            body: { brief: { version: 3 + turn, brief: { roles: [], data: [], scenarios: [] } } },
          };
        if (p.endsWith("/gates/latest")) return { status: 200, body: { reports: [] } };
        if (/^\/systems\/[^/]+$/.test(p))
          return turn < 4
            ? {
                status: 200,
                body: {
                  system: { stage: "interview" },
                  pipeline: "modules",
                  pendingQuestions: [q(["goals", "scenarios", "data", "roles"][turn])],
                },
              }
            : {
                status: 200,
                body: {
                  system: { stage: "card" },
                  pipeline: "modules",
                  pendingQuestions: [],
                  publishBlockers: [],
                },
              };
        if (p.startsWith("/runs/")) return { status: 200, body: run("build") };
        return { status: 200, body: { items: [] } };
      },
      async post(p, b) {
        posted.push([p, b]);
        if (p === "/systems") return { status: 201, body: { system: { id: "sys-2" }, run: run() } };
        if (p.endsWith("/answers")) {
          // «Дальше решай сам» finishes the interview (the agent writes the assumptions, the brief is ready).
          turn = b.restByRecommendation ? 4 : turn + 1;
          return { status: 202, body: { run: run() } };
        }
        if (p.endsWith("/directions"))
          throw Object.assign(new Error("POST /directions: 429 RATE_LIMITED"), { code: "RATE_LIMITED" });
        if (p.endsWith("/brief/approve"))
          return { status: 202, body: { run: { ...run("build"), status: "succeeded" }, capCredits: 100 } };
        return { status: 202, body: { run: run() } };
      },
      async upload() {
        throw new Error("POST /systems/sys-2/brief/upload: 415 UNSUPPORTED_MEDIA_TYPE");
      },
      async readEvents() {
        return [];
      },
    };
    const [crm] = loadBriefs("v3-03-cleaning-crm");
    const doc = await runV3Eval({
      client,
      briefs: [{ ...crm, rest_after: 2 }],
      orgId: "org",
      g2: "skip",
      pollMs: 1,
      sleep: async () => {},
      log: () => {},
    });
    const r = doc.results[0];
    expect(r.interview).toMatchObject({ questions: 3, restAt: 3 });
    const bodies = posted.filter(([p]) => p.endsWith("/answers")).map(([, b]) => b);
    expect(bodies.at(-1)).toEqual({ restByRecommendation: true });
    expect(r.tz).toMatchObject({ uploaded: false, format: "md" });
    expect(r.direction.error).toMatch(/RATE_LIMITED/);
    expect(posted.some(([p, b]) => p.endsWith("/brief/approve") && b.version >= 3)).toBe(true);
    expect(r.build.status).toBe("succeeded");
  });
});
