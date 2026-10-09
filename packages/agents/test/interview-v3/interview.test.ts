// V3-03 acceptance 1, 2, 4 on a scripted interview_v3 model (no network): questions one at a time along the tree, each
// with a recommended answer and why, 3–5 buttons, «Решите за меня» and an own answer; the stop rule by code (no
// blocking gap, the cap of 15); «Дальше решай сам» at any moment → the rest as explicit assumptions; facts about the
// niche by the recorded web search within the interview limit; non-blocking questions to the build queue.
import { emptyBrief, validateBrief } from "@wizard/appspec";
import { LlmError } from "@wizard/llm";
import { describe, expect, test, vi } from "vitest";
import {
  adoptStoredBrief,
  blockingGaps,
  createInterviewV3,
  INTERVIEW_RESEARCH_LIMITS,
  type InterviewV3Output,
  type InterviewV3Session,
  MAX_V3_QUESTIONS,
  newInterviewV3Session,
  questionOrderIssues,
  stopReason,
  V3_TOPICS,
} from "../../src/interview-v3/index.js";
import { recordedResearch } from "../research/helpers.js";
import {
  DENTAL_ANSWERS,
  DENTAL_SCRIPT,
  finish,
  PROMPTS,
  question,
  type ScriptStep,
  scriptedRoute,
  toolNames,
  update,
} from "./helpers.js";

const ORG = { ruOnly: false, t1Restricted: false };

function setup(script: readonly ScriptStep[], o: { research?: boolean } = {}) {
  const r = scriptedRoute(script);
  const emit = vi.fn(async () => {});
  const requests: { category: string; quote: string; offered: string | null }[] = [];
  let n = 0;
  const research = o.research === false ? null : recordedResearch().research;
  const iv = createInterviewV3({
    route: r.route,
    orgPolicy: ORG,
    ctx: { orgId: "org" },
    research,
    emit,
    newId: () => `m${++n}`,
    recordDevelopmentRequest: async (x) => {
      requests.push(x);
    },
  });
  return { iv, emit, requests, ...r };
}

const main = (outs: InterviewV3Output[]) => outs.find((o) => o.kind !== "notice");
const questionOf = (outs: InterviewV3Output[]) => {
  const m = main(outs);
  if (m?.kind !== "question") throw new Error(`no question: ${JSON.stringify(outs)}`);
  return m.question;
};

