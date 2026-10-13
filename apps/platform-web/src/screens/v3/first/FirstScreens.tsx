// «Сначала показать» (V4-08, D79_v4 (7)): as soon as the first message has a brief, three first screens of the
// directions (V3-09 /directions) fill the canvas at the real width of the window — one at a time, turned with the
// arrows, the keyboard or a swipe; «Собрать в этом стиле» is the one choice (D7 approval): the canvas finishes the
// interview by the recommendations when blocking questions are still open, saves the pick into the brief and starts
// the build. The questions stay in the chat meanwhile.
import { ActionButton } from "@wizard/ui-kit/v2";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  createDirectionsApi,
  type DirectionsApi,
  type DirectionsPendingView,
  type DirectionsProposalView,
  type DirectionView,
} from "../../../v3/directions/index.js";
import s from "./FirstScreens.module.css";
import { firstRu as T } from "./ru.js";

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : T.failed);
const SWIPE_PX = 48;
/** V4-17: how often a proposal being drawn is asked again, ms. */
export const FIRST_POLL_MS = 1500;
/** Failed reads in a row before the wait gives up (a blip of the network is waited out). */
const POLL_FAILURES = 4;
/** No endless wait: past this the canvas says so and offers to try again (the server's own deadline is 6 min), ms. */
export const FIRST_WAIT_MAX_MS = 8 * 60_000;

export interface FirstScreensState {
  proposal: DirectionsProposalView | null;
  /** V4-17: the proposal being drawn — its stage, the directions already ready and the skeleton. */
  pending: DirectionsPendingView | null;
  /** The directions to show: the ready ones while drawing, then the proposal's (the frames already shown are kept). */
  directions: DirectionView[];
  /** How many there will be. */
  total: number;
  loading: boolean;
  error: string | null;
  /** When the proposal was asked (ms), for the «≈ N с» line. */
  since: number | null;
  reroll(): void;
  retry(): void;
  api: DirectionsApi;
}

const sameScreen = (a: DirectionView, b: DirectionView) =>
  a.n === b.n && a.archetype === b.archetype && a.texts.title === b.texts.title && a.name === b.name;

/**
 * The first screens of a system: read the latest proposal, else ask for one as soon as the brief has a version.
 * V4-17: the proposal is drawn in the background — each first screen shows as soon as it is ready, the rest follow.
 * `briefVersion` null — no brief yet (the first turn still runs); a failure is retried when the brief grows.
 */
