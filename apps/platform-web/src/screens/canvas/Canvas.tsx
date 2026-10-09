// Canvas screen /s/:systemId of the modules pipeline (B2-25, platform-screens.yaml#canvas, prototype E, grill-7): the
// client system grows on the whole screen from the first phrase, the chat floats bottom-centre (a pull-up sheet on the
// phone), the plan is approved on the canvas and the build «materializes» it; «Как это работает» shows the automation.
import "@wizard/ui-kit/v2/theme.css";
import {
  ActionButton,
  businessColors,
  type CanvasBlockState,
  ChatMessage,
  ChatSheet,
  Chip,
  Composer,
  Glass,
  PLATFORM_COLORS,
  type PlatformThemeMode,
  QuestionCard,
  Serif,
  ThemeRoot,
} from "@wizard/ui-kit/v2";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../api/client.js";
import type {
  Answer,
  GoalQuestion,
  Message,
  MessageBlock,
  PlanEdit,
  PlanSketch,
  RunEvent,
  SystemPlanRevision,
  SystemView,
} from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { openSupport } from "../../features/support/SupportWidget.js";
import { canvas } from "../../i18n/ru/canvas.js";
import { demo } from "../../i18n/ru/demo.js";
import { support } from "../../i18n/ru/support.js";
import { ru } from "../../i18n/ru.js";
import { subscribeRun } from "../../run/stream.js";
import { useCanvasBrief } from "../brief/CanvasBrief.js";
import { briefRu } from "../brief/ru.js";
import { useBriefUpload } from "../v3/BriefUpload.js";
import { DELEGATE_OPTION_ID, v3Question } from "../v3/question.js";
import { v3Ru } from "../v3/ru.js";
import { Board, type BoardView, XrayData } from "./Board.js";
import { buildProgress, remainingText } from "./buildProgress.js";
import s from "./Canvas.module.css";
import {
  blockSignature,
  type CanvasBlockModel,
  type CanvasModel,
  canvasModel,
  type LocalAnswer,
  materializedCount,
} from "./model.js";
import { blockActions } from "./pick.js";
import { xrayModel } from "./xray.js";

/** The block the client tapped («ткни и скажи», B2-29: hints and edits in pick.ts). */
export interface SelectedBlock {
  id: string;
  kind: CanvasBlockModel["kind"];
  title: string;
  module?: string;
  /** Index of the landing section in the plan (PATCH /plan update_section). */
  sectionIndex?: number;
}

export interface CanvasProps {
  systemId: string;
  /** GET /systems/:id already read by the route (pipeline = modules). */
  initial: SystemView;
  /** A block was picked (null — the pick was cleared). */
  onBlockSelect?(block: SelectedBlock | null): void;
}

interface Line {
  id: string;
  from: "me" | "ai" | "sys";
  text: string;
  warn: boolean;
}

interface LocalAnswerRow extends LocalAnswer {
  answer: Answer;
}

/** The x-ray layer shows itself while this part of the build runs (grill-7 #3: «на несколько секунд»). */
const XRAY_AUTO = { from: 0.3, to: 0.7 } as const;
const THEME_KEY = "wz.canvas.theme";
const TOUCH_MS = 1800;

const errText = (e: unknown) => (e instanceof Error ? e.message : ru.errors.generic);

function readTheme(): PlatformThemeMode {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

function darkQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
}

function useDarkScheme(): boolean {
  const [dark, setDark] = useState(() => darkQuery()?.matches ?? false);
  useEffect(() => {
    const q = darkQuery();
    if (!q) return;
    const on = () => setDark(q.matches);
    q.addEventListener?.("change", on);
    return () => q.removeEventListener?.("change", on);
  }, []);
  return dark;
}

/** Stable key of a sketch: the plan reloads the canvas only when its fingerprint changes (api.yaml#PlanSketch). */
export function sketchKey(sk: PlanSketch): string {
  if (sk.stage === "plan") return `plan:${sk.fingerprint ?? JSON.stringify(sk.errors.map((e) => e.code))}`;
  return `interview:${JSON.stringify([sk.goals.map((g) => g.id), sk.modules.map((m) => m.id), sk.outOfScope])}`;
}

function messageText(m: Message): string {
  if (m.role === "user") {
    const masked = m.payload?.maskedText;
    const text = typeof masked === "string" ? masked : (m.text ?? "");
    // B2-29: a wish to a canvas block carries its label.
    const block = m.payload?.block as { title?: unknown } | undefined;
    return typeof block?.title === "string" && text ? canvas.pick.wish(block.title, text) : text;
  }
  return m.text ?? "";
}

function isGoalQuestion(q: unknown): q is GoalQuestion {
  const o = q as GoalQuestion;
  return !!o && typeof o.id === "string" && typeof o.text === "string" && Array.isArray(o.options);
}

