// Canvas v4 /s/:systemId (V4-11, D79_v4 (8), grill-9 №4): the client system on the whole window, 1 to 1 — the live
// draft runtime at the real width of the window (or 390 px for «Телефон»), working forms, booking and payment. Everything
// else floats: an island of icons (chat, the build with its ring, brief, device, edit, publication) that hides on
// Ctrl/Cmd+B, and panels that slide over the system from the right (from below on a phone) without changing its width.
// Esc or a click on the system closes them. During a build a thin bar runs along the top and short notices say what
// landed; the frame changes in batches, never showing a half-built page (preview/SystemFrame.tsx). Systems of the
// modules pipeline v2 open here too: the board v2 is gone, their plan is approved from the chat.
import "@wizard/ui-kit/v2/theme.css";
import {
  ActionButton,
  ChatMessage,
  Composer,
  Glass,
  PLATFORM_COLORS,
  QuestionCard,
  ThemeRoot,
} from "@wizard/ui-kit/v2";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../api/client.js";
import type {
  Answer,
  GoalQuestion,
  Message,
  RunEvent,
  SystemPlanRevision,
  SystemView,
} from "../../api/types.js";
import { canEdit, canOwn, usePlatform } from "../../app/context.js";
import { AppLink } from "../../components/v2/Shell.js";
import { openSupport } from "../../features/support/SupportWidget.js";
import { canvas } from "../../i18n/ru/canvas.js";
import { demo } from "../../i18n/ru/demo.js";
import { ru } from "../../i18n/ru.js";
import { type Device, openPreviewTab, SystemFrame } from "../../preview/SystemFrame.js";
import { subscribeRun } from "../../run/stream.js";
import { useCanvasBrief } from "../brief/CanvasBrief.js";
import { useBriefUpload } from "../v3/BriefUpload.js";
import { lastReportRun, useV3Live } from "../v3/build/index.js";
import { useKeyWindows } from "../v3/keys/index.js";
import { publishRunState, V3PublishCard } from "../v3/publish/index.js";
import { DELEGATE_OPTION_ID, v3Question } from "../v3/question.js";
import { v3Ru } from "../v3/ru.js";
import { StyleDrawer, spentLine, V3BuildCard } from "../v3/V3Build.js";
import { buildProgress, remainingText } from "./buildProgress.js";
import s from "./Canvas.module.css";
import { islandRu, stageRu } from "./ru.js";

export interface CanvasProps {
  systemId: string;
  /** GET /systems/:id already read by the route (pipeline = modules). */
  initial: SystemView;
}

type PanelId = "chat" | "build" | "publish";

interface Line {
  id: string;
  from: "me" | "ai" | "sys";
  text: string;
  warn: boolean;
}

interface LocalAnswerRow {
  answer: Answer;
  label: string;
}

const NO_EVENTS: RunEvent[] = [];
/** api.yaml postAnswers: an answer in own words is at most this long (longer — refused before the request). */
const ANSWER_MAX = 500;
/** A build notice stays this long over the system. */
const NEWS_MS = 4000;

const errText = (e: unknown) => (e instanceof Error ? e.message : ru.errors.generic);

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

function messageText(m: Message): string {
  if (m.role === "user") {
    const masked = m.payload?.maskedText;
    const text = typeof masked === "string" ? masked : (m.text ?? "");
    // B2-29: a wish to a canvas block of a v2 system carries its label.
    const block = m.payload?.block as { title?: unknown } | undefined;
    return typeof block?.title === "string" && text ? canvas.pick.wish(block.title, text) : text;
  }
  return m.text ?? "";
}

function isGoalQuestion(q: unknown): q is GoalQuestion {
  const o = q as GoalQuestion;
  return !!o && typeof o.id === "string" && typeof o.text === "string" && Array.isArray(o.options);
}