export function useFirstScreens(o: {
  systemId: string;
  enabled: boolean;
  briefVersion: number | null;
  api?: DirectionsApi;
  pollMs?: number;
  maxWaitMs?: number;
}): FirstScreensState {
  const [api] = useState(() => o.api ?? createDirectionsApi());
  const [proposal, setProposal] = useState<DirectionsProposalView | null>(null);
  const [pending, setPending] = useState<DirectionsPendingView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [since, setSince] = useState<number | null>(null);
  const asked = useRef<number | null>(null);
  const live = useRef(true);
  // The frames already shown, by direction: the stored proposal serves the same screen under another URL.
  const shown = useRef(new Map<number, DirectionView>());
  // Only the latest ask may write (a reroll or a retry supersedes the wait before it).
  const turn = useRef(0);
  const pollMs = o.pollMs ?? FIRST_POLL_MS;
  // StrictMode mounts twice: the flag is set again on every mount, not only at creation.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const keep = useCallback((list: readonly DirectionView[]): DirectionView[] => {
    return list.map((d) => {
      const before = shown.current.get(d.n);
      if (before && sameScreen(before, d)) return { ...d, previewHtml: before.previewHtml };
      shown.current.set(d.n, d);
      return d;
    });
  }, []);

  const ask = useCallback(
    // `fresh`: start a new proposal even when one is being drawn (a retry after a failure or a wait too long).
    async (reroll: boolean, fresh = false) => {
      const me = ++turn.current;
      const mine = () => live.current && turn.current === me;
      setLoading(true);
      setError(null);
      setSince(Date.now());
      try {
        let st = reroll || fresh ? null : await api.state(o.systemId);
        if (st?.proposal && !st.pending) {
          if (mine()) setProposal({ ...st.proposal, directions: keep(st.proposal.directions) });
          return;
        }
        let p = st?.pending && st.pending.stage !== "failed" ? st.pending : null;
        if (!p) {
          shown.current.clear();
          p = await api.start(o.systemId, reroll);
        }
        if (!mine()) return;
        const began = Date.now() - p.elapsedMs;
        setSince(began);
        setPending({ ...p, ready: keep(p.ready) });
        let failures = 0;
        for (;;) {
          await new Promise((r) => setTimeout(r, pollMs));
          if (!mine()) return;
          if (Date.now() - began > (o.maxWaitMs ?? FIRST_WAIT_MAX_MS)) throw new Error(T.tooLong);
          try {
            st = await api.state(o.systemId);
            failures = 0;
          } catch (e) {
            if (++failures >= POLL_FAILURES) throw e;
            continue;
          }
          if (!mine()) return;
          if (st.pending) {
            if (st.pending.stage === "failed") throw new Error(st.pending.error ?? T.failed);
            setPending({ ...st.pending, ready: keep(st.pending.ready) });
            continue;
          }
          if (st.proposal) {
            setProposal({ ...st.proposal, directions: keep(st.proposal.directions) });
            setPending(null);
            return;
          }
          throw new Error(T.failed);
        }
      } catch (e) {
        if (mine()) {
          setPending(null);
          setError(errText(e));
        }
      } finally {
        if (mine()) setLoading(false);
      }
    },
    [api, o.systemId, keep, pollMs, o.maxWaitMs],
  );

  useEffect(() => {
    if (!o.enabled || o.briefVersion === null || proposal || loading) return;
    // Once per brief version: a failure (no brief yet, a blip) is tried again when the interview writes a new one.
    if (asked.current === o.briefVersion) return;
    asked.current = o.briefVersion;
    void ask(false);
  }, [o.enabled, o.briefVersion, proposal, loading, ask]);

  const directions = pending ? pending.ready : (proposal?.directions ?? []);
  return {
    proposal,
    pending,
    directions,
    total: pending ? pending.total : directions.length,
    loading,
    error,
    since,
    api,
    reroll: () => void ask(true),
    retry: () => void ask(false, true),
  };
}

export interface FirstScreensProps {
  state: FirstScreensState;
  /** The owner may build (editor). */
  editable: boolean;
  /** «Собрать в этом стиле» was pressed and is going on (finishing the interview, the pick, the start). */
  building: boolean;
  /** Why the build could not start, in words. */
  buildError?: string | null;
  onBuild(n: number): void;
}

/** The live status of a proposal being drawn, in words. */
function statusText(p: DirectionsPendingView | null, ready: number, sec: number): string {
  if (ready > 0 && p) return T.readyMore(ready, p.total);
  if (!p) return T.loading(sec);
  return `${T.stage[p.stage === "failed" ? "design" : p.stage]} ${T.seconds(sec)}`;
}

