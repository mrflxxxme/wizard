// @vitest-environment happy-dom
// @vitest-environment-options {"settings": {"disableIframePageLoading": true}}
// V3-17 (DOM, API doubles): the live v3 build of the canvas from the structured snapshot of the run events — the latest
// snapshot is the state (no text parsing), the clock goes on from the event time and stops at the cap, the checklist
// says each scenario's state in words with the reason of those moved to «Запросы на развитие», the money and the
// time against the caps, «Подробнее» with stages, gates and checkpoints; the growing system reloads with a new
// revision and waits out PREVIEW_NOT_READY; a fresh end gives the toast and the browser notice once, a replayed old
// one stays quiet; status changes are announced only when fresh.
import { act, type ComponentProps, createElement as h, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type ApiClient, ApiError } from "../src/api/client.js";
import type { Message, PreviewUrl, RunEvent, V3BuildProgress, V3ProgressScenario } from "../src/api/types.js";
import { PlatformProvider } from "../src/app/context.js";
import {
  LivePreview,
  lastReportRun,
  liveClock,
  useV3Live,
  V3LivePanel,
  type V3LiveView,
  v3Live,
  v3SpendLine,
} from "../src/screens/v3/build/index.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SYS = "77777777-7777-4777-8777-777777777777";
const RUN = "88888888-8888-4888-8888-888888888888";
const STAGES = [
  ["brief", "Перечитываю бриф"],
  ["design", "Подбираю стиль"],
  ["backend", "Собираю данные, права и автоматизации"],
  ["skeleton", "Собираю каркас страниц"],
  ["scenarios", "Довожу сценарии по одному"],
  ["critic", "Смотрю на страницы глазами дизайнера"],
  ["template_gate", "Проверяю, что сайт не похож на шаблон"],
  ["techreview", "Провожу техревью"],
  ["gates", "Проверяю, что всё работает"],
] as const;
const SCEN: V3ProgressScenario[] = [
  {
    id: "s_book",
    title: "Когда пациент выбирает время — система создаёт запись",
    priority: "must",
    status: "pending",
  },
  {
    id: "s_lead",
    title: "Когда посетитель оставляет заявку — система пишет администратору",
    priority: "must",
    status: "pending",
  },
  {
    id: "s_doctors",
    title: "Когда посетитель смотрит врачей — система показывает их опыт",
    priority: "should",
    status: "pending",
  },
];

/** A snapshot of workflows.yaml#events.schemas.v3_progress at `stage` with scenario states. */
function snap(o: {
  stage: (typeof STAGES)[number][0];
  states?: Partial<Record<string, Partial<V3ProgressScenario>>>;
  spent?: number;
  reused?: number;
  elapsed?: number;
  remaining?: number;
  preview?: number | null;
  done?: boolean;
}): V3BuildProgress {
  const at = STAGES.findIndex(([id]) => id === o.stage);
  return {
    stage: o.stage,
    stages: STAGES.map(([id, label_ru], i) => ({
      id,
      label_ru,
      status:
        i < at || o.done
          ? ["critic", "template_gate", "techreview"].includes(id)
            ? "skipped"
            : "done"
          : i === at
            ? "running"
            : "pending",
    })),
    scenarios: SCEN.map((s) => ({ ...s, ...o.states?.[s.id] })),
    spentRub: o.spent ?? 0,
    reusedRub: o.reused ?? 0,
    capRub: 500,
    elapsedSec: o.elapsed ?? 0,
    capSec: 1800,
    remainingSec: o.remaining ?? 900,
    previewRevision: o.preview ?? null,
    checkpoints: { saved: 5, reused: o.reused ? 2 : 0 },
  };
}

let seq = 0;
const ev = (type: string, payload: Record<string, unknown>, ts = new Date().toISOString()): RunEvent => ({
  runId: RUN,
  seq: ++seq,
  type,
  ts,
  payload,
});
const stageEv = (p: V3BuildProgress, ts?: string) =>
  ev("build_stage", { stage: p.stage, status: "started", label_ru: "x", progress: p }, ts);

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.useRealTimers();
});