describe("the dental dialog on a scripted model", () => {
  test("questions one at a time along the tree, each with a recommendation and why, 3–5 buttons, delegate and own answer; the brief fills as it goes", async () => {
    const { iv, inputs, emit } = setup(DENTAL_SCRIPT);
    let res = await iv.start(newInterviewV3Session(), { prompt: PROMPTS.dental });
    const asked: string[] = [];
    for (const a of DENTAL_ANSWERS) {
      const q = questionOf(res.outputs);
      asked.push(q.topic);
      expect(q.options.length).toBeGreaterThanOrEqual(3);
      expect(q.options.length).toBeLessThanOrEqual(5);
      expect(q.options.filter((o) => o.recommended)).toHaveLength(1);
      expect(q.recommendation.length).toBeGreaterThan(0);
      expect(q.whyItMatters.length).toBeGreaterThan(0);
      expect(q).toMatchObject({ allowDelegate: true, allowCustom: true, max: MAX_V3_QUESTIONS });
      expect(q.step).toBe(asked.length);
      expect(res.session.state).toBe("asking");
      res = await iv.answer(res.session, { questionId: q.id, ...a });
    }
    // Tree order: scenarios → data → roles (the goals came from the description, not asked again).
    expect(asked).toEqual(["scenarios", "data", "roles"]);
    expect(asked.map((t) => V3_TOPICS.indexOf(t as never))).toEqual([2, 3, 4]);
    const done = main(res.outputs);
    expect(done?.kind).toBe("brief");
    if (done?.kind !== "brief") return;
    expect(done.reason).toBe("clear");
    const b = res.session.brief;
    expect(validateBrief(b).ok).toBe(true);
    expect(blockingGaps(b)).toEqual([]);
    expect(b.goals.map((g) => g.id)).toEqual(["fill_schedule"]);
    expect(b.scenarios.map((s) => [s.id, s.moduleHint, s.priority])).toEqual([
      ["s1", "booking", "must"],
      ["s2", "notify", "must"],
    ]);
    expect(b.roles.map((r) => r.id)).toEqual(["owner", "admin", "doctor"]);
    expect(b.data[0]?.fields.filter((f) => f.pii).map((f) => f.name)).toEqual(["Имя", "Телефон"]);
    // The journal: the recommended button, «Решите за меня» (with its assumption), an own answer.
    expect(b.qa.map((x) => x.chosen)).toEqual(["recommended", "delegated", "custom"]);
    expect(b.qa[1]).toMatchObject({ a: "Имя и телефон", recommended: "Имя и телефон" });
    expect(b.assumptions).toEqual([
      { text: "Какие данные пациента нужны для записи? — Имя и телефон (решили за вас)", source: "default" },
      { text: "Покажем список услуг без цен (уточним во время сборки)", source: "default" },
    ]);
    // Non-blocking questions → the build queue.
    expect(done.deferred).toEqual([
      {
        topic: "content",
        text: "Какие услуги и цены показать на сайте?",
        assumption: "Покажем список услуг без цен",
      },
    ]);
    expect(b.capability.map((c) => c.level)).toEqual(["modules", "modules"]);
    expect(done.text).toContain("Бриф готов");
    expect(done.text).toContain("на проверенных модулях — 2");
    // One search of the recorded answers, its fact kept with the source.
    expect(res.session.research).toEqual({ searches: 1, pages: 0 });
    expect(res.session.facts[0]?.url).toBe("https://klinika-kazan.example/uslugi");
    expect(inputs.map((i) => i.callType)).toEqual(Array(5).fill("interview_v3"));
    expect(res.session.llmCalls).toBe(5);
    expect(emit).not.toHaveBeenCalled();
    // The answer of the turn reaches the model with how it was chosen.
    expect(inputs[3]?.messages.at(-1)?.content).toContain("«Решите за меня»");
  });

  test("the prompt carries the tree, the gaps found by code and the research limit; web_search only while the limit lasts", async () => {
    const { iv, inputs } = setup(DENTAL_SCRIPT);
    await iv.start(newInterviewV3Session(), { prompt: PROMPTS.dental });
    const [system, user] = inputs[0]?.messages ?? [];
    expect(system?.content).toContain("Цели (goals) → Аудитория (audience) → Сценарии (scenarios)");
    expect(system?.content).toContain(`${INTERVIEW_RESEARCH_LIMITS.searches} поиска`);
    // One model call per turn where possible: the brief update and the next question in the same answer.
    expect(system?.content).toContain("submit_brief_update, затем submit_question или finish_interview");
    expect(user?.content).toContain("## Блокирующие пробелы (проверка кодом)");
    expect(user?.content).toContain("Цели (goals): Не ясно, зачем бизнесу система");
    expect(toolNames(inputs[0] as never)).toEqual([
      "submit_brief_update",
      "defer_question",
      "finish_interview",
      "submit_question",
      "web_search",
      "read_page",
    ]);
  });
});