/** The three first screens on the whole canvas. */
export function FirstScreens({
  state,
  editable,
  building,
  buildError,
  onBuild,
}: FirstScreensProps): ReactNode {
  const { proposal, pending, loading, error } = state;
  const [current, setCurrent] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const touch = useRef<number | null>(null);
  const list = state.directions;
  const n = list.length;
  // The direction on screen is kept by its number: the list grows while drawing and is reordered once stored.
  const at = Math.max(
    0,
    list.findIndex((x) => x.n === current),
  );
  const d = list[at];
  const sec = state.since ? Math.max(0, Math.round((now - state.since) / 1000)) : 0;

  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [loading]);

  const go = useCallback(
    (step: number) => {
      if (!n) return;
      const next = list[(at + step + n) % n];
      if (next) setCurrent(next.n);
    },
    [n, at, list],
  );
  useEffect(() => {
    if (n < 2) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [n, go]);

  if (!d) {
    if (error || !pending)
      return (
        <div className={s.wait} data-testid="first-screens" data-state={error ? "error" : "loading"}>
          <div className={s.waitBox}>
            <p className={s.waitTitle}>{error ? T.failedTitle : T.loadingTitle}</p>
            <p className={s.waitText} aria-live="polite">
              {error ?? (loading ? T.loading(sec) : T.waiting)}
            </p>
            {error && (
              <ActionButton size="sm" testId="first-screens-retry" onClick={state.retry}>
                {T.retry}
              </ActionButton>
            )}
          </div>
        </div>
      );
    // V4-17: the skeleton of the first screen in the brief's words and colour, the stage said live.
    const k = pending.skeleton;
    return (
      <div
        className={s.sketch}
        data-testid="first-screens"
        data-state="drawing"
        data-stage={pending.stage}
        style={k.accent ? ({ "--first-accent": k.accent } as CSSProperties) : undefined}
      >
        <div className={s.sketchPage} aria-hidden="true">
          <div className={s.sketchNav}>
            <i />
            <span>
              <i />
              <i />
              <i />
            </span>
          </div>
          <div className={s.sketchHero}>
            <div className={s.sketchText}>
              <p className={s.sketchTitle} data-testid="first-screens-sketch-title">
                {k.title}
              </p>
              {k.lead && <p className={s.sketchLead}>{k.lead}</p>}
              <span className={s.sketchButton}>{k.action}</span>
            </div>
            <div className={s.sketchPhoto} />
          </div>
        </div>
        <div className={s.bar} data-testid="first-screens-bar">
          <p className={s.count}>{T.loadingTitle}</p>
          <p className={s.status} aria-live="polite" data-testid="first-screens-status">
            {statusText(pending, 0, sec)}
          </p>
          <span className={s.dots} aria-hidden="true">
            {Array.from({ length: pending.total }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders of the directions still drawn
              <i key={i} data-wait="" />
            ))}
          </span>
        </div>
      </div>
    );
  }

  const total = Math.max(state.total, n);
  return (
    <section
      className={s.root}
      aria-roledescription={T.carousel}
      aria-label={T.label}
      data-testid="first-screens"
      data-state={pending ? "partial" : "ready"}
      data-current={d.n}
      data-ready={n}
      onTouchStart={(e) => {
        touch.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const x0 = touch.current;
        const x1 = e.changedTouches[0]?.clientX;
        touch.current = null;
        if (x0 === null || x1 === undefined || Math.abs(x1 - x0) < SWIPE_PX) return;
        go(x1 < x0 ? 1 : -1);
      }}
    >
      <iframe
        key={`${d.n}:${d.archetype}`}
        className={s.frame}
        srcDoc={d.previewHtml}
        sandbox="allow-scripts"
        title={T.frame(d.name)}
        data-testid="first-screens-frame"
      />
      <div className={s.bar} data-testid="first-screens-bar">
        <div className={s.text}>
          <p className={s.count} data-testid="first-screens-count">
            {T.count(at + 1, total)}
          </p>
          <p className={s.name} data-testid="first-screens-name">
            {d.name}
          </p>
          <p className={s.why}>{d.why}</p>
          {pending && (
            <p className={s.status} aria-live="polite" data-testid="first-screens-status">
              {statusText(pending, n, sec)}
            </p>
          )}
          {!pending && proposal?.fallback && (
            <p className={s.status} data-testid="first-screens-fallback">
              {T.fallback}
            </p>
          )}
        </div>
        <div className={s.actions}>
          {total > 1 && (
            <span className={s.nav}>
              <button
                type="button"
                className={s.arrow}
                aria-label={T.prev}
                data-testid="first-screens-prev"
                disabled={n < 2}
                onClick={() => go(-1)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M15 5l-7 7 7 7" />
                </svg>
              </button>
              <span className={s.dots} aria-hidden="true">
                {list.map((x, k) => (
                  <i key={x.n} data-on={k === at ? "" : undefined} />
                ))}
                {Array.from({ length: total - n }, (_, k) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: placeholders of the directions still drawn
                  <i key={`wait-${k}`} data-wait="" />
                ))}
              </span>
              <button
                type="button"
                className={s.arrow}
                aria-label={T.next}
                data-testid="first-screens-next"
                disabled={n < 2}
                onClick={() => go(1)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </span>
          )}
          {editable && (
            <>
              <ActionButton
                variant="create"
                testId="first-screens-build"
                busy={building}
                disabled={building}
                onClick={() => onBuild(d.n)}
              >
                {building ? T.building : T.build}
              </ActionButton>
              <ActionButton
                variant="ghost"
                size="sm"
                testId="first-screens-reroll"
                disabled={building || loading}
                onClick={state.reroll}
              >
                {T.reroll}
              </ActionButton>
            </>
          )}
        </div>
        {buildError && (
          <p className={s.error} role="alert" data-testid="first-screens-error">
            {buildError}
          </p>
        )}
      </div>
    </section>
  );
}
