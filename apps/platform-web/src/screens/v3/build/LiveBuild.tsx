// The live v3 build on the canvas (V3-17; platform-screens.yaml#S-canvas v3_live, product.yaml D77_v3 (10)): the
// revision the system grew to (the canvas shows it on the whole window, V4-11), the checklist of the brief's scenarios, the time left against the 30 min cap, the spend against
// the cap, the technical details under «Подробнее»; the ready toast and the browser notice. Everything comes from the
// structured snapshot of the run's events (live.ts), so leaving the page and coming back restores it from the server.
import { ActionButton, Serif } from "@wizard/ui-kit/v2";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunEvent, V3BuildProgress, V3ProgressScenario } from "../../../api/types.js";
import s from "./LiveBuild.module.css";
import { liveClock, scenarioCount, type V3Live, type V3LiveClock, v3Live } from "./live.js";
import { askNotify, firstNotice, type NotifyState, notifyState, showNotice } from "./notify.js";
import { liveRu as T } from "./ru.js";

/** How long the ready toast stays, ms. */
export const TOAST_MS = 8000;
/** A finish this recent (server time) is news: the toast and the browser notice; an older one is just replayed. */
const FRESH_MS = 3 * 60_000;
/** Status changes this recent are announced (a replay of the run on return is not read out). */
const ANNOUNCE_MS = 60_000;

const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");