describe("«Решите за меня» and «Дальше решай сам»", () => {
  test("«Дальше решай сам» at the first question: the model decides the rest, the code fills what is left; all owner_skip", async () => {
    const { iv, inputs } = setup([
      [
        update({ goals: [{ text: "Клиенты записываются сами", success: "Расписание заполнено" }] }),
        question("scenarios", "Что клиент делает сам?"),
      ],
      // skip turn: the model writes scenarios and one decision; roles and data stay for the code.
      [
        update({
          scenarios: [
            {
              actor: "client",
              when: "клиент выбирает время",
              // biome-ignore lint/suspicious/noThenProperty: scenario field of the brief (builder-v3.md §3 C1)
              then: ["записывает клиента"],
              moduleHint: "booking",
            },
          ],
          assumptions: [{ text: "Запись только онлайн, без звонков" }],
        }),
        finish,
      ],
    ]);
    const s1 = await iv.start(newInterviewV3Session(), { prompt: PROMPTS.booking });
    const q = questionOf(s1.outputs);
    const res = await iv.answer(s1.session, { questionId: q.id, finish: true });
    const done = main(res.outputs);
    expect(done?.kind).toBe("brief");
    if (done?.kind !== "brief") return;
    expect(done.reason).toBe("owner_skip");
    // No question was offered on the skip turn.
    expect(toolNames(inputs[1] as never)).not.toContain("submit_question");
    expect(inputs[1]?.messages.at(-1)?.content).toContain("«Дальше решай сам»");
    const b = res.session.brief;
    expect(blockingGaps(b)).toEqual([]);
    expect(b.qa).toEqual([
      {
        q: "Что клиент делает сам?",
        a: "Первый вариант",
        recommended: "Первый вариант",
        chosen: "delegated",
      },
    ]);
    expect(b.assumptions.map((a) => a.source)).toEqual([
      "owner_skip",
      "owner_skip",
      "owner_skip",
      "owner_skip",
    ]);
    expect(b.assumptions.map((a) => a.text)).toEqual([
      "Что клиент делает сам? — Первый вариант (решили за вас)",
      "Запись только онлайн, без звонков",
      expect.stringMatching(/^Данные: Только нужное: Записи/),
      expect.stringMatching(/^Роли и доступы: Я и сотрудники, каждый видит своё \(решили за вас\)$/),
    ]);
    expect(res.session.state).toBe("ready");
    expect(res.session.asked).toBe(1);
  });

  test("«Дальше решай сам» with a model that does not answer: everything blocking becomes assumptions by code", async () => {
    const { iv, emit } = setup([[question("goals", "Что главное?")], "не знаю"]);
    const s1 = await iv.start(newInterviewV3Session(), { prompt: PROMPTS.site });
    const q = questionOf(s1.outputs);
    const res = await iv.answer(s1.session, { questionId: q.id, finish: true });
    expect(main(res.outputs)?.kind).toBe("brief");
    const b = res.session.brief;
    expect(validateBrief(b).ok).toBe(true);
    expect(blockingGaps(b)).toEqual([]);
    expect(b.goals.length).toBeGreaterThan(0);
    expect(b.assumptions.length).toBeGreaterThanOrEqual(3);
    expect(b.assumptions.every((a) => a.source === "owner_skip")).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      "orch_invalid",
      expect.objectContaining({ step: "interview", fallback: "questions" }),
    );
  });

  test("«Решите за меня» by the reserved option id works like delegate: the recommended answer and an assumption", async () => {
    const { iv } = setup([
      [question("goals", "Что главное для бизнеса?", ["Заявки", "Запись", "Каталог"])],
      [
        update({ goals: [{ text: "Получать заявки", success: "Заявки не теряются" }] }),
        question("scenarios", "Что важнее?"),
      ],
    ]);
    const s1 = await iv.start(newInterviewV3Session(), { prompt: PROMPTS.site });
    const res = await iv.answer(s1.session, { questionId: "q1", optionId: "delegate" });
    expect(res.session.brief.qa[0]).toMatchObject({ a: "Заявки", chosen: "delegated" });
    expect(res.session.brief.assumptions[0]).toEqual({
      text: "Что главное для бизнеса? — Заявки (решили за вас)",
      source: "default",
    });
    expect(questionOf(res.outputs).id).toBe("q2");
  });
});

