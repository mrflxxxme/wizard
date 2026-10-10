// @vitest-environment happy-dom
// @vitest-environment-options {"settings": {"disableIframePageLoading": true}}
// V3-18 (DOM, API doubles): the owner's journey on the v3 canvas. A published system opened again replays its build,
// not the publication (run reports name their kind), and without a build to replay shows its preview, never
// «Думаю над системой…»; before the build the main area says what will appear there; a failed interview turn says why,
// asks the question again and offers «Повторить»; an answer in own words is counted against its limit, a longer one is
// not sent and a refused one comes back to the composer; a question of the edit loop of a built system is asked (not
// hidden under the publication card) and the agent's reply stays above the card; checks that did not pass give the
// techreview's reasons and «Исправить»; the logo leads to the list of systems.
import { briefDiagrams, systemBriefSchema } from "@wizard/appspec";
import { act, type ComponentProps, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dentalBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import { type ApiClient, ApiError } from "../src/api/client.js";
import type { Message, Question, RunEvent, System, SystemView } from "../src/api/types.js";
import { PlatformProvider } from "../src/app/context.js";
import { Canvas } from "../src/screens/canvas/Canvas.js";
import { lastReportRun } from "../src/screens/v3/build/index.js";
import { V3PublishCard } from "../src/screens/v3/publish/index.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SYS = "66666666-6666-4666-8666-666666666666";
const ORG = "00000000-0000-0000-0000-000000000001";
const BUILD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PUBLISH = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TURN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const system = (over: Partial<System> = {}): System => ({
  id: SYS,
  orgId: ORG,
  slug: "dental",
  name: "Стоматология",
  stage: "ready",
  draftRevision: 7,
  previewRevision: 7,
  prodRevision: null,
  prodUrl: null,
  createdAt: "2026-10-09T10:00:00Z",
  ...over,
});
const sysView = (over: Partial<System> = {}, rest: Partial<SystemView> = {}): SystemView => ({
  system: system(over),
  messages: [],
  pendingQuestions: [],
  activeRunId: null,
  publishBlockers: [],
  ...rest,
});
const msg = (seq: number, o: Partial<Message>): Message => ({
  id: `m${seq}`,
  seq,
  role: "assistant",
  kind: "text",
  createdAt: "2026-10-09T10:00:00Z",
  ...o,
});
const report = (seq: number, runId: string, kind?: string): Message =>
  msg(seq, {
    kind: "run_report",
    runId,
    text: "Готово",
    payload: { runId, status: "succeeded", ...(kind ? { kind } : {}) },
  });
/** A pending question of the v3 interview (agents/interview-v3.ts platformQuestion). */
const QUESTION = {
  id: "q1",
  text: "Как клиенты записываются на приём?",
  options: [
    { id: "o1", label: "Онлайн на сайте", recommended: true },
    { id: "o2", label: "По телефону", recommended: false },
    { id: "delegate", label: "Решите за меня", recommended: false, delegate: true },
  ],
  recommendation: "Онлайн-запись снимает звонки с администратора.",
  max: 12,
  step: 2,
  allowCustom: true,
} as unknown as Question;
const ev = (runId: string, seq: number, type: string, payload: Record<string, unknown> = {}): RunEvent => ({
  runId,
  seq,
  ts: "2026-10-09T10:00:00Z",
  type,
  payload,
});

/** The replayed events of a finished build (an older one: no v3 snapshot). */
const BUILT = [
  ev(BUILD, 1, "run_started", { kind: "build" }),
  ev(BUILD, 2, "run_finished", { status: "succeeded", summary_ru: "Система собрана" }),
];

/** An EventSource the test drives: the canvas subscribes to a run, the test pushes its frames. */
class FakeEventSource {
  static all: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((m: MessageEvent) => void)[]>();
  readyState = 1;
  onmessage: ((m: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (m: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.readyState = 2;
  }
  push(e: RunEvent) {
    for (const fn of this.listeners.get(e.type) ?? []) fn({ data: JSON.stringify(e) } as MessageEvent);
  }
}
const sourceOf = (runId: string) => FakeEventSource.all.find((x) => x.url.includes(runId));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
beforeEach(() => {
  FakeEventSource.all = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
}
async function mount(api: Partial<ApiClient>, node: ReturnType<typeof h>): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      h(
        PlatformProvider,
        { api: { getOrgSettings: async () => ({}), ...api } as ApiClient } as ComponentProps<
          typeof PlatformProvider
        >,
        node,
      ),
    ),
  );
  await flush();
}
const $ = (id: string) => container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const click = async (id: string) => {
  await act(async () => $(id)?.click());
  await flush();
};
const typeInto = async (value: string) => {
  const el = $("p-composer-input") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submitComposer = async () => {
  await act(async () => {
    $("p-composer-row")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
};
const push = async (runId: string, ...events: RunEvent[]) => {
  const es = sourceOf(runId);
  expect(es, `subscribed to ${runId}`).toBeDefined();
  await act(async () => {
    for (const e of events) es?.push(e);
  });
  await flush();
};

/** The canvas API of a v3 system: `brief` — it has a brief (built or ready to build). */
function canvasApi(view: () => SystemView, o: { brief?: boolean; extra?: Record<string, unknown> } = {}) {
  const brief = systemBriefSchema.parse(dentalBrief());
  const version = { version: 3, brief, diagrams: [], author: "agent", createdAt: "" };
  return {
    getSystem: async () => view(),
    getBrief: async () => {
      if (o.brief === false) throw new ApiError(404, { code: "NOT_FOUND", message_ru: "Брифа нет" });
      return { brief: version, diagrams: briefDiagrams(brief) };
    },
    getSystemPlan: async () => ({ plan: null }),
    listBriefVersions: async () => ({ versions: [], nextBefore: null }),
    listSessions: async () => ({ sessions: [] }),
    eventsUrl: (id: string, after: number) => `/api/v1/runs/${id}/events?after=${after}`,
    keys: { list: async () => ({ items: [], windows: [], needed: [] }) },
    getLatestGates: async () => ({ revision: 7, reports: [] }),
    listRevisions: async () => ({ items: [{ version: 7, g0Passed: true }] }),
    getRevision: async () => ({ version: 7, spec: { compliance: {} } }),
    getPreviewUrl: vi.fn(async () => ({
      url: "http://dental--draft.localhost:4100/_wizard/dev-logout?next=/",
      revision: 7,
      roles: [],
      expiresAt: "",
    })),
    ...o.extra,
  } as unknown as Partial<ApiClient>;
}

describe("a published v3 system opened again", () => {
  test("run reports name their kind: the build is replayed, a publication or a rollback is not", () => {
    expect(lastReportRun([report(1, BUILD, "build"), report(2, PUBLISH, "publish")])).toBe(BUILD);
    expect(lastReportRun([report(1, BUILD, "build"), report(2, PUBLISH, "rollback")])).toBe(BUILD);
    expect(lastReportRun([report(1, PUBLISH, "publish")])).toBeNull();
    // A report of an older platform (no kind) is still taken.
    expect(lastReportRun([report(1, BUILD)])).toBe(BUILD);
  });

  test("the canvas replays the build, not the publication, and shows the system — never «Думаю»", async () => {
    const view = sysView(
      { prodRevision: 7, prodUrl: "http://dental.localhost:4100/" },
      { messages: [report(1, BUILD, "build"), report(2, PUBLISH, "publish")] },
    );
    await mount(
      canvasApi(() => view),
      h(Canvas, { systemId: SYS, initial: view }),
    );
    expect(sourceOf(BUILD)).toBeDefined();
    expect(sourceOf(PUBLISH)).toBeUndefined();
    await push(BUILD, ...BUILT);
    // The replayed build has no v3 snapshot here: the preview of the system stands in for it.
    expect($("canvas-v3-system")).not.toBeNull();
    expect($("canvas-v3-live-frame")?.getAttribute("title")).toBe("Превью системы");
    expect($("canvas-main")?.textContent).not.toContain("Думаю над системой");
    expect($("canvas-v3-publish")).not.toBeNull();
  });

  test("only a publication report: no replay, the preview of the current revision", async () => {
    const view = sysView({ prodRevision: 7 }, { messages: [report(1, PUBLISH, "publish")] });
    const api = canvasApi(() => view);
    await mount(api, h(Canvas, { systemId: SYS, initial: view }));
    expect(FakeEventSource.all).toHaveLength(0);
    expect($("canvas-v3-system")).not.toBeNull();
    expect(api.getPreviewUrl).toHaveBeenCalledWith(SYS);
    expect($("canvas-empty")).toBeNull();
  });

  test("the logo leads to the list of systems", async () => {
    const view = sysView();
    await mount(
      canvasApi(() => view),
      h(Canvas, { systemId: SYS, initial: view }),
    );
    expect($("canvas-home")?.getAttribute("href")).toBe("/");
    expect($("canvas-home")?.getAttribute("aria-label")).toContain("Born to Build");
  });
});

describe("the v3 interview", () => {
  const interview = () =>
    sysView(
      { stage: "interview", previewRevision: null, draftRevision: 0 },
      { pendingQuestions: [QUESTION] },
    );

  test("the owner's turn: the main area says what will appear there, not «Думаю»", async () => {
    const view = interview();
    await mount(
      canvasApi(() => view, { brief: false }),
      h(Canvas, { systemId: SYS, initial: view }),
    );
    expect($("canvas-question")).not.toBeNull();
    expect($("canvas-v3-empty")?.textContent).toContain("Здесь появится ваша система");
    expect($("canvas-v3-empty")?.textContent).toContain("Отвечайте на вопросы в чате");
    expect($("canvas-main")?.textContent).not.toContain("Думаю над системой");
  });

  test("a failed turn: the reason, the question again, «Повторить» sends the same answer", async () => {
    const view = interview();
    const postAnswers = vi.fn(async () => ({ run: { id: TURN, kind: "interview_turn", status: "queued" } }));
    await mount(
      canvasApi(() => view, { brief: false, extra: { postAnswers } }),
      h(Canvas, { systemId: SYS, initial: view }),
    );
    await click("p-question-option-o1");
    expect(postAnswers).toHaveBeenCalledWith(SYS, { answers: [{ questionId: "q1", optionId: "o1" }] });
    expect($("canvas-question")).toBeNull();
    await push(
      TURN,
      ev(TURN, 1, "run_started", { kind: "interview_turn" }),
      ev(TURN, 2, "run_failed", {
        code: "LLM_UNAVAILABLE",
        message_ru: "Модели сейчас недоступны. Попробуйте ещё раз через минуту.",
        retryable: true,
      }),
    );
    expect($("canvas-turn-failed")?.textContent).toContain("Модели сейчас недоступны");
    expect($("canvas-turn-failed")?.getAttribute("role")).toBe("alert");
    // The question is pending on the server: it is asked again.
    expect($("canvas-question")).not.toBeNull();
    await click("canvas-turn-retry");
    expect(postAnswers).toHaveBeenCalledTimes(2);
    expect(postAnswers.mock.calls[1]).toEqual(postAnswers.mock.calls[0]);
  });

  test("own words: counted against the limit, a longer answer is not sent, a refused one comes back", async () => {
    const view = interview();
    const postAnswers = vi.fn(async () => {
      throw new ApiError(503, { code: "LLM_UNAVAILABLE", message_ru: "Сервис перегружен" });
    });
    await mount(
      canvasApi(() => view, { brief: false, extra: { postAnswers } }),
      h(Canvas, { systemId: SYS, initial: view }),
    );
    const long = "а".repeat(501);
    await typeInto(long);
    expect($("canvas-answer-count")?.textContent).toBe("501 из 500 знаков");
    await submitComposer();
    expect(postAnswers).not.toHaveBeenCalled();
    expect($("canvas-error")?.textContent).toBe(
      "Ответ на вопрос — не длиннее 500 знаков, сейчас 501. Сократите его и отправьте ещё раз.",
    );
    expect(($("p-composer-input") as HTMLInputElement).value).toBe(long);

    await typeInto("Через сайт и по телефону");
    expect($("canvas-answer-count")?.textContent).toBe("24 из 500 знаков");
    await submitComposer();
    expect(postAnswers).toHaveBeenCalledWith(SYS, {
      answers: [{ questionId: "q1", text: "Через сайт и по телефону" }],
    });
    expect($("canvas-error")?.textContent).toBe("Сервис перегружен");
    expect(($("p-composer-input") as HTMLInputElement).value).toBe("Через сайт и по телефону");
    expect($("canvas-question")).not.toBeNull();
  });
});

describe("a running v3 build", () => {
  test("«Остановить сборку» on the canvas cancels the followed build run after the confirmation", async () => {
    const view = sysView({ stage: "building", previewRevision: null }, { activeRunId: BUILD });
    const cancelRun = vi.fn(async () => ({ id: BUILD, kind: "build", status: "running" }));
    await mount(
      canvasApi(() => view, { extra: { cancelRun } }),
      h(Canvas, { systemId: SYS, initial: view }),
    );
    const progress = {
      stage: "brief",
      stages: [{ id: "brief", label_ru: "Перечитываю бриф", status: "running" }],
      scenarios: [],
      spentRub: 12,
      reusedRub: 0,
      capRub: 500,
      elapsedSec: 30,
      capSec: 1800,
      remainingSec: 900,
      previewRevision: null,
      checkpoints: { saved: 1, reused: 0 },
    };
    await push(
      BUILD,
      ev(BUILD, 1, "run_started", { kind: "build" }),
      ev(BUILD, 2, "build_stage", { stage: "brief", status: "started", label_ru: "x", progress }),
    );
    await click("canvas-v3-live-stop");
    expect(cancelRun).not.toHaveBeenCalled();
    await click("canvas-v3-live-stop-yes");
    expect(cancelRun).toHaveBeenCalledWith(BUILD);
  });
});

describe("a built v3 system", () => {
  test("a question of the edit loop is asked instead of the publication card", async () => {
    const view = sysView({}, { pendingQuestions: [QUESTION] });
    await mount(
      canvasApi(() => view),
      h(Canvas, { systemId: SYS, initial: view }),
    );
    expect($("canvas-question")?.textContent).toContain("Как клиенты записываются на приём?");
    expect($("canvas-v3-publish")).toBeNull();
  });

  test("the agent's reply to a wish stays above the publication card", async () => {
    const view = sysView(
      {},
      {
        messages: [
          report(1, BUILD, "build"),
          msg(2, { role: "user", text: "Добавь отзывы" }),
          msg(3, { text: "Добавил в бриф раздел «Отзывы» — соберите систему заново." }),
        ],
      },
    );
    await mount(
      canvasApi(() => view),
      h(Canvas, { systemId: SYS, initial: view }),
    );
    await push(BUILD, ...BUILT);
    expect($("canvas-last-reply")?.textContent).toBe(
      "Добавил в бриф раздел «Отзывы» — соберите систему заново.",
    );
    expect($("canvas-v3-publish")).not.toBeNull();
  });

  test("checks did not pass: the techreview's reasons in words and «Исправить» starts the build again", async () => {
    const view = sysView(
      {},
      {
        publishBlockers: ["GATES_FAILED"],
        techreviewBlockers: ["Права: Посетитель без входа видит чужие записи на приём."],
      },
    );
    const startFix = vi.fn(async () => ({ run: { id: BUILD, kind: "build", status: "queued" } }));
    await mount(
      canvasApi(() => view, { extra: { startFix } }),
      h(Canvas, { systemId: SYS, initial: view }),
    );
    expect($("canvas-v3-publish-techreview")?.textContent).toBe(
      "Техревью нашло: Права: Посетитель без входа видит чужие записи на приём.",
    );
    expect($("canvas-v3-publish-submit")?.hasAttribute("disabled")).toBe(true);
    expect($("canvas-v3-publish-fix")?.textContent).toBe("Исправить");
    await click("canvas-v3-publish-fix");
    expect(startFix).toHaveBeenCalledWith(SYS);
    expect(sourceOf(BUILD)).toBeDefined();
  });

  test("the publication card without «Исправить» for a member who may not edit", async () => {
    const view = sysView({}, { publishBlockers: ["GATES_FAILED", "NOT_OWNER"] });
    await mount(
      canvasApi(() => view),
      h(V3PublishCard, { systemId: SYS, view, run: null, onStarted: () => {}, onChanged: () => {} }),
    );
    expect($("canvas-v3-publish-blocker")).not.toBeNull();
    expect($("canvas-v3-publish-fix")).toBeNull();
    expect($("canvas-v3-publish-techreview")).toBeNull();
  });
});