async function mount(api: Partial<ApiClient>, node: ReactNode): Promise<void> {
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
  await settle();
}
const settle = async (n = 5) => {
  for (let i = 0; i < n; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
};
const $ = (id: string) => container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const $$ = (id: string) => [...(container?.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`) ?? [])];

describe("the live build of the run events (pure)", () => {
  test("the latest snapshot is the state; gates and the end come from their events; v2 events give nothing", () => {
    expect(
      v3Live([ev("run_started", { kind: "build" }), ev("build_stage", { stage: "plan", status: "started" })]),
    ).toBeNull();
    const a = snap({ stage: "skeleton", spent: 10 });
    const b = snap({ stage: "scenarios", states: { s_book: { status: "running" } }, spent: 42, preview: 3 });
    const events = [
      ev("run_started", { kind: "build" }),
      stageEv(a),
      ev("gate_result", { level: "G0", passed: true, revision: 3 }),
      ev("agent_message", { agent: "builder", messageId: "m", text: "Сейчас потрачено 999 ₽ из 500 ₽." }),
      ev("step_started", { step: "scenario:s_book", label_ru: "x", progress: b }),
      ev("gate_result", {
        level: "G1",
        passed: false,
        revision: 4,
        failedChecks: [{ id: "x", message_ru: "y" }],
      }),
    ];
    const live = v3Live(events);
    expect(live?.progress).toEqual(b);
    expect(live?.phase).toBe("running");
    expect(live?.gates.map((g) => [g.level, g.passed, g.revision, g.failed])).toEqual([
      ["G0", true, 3, 0],
      ["G1", false, 4, 1],
    ]);
    // The spend of the chat row is the snapshot's, never the text of a line.
    expect(v3SpendLine(events)).toBe("потрачено 42 ₽ из 500 ₽");
    const done = v3Live([
      ...events,
      ev("run_finished", { status: "succeeded", summary_ru: "Система собрана по брифу." }),
    ]);
    expect(done).toMatchObject({ phase: "done", summary: "Система собрана по брифу." });
    expect(v3Live([...events, ev("run_failed", { code: "GATES_FAILED", message_ru: "x" })])?.phase).toBe(
      "failed",
    );
    // A malformed snapshot is ignored.
    expect(
      v3Live([ev("build_stage", { stage: "brief", status: "started", progress: { scenarios: 1 } })]),
    ).toBeNull();
  });

  test("the clock goes on from the event time, never past the cap, and stops at the end", () => {
    const t0 = Date.parse("2026-10-09T10:00:00.000Z");
    const live = v3Live([
      stageEv(snap({ stage: "scenarios", elapsed: 300, remaining: 600 }), new Date(t0).toISOString()),
    ]);
    if (!live) throw new Error("no live");
    expect(liveClock(live, t0 + 60_000)).toEqual({ elapsedSec: 360, remainingSec: 540 });
    expect(liveClock(live, t0 + 1500_000)).toEqual({ elapsedSec: 1800, remainingSec: 0 });
    const ended = { ...live, phase: "done" as const, endedAt: t0 + 30_000 };
    expect(liveClock(ended, t0 + 600_000)).toEqual({ elapsedSec: 330, remainingSec: 0 });
  });

  test("the replayed build of a system opened later: the latest run report", () => {
    const m = (seqN: number, kind: Message["kind"], runId: string | null): Message => ({
      id: String(seqN),
      seq: seqN,
      role: "assistant",
      kind,
      runId,
      createdAt: "",
    });
    expect(lastReportRun([m(1, "text", "a"), m(3, "run_report", "b"), m(2, "run_report", "c")])).toBe("b");
    expect(lastReportRun([m(1, "text", "a")])).toBeNull();
  });
});

describe("the panel of the live build", () => {
  test("checklist states in words, reasons of the moved ones, time and money against the caps, «Подробнее»", async () => {
    const t = new Date().toISOString();
    const p = snap({
      stage: "scenarios",
      states: {
        s_book: { status: "passed", reused: true },
        s_lead: { status: "failed", reason: "не прошёл проверку в браузере: Страница «/lead» не открылась" },
        s_doctors: { status: "running" },
      },
      spent: 87.4,
      reused: 30,
      elapsed: 330,
      remaining: 610,
      preview: 4,
    });
    const live = v3Live([stageEv(p, t), ev("gate_result", { level: "G0", passed: true, revision: 4 })]);
    if (!live) throw new Error("no live");
    await mount({}, h(V3LivePanel, { live, now: Date.parse(t), notify: "default", onAskNotify: () => {} }));
    expect($("canvas-v3-live-title")?.textContent).toBe("Собираю систему");
    expect($("canvas-v3-live-stage")?.textContent).toBe("Сейчас: Довожу сценарии по одному");
    expect($("canvas-v3-live-time-left")?.textContent).toBe("Осталось около 10 минут");
    expect($("canvas-v3-live-time-cap")?.textContent).toBe("Идёт 5 мин · не дольше 30 мин");
    expect($("canvas-v3-live-spend-line")?.textContent).toBe("Потрачено 87 ₽ из 500 ₽");
    expect($("canvas-v3-live-spend-reused")?.textContent).toContain("Из них 30 ₽ — шаги прошлой сборки");
    expect($("canvas-v3-live-count")?.textContent).toContain("готово 1 из 3");
    const rows = $$("canvas-v3-live-scenario");
    expect(rows.map((r) => [r.dataset.id, r.dataset.status])).toEqual([
      ["s_book", "passed"],
      ["s_lead", "failed"],
      ["s_doctors", "running"],
    ]);
    expect(
      rows.map((r) => r.querySelector('[data-testid="canvas-v3-live-scenario-status"]')?.textContent),
    ).toEqual(["готово в прошлой сборке", "в «Запросы на развитие»", "делаю сейчас"]);
    expect(rows[2]?.getAttribute("aria-current")).toBe("step");
    expect($("canvas-v3-live-reason")?.textContent).toBe(
      "Причина: не прошёл проверку в браузере: Страница «/lead» не открылась. Его можно доделать правкой.",
    );
    expect(rows[0]?.textContent).toContain("обязательно");
    expect(rows[2]?.textContent).toContain("желательно");
    expect($("canvas-v3-live-leave")?.textContent).toContain("Можно закрыть страницу");
    expect($("canvas-v3-live-notify")?.textContent).toBe("Сообщить в браузере, когда будет готово");
    // «Подробнее»: stages, gates, checkpoints.
    expect($("canvas-v3-live-more")?.querySelector("summary")?.textContent).toBe("Подробнее");
    const stages = [...($("canvas-v3-live-stages")?.querySelectorAll("li") ?? [])];
    expect(stages.map((x) => x.dataset.status)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "running",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect($("canvas-v3-live-gates")?.textContent).toBe("G0, ревизия 4: пройдена");
    expect($("canvas-v3-live-checkpoints")?.textContent).toBe(
      "Сохранено шагов: 5. Взято из прошлой сборки: 2 — повторно не оплачиваются. Превью — ревизия 4.",
    );
  });

  test("the end: «Система собрана» with the summary, a halted scenario of a failed build", async () => {
    const p = snap({
      stage: "gates",
      states: { s_book: { status: "passed" }, s_lead: { status: "running" } },
      elapsed: 700,
    });
    const failed = v3Live([stageEv(p), ev("run_failed", { code: "GATES_FAILED", message_ru: "x" })]);
    if (!failed) throw new Error("no live");
    await mount(
      {},
      h(V3LivePanel, { live: failed, now: Date.now(), notify: "granted", onAskNotify: () => {} }),
    );
    expect($("canvas-v3-live-title")?.textContent).toBe("Сборка остановилась");
    expect($$("canvas-v3-live-scenario-status").map((x) => x.textContent)).toEqual([
      "готово",
      "остановлен",
      "остановлен",
    ]);
    expect($("canvas-v3-live-leave")).toBeNull();
    expect($("canvas-v3-live-time-left")?.textContent).toBe("Шла 12 мин");
  });
});

describe("the growing system", () => {
  test("a new revision reloads the frame; PREVIEW_NOT_READY is waited out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let rev = 3;
    let notReady = 1;
    const getPreviewUrl = vi.fn(async (): Promise<PreviewUrl> => {
      if (notReady-- > 0)
        throw new ApiError(409, { code: "PREVIEW_NOT_READY", message_ru: "Превью ещё не готово" });
      return {
        url: "http://v3--draft.localhost:4100/_wizard/dev-logout?next=/",
        revision: rev,
        roles: [],
        expiresAt: "",
      };
    });
    let set: (r: number | null) => void = () => {};
    function Wrap(): ReactNode {
      const [r, setR] = useState<number | null>(null);
      set = setR;
      return h(LivePreview, { systemId: SYS, revision: r });
    }
    await mount({ getPreviewUrl } as unknown as Partial<ApiClient>, h(Wrap));
    expect($("canvas-v3-live-preview-pending")?.textContent).toContain("Каркас страниц появится здесь");
    expect(getPreviewUrl).not.toHaveBeenCalled();
    await act(async () => set(3));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await settle();
    const frame = () => $("canvas-v3-live-frame") as HTMLIFrameElement | null;
    expect(getPreviewUrl).toHaveBeenCalledTimes(2);
    expect(frame()?.getAttribute("src")).toContain("wzrev=3");
    expect(frame()?.getAttribute("title")).toBe("Превью собираемой системы");
    rev = 5;
    await act(async () => set(5));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await settle();
    expect(frame()?.getAttribute("src")).toContain("wzrev=5");
    expect($("canvas-v3-live-preview")?.dataset.revision).toBe("5");
  });
});

describe("useV3Live: the toast, the browser notice and the announcements", () => {
  function Probe({ events, onView }: { events: RunEvent[]; onView(v: V3LiveView): void }): ReactNode {
    const v = useV3Live({ systemId: SYS, name: "Стоматология", events, announce: (t) => said.push(t) });
    onView(v);
    return h("div", null, v.main, v.ready, v.toast);
  }
  let said: string[] = [];

  test("a fresh end: the toast and one browser notice; a replayed old end stays quiet", async () => {
    said = [];
    localStorage.clear();
    const notes: { title: string; body?: string }[] = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission = async () => "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, o?: { body?: string }) {
        notes.push({ title, ...(o?.body ? { body: o.body } : {}) });
      }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    const getPreviewUrl = vi.fn(async () => ({
      url: "http://x--draft.localhost:4100/",
      revision: 4,
      roles: [],
      expiresAt: "",
    }));
    let view = null as V3LiveView | null;
    const running = [
      ev("run_started", { kind: "build" }),
      stageEv(snap({ stage: "scenarios", states: { s_book: { status: "running" } }, preview: 3 })),
    ];
    await mount(
      { getPreviewUrl } as unknown as Partial<ApiClient>,
      h(Probe, { events: running, onView: (v) => (view = v) }),
    );
    expect($("canvas-v3-live")?.dataset.phase).toBe("running");
    expect(view?.spend).toBe("потрачено 0 ₽ из 500 ₽");
    // A scenario lands: announced (fresh).
    const landed = [
      ...running,
      ev("step_finished", {
        step: "scenario:s_book",
        progress: snap({ stage: "scenarios", states: { s_book: { status: "passed" } }, preview: 4 }),
      }),
    ];
    await act(async () =>
      root?.render(wrap(h(Probe, { events: landed, onView: (v) => (view = v) }), getPreviewUrl)),
    );
    await settle();
    expect(said.join(" | ")).toContain(`Готово: ${SCEN[0]?.title}`);
    expect(said.join(" | ")).toContain("Превью обновилось");
    const finished = [
      ...landed,
      ev("build_stage", {
        stage: "gates",
        status: "done",
        label_ru: "x",
        progress: snap({
          stage: "gates",
          done: true,
          states: {
            s_book: { status: "passed" },
            s_lead: { status: "passed" },
            s_doctors: { status: "stopped", reason: "не успели" },
          },
          remaining: 0,
          preview: 5,
        }),
      }),
      ev("run_finished", {
        status: "succeeded",
        summary_ru: "Система собрана по брифу: готово 2 из 3 сценариев.",
      }),
    ];
    await act(async () =>
      root?.render(wrap(h(Probe, { events: finished, onView: (v) => (view = v) }), getPreviewUrl)),
    );
    await settle();
    expect($("canvas-v3-live-toast")?.getAttribute("role")).toBe("status");
    expect($("canvas-v3-live-toast")?.textContent).toContain("Система «Стоматология» готова");
    expect($("canvas-v3-live-toast")?.textContent).toContain("Готово 2 из 3 сценариев брифа");
    expect(notes).toEqual([
      { title: "Система «Стоматология» готова", body: "Готово 2 из 3 сценариев брифа" },
    ]);
    expect($("canvas-v3-live-ready")?.textContent).toContain("Система готова");
    expect(said.at(-1)).toBe("Система собрана");
    await act(async () => $("canvas-v3-live-toast-close")?.click());
    expect($("canvas-v3-live-toast")).toBeNull();
    // The same run again (a reload right after the end): no second notice.
    act(() => root?.unmount());
    await mount(
      { getPreviewUrl } as unknown as Partial<ApiClient>,
      h(Probe, { events: finished, onView: (v) => (view = v) }),
    );
    expect(notes).toHaveLength(1);
    expect($("canvas-v3-live-toast")).toBeNull();

    // A build that ended an hour ago, replayed on return: the state, no toast, nothing read out.
    act(() => root?.unmount());
    localStorage.clear();
    said = [];
    const old = new Date(Date.now() - 3600_000).toISOString();
    const replay = [
      stageEv(snap({ stage: "scenarios", states: { s_book: { status: "running" } } }), old),
      ev(
        "build_stage",
        {
          stage: "gates",
          status: "done",
          label_ru: "x",
          progress: snap({ stage: "gates", done: true, states: { s_book: { status: "passed" } } }),
        },
        old,
      ),
      ev("run_finished", { status: "succeeded" }, old),
    ];
    await mount(
      { getPreviewUrl } as unknown as Partial<ApiClient>,
      h(Probe, { events: replay, onView: (v) => (view = v) }),
    );
    expect($("canvas-v3-live")?.dataset.phase).toBe("done");
    expect($("canvas-v3-live-toast")).toBeNull();
    expect(notes).toHaveLength(1);
    expect(said).toEqual([]);
    vi.unstubAllGlobals();
  });

  test("the owner allows the browser notice from the panel", async () => {
    let permission = "default";
    vi.stubGlobal(
      "Notification",
      class {
        static get permission() {
          return permission;
        }
        static requestPermission = vi.fn(async () => {
          permission = "granted";
          return "granted";
        });
        close() {}
      },
    );
    const events = [stageEv(snap({ stage: "design" }))];
    await mount({}, h(Probe, { events, onView: () => {} }));
    expect($("canvas-v3-live-preview-pending")).not.toBeNull();
    await act(async () => $("canvas-v3-live-notify")?.click());
    await settle();
    expect($("canvas-v3-live-notify")).toBeNull();
    expect($("canvas-v3-live-notify-on")?.textContent).toBe("Сообщу в браузере, когда система будет готова.");
    vi.unstubAllGlobals();
  });
});

function wrap(node: ReactNode, getPreviewUrl: unknown): ReactNode {
  return h(
    PlatformProvider,
    { api: { getOrgSettings: async () => ({}), getPreviewUrl } as unknown as ApiClient } as ComponentProps<
      typeof PlatformProvider
    >,
    node,
  );
}