describe("the stop rule by code", () => {
  test("pure rules: gaps in tree order, the tree goes forward, stop on clear or at the cap", () => {
    expect(blockingGaps(emptyBriefOf()).map((g) => g.topic)).toEqual(["goals", "scenarios", "roles"]);
    const gaps = blockingGaps(emptyBriefOf());
    expect(questionOrderIssues("goals", { gaps, lastTopic: null })).toEqual([]);
    expect(questionOrderIssues("data", { gaps, lastTopic: null })[0]?.code).toBe("TREE_ORDER");
    expect(questionOrderIssues("audience", { gaps: [], lastTopic: "roles" })[0]?.code).toBe("TREE_ORDER");
    expect(questionOrderIssues("integrations", { gaps: [], lastTopic: "roles" })).toEqual([]);
    expect(stopReason({ gaps: [], asked: 3, modelFinished: true })).toBe("clear");
    expect(stopReason({ gaps, asked: 3, modelFinished: true })).toBeNull();
    expect(stopReason({ gaps: [], asked: 3, modelFinished: false })).toBeNull();
    expect(stopReason({ gaps, asked: MAX_V3_QUESTIONS, modelFinished: false })).toBe("cap");
  });

  test("the model may not finish over a blocking gap nor skip a topic: the tool says why and it asks in order", async () => {
    const { iv, inputs } = setup([
      [finish],
      [question("roles", "Кто работает в системе?")],
      [question("goals", "Что главное для бизнеса?")],
    ]);
    const res = await iv.start(newInterviewV3Session(), { prompt: PROMPTS.crm });
    expect(questionOf(res.outputs)).toMatchObject({ id: "q1", topic: "goals" });
    const results = inputs[2]?.messages
      .filter((m) => m.role === "tool")
      .map((m) => JSON.stringify(m.content));
    expect(results?.[0]).toContain("BLOCKING_GAPS");
    expect(results?.[1]).toContain("TREE_ORDER");
  });

  test("cap: never more than 15 questions — the 15th answer ends the interview, the rest by assumptions", async () => {
    const { iv, inputs } = setup([
      (input) =>
        toolNames(input).includes("submit_question") ? [question("goals", "Ещё вопрос о целях?")] : "нет",
    ]);
    let res = await iv.start(newInterviewV3Session(), { prompt: PROMPTS.site });
    let count = 0;
    for (let i = 0; i < 20 && res.session.state === "asking"; i++) {
      const q = questionOf(res.outputs);
      count += 1;
      expect(q.step).toBe(count);
      res = await iv.answer(res.session, { questionId: q.id, optionId: "o2" });
    }
    expect(count).toBe(MAX_V3_QUESTIONS);
    expect(res.session.asked).toBe(MAX_V3_QUESTIONS);
    const done = main(res.outputs);
    expect(done?.kind === "brief" && done.reason).toBe("cap");
    // The cap turn offers no question; what is still blocking is filled by code as the agent's assumptions.
    expect(toolNames(inputs.at(-1) as never)).not.toContain("submit_question");
    expect(blockingGaps(res.session.brief)).toEqual([]);
    expect(res.session.brief.assumptions.every((a) => a.source === "default")).toBe(true);
    expect(res.session.brief.qa).toHaveLength(MAX_V3_QUESTIONS);
  });
});

