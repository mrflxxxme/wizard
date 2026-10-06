// Workspace /s/:systemId (screens S2–S6): rail · chat · main · aside «Стиль» (platform-screens.yaml#regions).
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ApiError } from "../../api/client.js";
import type {
  Answer,
  DiffChange,
  GateReport,
  LockStatus,
  MessageTarget,
  RevisionSummary,
  RunEvent,
  SystemCard,
  SystemView,
  Theme,
} from "../../api/types.js";
import { canEdit, usePlatform } from "../../app/context.js";
import { navigate, setQueryParam, useRoute } from "../../app/router.js";
import { Alert, Pill } from "../../components/ui.js";
import { DemoBanner } from "../../features/demo/DemoBanner.js";
import { UndoPanel } from "../../features/destructive/DestructivePanel.js";
import { ru } from "../../i18n/ru.js";
import { initialRunState, type RunState, reduceRun } from "../../run/reducer.js";
import { subscribeRun } from "../../run/stream.js";
import { BuildLog } from "./BuildLog.js";
import { CardView, changedSections } from "./CardView.js";
import { ChatFeed } from "./ChatFeed.js";
import { ChangesPanel, DiffCard } from "./DiffCard.js";
import { GateReportView, PublishCard, publishBlockers } from "./GateReport.js";
import { TargetChip } from "./PointTarget.js";
import { PreviewPane } from "./PreviewPane.js";
import { QuestionCard } from "./QuestionCard.js";
import { Rail } from "./Rail.js";
import { RunNotice } from "./RunNotice.js";
import { StylePanel, useStyleSaver } from "./StylePanel.js";
import { Understanding } from "./Understanding.js";
import s from "./Workspace.module.css";

type RunAction = { type: "reset" } | { type: "event"; e: RunEvent };
const runReducer = (st: RunState, a: RunAction): RunState =>
  a.type === "reset" ? initialRunState() : reduceRun(st, a.e);

const errText = (e: unknown) => (e instanceof Error ? e.message : ru.errors.generic);
/** api.yaml#createImport: xlsx/csv ≤ 20 МБ. */
const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The revision the owner would publish now (as getSystem.publishBlockers counts it): the latest draft revision
 * unless its G0 failed, else the preview revision.
 */
export function publishTarget(
  latest: RevisionSummary | undefined,
  previewRevision: number | null,
): number | null {
  if (latest && latest.g0Passed !== false) return latest.version;
  return previewRevision;
}

type Segment = "draft" | "prod" | "changes";

