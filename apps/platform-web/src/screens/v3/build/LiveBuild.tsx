// The live v3 build on the canvas (V3-17; platform-screens.yaml#S-canvas v3_live, product.yaml D77_v3 (10)): the growing
// system (the live preview of the latest revision a part of the system landed in: the skeleton first, then the pages
// of each scenario), the checklist of the brief's scenarios, the time left against the 30 min cap, the spend against
// the cap, the technical details under «Подробнее»; the ready toast and the browser notice. Everything comes from the
// structured snapshot of the run's events (live.ts), so leaving the page and coming back restores it from the server.
import { ActionButton, Serif } from "@wizard/ui-kit/v2";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PreviewUrl, RunEvent, V3BuildProgress, V3ProgressScenario } from "../../../api/types.js";
import { usePlatform } from "../../../app/context.js";
import { previewSrc } from "../../../preview/bridge.js";
import s from "./LiveBuild.module.css";
import { liveClock, scenarioCount, type V3Live, type V3LiveClock, v3Live } from "./live.js";
import { askNotify, firstNotice, type NotifyState, notifyState, showNotice } from "./notify.js";
import { liveRu as T } from "./ru.js";

/** A finish this recent (server time) is news: the toast and the browser notice; an older one is just replayed. */
const FRESH_MS = 3 * 60_000;
/** Status changes this recent are announced (a replay of the run on return is not read out). */
const ANNOUNCE_MS = 60_000;
const PREVIEW_RETRY_MS = 1500;
const PREVIEW_RETRIES = 20;
const PREVIEW_DEBOUNCE_MS = 800;

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

/** The growing system: the live preview of the system, reloaded when a new part of it lands. */
export function LivePreview({
  systemId,
  revision,
}: {
  systemId: string;
  /** Revision of the snapshot (null — no preview yet); a new one reloads the frame. */
  revision: number | null;
}): ReactNode {
  const { api } = usePlatform();
  const [info, setInfo] = useState<PreviewUrl | null>(null);
  const [failed, setFailed] = useState(false);
  const loaded = useRef(false);
  useEffect(() => {
    if (revision === null) return;
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    // The bundle follows the gate by a moment: PREVIEW_NOT_READY is retried; a reload waits for the burst to settle.
    const attempt = async (left: number) => {
      try {
        const i = await api.getPreviewUrl(systemId);
        if (!alive) return;
        loaded.current = true;
        setFailed(false);
        setInfo((cur) => (cur && cur.revision === i.revision && cur.url === i.url ? cur : i));
      } catch {
        if (!alive) return;
        if (left > 0) t = setTimeout(() => void attempt(left - 1), PREVIEW_RETRY_MS);
        else setFailed(true);
      }
    };
    t = setTimeout(() => void attempt(PREVIEW_RETRIES), loaded.current ? PREVIEW_DEBOUNCE_MS : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [api, systemId, revision]);

  const src = info ? previewSrc(info.url, "/", info.revision) : null;
  let host = "";
  try {
    host = info ? new URL(info.url).host : "";
  } catch {
    host = "";
  }
  return (
    <section className={s.frameWrap} aria-label={T.preview.label} id="canvas-v3-live-preview" tabIndex={-1}>
      <div
        className={s.frame}
        data-testid="canvas-v3-live-preview"
        data-revision={info?.revision ?? undefined}
      >
        <div className={s.addr}>
          <span className={s.dots} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className={s.host}>{host || T.preview.label}</span>
          {info && <span className={s.rev}>{T.preview.revision(info.revision)}</span>}
          {src && (
            <a className={s.open} href={src} target="_blank" rel="noopener noreferrer">
              {T.preview.open}
            </a>
          )}
        </div>
        {src && info ? (
          <iframe
            key={info.revision}
            className={s.iframe}
            src={src}
            title={T.preview.frame}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
            data-testid="canvas-v3-live-frame"
          />
        ) : (
          <div className={s.pending} data-testid="canvas-v3-live-preview-pending">
            <div className={s.skel} aria-hidden="true">
              <span className={s.skHero} />
              <span className={s.skLine} />
              <span className={s.skLine} />
              <span className={s.skCards}>
                <i />
                <i />
                <i />
              </span>
            </div>
            <p className={s.pendingText}>
              {revision === null || failed ? T.preview.pending : T.preview.loading}
            </p>
          </div>
        )}
      </div>
      {src && <p className={s.caption}>{T.preview.growing}</p>}
    </section>
  );
}

export interface V3LivePanelProps {
  live: V3Live;
  now: number;
  notify: NotifyState;
  onAskNotify(): void;
}

/** The panel of the live build: what is going on, the time, the money, the scenarios and «Подробнее». */
export function V3LivePanel({ live, now, notify, onAskNotify }: V3LivePanelProps): ReactNode {
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
}

export interface V3LiveView {
  live: V3Live | null;
  /** The canvas main area: the panel and the growing system (null — not a v3 build). */
  main: ReactNode;
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
  const { announce } = o;

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
    if (said.length) announce(said.join(". "));
  }, [live, announce]);

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

  const askNotifyNow = useCallback(() => {
    void askNotify().then(setNotify);
  }, []);

  const look = useCallback(() => {
    const el = document.getElementById("canvas-v3-live-preview");
    if (!el) return;
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    el.focus({ preventScroll: true });
  }, []);

  if (!live) return { live: null, main: null, ready: null, toast: null, spend: null, remainingSec: null };
  const p = live.progress;
  const { done, total } = scenarioCount(p);
  const main = (
    <section
      className={s.live}
      aria-label={T.title[live.phase]}
      data-testid="canvas-v3-live"
      data-phase={live.phase}
    >
      <V3LivePanel live={live} now={now} notify={notify} onAskNotify={askNotifyNow} />
      <LivePreview systemId={o.systemId} revision={p.previewRevision} />
    </section>
  );
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
    main,
    ready,
    toast: toastNode,
    spend: T.spend.line(p.spentRub, p.capRub),
    remainingSec: liveClock(live, now).remainingSec,
  };
}
