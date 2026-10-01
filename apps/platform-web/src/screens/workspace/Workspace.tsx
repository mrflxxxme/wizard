// Workspace /s/:systemId (screens S2–S6): rail · chat · main · aside «Стиль» (platform-screens.yaml#regions).
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { Answer, GateReport, RunEvent, SystemCard, SystemView, Theme } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { navigate, setQueryParam, useRoute } from "../../app/router.js";
import { Alert, Pill } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import { initialRunState, type RunState, reduceRun } from "../../run/reducer.js";
import { subscribeRun } from "../../run/stream.js";
import { BuildLog } from "./BuildLog.js";
import { CardView, changedSections } from "./CardView.js";
import { ChatFeed } from "./ChatFeed.js";
import { GateReportView, PublishCard, publishBlockers } from "./GateReport.js";
import { PreviewPane } from "./PreviewPane.js";
import { QuestionCard } from "./QuestionCard.js";
import { StylePanel, useStyleSaver } from "./StylePanel.js";
import { Understanding } from "./Understanding.js";
import s from "./Workspace.module.css";

type RunAction = { type: "reset" } | { type: "event"; e: RunEvent };
const runReducer = (st: RunState, a: RunAction): RunState =>
  a.type === "reset" ? initialRunState() : reduceRun(st, a.e);

const errText = (e: unknown) => (e instanceof Error ? e.message : ru.errors.generic);

