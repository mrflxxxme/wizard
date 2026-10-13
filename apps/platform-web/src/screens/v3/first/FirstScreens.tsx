// «Сначала показать» (V4-08, D79_v4 (7)): as soon as the first message has a brief, three first screens of the
// directions (V3-09 /directions) fill the canvas at the real width of the window — one at a time, turned with the
// arrows, the keyboard or a swipe; «Собрать в этом стиле» is the one choice (D7 approval): the canvas finishes the
// interview by the recommendations when blocking questions are still open, saves the pick into the brief and starts
// the build. The questions stay in the chat meanwhile.
import { ActionButton } from "@wizard/ui-kit/v2";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  createDirectionsApi,
  type DirectionsApi,
  type DirectionsProposalView,
} from "../../../v3/directions/index.js";
import s from "./FirstScreens.module.css";
import { firstRu as T } from "./ru.js";

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : T.failed);
const SWIPE_PX = 48;

export interface FirstScreensState {
  proposal: DirectionsProposalView | null;
  loading: boolean;
  error: string | null;
  /** When the proposal was asked (ms), for the «≈ N с» line. */
  since: number | null;
  reroll(): void;
  retry(): void;
  api: DirectionsApi;
}

/**
 * The first screens of a system: read the latest proposal, else ask for one as soon as the brief has a version.
 * `briefVersion` null — no brief yet (the first turn still runs); a failure is retried when the brief grows.
 */
export function useFirstScreens(o: {
  systemId: string;
  enabled: boolean;
  briefVersion: number | null;
  api?: DirectionsApi;
}): FirstScreensState {
  const [api] = useState(() => o.api ?? createDirectionsApi());
  const [proposal, setProposal] = useState<DirectionsProposalView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [since, setSince] = useState<number | null>(null);
  const asked = useRef<number | null>(null);
  const live = useRef(true);
  // StrictMode mounts twice: the flag is set again on every mount, not only at creation.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const ask = useCallback(
    async (reroll: boolean) => {
      setLoading(true);
      setError(null);
      setSince(Date.now());
      try {
        const current = reroll ? null : await api.get(o.systemId);
        const p = current ?? (await api.propose(o.systemId, reroll));
        if (live.current) setProposal(p);
      } catch (e) {
        if (live.current) setError(errText(e));
      } finally {
        if (live.current) setLoading(false);
      }
    },
    [api, o.systemId],
  );

  useEffect(() => {
    if (!o.enabled || o.briefVersion === null || proposal || loading) return;
    // Once per brief version: a failure (no brief yet, a blip) is tried again when the interview writes a new one.
    if (asked.current === o.briefVersion) return;
    asked.current = o.briefVersion;
    void ask(false);
  }, [o.enabled, o.briefVersion, proposal, loading, ask]);

  return {
    proposal,
    loading,
    error,
    since,
    api,
    reroll: () => void ask(true),
    retry: () => void ask(false),
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

/** The three first screens on the whole canvas. */
export function FirstScreens({
  state,
  editable,
  building,
  buildError,
  onBuild,
}: FirstScreensProps): ReactNode {
  const { proposal, loading, error } = state;
  const [i, setI] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const touch = useRef<number | null>(null);
  const list = proposal?.directions ?? [];
  const n = list.length;
  const d = list[Math.min(i, Math.max(0, n - 1))];

  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [loading]);

  const go = useCallback((step: number) => setI((x) => (n ? (x + step + n) % n : 0)), [n]);
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
    const sec = state.since ? Math.max(0, Math.round((now - state.since) / 1000)) : 0;
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
          {!error && (
            <div className={s.skel} aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <section
      className={s.root}
      aria-roledescription={T.carousel}
      aria-label={T.label}
      data-testid="first-screens"
      data-state="ready"
      data-current={d.n}
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
        key={`${proposal?.id}:${d.n}`}
        className={s.frame}
        srcDoc={d.previewHtml}
        sandbox="allow-scripts"
        title={T.frame(d.name)}
        data-testid="first-screens-frame"
      />
      <div className={s.bar} data-testid="first-screens-bar">
        <div className={s.text}>
          <p className={s.count} data-testid="first-screens-count">
            {T.count(i + 1, n)}
          </p>
          <p className={s.name} data-testid="first-screens-name">
            {d.name}
          </p>
          <p className={s.why}>{d.why}</p>
        </div>
        <div className={s.actions}>
          {n > 1 && (
            <span className={s.nav}>
              <button
                type="button"
                className={s.arrow}
                aria-label={T.prev}
                data-testid="first-screens-prev"
                onClick={() => go(-1)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M15 5l-7 7 7 7" />
                </svg>
              </button>
              <span className={s.dots} aria-hidden="true">
                {list.map((x, k) => (
                  <i key={x.n} data-on={k === i ? "" : undefined} />
                ))}
              </span>
              <button
                type="button"
                className={s.arrow}
                aria-label={T.next}
                data-testid="first-screens-next"
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