/** An icon of the island: 24×24 strokes. */
function Icon({ d }: { d: string }): ReactNode {
  return (
    <svg className={s.icon} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  chat: "M4 5h16v11H9l-5 4z",
  brief: "M7 3.5h7l4 4v13H7zM14 3.5v4h4M10 12h5M10 15.5h5",
  desktop: "M3.5 5h17v11h-17zM9 20h6M12 16v4",
  phone: "M8 3h8v18H8zM11 18h2",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  publish: "M12 15V4M7.5 8.5 12 4l4.5 4.5M5 14v6h14v-6",
  open: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  hide: "M6 9l6 6 6-6",
  show: "M6 15l6-6 6 6",
  home: "M4 11 12 4l8 7M6 9.5V20h12V9.5",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  support: "M12 21a9 9 0 1 0-9-9c0 1.6.4 3 1.1 4.3L3 21l4.7-1.1A9 9 0 0 0 12 21z",
  close: "M6 6l12 12M18 6 6 18",
} as const;

export function Canvas({ systemId, initial }: CanvasProps): ReactNode {
  const { api, auth, roleIn } = usePlatform();
  const [styleOpen, setStyleOpen] = useState(false);
  const [view, setView] = useState<SystemView>(initial);
  const [plan, setPlan] = useState<SystemPlanRevision | null>(null);
  const [runId, setRunId] = useState<string | null>(initial.activeRunId ?? null);
  /** V3-19: the publish run started from the canvas (before its run_started arrives). */
  const [publishRunId, setPublishRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [answers, setAnswers] = useState<LocalAnswerRow[]>([]);
  /** V3-18: the last chat turn sent (answers or a message) — «Повторить» of a failed turn sends it again. */
  const retryTurn = useRef<(() => Promise<unknown>) | null>(null);
  const [sent, setSent] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const [news, setNews] = useState<{ id: number; text: string } | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [hidden, setHidden] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [openError, setOpenError] = useState(false);
  const route = useRef("/");
  const dark = useDarkScheme();

  const stage = view.system.stage;
  const built = view.system.previewRevision != null;
  // Nothing to look at yet (the interview, the brief before «Собрать»): the chat is open from the start.
  const [panel, setPanel] = useState<PanelId | null>(() =>
    initial.system.previewRevision == null && initial.system.stage !== "building" ? "chat" : null,
  );

  // The floating «Написать команде» would cover the island: on the canvas it lives in «Ещё» (D68).
  useEffect(() => {
    document.documentElement.setAttribute("data-wz-canvas", "");
    return () => document.documentElement.removeAttribute("data-wz-canvas");
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
  const screenRef = useRef<HTMLDivElement>(null);
  const focusInput = useCallback(() => {
    setPanel("chat");
    setHidden(false);
    requestAnimationFrame(() =>
      screenRef.current?.querySelector<HTMLElement>('[data-testid="p-composer-input"]')?.focus(),
    );
  }, []);
  // V3-06: the system brief (a system with a brief v3): «Бриф» in the island, short brief before «Собрать», the panel.
  const brief = useCanvasBrief(systemId, { orgId: view.system.orgId, announce, onAskInChat: focusInput });
  // V3-04: «Приложить ТЗ» of a v3 system — the new version goes straight to the brief.
  const upload = useBriefUpload(systemId, { onUploaded: brief.adopt, onOpen: brief.show, announce });
  const reloadBrief = brief.reload;

  const reload = useCallback(async () => {
    const v = await api.getSystem(systemId);
    setView(v);
    return v;
  }, [api, systemId]);

  const loadPlan = useCallback(async () => {
    try {
      setPlan((await api.getSystemPlan(systemId)).plan);
    } catch {
      // No plan (a v3 system, the interview) or a network blip: the canvas keeps what it has.
    }
  }, [api, systemId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opened system
  useEffect(() => {
    if (initial.system.stage !== "interview") void loadPlan();
  }, []);

  const onEvent = useCallback(
    (e: RunEvent) => {
      setEvents((xs) => (xs.some((x) => x.seq === e.seq) ? xs : [...xs, e]));
      if (e.type === "chat_output") {
        void reload().catch(() => {});
        reloadBrief();
        if (e.payload.kind === "plan") {
          setAnswers([]);
          void loadPlan();
        }
      }
      if (e.type === "run_finished" || e.type === "run_failed") {
        // V3-18: a failed turn leaves its question pending — it is asked again, not hidden by the answer given.
        if (e.type === "run_failed") setAnswers([]);
        setSent([]);
        void reload().catch(() => {});
        void loadPlan();
        reloadBrief();
      }
    },
    [reload, loadPlan, reloadBrief],
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
  // V3-17: a v3 system opened after its build replays that build from the server (scenarios, spend, revision).
  const reportRun = useMemo(() => lastReportRun(view.messages), [view.messages]);
  const replayedV3 = useRef(false);
  useEffect(() => {
    if (replayedV3.current || runId !== null || !reportRun || plan || !brief.available) return;
    if (stage !== "ready" && stage !== "failed") return;
    replayedV3.current = true;
    setRunId(reportRun);
  }, [runId, reportRun, plan, brief.available, stage]);

  const runKind = events.find((e) => e.type === "run_started")?.payload.kind;
  const progress = useMemo(() => buildProgress(runKind === "build" ? events : []), [runKind, events]);
  const role = roleIn(view.system.orgId);
  const editable = canEdit(role, auth);
  // V3-18: «Остановить сборку» of the followed build (POST /runs/:id/cancel), for those who may edit the system.
  const stopBuild = useCallback(async () => {
    if (runId) await api.cancelRun(runId);
  }, [api, runId]);
  const runActive =
    runId !== null && !events.some((e) => e.type === "run_finished" || e.type === "run_failed");
  const onNews = useCallback((t: string) => setNews({ id: Date.now(), text: t }), []);
  const closePanels = useCallback(() => {
    setPanel(null);
    setMoreOpen(false);
  }, []);
  // V3-17: the live v3 build from the structured progress of the run's events (panel, revision, toast, time).
  const v3live = useV3Live({
    systemId,
    name: view.system.name,
    events: runKind === "build" ? events : NO_EVENTS,
    announce,
    onNews,
    onLook: closePanels,
    ...(runKind === "build" && editable ? { onStop: stopBuild } : {}),
  });
  // V3-06: «потрачено X ₽ из Y» while a build runs — the v3 progress, else the harness v3 lines.
  const spend = runKind === "build" ? (v3live.spend ?? spentLine(events)) : null;
  const eta = v3live.remainingSec ?? progress.remainingSec;
  // V3-19: a publish run is followed in the publication card, not as the model «thinking».
  const publishing = runId !== null && (runKind === "publish" || runId === publishRunId);
  const publishRun = useMemo(() => (publishing ? publishRunState(events) : null), [publishing, events]);
  const thinking = runActive && runKind !== "build" && !publishing;
  // V3-21: a key typed into the chat is not sent — the platform's key window takes it; the agent's key requests.
  const keys = useKeyWindows({
    systemId,
    enabled: brief.available,
    editable,
    // V3-18: prod keys are the owner's (the server answers NOT_OWNER); unknown role — the server decides.
    ...(role ? { owner: canOwn(role) } : {}),
    live: runActive,
    refresh: `${view.messages.length}:${stage}:${runActive}`,
    composer: text,
    setComposer: setText,
    announce,
  });

  const questions = (view.pendingQuestions ?? []).filter(isGoalQuestion) as unknown as GoalQuestion[];
  // V3-03: the v3 interview asks one question per turn — a new pending question starts with no local answers.
  const qKey = questions.map((q) => q.id).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new set of pending questions only
  useEffect(() => {
    if (questions.some((q) => v3Question(q) !== null)) setAnswers([]);
  }, [qKey]);
  const qIndex = answers.length;
  // V3-18: a pending question is asked at any stage (the edit loop of a built v3 system asks too), not during a build.
  const question = !thinking && stage !== "building" ? questions[qIndex] : undefined;
  // V3-18: a chat turn that failed says why and offers to send it again (a build or a publication say it themselves).
  const failedEvent = events.find((e) => e.type === "run_failed");
  const turnFailure =
    failedEvent && runKind !== "build" && !publishing
      ? {
          text:
            typeof failedEvent.payload.message_ru === "string" && failedEvent.payload.message_ru
              ? failedEvent.payload.message_ru
              : canvas.chat.turnFailed,
          retry: failedEvent.payload.retryable !== false ? retryTurn.current : null,
        }
      : null;

  const building = stage === "building" || (runKind === "build" && progress.phase === "running");
  const ready = stage === "ready" && !runActive;
  const sketch = plan?.sketch?.stage === "plan" ? plan.sketch : null;
  const fraction = v3live.live ? v3live.fraction : progress.fraction;
  const stepLabel = v3live.stageLabel ?? (progress.label || canvas.build.stages.plan);
  // The newest revision with a preview: the system as saved, or the one the running build grew to.
  const revision = Math.max(view.system.previewRevision ?? -1, v3live.previewRevision ?? -1);
  const shownRevision = revision >= 0 ? revision : null;

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

  // A build started: the panels give the whole window back to the system (the bar and notices say how it goes).
  const started = useCallback(
    (id: string) => {
      setRunId(id);
      closePanels();
      announce(canvas.build.ring);
    },
    [announce, closePanels],
  );

  async function submitAnswers(rows: LocalAnswerRow[], rest = false): Promise<boolean> {
    const r = await act("answers", () =>
      api.postAnswers(systemId, {
        answers: rows.map((a) => a.answer),
        ...(rest ? { restByRecommendation: true } : {}),
      }),
    );
    if (!r) return false;
    retryTurn.current = () => submitAnswers(rows, rest);
    setRunId(r.run.id);
    await reload().catch(() => {});
    return true;
  }

  /** An answer to the question; `typed` — the own words from the composer, put back if the answer is refused. */
  function answer(a: Answer, label: string, typed?: string) {
    const before = answers;
    const rows = [...answers, { answer: a, label }];
    setAnswers(rows);
    setSent((x) => [...x, label]);
    announce(canvas.chat.answered(label));
    if (rows.length < questions.length) return;
    void submitAnswers(rows).then((ok) => {
      if (ok) return;
      // V3-18: the answer did not go — the question comes back, and the own words return to the composer.
      setAnswers(before);
      setSent((x) => {
        const i = x.lastIndexOf(label);
        return i < 0 ? x : [...x.slice(0, i), ...x.slice(i + 1)];
      });
      if (typed !== undefined) setText((cur) => cur || typed);
    });
  }

  async function send(t: string) {
    const value = t.trim();
    if (!value) return;
    // V3-21: a message with an access key never leaves the page; the key window is offered instead.
    if (keys.intercept(value)) return;
    if (question) {
      if (question.allowCustom === false) return;
      if (value.length > ANSWER_MAX) {
        setError(canvas.chat.answerTooLong(value.length, ANSWER_MAX));
        return;
      }
      setError(null);
      setText("");
      answer({ questionId: question.id, text: value }, value, t);
      return;
    }
    const post = async (first: boolean): Promise<void> => {
      const r = await act("message", () => api.postMessage(systemId, value, {}));
      if (!r) return;
      retryTurn.current = () => post(false);
      if (first) setText("");
      setSent((x) => [...x, value]);
      setRunId(r.run.id);
      await reload().catch(() => {});
    };
    await post(true);
  }

  async function approve() {
    if (!plan) return;
    const r = await act("approve", () => api.approvePlan(systemId, plan.revision));
    if (!r) return;
    setNotice(null);
    started(r.run.id);
    await reload().catch(() => {});
  }

  async function retry() {
    const r = await act("fix", () => api.startFix(systemId));
    if (!r) return;
    started(r.run.id);
    await reload().catch(() => {});
  }

  async function openTab() {
    setMoreOpen(false);
    setOpenError(!(await openPreviewTab(api, systemId, route.current)));
  }
  const onRoute = useCallback((r: string) => {
    route.current = r;
  }, []);

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
  const failure = stage === "failed" || progress.phase === "failed" ? progress.failure : null;

  // ——— what the chat asks of the owner now (a question, a card to act on) ———
  let dock: ReactNode = null;
  /** The owner has something to answer or press: the chat opens by itself. */
  let attention: string | null = null;
  if (question) {
    // V3-03: a v3 question has «Почему советуем», «Решите за меня» and «Дальше решай сам» as its own buttons.
    const q3 = v3Question(question);
    attention = `q:${question.id}`;
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
            if (o) answer({ questionId: question.id, optionId: o.id }, o.label);
          }}
          {...(q3
            ? {
                ...(q3.why ? { recommendationWhy: q3.why } : {}),
                ...(q3.delegate
                  ? {
                      onDelegate: () =>
                        answer(
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
  } else if (stage === "card" && plan && !runActive && sketch) {
    // A v2 system: its plan is approved from the chat (the board v2 is gone, V4-11).
    const errors = plan.errors ?? [];
    attention = `plan:${plan.revision}`;
    dock = (
      <div className={s.sum} data-testid="canvas-plan-card">
        <div className={s.sumText}>
          <p className={s.sumTitle}>{built ? canvas.plan.changed : canvas.plan.title}</p>
          <p className={s.sumMeta}>
            {[
              canvas.plan.goals(sketch.goals.length),
              canvas.plan.blocks(sketch.modules.length),
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
    attention = `fail:${failure.code}`;
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
  } else if (ready && v3live.ready) {
    // V3-17: after a v3 build the chat says «Система готова»; «Посмотреть» closes the panel over the system.
    dock = v3live.ready;
  }
  // V3-18: the agent's reply to a wish about a built system stays in sight.
  const lastMessage = messages[messages.length - 1];
  const lastReply =
    lastMessage?.role === "assistant" && lastMessage.kind === "text" && lastMessage.text
      ? lastMessage.text
      : null;
  // V3-18: a chat turn that failed — its reason and «Повторить» above whatever the chat shows.
  if (turnFailure) {
    attention = `turn:${failedEvent?.runId ?? ""}`;
    dock = (
      <>
        <div className={s.fail} role="alert" data-testid="canvas-turn-failed">
          <p className={s.failText}>{turnFailure.text}</p>
          {turnFailure.retry && (
            <ActionButton
              variant="primary"
              size="sm"
              testId="canvas-turn-retry"
              disabled={busy !== null || runActive}
              onClick={() => void turnFailure.retry?.()}
            >
              {ru.errors.retry}
            </ActionButton>
          )}
        </div>
        {dock}
      </>
    );
  }
  // V3-06: a v3 system with its brief ready (no plan) — the short brief, the style and «Собрать» (startV3Build).
  const v3Ready = !!brief.current && stage === "card" && !plan && !runActive && !building;
  if (v3Ready && brief.current) {
    attention = `build:${brief.current.version}`;
    dock = (
      <>
        {brief.summary}
        <V3BuildCard
          systemId={systemId}
          version={brief.current.version}
          brief={brief.current.brief}
          editable={editable}
          onStyle={() => setStyleOpen(true)}
          onStale={brief.reload}
          onStarted={(run) => {
            started(run.id);
            void reload().catch(() => {});
          }}
        />
      </>
    );
  }
  // V3-04: the result of «Приложить ТЗ» (short brief and gaps) stays above the question until «Понятно».
  if (upload.card) {
    attention = "upload";
    dock = (
      <>
        {upload.card}
        {dock}
      </>
    );
  } else if (
    brief.summary &&
    !v3Ready &&
    !runActive &&
    !building &&
    (stage === "card" || (stage === "interview" && !question))
  )
    dock = (
      <>
        {brief.summary}
        {dock}
      </>
    );
  // V3-21: the key window (interception, the agent's request, the result) stays above whatever the chat shows.
  if (keys.card) {
    attention = "keys";
    dock = (
      <>
        {keys.card}
        {dock}
      </>
    );
  }

  // The chat opens by itself when it asks something new of the owner.
  const seenAttention = useRef<string | null>(null);
  useEffect(() => {
    if (attention === seenAttention.current) return;
    seenAttention.current = attention;
    if (attention) {
      setPanel("chat");
      setHidden(false);
    }
  }, [attention]);

  // V3-19: a built v3 system — what stops the publication, the owner's data, «Опубликовать», the site and the cabinet.
  const canPublish = brief.available && (built || publishing);
  const publishCard = canPublish ? (
    <V3PublishCard
      systemId={systemId}
      view={view}
      run={publishRun}
      announce={announce}
      onStarted={(run) => {
        setPublishRunId(run.id);
        setRunId(run.id);
      }}
      onChanged={() => void reload().catch(() => {})}
      {...(editable ? { onFix: () => void retry(), fixing: busy === "fix" } : {})}
    />
  ) : null;

  // Esc closes the panel; Ctrl/Cmd+B hides the island and its panels (and shows them again).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setHidden((h) => !h);
        closePanels();
        return;
      }
      if (e.key === "Escape" && !brief.open && !styleOpen) closePanels();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [brief.open, styleOpen, closePanels]);
  // A click on the system (focus goes into its frame) closes the panel over it.
  useEffect(() => {
    if (panel === null && !moreOpen) return;
    const onBlur = () =>
      setTimeout(() => {
        const el = document.activeElement;
        if (el instanceof HTMLIFrameElement && screenRef.current?.contains(el)) closePanels();
      }, 0);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [panel, moreOpen, closePanels]);
  // A build notice disappears by itself.
  useEffect(() => {
    if (!news) return;
    const t = setTimeout(() => setNews(null), NEWS_MS);
    return () => clearTimeout(t);
  }, [news]);

  // V3-04: a v3 system (it has a brief, or its question is a v3 one) offers «Приложить ТЗ» until the build.
  const v3 = brief.available || questions.some((q) => v3Question(q) !== null);
  const composerState = building ? "building" : thinking || busy === "answers" ? "thinking" : "idle";
  const placeholder = building
    ? canvas.chat.building
    : thinking
      ? canvas.chat.thinking
      : question
        ? canvas.chat.custom
        : stage === "interview"
          ? canvas.chat.start
          : canvas.chat.change;
  const canType = !building && !thinking && question?.allowCustom !== false;
  const hasBuild = building || v3live.live !== null || progress.phase !== "idle";

  const placeholderNode =
    shownRevision !== null ? (
      <p className={s.emptyText}>{stageRu.loading}</p>
    ) : building ? (
      <div className={s.emptyBox}>
        <p className={s.emptyTitle}>{stepLabel}</p>
        <p className={s.emptyText}>{stageRu.pending}</p>
      </div>
    ) : thinking ? (
      <div className={s.emptyBox} aria-busy="true" data-testid="canvas-empty">
        <p className={s.emptyTitle}>{canvas.chat.thinking}</p>
      </div>
    ) : (
      // V3-18: the owner's turn before the build — what will appear here, not «Думаю».
      <div className={s.emptyBox} data-testid="canvas-empty">
        <div className={s.emptyBox} data-testid={v3 ? "canvas-v3-empty" : undefined}>
          <p className={s.emptyTitle}>{canvas.v3.emptyTitle}</p>
          <p className={s.emptyText}>
            {!v3 ? stageRu.v2Empty : stage === "card" ? canvas.v3.card : canvas.v3.interview}
          </p>
        </div>
      </div>
    );

  const toggle = (id: PanelId) => {
    setMoreOpen(false);
    setPanel((p) => (p === id ? null : id));
  };
  const leftText = remainingText(eta);

  const panelBody: Record<PanelId, { title: string; body: ReactNode }> = {
    chat: {
      title: canvas.chat.label,
      body: (
        <>
          <ol className={s.history} role="log" aria-label={canvas.chat.label} data-testid="canvas-history">
            {allLines.map((l) => (
              <li key={l.id}>
                <ChatMessage
                  from={l.from}
                  testId="canvas-message"
                  {...(l.warn ? { tone: "warn" as const } : {})}
                >
                  {l.text}
                </ChatMessage>
              </li>
            ))}
          </ol>
          <div className={s.dock} data-testid="canvas-dock">
            {lastReply && ready && !question && (
              <p className={s.lastReply} data-testid="canvas-last-reply">
                {lastReply}
              </p>
            )}
            {dock}
            {building && (
              <div className={s.bRow} data-testid="canvas-build-row" aria-live="polite">
                <span className={s.spark} aria-hidden="true" />
                <span className={s.k}>{canvas.build.doing}</span>
                <b className={s.bStep} data-testid="canvas-build-step">
                  {stepLabel}
                </b>
                {spend && (
                  <p className={s.note} data-testid="canvas-build-spend">
                    {spend}
                  </p>
                )}
              </div>
            )}

            {notice && (
              <p className={s.sheetNotice} role="status" data-testid="canvas-notice">
                {notice}
              </p>
            )}
            {error && (
              <p className={s.error} role="alert" data-testid="canvas-error">
                {error}
              </p>
            )}
            {upload.progress}
            {keys.row}
            {question && question.allowCustom !== false && text.trim().length > 0 && (
              <p
                className={`${s.limit} ${text.trim().length > ANSWER_MAX ? s.limitOver : ""}`}
                data-testid="canvas-answer-count"
              >
                {canvas.chat.answerCount(text.trim().length, ANSWER_MAX)}
              </p>
            )}
          </div>
          <Composer
            testId="canvas-composer"
            attach={v3 && !building && (stage === "interview" || stage === "card") ? upload.attach : null}
            value={text}
            onChange={setText}
            onSubmit={(t) => void send(t)}
            placeholder={placeholder}
            state={composerState}
            disabled={!canType || busy !== null}
          />
        </>
      ),
    },
    build: {
      title: stageRu.buildPanel,
      body: v3live.panel ?? (
        <div className={s.bPanel} data-testid="canvas-build-panel">
          {hasBuild ? (
            <>
              <p className={s.bStep} data-testid="canvas-build-step">
                {stepLabel}
              </p>
              {progress.index > 0 && (
                <p className={s.note}>
                  {canvas.chat.step(progress.index, progress.total)} · {leftText}
                </p>
              )}
              {progress.reused > 0 && <p className={s.note}>{canvas.build.reused(progress.reused)}</p>}
              {spend && <p className={s.note}>{spend}</p>}
            </>
          ) : (
            <p className={s.note}>{stageRu.noBuild}</p>
          )}
        </div>
      ),
    },
    publish: { title: stageRu.publishPanel, body: publishCard },
  };
  const current = panel && (panel !== "publish" || publishCard) ? panelBody[panel] : null;

  return (
    <ThemeRoot theme="auto" className={s.root} testId="canvas-root">
      <div ref={screenRef} className={s.screen} data-testid="canvas" data-panel={current ? panel : undefined}>
        <main className={s.main} data-testid="canvas-main">
          <h1 className={s.srOnly} data-testid="canvas-name">
            {view.system.name || canvas.brand}
          </h1>
          <SystemFrame
            systemId={systemId}
            revision={shownRevision}
            device={device}
            batching={building}
            title={view.system.name ? `${stageRu.frame}: ${view.system.name}` : stageRu.frame}
            placeholder={placeholderNode}
            onRoute={onRoute}
          />
        </main>

        {building && (
          <div
            className={s.bar}
            role="progressbar"
            aria-label={canvas.build.ring}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            aria-valuetext={`${stepLabel} · ${leftText}`}
            data-testid="canvas-eta"
          >
            <span className={s.barFill} style={{ transform: `scaleX(${Math.max(0.02, fraction)})` }} />
          </div>
        )}
        {view.demoReplay && (
          <p className={s.demo} role="status" data-testid="demo-replay">
            {demo.banner}
          </p>
        )}
        {news && !current && (
          <p key={news.id} className={s.news} role="status" data-testid="canvas-news">
            {news.text}
          </p>
        )}

        {current && panel && (
          <Glass
            as="aside"
            className={`${s.panel} ${panel === "chat" ? s.panelChat : ""}`}
            testId={panel === "chat" ? "canvas-sheet" : `canvas-panel-${panel}`}
            aria-label={current.title}
          >
            <header className={s.panelHead}>
              <h2 className={s.panelTitle}>{current.title}</h2>
              <button
                type="button"
                className={s.ibtn}
                aria-label={islandRu.close}
                title={islandRu.close}
                data-testid="canvas-panel-close"
                onClick={closePanels}
              >
                <Icon d={ICONS.close} />
              </button>
            </header>
            <div className={s.panelBody}>{current.body}</div>
          </Glass>
        )}

        {hidden ? (
          <button
            type="button"
            className={`${s.ibtn} ${s.showIsland}`}
            aria-label={islandRu.show}
            title={islandRu.show}
            data-testid="canvas-island-show"
            onClick={() => setHidden(false)}
          >
            <Icon d={ICONS.show} />
          </button>
        ) : (
          <Glass as="nav" className={s.island} testId="canvas-island" aria-label={islandRu.label}>
            <button
              type="button"
              className={s.ibtn}
              aria-pressed={panel === "chat"}
              aria-label={
                attention && panel !== "chat" ? `${islandRu.chat}: ${islandRu.attention}` : islandRu.chat
              }
              title={islandRu.chat}
              data-testid="canvas-island-chat"
              data-attention={attention && panel !== "chat" ? "" : undefined}
              onClick={() => toggle("chat")}
            >
              <Icon d={ICONS.chat} />
              {attention && panel !== "chat" && <span className={s.dot} aria-hidden="true" />}
            </button>
            {hasBuild && (
              <button
                type="button"
                className={s.ibtn}
                aria-pressed={panel === "build"}
                aria-label={building ? islandRu.buildLeft(leftText) : islandRu.build}
                title={building ? islandRu.buildLeft(leftText) : islandRu.build}
                data-testid="canvas-island-build"
                onClick={() => toggle("build")}
              >
                <svg className={s.ring} viewBox="0 0 24 24" aria-hidden="true">
                  <circle className={s.ringTrack} cx="12" cy="12" r="8.5" />
                  <circle
                    className={s.ringFill}
                    cx="12"
                    cy="12"
                    r="8.5"
                    pathLength="100"
                    strokeDasharray="100"
                    strokeDashoffset={(100 - fraction * 100).toFixed(1)}
                  />
                </svg>
              </button>
            )}
            {brief.available && (
              <button
                type="button"
                className={s.ibtn}
                aria-pressed={brief.open}
                aria-haspopup="dialog"
                aria-label={islandRu.brief}
                title={islandRu.brief}
                data-testid="canvas-brief-toggle"
                onClick={() => {
                  setMoreOpen(false);
                  brief.show();
                }}
              >
                <Icon d={ICONS.brief} />
              </button>
            )}
            <fieldset className={s.device} aria-label={islandRu.device.label}>
              {(["desktop", "phone"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={s.ibtn}
                  aria-pressed={device === d}
                  aria-label={islandRu.device[d]}
                  title={islandRu.device[d]}
                  data-testid={`canvas-device-${d}`}
                  onClick={() => setDevice(d)}
                >
                  <Icon d={ICONS[d]} />
                </button>
              ))}
            </fieldset>
            {editable && (
              <button
                type="button"
                className={s.ibtn}
                aria-label={islandRu.edit}
                title={islandRu.edit}
                data-testid="canvas-island-edit"
                disabled={building}
                onClick={() => (v3Ready ? setStyleOpen(true) : focusInput())}
              >
                <Icon d={ICONS.edit} />
              </button>
            )}
            {canPublish && (
              <button
                type="button"
                className={s.ibtn}
                aria-pressed={panel === "publish"}
                aria-label={islandRu.publish}
                title={islandRu.publish}
                data-testid="canvas-island-publish"
                onClick={() => toggle("publish")}
              >
                <Icon d={ICONS.publish} />
              </button>
            )}
            <span className={s.moreWrap}>
              <button
                type="button"
                className={s.ibtn}
                aria-expanded={moreOpen}
                aria-label={islandRu.more}
                title={islandRu.more}
                data-testid="canvas-island-more"
                onClick={() => setMoreOpen((o) => !o)}
              >
                <Icon d={ICONS.more} />
              </button>
              {moreOpen && (
                <Glass className={s.menu} testId="canvas-menu">
                  {shownRevision !== null && (
                    <button
                      type="button"
                      className={s.mitem}
                      data-testid="canvas-open-tab"
                      onClick={() => void openTab()}
                    >
                      <Icon d={ICONS.open} />
                      {islandRu.open}
                    </button>
                  )}
                  <AppLink to="/" className={s.mitem} label={canvas.home} testId="canvas-home">
                    <Icon d={ICONS.home} />
                    {islandRu.home}
                  </AppLink>
                  <AppLink
                    to={`/s/${systemId}/settings`}
                    className={s.mitem}
                    label={islandRu.settings}
                    testId="canvas-settings"
                  >
                    <Icon d={ICONS.settings} />
                    {islandRu.settings}
                  </AppLink>
                  <button
                    type="button"
                    className={s.mitem}
                    data-testid="canvas-support"
                    onClick={() => {
                      setMoreOpen(false);
                      openSupport();
                    }}
                  >
                    <Icon d={ICONS.support} />
                    {islandRu.support}
                  </button>
                </Glass>
              )}
            </span>
            <button
              type="button"
              className={s.ibtn}
              aria-label={islandRu.hide}
              title={islandRu.hide}
              data-testid="canvas-island-hide"
              onClick={() => {
                closePanels();
                setHidden(true);
              }}
            >
              <Icon d={ICONS.hide} />
            </button>
          </Glass>
        )}
        {openError && (
          <p className={s.news} role="alert" data-testid="canvas-open-error">
            {islandRu.openFailed}
          </p>
        )}

        {brief.panel}
        {styleOpen && (
          <StyleDrawer
            systemId={systemId}
            editable={editable}
            onClose={() => setStyleOpen(false)}
            onPicked={() => {
              setStyleOpen(false);
              brief.reload();
              announce(v3Ru.build.picked);
            }}
          />
        )}
        {v3live.toast}
        <div className={s.srOnly} aria-live="polite" data-testid="canvas-live">
          {live}
        </div>
      </div>
    </ThemeRoot>
  );
}