describe("without a model (fallback) and failures", () => {
  test("a model that never calls the tools: deterministic questions of the blocking topics, answers applied by code", async () => {
    const { iv, emit } = setup(["Не знаю, что ответить."], { research: false });
    let res = await iv.start(newInterviewV3Session(), { prompt: PROMPTS.dental });
    const topics: string[] = [];
    for (let i = 0; i < 6 && res.session.state === "asking"; i++) {
      const q = questionOf(res.outputs);
      topics.push(q.topic);
      expect(q.options.length).toBeGreaterThanOrEqual(3);
      expect(q.options.filter((o) => o.recommended)).toHaveLength(1);
      const rec = q.options.find((o) => o.recommended);
      res = await iv.answer(res.session, { questionId: q.id, optionId: rec?.id as string });
    }
    expect(topics).toEqual(["goals", "scenarios", "data", "roles"]);
    expect(main(res.outputs)?.kind).toBe("brief");
    const b = res.session.brief;
    expect(validateBrief(b).ok).toBe(true);
    expect(b.goals.map((g) => g.id)).toEqual(["fill_schedule"]);
    expect(b.scenarios[0]).toMatchObject({
      moduleHint: "booking",
      goalId: "fill_schedule",
      priority: "must",
    });
    expect(b.data.map((d) => d.entity)).toEqual(["Записи"]);
    // «администратор» and «врачам» in the description → the recommended roles.
    expect(b.roles.map((r) => r.id)).toEqual(["owner", "admin", "staff"]);
    expect(emit).toHaveBeenCalledWith("orch_invalid", expect.objectContaining({ fallback: "questions" }));
  });

  test("an own answer the model cannot apply: the topic's default as an assumption, then the gap it opens is asked", async () => {
    const { iv } = setup(["нет"], { research: false });
    let res = await iv.start(newInterviewV3Session(), { prompt: PROMPTS.dental });
    const q1 = questionOf(res.outputs);
    expect(q1.topic).toBe("goals");
    res = await iv.answer(res.session, { questionId: q1.id, optionId: q1.options[0]?.id as string });
    expect(questionOf(res.outputs).topic).toBe("scenarios");
    res = await iv.answer(res.session, { questionId: "q2", text: "Пациент сам выбирает врача" });
    // Scenarios closed by the default (an explicit assumption); its booking needs data → the data question.
    expect(questionOf(res.outputs).topic).toBe("data");
    expect(res.session.brief.scenarios).toHaveLength(1);
    expect(res.session.brief.qa.at(-1)).toMatchObject({ a: "Пациент сам выбирает врача", chosen: "custom" });
    expect(res.session.brief.assumptions.at(-1)?.text).toMatch(/^Сценарии: .+ \(решили за вас\)$/);
  });

  test("models unavailable: the turn fails retryably and the session stays as it was", async () => {
    const { iv } = setup([new LlmError("LLM_UNAVAILABLE", "нет моделей")]);
    const s0 = newInterviewV3Session();
    const res = await iv.start(s0, { prompt: PROMPTS.site });
    expect(res.failure).toMatchObject({ code: "LLM_UNAVAILABLE", retryable: true });
    expect(res.session).toBe(s0);
  });
});