export function Canvas({ systemId, initial, onBlockSelect }: CanvasProps): ReactNode {
  const { api } = usePlatform();
  const [view, setView] = useState<SystemView>(initial);
  const [plan, setPlan] = useState<SystemPlanRevision | null>(null);
  const [sketch, setSketch] = useState<PlanSketch | null>(null);
  const sketchRef = useRef<string | null>(null);
  const [runId, setRunId] = useState<string | null>(initial.activeRunId ?? null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [answers, setAnswers] = useState<LocalAnswerRow[]>([]);
  const [sent, setSent] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [board, setBoard] = useState<BoardView>("overview");
  const [readyCard, setReadyCard] = useState(true);
  const [manualXray, setManualXray] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The last removed section and the edits that bring it back («Вернуть»). */
  const [undo, setUndo] = useState<{ title: string; edits: PlanEdit[] } | null>(null);
  const [theme, setTheme] = useState<PlatformThemeMode>(readTheme);
  const [live, setLive] = useState("");
  const [fx, setFx] = useState<{ born: Set<string>; touched: Set<string> }>({
    born: new Set(),
    touched: new Set(),
  });
  const sysDark = useDarkScheme();
  const dark = theme === "dark" || (theme === "auto" && sysDark);

  const stage = view.system.stage;
  // The floating «Написать команде» would cover the chat: on the canvas it lives in the top bar (D68).
  useEffect(() => {
    document.documentElement.setAttribute("data-wz-canvas", "");
    return () => document.documentElement.removeAttribute("data-wz-canvas");
  }, []);
  // Height of the floating chat (--dock-h): the canvas scrolls above it and the x-ray data panel sits over it.
  const screenRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = screenRef.current;
    const dockEl = el?.querySelector<HTMLElement>('[data-testid="p-sheet-dock"]');
    if (!el || !dockEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => el.style.setProperty("--dock-h", `${dockEl.offsetHeight}px`));
    ro.observe(dockEl);
    return () => ro.disconnect();
  }, []);
  // The page under the canvas has the canvas background (overscroll, safe areas), set through CSSOM (CSP).
  useEffect(() => {
    const html = document.documentElement;
    html.style.setProperty("background", PLATFORM_COLORS[dark ? "dark" : "light"].bg);
    html.style.setProperty("color-scheme", dark ? "dark" : "light");
    return () => {
      html.style.removeProperty("background");
      html.style.removeProperty("color-scheme");
    };
  }, [dark]);
  const announce = useCallback((t: string) => setLive(t), []);
  // V3-06: the system brief (a system with a brief v3): «Бриф» button, short brief before «Собрать», the panel.
  const focusInput = useCallback(
    () => screenRef.current?.querySelector<HTMLElement>('[data-testid="p-composer-input"]')?.focus(),
    [],
  );
  const brief = useCanvasBrief(systemId, { orgId: view.system.orgId, announce, onAskInChat: focusInput });
  // V3-04: «Приложить ТЗ» of a v3 system — the new version goes straight to the brief.
  const upload = useBriefUpload(systemId, { onUploaded: brief.adopt, onOpen: brief.show, announce });
  const reloadBrief = brief.reload;

  const applySketch = useCallback((sk: PlanSketch | null | undefined) => {
    if (!sk) return;
    const key = sketchKey(sk);
    if (key === sketchRef.current) return;
    sketchRef.current = key;
    setSketch(sk);
  }, []);

  const reload = useCallback(async () => {
    const v = await api.getSystem(systemId);
    setView(v);
    return v;
  }, [api, systemId]);

  const loadPlan = useCallback(async () => {
    try {
      const r = await api.getSystemPlan(systemId);
      setPlan(r.plan);
      applySketch(r.plan?.sketch);
    } catch {
      // No plan yet (interview) or a network blip: the canvas keeps what it has.
    }
  }, [api, systemId, applySketch]);

  // Plan and sketch of a system past the interview; the interview sketch is replayed from its run (plan_sketch).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opened system
  useEffect(() => {
    if (initial.system.stage !== "interview") {
      void loadPlan();
      return;
    }
    const q = [...initial.messages].reverse().find((m) => m.kind === "questions" && m.runId);
    if (!q?.runId || q.runId === initial.activeRunId) return;
    return subscribeRun({
      url: (after) => api.eventsUrl(q.runId as string, after),
      onEvent: (e) => {
        if (e.type === "plan_sketch") applySketch(e.payload.sketch as PlanSketch);
      },
    });
  }, []);

  const onEvent = useCallback(
    (e: RunEvent) => {
      setEvents((xs) => (xs.some((x) => x.seq === e.seq) ? xs : [...xs, e]));
      if (e.type === "plan_sketch") applySketch(e.payload.sketch as PlanSketch);
      if (e.type === "chat_output") {
        void reload().catch(() => {});
        reloadBrief();
        if (e.payload.kind === "plan") {
          setAnswers([]);
          void loadPlan();
        }
      }
      if (e.type === "run_finished" || e.type === "run_failed") {
        setSent([]);
        setManualXray(null);
        void reload().catch(() => {});
        void loadPlan();
        reloadBrief();
      }
    },
    [applySketch, reload, loadPlan, reloadBrief],
  );

  useEffect(() => {
    if (!runId) return;
    setEvents([]);
    return subscribeRun({ url: (after) => api.eventsUrl(runId, after), after: 0, onEvent });
  }, [api, runId, onEvent]);

  // A failed build seen when the screen opens: its events say what stopped it (replayed, the run is over).
  const replayedFailure = useRef(false);
  useEffect(() => {
    const id = plan?.buildRunId;
    if (replayedFailure.current || initial.system.stage !== "failed" || !id || runId !== null) return;
    replayedFailure.current = true;
    setRunId(id);
  }, [initial.system.stage, plan?.buildRunId, runId]);

  const runKind = events.find((e) => e.type === "run_started")?.payload.kind;
  const progress = useMemo(() => buildProgress(runKind === "build" ? events : []), [runKind, events]);
  const runActive =
    runId !== null && !events.some((e) => e.type === "run_finished" || e.type === "run_failed");
  const thinking = runActive && runKind !== "build";

  const questions = (view.pendingQuestions ?? []).filter(isGoalQuestion) as unknown as GoalQuestion[];
  // V3-03: the v3 interview asks one question per turn — a new pending question starts with no local answers.
  const qKey = questions.map((q) => q.id).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new set of pending questions only
  useEffect(() => {
    if (questions.some((q) => v3Question(q) !== null)) setAnswers([]);
  }, [qKey]);
  const qIndex = answers.length;
  const question = stage === "interview" && !thinking ? questions[qIndex] : undefined;
  const localAnswers = useMemo<LocalAnswer[]>(
    () => answers.map((a) => ({ ...(a.module ? { module: a.module } : {}), label: a.label })),
    [answers],
  );

  const model: CanvasModel | null = useMemo(
    () => (sketch ? canvasModel(sketch, view.system.name || sketch.niche, localAnswers) : null),
    [sketch, view.system.name, localAnswers],
  );

  const selected = useMemo(
    () =>
      selectedId && model
        ? ([...model.frames.site, ...model.frames.phone, ...model.frames.cab].find(
            (b) => b.id === selectedId,
          ) ?? null)
        : null,
    [model, selectedId],
  );

  // «Born» and «touched» blocks of a new model (amber edge for a change, rise for a new block).
  const sigs = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!model) return;
    const all = [...model.frames.site, ...model.frames.phone, ...model.frames.cab];
    const prev = sigs.current;
    const next = new Map(all.map((b) => [b.id, blockSignature(b)]));
    sigs.current = next;
    if (!prev) {
      setFx({ born: new Set(next.keys()), touched: new Set() });
      announce(canvas.chat.sketchReady);
    } else {
      const born = new Set([...next.keys()].filter((k) => !prev.has(k)));
      const touched = new Set([...next.keys()].filter((k) => prev.has(k) && prev.get(k) !== next.get(k)));
      if (born.size === 0 && touched.size === 0) return;
      setFx({ born, touched });
    }
    const t = setTimeout(() => setFx({ born: new Set(), touched: new Set() }), TOUCH_MS);
    return () => clearTimeout(t);
  }, [model, announce]);

  const xray = useMemo(
    () => (sketch?.stage === "plan" && model ? xrayModel(sketch, model) : null),
    [sketch, model],
  );
  const building = stage === "building" || (runKind === "build" && progress.phase === "running");
  const autoXray =
    building &&
    progress.phase === "running" &&
    progress.fraction >= XRAY_AUTO.from &&
    progress.fraction < XRAY_AUTO.to;
  const xrayVisible = !!xray && (manualXray ?? autoXray);

  const ready = stage === "ready" && !runActive;
  // A built system whose plan was edited waits for the rebuild: its blocks stay built (B2-29).
  const built = view.system.previewRevision !== null;
  const order = model?.order ?? [];
  const done = materializedCount(order.length, progress.fraction);
  const stateOf = useCallback(
    (id: string): CanvasBlockState => {
      if (ready || (stage === "card" && built && progress.phase === "idle")) return "ready";
      const i = order.indexOf(id);
      if (stage === "building" || stage === "failed" || progress.phase !== "idle") {
        if (progress.phase === "done") return "ready";
        if (i < done) return "ready";
        if (i === done && progress.phase === "running") return "materializing";
      }
      return "sketch";
    },
    [ready, built, order, stage, progress.phase, done],
  );
  const delayOf = useCallback(() => 0, []);

  // «Ткни и скажи» (B2-29): blocks of a plan awaiting approval or of a built system; never during a run.
  const canPick =
    !!plan && sketch?.stage === "plan" && !runActive && !building && (ready || stage === "card");
  const actions = useMemo(
    () => (selected && sketch && canPick ? blockActions(selected, sketch, plan?.plan ?? null) : null),
    [selected, sketch, canPick, plan],
  );
  // The picked block went away (removed, or picking is over): the pick is cleared.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pick is a plain function of this render
  useEffect(() => {
    if (selectedId && (!canPick || (model && !selected))) pick(null);
  }, [selectedId, canPick, model, selected]);

  // Esc clears the pick when the history is closed (the sheet handles Esc itself while open).
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !open) pick(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  function pick(b: CanvasBlockModel | null) {
    const next = b && selectedId === b.id ? null : b;
    setSelectedId(next?.id ?? null);
    if (next) setUndo(null);
    if (next) announce(canvas.pick.selected(next.title));
    const idx = next?.data.sectionIndex;
    onBlockSelect?.(
      next
        ? {
            id: next.id,
            kind: next.kind,
            title: next.title,
            ...(next.module ? { module: next.module } : {}),
            ...(typeof idx === "number" ? { sectionIndex: idx } : {}),
          }
        : null,
    );
  }

  async function act<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(name);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === "PLAN_REVISION_STALE") {
        setNotice(canvas.plan.stale);
        await loadPlan();
      } else setError(errText(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function submitAnswers(rows: LocalAnswerRow[], rest = false) {
    const r = await act("answers", () =>
      api.postAnswers(systemId, {
        answers: rows.map((a) => a.answer),
        ...(rest ? { restByRecommendation: true } : {}),
      }),
    );
    if (!r) return;
    setRunId(r.run.id);
    await reload().catch(() => {});
  }

  function answer(q: GoalQuestion, a: Answer, label: string) {
    const rows = [...answers, { answer: a, label, ...(q.module ? { module: q.module } : {}) }];
    setAnswers(rows);
    setSent((x) => [...x, label]);
    announce(canvas.chat.answered(label));
    if (rows.length >= questions.length) void submitAnswers(rows);
  }

  /**
   * A hint of a picked block (B2-29): the edits go to PATCH /plan with the revision the client sees, no model and no
   * credits. The dry run answers first and the sketch is redrawn by it at once; then the edit is saved. A stale
   * revision reloads the sketch with a plain message; an edit the plan cannot take is explained and rolled back.
   */
  async function edit(edits: PlanEdit[], said: string, after?: { title: string; edits: PlanEdit[] }) {
    const base = plan;
    if (!base || busy !== null) return;
    setBusy("edit");
    setError(null);
    setNotice(null);
    setUndo(null);
    let previewed = false;
    try {
      const dry = await api.editPlan(systemId, { revision: base.revision, edits, dryRun: true });
      applySketch(dry.plan.sketch);
      previewed = true;
      const saved = await api.editPlan(systemId, { revision: base.revision, edits });
      setPlan(saved.plan);
      applySketch(saved.plan.sketch);
      setSent((x) => [...x, said]);
      announce(canvas.pick.done(said));
      if (after) setUndo(after);
      // A built system: the edit waits for the rebuild (the plan card says «Пересобрать»).
      if (built) setNotice(canvas.pick.rebuild);
      if (stage === "ready") await reload().catch(() => {});
    } catch (e) {
      if (e instanceof ApiError && e.code === "PLAN_REVISION_STALE") {
        setNotice(canvas.pick.stale);
        sketchRef.current = null;
        await loadPlan();
        await reload().catch(() => {});
      } else {
        setError(
          e instanceof ApiError && e.code === "PLAN_INVALID" ? canvas.pick.invalid(e.message) : errText(e),
        );
        if (previewed) {
          sketchRef.current = null;
          applySketch(base.sketch);
        }
      }
    } finally {
      setBusy(null);
    }
  }

  function hint(id: string) {
    const h = actions?.hints.find((x) => x.id === id);
    if (!h || !selected) return;
    const title = selected.title;
    void edit(h.edits, h.said, h.undo ? { title, edits: h.undo } : undefined);
  }

  async function send(t: string) {
    const value = t.trim();
    if (!value) return;
    if (question) {
      if (question.allowCustom === false) return;
      setText("");
      answer(question, { questionId: question.id, text: value }, value);
      return;
    }
    // A wish with the label of the picked block goes to the planner about that block (B2-29).
    const target = selected && canPick ? selected : null;
    const idx = target?.data.sectionIndex;
    const block: MessageBlock | undefined = target
      ? {
          id: target.id,
          title: target.title,
          ...(target.module ? { module: target.module } : {}),
          ...(typeof idx === "number" ? { sectionIndex: idx } : {}),
        }
      : undefined;
    const r = await act("message", () => api.postMessage(systemId, value, block ? { block } : {}));
    if (!r) return;
    setText("");
    setUndo(null);
    setSent((x) => [...x, target ? canvas.pick.wish(target.title, value) : value]);
    setRunId(r.run.id);
    await reload().catch(() => {});
  }

  async function approve() {
    if (!plan) return;
    const r = await act("approve", () => api.approvePlan(systemId, plan.revision));
    if (!r) return;
    setNotice(null);
    setUndo(null);
    setManualXray(null);
    setReadyCard(true);
    setBoard("overview");
    setRunId(r.run.id);
    announce(canvas.build.ring);
    await reload().catch(() => {});
  }

  async function retry() {
    const r = await act("fix", () => api.startFix(systemId));
    if (!r) return;
    setManualXray(null);
    setRunId(r.run.id);
    await reload().catch(() => {});
  }

  function chooseView(v: BoardView) {
    window.scrollTo({ top: 0 });
    setBoard(v);
    setReadyCard(false);
    setManualXray(false);
    pick(null);
  }

  function toggleTheme() {
    const next = dark ? "light" : "dark";
    setTheme(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private mode: the choice lives for this tab.
    }
  }

  // Business colour of the client system once the plan has it (grill-7 #7). Set as custom properties on the screen
  // root (CSSOM: the platform CSP forbids injected <style>, so ThemeRoot's own business stylesheet is not used here).
  const tint = useMemo<CSSProperties | undefined>(() => {
    const hex = model?.accent;
    if (!hex) return undefined;
    const b = businessColors(hex, dark ? "dark" : "light");
    return {
      "--p-biz": b.biz,
      "--p-biz-text": b.bizText,
      "--p-biz-ink": b.bizInk,
      "--p-biz-soft": b.bizSoft,
      "--p-biz-ring": b.bizRing,
      "--p-biz-wash": b.bizWash,
      "--p-tint": b.biz,
      "--p-tint-text": b.bizText,
      "--p-tint-soft": b.bizSoft,
      "--p-tint-ring": b.bizRing,
    } as CSSProperties;
  }, [model?.accent, dark]);

  const messages = [...view.messages].sort((a, b) => a.seq - b.seq);
  const lines = messages.flatMap((m): Line[] => {
    if (m.kind === "notice") return [{ id: m.id, from: "sys", text: canvas.chat.piiShort, warn: true }];
    const t = messageText(m);
    if (!t) return [];
    return [{ id: m.id, from: m.role === "user" ? "me" : "ai", text: t, warn: false }];
  });
  const allLines: Line[] = [
    ...lines,
    ...sent.map((t, i): Line => ({ id: `sent-${i}`, from: "me", text: t, warn: false })),
  ];
  const blockCount = order.length;
  // «Система готова»: back to the top of the canvas, like after the last block of the prototype.
  const finished = progress.phase === "done";
  useEffect(() => {
    if (!finished) return;
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }, [finished]);
  const failure = stage === "failed" || progress.phase === "failed" ? progress.failure : null;

  let dock: ReactNode = null;
  /** The dock shows only the last lines of the chat (a short brief replaces them, V3-06). */
  let recentOnly = false;
  if (selected && actions) {
    dock = (
      <div className={s.pick} data-testid="canvas-pick">
        {actions.variant && (
          <p className={s.pickMeta} data-testid="canvas-pick-variant">
            {canvas.pick.variantOf(actions.variant.index, actions.variant.of)}
          </p>
        )}
        {actions.params.length > 0 && (
          <fieldset className={s.params} data-testid="canvas-params">
            <legend className={s.srOnly}>{canvas.pick.params}</legend>
            {actions.params.map((c) => (
              <fieldset key={c.param} className={s.paramSet}>
                <legend className={c.kind === "bool" ? s.srOnly : s.paramLabel}>{c.label}</legend>
                <div className={s.param}>
                  {c.options.map((o) => (
                    <Chip
                      key={o.id}
                      tone="outline"
                      pressed={o.pressed}
                      disabled={busy !== null}
                      testId={`canvas-param-${c.param}${c.kind === "bool" ? "" : `-${o.id}`}`}
                      onClick={() => void edit(o.edits, o.said)}
                    >
                      {o.label}
                    </Chip>
                  ))}
                </div>
              </fieldset>
            ))}
          </fieldset>
        )}
        <p className={s.pickNote} data-testid="canvas-pick-note">
          {built ? canvas.pick.built : canvas.pick.free}
        </p>
      </div>
    );
  } else if (stage === "interview" && question) {
    // V3-03: a v3 question has «Почему советуем», «Решите за меня» and «Дальше решай сам» as its own buttons.
    const q3 = v3Question(question);
    dock = (
      <div className={s.qwrap}>
        <QuestionCard
          key={question.id}
          testId="canvas-question"
          step={q3 ? v3Ru.question.step(q3.step) : canvas.chat.step(qIndex + 1, questions.length)}
          question={question.text}
          {...(question.whyItMatters ? { hint: question.whyItMatters } : {})}
          options={(q3?.options ?? question.options).map((o) => ({
            id: o.id,
            label: o.label,
            recommended: o.recommended,
          }))}
          selected={[]}
          onToggle={(id) => {
            const o = question.options.find((x) => x.id === id);
            if (o) answer(question, { questionId: question.id, optionId: o.id }, o.label);
          }}
          {...(q3
            ? {
                ...(q3.why ? { recommendationWhy: q3.why } : {}),
                ...(q3.delegate
                  ? {
                      onDelegate: () =>
                        answer(
                          question,
                          { questionId: question.id, optionId: DELEGATE_OPTION_ID },
                          v3Ru.question.delegated,
                        ),
                    }
                  : {}),
                onFinish: () => {
                  setSent((x) => [...x, v3Ru.question.finished]);
                  void submitAnswers(answers, true);
                },
                assistDisabled: busy !== null,
              }
            : {})}
        />
        {!q3 && (
          <div className={s.qfoot}>
            <ActionButton
              variant="ghost"
              size="sm"
              testId="canvas-rest"
              disabled={busy !== null}
              onClick={() => void submitAnswers(answers, true)}
            >
              {canvas.chat.rest}
            </ActionButton>
          </div>
        )}
      </div>
    );
  } else if (stage === "card" && plan && !runActive && sketch?.stage === "plan") {
    const errors = plan.errors ?? [];
    dock = (
      <div className={s.sum} data-testid="canvas-plan-card">
        <div className={s.sumText}>
          <p className={s.sumTitle}>{built ? canvas.plan.changed : canvas.plan.title}</p>
          <p className={s.sumMeta}>
            {[
              canvas.plan.goals(sketch.goals.length),
              canvas.plan.blocks(blockCount),
              ...(sketch.outOfScope.length > 0 ? [canvas.plan.out(sketch.outOfScope.length)] : []),
            ].join(" · ")}
            {" · "}
            {canvas.plan.free}
          </p>
          {errors.length > 0 && (
            <div role="alert" className={s.errors} data-testid="canvas-plan-errors">
              <p>{canvas.plan.errors}</p>
              <ul>
                {errors.slice(0, 3).map((e) => (
                  <li key={`${e.code}${e.path ?? ""}`}>{e.message_ru}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <ActionButton
          variant="create"
          testId="canvas-approve"
          busy={busy === "approve"}
          disabled={busy !== null || errors.length > 0}
          onClick={() => void approve()}
        >
          {busy === "approve" ? canvas.plan.approving : built ? canvas.plan.rebuild : canvas.plan.build}
        </ActionButton>
      </div>
    );
  } else if (failure) {
    dock = (
      <div className={s.fail} role="alert" data-testid="canvas-failure">
        <p className={s.failTitle}>{canvas.failed.title}</p>
        <p className={s.failText}>
          {canvas.failed.reasons[failure.code] ?? (failure.message || canvas.failed.generic)}
        </p>
        <details className={s.more} data-testid="canvas-failure-more">
          <summary>{canvas.failed.more}</summary>
          <dl>
            <dt>{canvas.failed.code}</dt>
            <dd>{failure.code}</dd>
            {failure.stage && (
              <>
                <dt>{canvas.failed.stage}</dt>
                <dd>{canvas.build.stages[failure.stage] ?? failure.stage}</dd>
              </>
            )}
            {failure.message && (
              <>
                <dt>{canvas.failed.message}</dt>
                <dd>{failure.message}</dd>
              </>
            )}
          </dl>
        </details>
        {failure.code !== "PLAN_INVALID" && (
          <ActionButton
            variant="primary"
            size="sm"
            testId="canvas-retry"
            disabled={busy !== null || runActive}
            onClick={() => void retry()}
          >
            {canvas.failed.retry}
          </ActionButton>
        )}
      </div>
    );
  } else if (building) {
    dock = (
      <div className={s.bRow} data-testid="canvas-build-row" aria-live="polite">
        <span className={s.spark} aria-hidden="true" />
        <span className={s.k}>{canvas.build.doing}</span>
        <b className={s.bStep} data-testid="canvas-build-step">
          {progress.label || canvas.build.stages.plan}
        </b>
        {progress.index > 0 && (
          <span className={s.count}>
            {canvas.chat.step(progress.index, progress.total)}
            <span className={s.etaInline}> · {remainingText(progress.remainingSec)}</span>
          </span>
        )}
        {progress.reused > 0 && <p className={s.note}>{canvas.build.reused(progress.reused)}</p>}
      </div>
    );
  } else if (ready && readyCard) {
    dock = (
      <div className={s.ready} data-testid="canvas-ready">
        <Serif as="p" size="lg">
          {canvas.ready.title}
        </Serif>
        <p className={s.sumMeta}>{canvas.ready.meta(blockCount)}</p>
        <div className={s.readyA}>
          <ActionButton variant="primary" testId="canvas-open-site" onClick={() => chooseView("site")}>
            {canvas.ready.open.site}
          </ActionButton>
          <ActionButton testId="canvas-open-cab" onClick={() => chooseView("cab")}>
            {canvas.ready.open.cab}
          </ActionButton>
          {(model?.frames.phone.length ?? 0) > 0 && (
            <ActionButton testId="canvas-open-phone" onClick={() => chooseView("phone")}>
              {canvas.ready.open.phone}
            </ActionButton>
          )}
        </div>
      </div>
    );
  } else if (allLines.length > 0) {
    recentOnly = true;
    dock = (
      <ol className={s.recent} data-testid="canvas-recent">
        {allLines.slice(-3).map((l) => (
          <li key={l.id}>
            <ChatMessage from={l.from} {...(l.warn ? { tone: "warn" as const } : {})}>
              {l.text}
            </ChatMessage>
          </li>
        ))}
      </ol>
    );
  }

  // V3-06: before «Собрать» a system with a brief shows the short brief in the chat (above the plan card).
  // V3-04: the result of «Приложить ТЗ» (short brief and gaps) stays above the question until «Понятно».
  if (upload.card)
    dock = (
      <>
        {upload.card}
        {dock}
      </>
    );
  else if (
    brief.summary &&
    !runActive &&
    !building &&
    !selected &&
    (stage === "card" || (stage === "interview" && !question))
  )
    dock = recentOnly ? (
      brief.summary
    ) : (
      <>
        {brief.summary}
        {dock}
      </>
    );

  // V3-04: a v3 system (it has a brief, or its question is a v3 one) offers «Приложить ТЗ» until the build.
  const v3 = brief.available || questions.some((q) => v3Question(q) !== null);
  const composerState = building ? "building" : thinking || busy === "answers" ? "thinking" : "idle";
  const placeholder = building
    ? canvas.chat.building
    : thinking
      ? canvas.chat.thinking
      : question
        ? canvas.chat.custom
        : stage === "interview" && !sketch
          ? canvas.chat.start
          : canvas.chat.change;
  const canType = !building && !thinking && question?.allowCustom !== false;

  return (
    <ThemeRoot theme={theme} className={s.root} testId="canvas-root">
      <div
        ref={screenRef}
        className={s.screen}
        style={tint}
        data-biz={tint ? "" : undefined}
        data-testid="canvas"
      >
        <Glass as="header" className={s.top} testId="canvas-top">
          <span className={s.brand}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect className={s.m1} x="2" y="2" width="10" height="10" rx="3" />
              <rect className={s.m2} x="8" y="8" width="10" height="10" rx="3" />
            </svg>
            <span className={s.wm}>{canvas.brand}</span>
          </span>
          {model && (
            <span className={s.sys}>
              <Serif as="h1" size="md" className={s.sysName} testId="canvas-name">
                {view.system.name || sketch?.niche}
              </Serif>
            </span>
          )}
          <span className={s.grow} />
          {building && (
            <span
              className={s.eta}
              role="progressbar"
              aria-label={canvas.build.ring}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress.fraction * 100)}
              data-testid="canvas-eta"
            >
              <svg className={s.ringSm} width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
                <circle className={s.tr} cx="11" cy="11" r="8.5" />
                <circle
                  className={s.fg}
                  cx="11"
                  cy="11"
                  r="8.5"
                  pathLength="100"
                  strokeDasharray="100"
                  strokeDashoffset={(100 - progress.fraction * 100).toFixed(1)}
                />
              </svg>
              <span className={s.num} data-testid="canvas-eta-text">
                {remainingText(progress.remainingSec)}
              </span>
            </span>
          )}
          {ready && (
            <div
              className={s.seg}
              role="radiogroup"
              aria-label={canvas.views.label}
              data-testid="canvas-views"
            >
              {(["site", "cab", "phone"] as const)
                .filter((v) => (model?.frames[v].length ?? 0) > 0)
                .map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={board === v}
                    data-testid={`canvas-view-${v}`}
                    onClick={() => chooseView(v)}
                  >
                    {canvas.views[v]}
                  </button>
                ))}
            </div>
          )}
          <span className={s.grow} />
          {brief.available && (
            <button
              type="button"
              className={s.tbtn}
              aria-pressed={brief.open}
              aria-haspopup="dialog"
              aria-label={briefRu.button}
              data-testid="canvas-brief-toggle"
              onClick={() => {
                pick(null);
                brief.show();
              }}
            >
              <svg className={s.icon} viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 3.5h7l4 4v13H7z" />
                <path d="M14 3.5v4h4M10 12h5M10 15.5h5" />
              </svg>
              <span className={s.lx}>{briefRu.button}</span>
            </button>
          )}
          {xray && (
            <button
              type="button"
              className={s.tbtn}
              aria-pressed={xrayVisible}
              aria-label={canvas.xray.button}
              data-testid="canvas-xray-toggle"
              onClick={() => {
                setManualXray(!xrayVisible);
                pick(null);
              }}
            >
              <svg className={s.icon} viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="6" cy="6" r="2.5" />
                <circle cx="18" cy="12" r="2.5" />
                <circle cx="6" cy="18" r="2.5" />
                <path d="M8.3 7.2 15.6 11M8.3 16.8l7.3-3.8" />
              </svg>
              <span className={s.lx}>{canvas.xray.button}</span>
            </button>
          )}
          <button
            type="button"
            className={`${s.tbtn} ${s.iconOnly}`}
            aria-label={support.open}
            title={support.open}
            data-testid="canvas-support"
            onClick={() => openSupport()}
          >
            <svg className={s.icon} viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 5h16v11H9l-5 4z" />
            </svg>
          </button>
          <button
            type="button"
            className={`${s.tbtn} ${s.iconOnly}`}
            aria-pressed={dark}
            aria-label={dark ? canvas.theme.toLight : canvas.theme.toDark}
            data-testid="canvas-theme"
            onClick={toggleTheme}
          >
            <svg className={s.icon} viewBox="0 0 24 24" aria-hidden="true">
              {dark ? (
                <>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
                </>
              ) : (
                <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
              )}
            </svg>
          </button>
        </Glass>

        <div className={`${s.veil} ${s.veilTop}`} aria-hidden="true" />
        <div className={`${s.veil} ${s.veilBottom}`} aria-hidden="true" />
        <main className={s.canvas} data-testid="canvas-main">
          {view.demoReplay && (
            <p className={s.demo} role="status" data-testid="demo-replay">
              {demo.banner}
            </p>
          )}
          {model ? (
            <Board
              model={model}
              slug={view.system.slug}
              view={xrayVisible ? "overview" : board}
              stateOf={stateOf}
              delayOf={delayOf}
              born={fx.born}
              touched={fx.touched}
              xray={xray}
              xrayVisible={xrayVisible}
              selected={selected?.id ?? null}
              {...(canPick ? { onSelect: (b: CanvasBlockModel) => pick(b) } : {})}
            />
          ) : (
            <div className={s.empty} aria-busy={thinking || undefined} data-testid="canvas-empty">
              <Serif as="p" size="xl">
                {canvas.chat.thinking}
              </Serif>
            </div>
          )}
        </main>
        {xray && xrayVisible && <XrayData xray={xray} />}

        <ChatSheet
          open={open}
          onOpenChange={setOpen}
          label={canvas.chat.label}
          testId="canvas-sheet"
          history={allLines.map((l) => (
            <ChatMessage
              key={l.id}
              from={l.from}
              testId="canvas-message"
              {...(l.warn ? { tone: "warn" as const } : {})}
            >
              {l.text}
            </ChatMessage>
          ))}
        >
          {dock}
          {notice && (
            <p className={s.sheetNotice} role="status" data-testid="canvas-notice">
              {notice}
            </p>
          )}
          {undo && !selected && (
            <p className={s.undo} role="status" data-testid="canvas-undo">
              <span>{canvas.pick.removed(undo.title)}</span>
              <Chip
                tone="outline"
                testId="canvas-undo-button"
                disabled={busy !== null}
                onClick={() => void edit(undo.edits, canvas.pick.said.undo(undo.title))}
              >
                {canvas.pick.undo}
              </Chip>
            </p>
          )}
          {error && (
            <p className={s.error} role="alert" data-testid="canvas-error">
              {error}
            </p>
          )}
          {upload.progress}
          <Composer
            testId="canvas-composer"
            attach={v3 && !building && (stage === "interview" || stage === "card") ? upload.attach : null}
            value={text}
            onChange={setText}
            onSubmit={(t) => void send(t)}
            placeholder={placeholder}
            state={composerState}
            disabled={!canType || busy !== null}
            target={selected ? { label: selected.title, onClear: () => pick(null) } : null}
            suggestions={actions?.hints.map((h) => ({ id: h.id, label: h.label })) ?? []}
            onSuggestion={hint}
          />
        </ChatSheet>
        {brief.panel}
        <div className={s.srOnly} aria-live="polite" data-testid="canvas-live">
          {live}
        </div>
      </div>
    </ThemeRoot>
  );
}