function useNow(everyMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (everyMs === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

const statusWord = (x: V3ProgressScenario, phase: V3Live["phase"]): string => {
  if (x.status === "passed") return x.reused ? T.scenarios.status.reused : T.scenarios.status.passed;
  if (phase === "failed" && (x.status === "running" || x.status === "pending"))
    return T.scenarios.status.halted;
  return T.scenarios.status[x.status];
};

/** The time of the build: left (expected) and gone against the cap; a bar of the 30 min with the expected end. */
function TimeFact({ live, clock }: { live: V3Live; clock: V3LiveClock }): ReactNode {
  const cap = Math.max(1, live.progress.capSec);
  const gone = Math.min(100, (clock.elapsedSec / cap) * 100);
  const ahead = Math.min(100 - gone, (clock.remainingSec / cap) * 100);
  const main =
    live.phase === "done"
      ? T.time.took(clock.elapsedSec)
      : live.phase === "failed"
        ? T.time.stopped(clock.elapsedSec)
        : clock.remainingSec > 0
          ? T.time.left(clock.remainingSec)
          : T.time.almost;
  return (
    <div className={s.fact} data-testid="canvas-v3-live-time">
      <p className={s.factMain} data-testid="canvas-v3-live-time-left">
        {main}
      </p>
      <div className={s.bar} aria-hidden="true">
        <span className={s.barFill} style={{ width: `${gone.toFixed(1)}%` }} />
        {live.phase === "running" && (
          <span
            className={s.barAhead}
            style={{ left: `${gone.toFixed(1)}%`, width: `${ahead.toFixed(1)}%` }}
          />
        )}
      </div>
      {live.phase === "running" && (
        <p className={s.factSub} data-testid="canvas-v3-live-time-cap">
          {T.time.going(clock.elapsedSec, live.progress.capSec)}
        </p>
      )}
    </div>
  );
}

/** «Потрачено X ₽ из Y»: the cap, and what earlier builds paid for the steps taken from their checkpoints. */
function SpendFact({ p }: { p: V3BuildProgress }): ReactNode {
  const share = p.capRub > 0 ? Math.min(100, (p.spentRub / p.capRub) * 100) : 0;
  return (
    <div className={s.fact} data-testid="canvas-v3-live-spend">
      <p className={s.factMain} data-testid="canvas-v3-live-spend-line">
        {T.spend.title(p.spentRub, p.capRub)}
      </p>
      <div className={s.bar} aria-hidden="true">
        <span className={cx(s.barFill, s.barMoney)} style={{ width: `${share.toFixed(1)}%` }} />
      </div>
      <p className={s.factSub}>
        {T.spend.cap(p.capRub)}
        {p.reusedRub > 0 && (
          <span data-testid="canvas-v3-live-spend-reused"> {T.spend.reused(p.reusedRub)}</span>
        )}
      </p>
    </div>
  );
}

function Checklist({ live }: { live: V3Live }): ReactNode {
  const p = live.progress;
  const { done, total } = scenarioCount(p);
  return (
    <section className={s.list} aria-label={T.scenarios.title}>
      <h3 className={s.h3}>
        {T.scenarios.title}
        {total > 0 && (
          <span className={s.count} data-testid="canvas-v3-live-count">
            {" "}
            · {T.scenarios.count(done, total)}
          </span>
        )}
      </h3>
      {total === 0 ? (
        <p className={s.factSub}>{T.scenarios.none}</p>
      ) : (
        <ol className={s.scenarios} data-testid="canvas-v3-live-scenarios">
          {p.scenarios.map((x) => {
            const halted = live.phase === "failed" && (x.status === "running" || x.status === "pending");
            return (
              <li
                key={x.id}
                className={s.scenario}
                data-testid="canvas-v3-live-scenario"
                data-id={x.id}
                data-status={x.status}
                aria-current={x.status === "running" && live.phase === "running" ? "step" : undefined}
              >
                <span className={cx(s.mark, s[`m_${halted ? "halted" : x.status}`])} aria-hidden="true">
                  {x.status === "passed" ? (
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3.5 8.5l3 3 6-7" />
                    </svg>
                  ) : x.status === "failed" || x.status === "stopped" ? (
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4 8h8M9 5l3 3-3 3" />
                    </svg>
                  ) : null}
                </span>
                <span className={s.sBody}>
                  <span className={s.sTitle}>{x.title}</span>
                  <span className={s.sMeta}>
                    <span className={cx(s.tag, x.priority === "must" && s.tagMust)}>
                      {x.priority === "must" ? T.scenarios.must : T.scenarios.should}
                    </span>
                    <span className={s.sStatus} data-testid="canvas-v3-live-scenario-status">
                      {statusWord(x, live.phase)}
                    </span>
                  </span>
                  {x.reason && (x.status === "failed" || x.status === "stopped") && (
                    <span className={s.reason} data-testid="canvas-v3-live-reason">
                      {T.scenarios.reason(x.reason)}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** Stages, gate results and checkpoints — for whoever wants the technical side. */
function Details({ live }: { live: V3Live }): ReactNode {
  const p = live.progress;
  return (
    <details className={s.more} data-testid="canvas-v3-live-more">
      <summary>{T.more.summary}</summary>
      <div className={s.moreBody}>
        <h4 className={s.h4}>{T.more.stages}</h4>
        <ol className={s.stages} data-testid="canvas-v3-live-stages">
          {p.stages.map((st) => (
            <li key={st.id} data-stage={st.id} data-status={st.status}>
              <span>{st.label_ru}</span>
              <span className={s.stageStatus}>{T.more.stage[st.status] ?? st.status}</span>
            </li>
          ))}
        </ol>
        <h4 className={s.h4}>{T.more.gates}</h4>
        {live.gates.length === 0 ? (
          <p className={s.factSub}>{T.more.noGates}</p>
        ) : (
          <ul className={s.gates} data-testid="canvas-v3-live-gates">
            {live.gates.map((g) => (
              <li key={g.seq} data-passed={g.passed ? "" : undefined}>
                {T.more.gate(g.level, g.revision, g.passed, g.failed)}
              </li>
            ))}
          </ul>
        )}
        <h4 className={s.h4}>{T.more.checkpoints}</h4>
        <p className={s.factSub} data-testid="canvas-v3-live-checkpoints">
          {T.more.saved(p.checkpoints.saved)}
          {p.checkpoints.reused > 0 && ` ${T.more.reused(p.checkpoints.reused)}`}{" "}
          {T.more.preview(p.previewRevision)}
        </p>
      </div>
    </details>
  );
}

export interface V3LivePanelProps {
  live: V3Live;
  now: number;
  notify: NotifyState;
  onAskNotify(): void;
  /** V3-18: stop the running build (POST /runs/:id/cancel); absent — no «Остановить» (a viewer, another run). */
  onStop?(): Promise<void>;
}

/** «Остановить сборку» with a confirmation: what is spent stays spent, the steps done are kept for the next build. */
function StopBuild({ onStop }: { onStop(): Promise<void> }): ReactNode {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function stop() {
    setBusy(true);
    setError(null);
    try {
      await onStop();
      setConfirm(false);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : T.stop.failed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={s.stop} data-testid="canvas-v3-live-stop-box">
      {confirm ? (
        <>
          <p data-testid="canvas-v3-live-stop-confirm">{T.stop.confirm}</p>
          <div className={s.stopRow}>
            <ActionButton
              size="sm"
              variant="secondary"
              busy={busy}
              disabled={busy}
              testId="canvas-v3-live-stop-yes"
              onClick={() => void stop()}
            >
              {busy ? T.stop.stopping : T.stop.yes}
            </ActionButton>
            <ActionButton
              size="sm"
              variant="ghost"
              disabled={busy}
              testId="canvas-v3-live-stop-no"
              onClick={() => setConfirm(false)}
            >
              {T.stop.no}
            </ActionButton>
          </div>
        </>
      ) : (
        <ActionButton size="sm" variant="ghost" testId="canvas-v3-live-stop" onClick={() => setConfirm(true)}>
          {T.stop.button}
        </ActionButton>
      )}
      {error && (
        <p className={s.stopError} role="alert" data-testid="canvas-v3-live-stop-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** The panel of the live build: what is going on, the time, the money, the scenarios and «Подробнее». */
export function V3LivePanel({ live, now, notify, onAskNotify, onStop }: V3LivePanelProps): ReactNode {
  const p = live.progress;
  const clock = liveClock(live, now);
  const stageLabel = p.stages.find((x) => x.id === p.stage)?.label_ru ?? T.starting;
  return (
    <div className={s.panel}>
      <header className={s.head}>
        <p className={s.kicker}>{T.kicker}</p>
        <Serif as="h2" size="md" className={s.title} testId="canvas-v3-live-title">
          {T.title[live.phase]}
        </Serif>
        <p className={s.now} data-testid="canvas-v3-live-stage">
          {live.phase === "running" ? T.now(stageLabel) : (live.summary ?? "")}
        </p>
      </header>
      <div className={s.facts}>
        <TimeFact live={live} clock={clock} />
        <SpendFact p={p} />
      </div>
      <Checklist live={live} />
      {live.phase === "running" && (
        <div className={s.leave}>
          <p data-testid="canvas-v3-live-leave">{T.leave}</p>
          {notify === "default" && (
            <ActionButton size="sm" variant="ghost" testId="canvas-v3-live-notify" onClick={onAskNotify}>
              {T.notify.ask}
            </ActionButton>
          )}
          {notify === "granted" && <p data-testid="canvas-v3-live-notify-on">{T.notify.on}</p>}
          {notify === "denied" && <p>{T.notify.denied}</p>}
          {onStop && <StopBuild onStop={onStop} />}
        </div>
      )}
      <Details live={live} />
    </div>
  );
}

export interface UseV3LiveOptions {
  systemId: string;
  /** Name of the system (the toast and the browser notice). */
  name: string;
  /** Events of the build run the canvas follows ([] for other runs). */
  events: readonly RunEvent[];
  /** The canvas live region. */
  announce(text: string): void;
  /** V3-18: stop the followed build (absent — the member may not, or no build runs). */
  onStop?(): Promise<void>;
  /** V4-11: «Посмотреть» of the ready card — the canvas closes its panels over the system. */
  onLook?(): void;
  /** V4-11: a fresh status change in words (a stage, a scenario passed) — the short notice over the canvas. */
  onNews?(text: string): void;
}

export interface V3LiveView {
  live: V3Live | null;
  /** The panel of the build (time, money, scenarios, «Подробнее»; null — not a v3 build). */
  panel: ReactNode;
  /** The revision the system grew to (null — none yet). */
  previewRevision: number | null;
  /** Share of the build done, 0…1, by the clock (elapsed against elapsed + left). */
  fraction: number;
  /** What the build does now («Пишу тексты»), null at the end. */
  stageLabel: string | null;
  /** The chat dock after a v3 build: «Система готова» and the way to the system. */
  ready: ReactNode;
  /** The ready toast (fixed over the canvas). */
  toast: ReactNode;
  /** «потрачено X ₽ из Y» for the build row. */
  spend: string | null;
  /** Seconds left for the ring and the build row (null — not a v3 build). */
  remainingSec: number | null;
}

/** The live v3 build of the canvas: one call, the canvas places what it returns. */
export function useV3Live(o: UseV3LiveOptions): V3LiveView {
  const current = useMemo(() => v3Live(o.events), [o.events]);
  // The latest build stays on the canvas while another run (a chat turn) is followed; a new build run without its
  // first snapshot yet clears it (no stale checklist of the previous build).
  const kept = useRef<V3Live | null>(null);
  if (current) kept.current = current;
  else if (o.events.length > 0) kept.current = null;
  const live = current ?? kept.current;
  const now = useNow(live?.phase === "running" ? 5000 : null);
  const [notify, setNotify] = useState<NotifyState>(() => notifyState());
  const [toast, setToast] = useState<{ title: string; text: string } | null>(null);
  const { announce, onNews } = o;

  // Status changes in words for screen readers — only fresh ones (a replay on return stays quiet).
  const seen = useRef<{ stage: string | null; statuses: Map<string, string>; preview: number | null } | null>(
    null,
  );
  useEffect(() => {
    if (!live) return;
    const p = live.progress;
    const prev = seen.current;
    seen.current = {
      stage: p.stage,
      statuses: new Map(p.scenarios.map((x) => [x.id, x.status])),
      preview: p.previewRevision,
    };
    if (!prev || live.phase !== "running" || Date.now() - live.at > ANNOUNCE_MS) return;
    const said: string[] = [];
    if (p.stage !== prev.stage) {
      const label = p.stages.find((x) => x.id === p.stage)?.label_ru;
      if (label) said.push(T.announce.stage(label));
    }
    for (const x of p.scenarios) {
      const was = prev.statuses.get(x.id);
      if (was === x.status) continue;
      if (x.status === "passed" && !x.reused) said.push(T.announce.passed(x.title));
      if (x.status === "failed" || x.status === "stopped") said.push(T.announce.moved(x.title));
    }
    if (p.previewRevision !== null && p.previewRevision !== prev.preview && prev.preview !== null)
      said.push(T.announce.preview);
    if (said.length) {
      announce(said.join(". "));
      onNews?.(said[said.length - 1] as string);
    }
  }, [live, announce, onNews]);

  // The end: the toast and the browser notice once per run, for a fresh finish only.
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (!live || live.phase === "running" || told.current === live.runId) return;
    told.current = live.runId;
    if (live.endedAt === null || Date.now() - live.endedAt > FRESH_MS) return;
    announce(live.phase === "done" ? T.announce.done : T.announce.failed);
    if (live.phase !== "done" || !firstNotice(live.runId)) return;
    const { done, total } = scenarioCount(live.progress);
    const title = T.toast.title(o.name);
    const text = T.ready.meta(done, total);
    setToast({ title, text });
    showNotice(title, text, `wz-v3-ready-${live.runId}`);
  }, [live, announce, o.name]);

  // The toast says its news and goes: it never stays over the site or the panels the owner opens next.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const askNotifyNow = useCallback(() => {
    void askNotify().then(setNotify);
  }, []);

  const { onLook } = o;
  const look = useCallback(() => onLook?.(), [onLook]);

  if (!live)
    return {
      live: null,
      panel: null,
      previewRevision: null,
      fraction: 0,
      stageLabel: null,
      ready: null,
      toast: null,
      spend: null,
      remainingSec: null,
    };
  const p = live.progress;
  const { done, total } = scenarioCount(p);
  const clock = liveClock(live, now);
  const panel = (
    <section
      className={s.live}
      aria-label={T.title[live.phase]}
      data-testid="canvas-v3-live"
      data-phase={live.phase}
    >
      <V3LivePanel
        live={live}
        now={now}
        notify={notify}
        onAskNotify={askNotifyNow}
        {...(o.onStop ? { onStop: o.onStop } : {})}
      />
    </section>
  );
  const span = clock.elapsedSec + clock.remainingSec;
  const ready =
    live.phase === "done" ? (
      <div className={s.ready} data-testid="canvas-v3-live-ready">
        <Serif as="p" size="lg">
          {T.ready.title}
        </Serif>
        <p className={s.readyMeta}>{T.ready.meta(done, total)}</p>
        <ActionButton variant="primary" testId="canvas-v3-live-look" onClick={look}>
          {T.ready.look}
        </ActionButton>
      </div>
    ) : null;
  const toastNode = toast ? (
    <div className={s.toast} role="status" data-testid="canvas-v3-live-toast">
      <span className={s.toastMark} aria-hidden="true">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      </span>
      <span className={s.toastBody}>
        <span className={s.toastTitle}>{toast.title}</span>
        <span className={s.toastText}>{toast.text}</span>
      </span>
      <button
        type="button"
        className={s.toastClose}
        aria-label={T.toast.close}
        data-testid="canvas-v3-live-toast-close"
        onClick={() => setToast(null)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  ) : null;
  return {
    live,
    panel,
    previewRevision: p.previewRevision,
    fraction: live.phase === "running" ? (span > 0 ? Math.min(0.99, clock.elapsedSec / span) : 0) : 1,
    stageLabel:
      live.phase === "running" ? (p.stages.find((x) => x.id === p.stage)?.label_ru ?? T.starting) : null,
    ready,
    toast: toastNode,
    spend: T.spend.line(p.spentRub, p.capRub),
    remainingSec: clock.remainingSec,
  };
}