export function Workspace({ systemId }: { systemId: string }): ReactNode {
  const { api, settings } = usePlatform();
  const { search } = useRoute();
  const [view, setView] = useState<SystemView | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, dispatch] = useReducer(runReducer, undefined, initialRunState);
  const [reports, setReports] = useState<GateReport[]>([]);
  const [theme, setTheme] = useState<Theme | null>(null);
  const [changed, setChanged] = useState<ReturnType<typeof changedSections>>(new Set());
  const [runFinished, setRunFinished] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [pane, setPane] = useState<"chat" | "main">("chat");
  const lastText = useRef("");
  const cardRef = useRef<SystemCard | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const reload = useCallback(async (): Promise<SystemView> => {
    const v = await api.getSystem(systemId);
    const prev = cardRef.current;
    if (v.card && prev && v.card.cardVersion !== prev.cardVersion) setChanged(changedSections(prev, v.card));
    if (v.card) cardRef.current = v.card;
    setView(v);
    return v;
  }, [api, systemId]);

  const refreshGates = useCallback(async () => {
    try {
      setReports((await api.getLatestGates(systemId)).reports);
    } catch {
      setReports([]);
    }
  }, [api, systemId]);

  // Open /s/:id: GET /systems/:id; an active run is re-read from after=0 (platform-screens.yaml#sse.client_rules).
  useEffect(() => {
    let live = true;
    setView(null);
    setLoadError(null);
    setRunId(null);
    cardRef.current = null;
    api
      .getSystem(systemId)
      .then((v) => {
        if (!live) return;
        cardRef.current = v.card ?? null;
        setView(v);
        if (v.activeRunId) setRunId(v.activeRunId);
      })
      .catch((e) => live && setLoadError(e instanceof ApiError ? e : new ApiError(0, null)));
    return () => {
      live = false;
    };
  }, [api, systemId]);

  const stage = view?.system.stage;
  const hasDraft = stage === "building" || stage === "ready" || stage === "failed";

  useEffect(() => {
    if (hasDraft) void refreshGates();
  }, [hasDraft, refreshGates]);

  // Current theme of the draft for «Стиль» (spec of draftRevision).
  const draftRevision = view?.system.draftRevision ?? 0;
  useEffect(() => {
    if (theme !== null || !hasDraft || draftRevision < 1) return;
    let live = true;
    api
      .getRevision(systemId, draftRevision)
      .then((r) => live && setTheme(r.spec.theme ?? {}))
      .catch(() => live && setTheme({}));
    return () => {
      live = false;
    };
  }, [api, systemId, hasDraft, draftRevision, theme]);

  const onEvent = useCallback(
    (e: RunEvent) => {
      dispatch({ type: "event", e });
      if (e.type === "chat_output") void reload().catch(() => {});
      if (e.type === "run_finished" || e.type === "run_failed") {
        void reload().catch(() => {});
        void refreshGates();
        setRunFinished((n) => n + 1);
      }
    },
    [reload, refreshGates],
  );

  useEffect(() => {
    if (!runId) return;
    dispatch({ type: "reset" });
    return subscribeRun({ url: (after) => api.eventsUrl(runId, after), after: 0, onEvent });
  }, [api, runId, onEvent]);

  const saver = useStyleSaver({
    systemId,
    draftRevision,
    reloadRevision: async () => (await reload()).system.draftRevision,
    runFinished,
  });

  async function act<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(name);
    setActionError(null);
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === "CARD_VERSION_STALE") await reload().catch(() => {});
      setActionError(errText(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function sendMessage(t: string) {
    const value = t.trim();
    if (!value) return;
    const r = await act("message", () => api.postMessage(systemId, value));
    if (!r) return;
    lastText.current = value;
    setText("");
    setRunId(r.run.id);
    await reload().catch(() => {});
  }

  async function submitAnswers(body: { answers: Answer[]; restByRecommendation?: boolean }) {
    const r = await act("answers", () => api.postAnswers(systemId, body));
    if (!r) return;
    setRunId(r.run.id);
    await reload().catch(() => {});
  }

  async function approve() {
    const card = view?.card;
    if (!card) return;
    const r = await act("approve", () => api.approveCard(systemId, { cardVersion: card.cardVersion }));
    if (!r) return;
    setChanged(new Set());
    setRunId(r.run.id);
    await reload().catch(() => {});
  }

  async function fix() {
    const r = await act("fix", () => api.startFix(systemId));
    if (!r) return;
    setRunId(r.run.id);
    await reload().catch(() => {});
  }

  const focusInput = () => {
    setPane("chat");
    inputRef.current?.focus();
  };

  if (loadError) {
    return (
      <div className={s.center}>
        <Alert>{loadError.status === 404 ? ru.errors.systemNotFound : loadError.message}</Alert>
        <Button variant="secondary" onClick={() => navigate("/")}>
          {ru.errors.toStart}
        </Button>
      </div>
    );
  }
  if (!view) {
    return (
      <div className={s.center} aria-busy="true">
        {ru.workspace.loading}
      </div>
    );
  }

  const system = view.system;
  const questions = view.pendingQuestions ?? [];
  const running =
    runId !== null && (run.phase === "idle" || run.phase === "running" || run.phase === "needs_input");
  const locked = stage === "building";
  const buildRun = run.kind === "build" || (run.kind === undefined && stage === "building");
  const interviewFailure = run.kind === "interview_turn" ? run.failure : null;
  const retryText =
    lastText.current ||
    ([...view.messages].reverse().find((m) => m.role === "user" && m.kind === "text")?.text ?? "");
  const finishedSummary =
    run.kind === "build" &&
    run.finished?.summary_ru &&
    !view.messages.some((m) => m.kind === "run_report" && m.runId === runId)
      ? run.finished.summary_ru
      : null;
  const styleOpen = hasDraft && search.get("panel") === "style" && theme !== null;
  const previewAvailable = system.previewRevision != null || run.g0PassedRevision !== null;
  // The newest revision known to have a preview: previewRevision catching up with g0PassedRevision is not growth.
  const previewRevision = Math.max(system.previewRevision ?? -1, run.g0PassedRevision ?? -1);
  const blockers = publishBlockers(view.publishBlockers, reports);

  const chatBody = (
    <>
      <ChatFeed messages={view.messages} ruOnly={settings?.ruOnly ?? false} />
      {stage === "interview" && questions.length > 0 && (
        <QuestionCard
          key={questions.map((q) => q.id).join()}
          questions={questions}
          onSubmit={submitAnswers}
        />
      )}
      {stage === "interview" && questions.length === 0 && running && (
        <p className={s.muted} aria-busy="true">
          {ru.chat.analyzing}
        </p>
      )}
      {stage === "card" && view.card && (
        <div className={s.bubble}>
          <span className={s.bubbleText}>
            {view.card.assumptions && view.card.assumptions.length > 0 && (
              <>
                {ru.card.answersSummary(view.card.forkAnswers?.length || view.card.assumptions.length)}{" "}
                {view.card.assumptions.join("; ")}
                {". "}
              </>
            )}
            {ru.card.acceptanceNote}
          </span>
        </div>
      )}
      {interviewFailure && (
        <Alert testId="run-error">
          <span>{interviewFailure.message_ru}</span>
          {interviewFailure.retryable && retryText && (
            <Button size="sm" variant="secondary" onClick={() => void sendMessage(retryText)}>
              {ru.build.retry}
            </Button>
          )}
        </Alert>
      )}
      {hasDraft && buildRun && (
        <BuildLog
          run={run}
          reports={reports}
          active={running && buildRun}
          onCancel={() => runId && void act("cancel", () => api.cancelRun(runId))}
          onAnswer={async (body) => {
            if (runId) await act("input", () => api.provideInput(runId, body));
          }}
          onFix={() => void fix()}
          onRetry={() => void fix()}
        />
      )}
      {finishedSummary && (
        <div className={s.bubble} data-testid="chat-message">
          <span className={s.bubbleAuthor}>{ru.chat.agents.builder}</span>
          <span className={s.bubbleText}>{finishedSummary}</span>
        </div>
      )}
      {stage === "ready" && (
        <>
          <GateReportView reports={reports} />
          <PublishCard slug={system.slug} blockers={blockers} onEdit={focusInput} />
        </>
      )}
      {stage === "failed" && !run.failure && (
        <Alert testId="run-error">
          <span>{ru.workspace.stage.failed}</span>
          <Button size="sm" variant="primary" data-testid="run-fix" onClick={() => void fix()}>
            {ru.build.fix}
          </Button>
        </Alert>
      )}
      {actionError && <Alert>{actionError}</Alert>}
    </>
  );

  let main: ReactNode = null;
  if (stage === "interview")
    main = <Understanding messages={view.messages} analyzing={running} questions={questions} />;
  else if (stage === "card" && view.card)
    main = (
      <CardView
        card={view.card}
        changed={changed}
        buildModelLabel={settings?.buildModelLabel}
        busy={busy === "approve"}
        error={null}
        onBuild={() => void approve()}
        onEdit={focusInput}
      />
    );
  else if (hasDraft)
    main = (
      <PreviewPane
        systemId={systemId}
        revision={previewRevision}
        available={previewAvailable}
        theme={theme ?? {}}
        testData={stage === "ready"}
        toolbar={
          <Button
            size="sm"
            variant={styleOpen ? "primary" : "secondary"}
            data-testid="style-toggle"
            disabled={theme === null}
            onClick={() => setQueryParam("panel", styleOpen ? null : "style")}
          >
            {ru.workspace.styleToggle}
          </Button>
        }
      />
    );

  return (
    <div className={s.shell} data-pane={pane}>
      <nav className={s.rail} aria-label={ru.appName}>
        <a
          href="/"
          className={s.logo}
          aria-label={ru.rail.home}
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          W
        </a>
        <a
          href="/"
          className={s.railButton}
          aria-label={ru.rail.newSystem}
          title={ru.rail.newSystem}
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          +
        </a>
      </nav>
      <div className={s.paneTabs} role="tablist">
        <button type="button" role="tab" aria-selected={pane === "chat"} onClick={() => setPane("chat")}>
          {ru.workspace.tabChat}
        </button>
        <button type="button" role="tab" aria-selected={pane === "main"} onClick={() => setPane("main")}>
          {ru.workspace.tabPreview}
        </button>
      </div>
      <section className={s.chat} aria-label={ru.workspace.tabChat}>
        <header className={s.chatHead}>
          <h1 className={s.chatTitle}>
            {(system.stage !== "interview" && system.name) || ru.workspace.newSystem} ·{" "}
            {ru.workspace.stage[system.stage] ?? system.stage}
          </h1>
          {running && <Pill tone="accent">{ru.build.running}</Pill>}
        </header>
        <div className={s.chatScroll}>{chatBody}</div>
        <footer className={s.chatFoot}>
          <form
            className={s.composer}
            onSubmit={(e) => {
              e.preventDefault();
              void sendMessage(text);
            }}
          >
            <textarea
              ref={inputRef}
              className={s.textarea}
              aria-label={ru.workspace.inputPlaceholder}
              placeholder={
                locked
                  ? ru.workspace.lockedHint
                  : stage === "card"
                    ? ru.workspace.inputPlaceholderCard
                    : ru.workspace.inputPlaceholder
              }
              disabled={locked}
              maxLength={8000}
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void sendMessage(text);
                }
              }}
              data-testid="chat-input"
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              data-testid="chat-send"
              disabled={locked || !text.trim()}
              loading={busy === "message"}
            >
              {ru.workspace.send}
            </Button>
          </form>
          {locked && <p className={s.small}>{ru.workspace.lockedHint}</p>}
        </footer>
      </section>
      <main className={s.main}>{main}</main>
      {styleOpen && theme !== null && (
        <aside className={s.aside}>
          <StylePanel
            theme={theme}
            onChange={setTheme}
            saver={saver}
            onClose={() => setQueryParam("panel", null)}
          />
        </aside>
      )}
    </div>
  );
}