describe("research, personal data, development requests, owner edits, wishes", () => {
  test("web_search within the interview limit on recorded answers; the fourth search is refused without a request", async () => {
    const queries = [
      "стоматология Казань услуги",
      "клиника отзывы",
      "абвгд несуществующий запрос",
      "стоматология цены",
    ];
    const { iv, inputs } = setup([
      ...queries.map((q) => [{ name: "web_search", args: { query: q } }]),
      [
        update({ goals: [{ text: "Запись онлайн", success: "Записи приходят" }] }),
        question("scenarios", "Что делает пациент?"),
      ],
    ]);
    const res = await iv.start(newInterviewV3Session(), { prompt: PROMPTS.dental });
    expect(res.session.research.searches).toBe(INTERVIEW_RESEARCH_LIMITS.searches);
    const results = (inputs[4]?.messages ?? [])
      .filter((m) => m.role === "tool")
      .map((m) => JSON.stringify(m.content));
    expect(results[0]).toContain("klinika-kazan.example");
    expect(results[3]).toContain("RESEARCH_LIMIT");
    // The next turn offers no web_search any more.
    const next = await iv.answer(res.session, { questionId: "q1", optionId: "o1" });
    expect(toolNames(inputs[5] as never)).not.toContain("web_search");
    expect(next.session.research.searches).toBe(3);
  });

  test("an own answer with a phone: the PII notice once, no phone in the brief or in the model's answer line", async () => {
    const { iv, inputs } = setup([
      [
        update({ goals: [{ text: "Запись онлайн", success: "Записи приходят" }] }),
        question("scenarios", "Кто записывает клиентов?"),
      ],
      [question("scenarios", "Что ещё важно?")],
    ]);
    const s1 = await iv.start(newInterviewV3Session(), { prompt: PROMPTS.booking });
    const res = await iv.answer(s1.session, {
      questionId: "q1",
      text: "Администратор, её телефон +7 917 123-45-67",
    });
    expect(res.outputs[0]).toMatchObject({ kind: "notice", payload: { type: "pii", categories: ["phone"] } });
    expect(JSON.stringify(res.session.brief)).not.toContain("123-45-67");
    expect(inputs[1]?.messages.at(-1)?.content).not.toContain("123-45-67");
  });

  test("shop: every «не умею» becomes one development request with a replacement and a gap for «Написать команде»", async () => {
    const { iv, requests } = setup([
      [
        update({
          goals: [{ text: "Продавать чай онлайн", success: "Заказы приходят с сайта" }],
          scenarios: [
            {
              actor: "visitor",
              when: "покупатель смотрит каталог",
              // biome-ignore lint/suspicious/noThenProperty: scenario field of the brief (builder-v3.md §3 C1)
              then: ["показывает товары с ценами"],
              moduleHint: "catalog",
            },
            // biome-ignore lint/suspicious/noThenProperty: scenario field of the brief (builder-v3.md §3 C1)
            { actor: "visitor", when: "покупатель кладёт товар в корзину", then: ["оформляет заказ"] },
          ],
          data: [
            {
              entity: "Товары",
              fields: [{ name: "Название" }, { name: "Цена" }],
              retention: "пока товар продаётся",
            },
          ],
          roles: [{ name: "Владелец", can: ["всё"] }],
          // V3-23: the cart and СДЭК are «Интернет-магазин»; Почта России and a mobile app are still not built.
          requirements: [{ text: "Доставка Почтой России" }, { text: "Мобильное приложение в App Store" }],
        }),
        finish,
      ],
    ]);
    const res = await iv.start(newInterviewV3Session(), { prompt: PROMPTS.shop });
    const done = main(res.outputs);
    expect(done?.kind).toBe("brief");
    expect(requests.map((r) => r.category)).toEqual(["integration", "mobile"]);
    expect(requests.every((r) => r.offered)).toBe(true);
    expect(done?.gaps?.map((g) => g.category)).toEqual(["integration", "mobile"]);
    expect(res.session.brief.capability.map((c) => c.level)).toEqual([
      "modules",
      "modules",
      "not_yet",
      "not_yet",
    ]);
    expect(done?.text).toContain("пока не умею — 2");
  });

  test("a newer stored brief (the owner edited the panel) replaces the session's copy; an older one does not", () => {
    const s = { ...newInterviewV3Session(), baseVersion: 2 } as InterviewV3Session;
    const edited = { ...emptyBriefOf(), audience: "Жители района" };
    expect(adoptStoredBrief(s, { version: 3, brief: edited })).toMatchObject({
      baseVersion: 3,
      brief: { audience: "Жители района" },
    });
    expect(adoptStoredBrief(s, { version: 2, brief: edited })).toBe(s);
    expect(adoptStoredBrief(s, null)).toBe(s);
  });

  test("a wish after the brief is ready: the model edits the brief and finishes again", async () => {
    const { iv } = setup([...DENTAL_SCRIPT, [update({ audience: "Пациенты и их родители" }), finish]]);
    let res = await iv.start(newInterviewV3Session(), { prompt: PROMPTS.dental });
    for (const a of DENTAL_ANSWERS)
      res = await iv.answer(res.session, { questionId: questionOf(res.outputs).id, ...a });
    expect(res.session.state).toBe("ready");
    const wish = await iv.say(res.session, "Добавь, что приходят и родители с детьми");
    expect(main(wish.outputs)?.kind).toBe("brief");
    expect(wish.session.brief.audience).toBe("Пациенты и их родители");
  });

  test("a chat message while a question waits is the own answer to it", async () => {
    const { iv } = setup([
      [
        update({ goals: [{ text: "Запись онлайн", success: "Записи приходят" }] }),
        question("scenarios", "Что делает клиент?"),
      ],
      [question("scenarios", "Что ещё?")],
    ]);
    const s1 = await iv.start(newInterviewV3Session(), { prompt: PROMPTS.booking });
    const res = await iv.say(s1.session, "Клиент сам выбирает мастера");
    expect(res.session.brief.qa[0]).toMatchObject({ a: "Клиент сам выбирает мастера", chosen: "custom" });
  });
});

function emptyBriefOf() {
  return emptyBrief();
}