export function Workspace({ systemId }: { systemId: string }): ReactNode {
  const { api, settings, roleIn, auth } = usePlatform();
  const [publishError, setPublishError] = useState<string | null>(null);
  const [lock, setLock] = useState<LockStatus | null>(null);
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
  // M3-01: the element picked in the preview; the next message becomes a point_edit of its file.
  const [pointTarget, setPointTarget] = useState<MessageTarget | null>(null);
  const [pane, setPane] = useState<"chat" | "main">("chat");
  const [latestRevision, setLatestRevision] = useState<RevisionSummary | undefined>();
  const [changes, setChanges] = useState<DiffChange[] | null>(null);
  const [segment, setSegment] = useState<Segment>("draft");
  const lastText = useRef("");
  const cardRef = useRef<SystemCard | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

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

  // S6 (M2-11): «✓ Карта РФ привязана» from Org.cardBound (any role); re-read when the publish blockers change.
  const [cardBound, setCardBound] = useState<boolean | undefined>(undefined);
  const sysOrg = view?.system.orgId;
  const blockerKey = (view?.publishBlockers ?? []).join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: blockerKey is a re-read trigger
  useEffect(() => {
    if (stage !== "ready" || !sysOrg || typeof api.getOrg !== "function") return;
    let live = true;
    api
      .getOrg(sysOrg)
      .then((o) => live && setCardBound(o.cardBound === true))
      .catch(() => live && setCardBound(undefined));
    return () => {
      live = false;
    };
  }, [api, sysOrg, stage, blockerKey]);

  // S7: the latest revision and, when the draft is ahead of prod, its human diff against prod (M1-08).
  const prodRevision = view?.system.prodRevision ?? null;
  const draftRev = view?.system.draftRevision ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runFinished and draftRev are re-read triggers
  useEffect(() => {
    if (stage !== "ready") return;
    let live = true;
    api
      .listRevisions(systemId, 5)
      .then((r) => live && setLatestRevision(r.items[0]))
      .catch(() => live && setLatestRevision(undefined));
    return () => {
      live = false;
    };
  }, [api, systemId, stage, draftRev, runFinished]);
  const target = publishTarget(latestRevision, view?.system.previewRevision ?? null);
  const ahead = prodRevision !== null && target !== null && target > prodRevision;
  useEffect(() => {
    setChanges(null);
    if (!ahead || target === null) return;
    let live = true;
    api
      .getRevisionDiff(systemId, target, prodRevision)
      .then((r) => live && setChanges(r.changes))
      .catch(() => live && setChanges([]));
    return () => {
      live = false;
    };
  }, [api, systemId, ahead, target, prodRevision]);

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

  // S4 M1: «<Имя> собирает» (GET /systems/:id/lock) while a build holds the system; a new run re-reads it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runId is the re-read trigger
  useEffect(() => {
    if (stage !== "building") {
      setLock(null);
      return;
    }
    let live = true;
    api
      .getLock(systemId)
      .then((l) => live && setLock(l))
      .catch(() => live && setLock(null));
    return () => {
      live = false;
    };
  }, [api, systemId, stage, runId]);

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

  async function sendMessage(t: string, target: MessageTarget | null = null) {
    const value = t.trim();
    if (!value) return;
    const r = await act("message", () => api.postMessage(systemId, value, target ? { target } : undefined));
    if (!r) return;
    lastText.current = value;
    setText("");
    if (target) setPointTarget(null);
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

  /** POST publish (owner, confirmDiff); 403/422 come back as message_ru (the UI is not the protection, D8/D11). */
  async function publish(revision: number) {
    setBusy("publish");
    setPublishError(null);
    try {
      const r = await api.publish(systemId, revision);
      setRunId(r.run.id);
    } catch (e) {
      setPublishError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function cancelDraft(toRevision: number) {
    const r = await act("cancel-draft", () => api.rollback(systemId, { env: "draft", toRevision }));
    if (!r) return;
    setSegment("draft");
    setRunId(r.run.id);
  }

  /** POST /systems/:id/imports → S-import. Only the extension leaves the browser as the file name (it may hold PII). */
  async function uploadTable(file: File) {
    const ext = /\.(xlsx|csv)$/i.exec(file.name)?.[1]?.toLowerCase();
    if (!ext) return setActionError(ru.import.unsupported);
    if (file.size > IMPORT_MAX_BYTES) return setActionError(ru.import.tooLarge);
    setBusy("upload");
    setActionError(null);
    try {
      const r = await api.createImport(systemId, file, `table.${ext}`);
      navigate(`/s/${systemId}/import/${r.importId}`);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setActionError(
        status === 413 ? ru.import.tooLarge : status === 415 ? ru.import.unsupported : errText(e),
      );
    } finally {
      setBusy(null);
    }
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
  const role = roleIn(view.system.orgId);
  const editor = canEdit(role, auth);
  const readOnly = !editor && auth === "ready";
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
  // S5 M3: a point edit needs a built system, edit rights and no run in progress.
  const pointable = editor && stage === "ready" && !running && !locked && previewRevision > 0;
  const chipTarget = pointable ? pointTarget : null;
  // S7: the draft is ahead of prod with real changes (an empty diff — e.g. after «Отменить» — is not a proposal).
  const showDiff = ahead && (changes === null || changes.length > 0);
  const seg: Segment = showDiff ? segment : "draft";
  // S-import (L1-54): rows are loaded into the preview revision's schema, so a built system is required.
  const canUpload = editor && system.previewRevision != null && !running && !locked;
  const uploadHint = !editor
    ? ru.workspace.uploadViewer
    : system.previewRevision == null
      ? ru.workspace.uploadNotReady
      : ru.workspace.uploadHint;

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
      {(run.kind === "publish" || run.kind === "rollback" || run.kind === "import_table") && (
        <RunNotice run={run} />
      )}
      {stage === "ready" && (
        <>
          <GateReportView
            reports={reports}
            revision={view.system.previewRevision ?? null}
            dispute={
              (view.publishBlockers ?? []).includes("NOT_OWNER")
                ? undefined
                : {
                    send: async (revision, note) =>
                      (await api.disputeG2Block(systemId, { revision, ...(note ? { text: note } : {}) }))
                        .message_ru,
                  }
            }
          />
          {showDiff && target !== null && prodRevision !== null && (
            <DiffCard
              systemId={systemId}
              revision={target}
              changes={changes}
              reports={reports}
              blockers={blockers}
              canCancel={!running}
              busy={busy === "publish" ? "publish" : busy === "cancel-draft" ? "cancel" : null}
              onCancel={() => void cancelDraft(prodRevision)}
              onPublish={() => void publish(target)}
            />
          )}
          <UndoPanel systemId={systemId} prodRevision={prodRevision} onRun={setRunId} />
          <PublishCard
            systemId={systemId}
            slug={system.slug}
            blockers={blockers}
            codes={view.publishBlockers ?? []}
            prodRevision={system.prodRevision ?? null}
            prodUrl={system.prodUrl ?? null}
            revision={target}
            showSubmit={!showDiff}
            running={running}
            busy={busy === "publish"}
            error={publishError}
            cardBound={cardBound}
            onEdit={focusInput}
            onPublish={() => target !== null && void publish(target)}
          />
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
        canBuild={editor}
        onBuild={() => void approve()}
        onEdit={focusInput}
      />
    );
  else if (hasDraft && seg === "changes") main = <ChangesPanel changes={changes} />;
  else if (hasDraft && seg === "prod" && system.prodUrl)
    main = (
      <div className={s.frameWrap}>
        <iframe
          src={system.prodUrl}
          title={ru.diff.prodFrameTitle}
          className={s.frame}
          style={{ width: "100%" }}
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
          data-testid="prod-frame"
        />
      </div>
    );
  else if (hasDraft)
    main = (
      <PreviewPane
        systemId={systemId}
        revision={previewRevision}
        available={previewAvailable}
        theme={theme ?? {}}
        testData={stage === "ready"}
        {...(showDiff && target !== null ? { envLabel: ru.diff.draftTopbar(target) } : {})}
        pointable={pointable}
        selected={chipTarget}
        onSelect={(t) => {
          setPointTarget(t);
          setPane("chat");
          inputRef.current?.focus();
        }}
        toolbar={
          <Button
            size="sm"
            variant={styleOpen ? "primary" : "secondary"}
            data-testid="style-toggle"
            disabled={theme === null || !editor}
            onClick={() => setQueryParam("panel", styleOpen ? null : "style")}
          >
            {ru.workspace.styleToggle}
          </Button>
        }
      />
    );

  return (
    <div className={s.shell} data-pane={pane}>
      <Rail systemId={systemId} />
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
          {system.prodRevision != null && (
            <Pill tone="ok" title={ru.start.prodTitle} testId="chat-prod-revision">
              {ru.workspace.prodRevision(system.prodRevision)}
            </Pill>
          )}
          {running && <Pill tone="accent">{ru.build.running}</Pill>}
          {lock?.held && lock.holder && (
            <Pill tone="warn" testId="chat-lock">
              {ru.workspace.holder(lock.holder.name)}
            </Pill>
          )}
        </header>
        {view?.demoReplay && <DemoBanner testId="workspace-demo-replay" />}
        <div className={s.chatScroll}>{chatBody}</div>
        <footer className={s.chatFoot}>
          {chipTarget && (
            <TargetChip
              systemId={systemId}
              revision={previewRevision}
              target={chipTarget}
              onClear={() => setPointTarget(null)}
            />
          )}
          <form
            className={s.composer}
            onSubmit={(e) => {
              e.preventDefault();
              void sendMessage(text, chipTarget);
            }}
          >
            <textarea
              ref={inputRef}
              className={s.textarea}
              aria-label={ru.workspace.inputPlaceholder}
              placeholder={
                readOnly
                  ? ru.workspace.viewerHint
                  : locked
                    ? ru.workspace.lockedHint
                    : chipTarget
                      ? ru.point.placeholder(chipTarget.componentName)
                      : stage === "card"
                        ? ru.workspace.inputPlaceholderCard
                        : ru.workspace.inputPlaceholder
              }
              disabled={locked || readOnly}
              maxLength={8000}
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void sendMessage(text, chipTarget);
                }
              }}
              data-testid="chat-input"
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              data-testid="chat-send"
              disabled={locked || readOnly || !text.trim()}
              loading={busy === "message"}
            >
              {ru.workspace.send}
            </Button>
          </form>
          {locked && <p className={s.small}>{ru.workspace.lockedHint}</p>}
          {readOnly && !locked && <p className={s.small}>{ru.workspace.viewerHint}</p>}
          <div className={s.uploadRow}>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              className={s.visuallyHidden}
              tabIndex={-1}
              aria-label={ru.workspace.uploadFile}
              data-testid="chat-upload-file"
              disabled={!canUpload}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void uploadTable(f);
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              data-testid="chat-upload"
              disabled={!canUpload}
              loading={busy === "upload"}
              title={uploadHint}
              aria-describedby="chat-upload-hint"
              onClick={() => fileRef.current?.click()}
            >
              {ru.workspace.upload}
            </Button>
            <span id="chat-upload-hint" className={s.small}>
              {uploadHint}
            </span>
          </div>
        </footer>
      </section>
      <main className={s.main}>
        {showDiff && (
          <fieldset className={`${s.segmented} ${s.envSegments}`}>
            <legend className={s.visuallyHidden}>{ru.diff.segments}</legend>
            {(
              [
                ["prod", ru.diff.segmentProd],
                ["draft", ru.diff.segmentDraft],
                ["changes", ru.diff.changesSegment],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={seg === id ? s.segOn : s.seg}
                aria-pressed={seg === id}
                data-testid={`env-segment-${id}`}
                onClick={() => setSegment(id)}
              >
                {label}
              </button>
            ))}
          </fieldset>
        )}
        {main}
      </main>
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
