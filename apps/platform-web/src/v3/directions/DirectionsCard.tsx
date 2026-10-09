// «Три направления» chat card (V3-09; D77 (7)): three live first screens of the client's site — each a built preview
// in <iframe srcdoc sandbox="allow-scripts"> (an opaque origin: the preview cannot touch the platform) — with «Выбрать»,
// «Что поменять?» in the owner's words, «Решите за меня» and an optional logo / references block. Works at 390 px: one
// column, the preview scaled to the card width.
import { Chip } from "@wizard/ui-kit/v2";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ApiError } from "../../api/client.js";
import { Button } from "../../components/v2/Button.js";
import {
  createDirectionsApi,
  type DirectionsApi,
  type DirectionsProposalView,
  type DirectionView,
} from "./api.js";
import s from "./Directions.module.css";
import { directionsRu as t } from "./texts.js";

/** Largest logo or screenshot (api.yaml uploadDesignReference). */
export const DIRECTIONS_UPLOAD_MAX = 2 * 1024 * 1024;
const VIEWPORTS = { desktop: { w: 1280, h: 800 }, phone: { w: 390, h: 760 } } as const;
type ViewMode = keyof typeof VIEWPORTS;

export interface DirectionsCardProps {
  systemId: string;
  /** Default: the platform API. */
  api?: DirectionsApi;
  /** Owner or editor: the controls are shown (a viewer only looks). */
  editable?: boolean;
  /** The owner picked a direction or left it to the system. */
  onPicked?(p: { archetype: string; pinned: boolean }): void;
}

const errText = (e: unknown) => (e instanceof ApiError ? e.message : t.network);

/** A built first screen scaled into the card: rendered at the desktop or phone width, shrunk to fit. */
function Preview({ d, mode }: { d: DirectionView; mode: ViewMode }): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const vp = VIEWPORTS[mode];
  const scale = width > 0 ? Math.min(1, width / vp.w) : 0.28;
  return (
    <div ref={box} className={s.previewBox} style={{ height: Math.round(vp.h * scale) }}>
      <iframe
        className={s.preview}
        title={t.frameTitle(d.n, d.name)}
        srcDoc={d.previewHtml}
        sandbox="allow-scripts"
        loading="lazy"
        tabIndex={-1}
        data-testid={`direction-preview-${d.n}`}
        style={{ width: vp.w, height: vp.h, transform: `scale(${scale})` }}
      />
    </div>
  );
}

function Direction({
  d,
  mode,
  picked,
  busy,
  editable,
  onPick,
}: {
  d: DirectionView;
  mode: ViewMode;
  picked: boolean;
  busy: boolean;
  editable: boolean;
  onPick(n: number): void;
}): ReactNode {
  const head = `direction-${d.n}-title`;
  return (
    <article
      className={picked ? `${s.card} ${s.cardPicked}` : s.card}
      aria-labelledby={head}
      data-testid={`direction-${d.n}`}
    >
      <Preview d={d} mode={mode} />
      <div className={s.cardBody}>
        <h3 id={head} className={s.cardTitle}>
          {t.cardTitle(d.n, d.name)}
        </h3>
        <p className={s.why}>{d.why}</p>
        <p className={s.meta}>
          <span className={s.swatches} aria-hidden="true">
            {[d.palette.background, d.palette.foreground, d.palette.accent].map((c) => (
              <span key={c} className={s.swatch} style={{ backgroundColor: c }} />
            ))}
          </span>
          {t.fonts(d.fonts.display, d.fonts.text)}
        </p>
        {d.tuning.length > 0 && (
          <p className={s.meta}>
            {t.wishes} {d.tuning.join(", ")}
          </p>
        )}
        {editable && (
          <Button
            variant={picked ? "primary" : "secondary"}
            className={s.pick}
            aria-pressed={picked}
            disabled={busy}
            onClick={() => onPick(d.n)}
            data-testid={`direction-pick-${d.n}`}
          >
            {picked ? t.picked : t.pick}
          </Button>
        )}
      </div>
    </article>
  );
}

function References({
  systemId,
  api,
  used,
  onAdded,
}: {
  systemId: string;
  api: DirectionsApi;
  used: readonly string[];
  onAdded(line: string): void;
}): ReactNode {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = async (f: () => Promise<{ reference: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await f();
      setNote(t.added(r.reference));
      onAdded(r.reference);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const onFile = (kind: "logo" | "screenshot") => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > DIRECTIONS_UPLOAD_MAX) return setError(t.tooLarge);
    const ok = file.type === "image/png" || (kind === "logo" && file.type === "image/svg+xml");
    if (!ok) return setError(t.wrongType);
    void run(() => api.upload(systemId, kind, file));
  };
  const onUrl = (e: FormEvent) => {
    e.preventDefault();
    const v = url.trim();
    if (!v) return;
    void run(async () => {
      const r = await api.addUrl(systemId, v);
      setUrl("");
      return r;
    });
  };
  return (
    <details className={s.refs} data-testid="directions-references">
      <summary className={s.refsSummary}>{t.references}</summary>
      <p className={s.hint}>{t.referencesHint}</p>
      <div className={s.uploads}>
        <label className={s.upload}>
          <input
            type="file"
            accept="image/png,image/svg+xml"
            onChange={onFile("logo")}
            disabled={busy}
            data-testid="directions-logo"
          />
          <span>{t.logo}</span>
        </label>
        <label className={s.upload}>
          <input
            type="file"
            accept="image/png"
            onChange={onFile("screenshot")}
            disabled={busy}
            data-testid="directions-screenshot"
          />
          <span>{t.screenshot}</span>
        </label>
      </div>
      <form className={s.row} onSubmit={onUrl}>
        <label className={s.field}>
          <span className={s.label}>{t.url}</span>
          <input
            className={s.input}
            type="url"
            inputMode="url"
            placeholder={t.urlPlaceholder}
            value={url}
            maxLength={500}
            onChange={(e) => setUrl(e.target.value)}
            data-testid="directions-url"
          />
        </label>
        <Button
          type="submit"
          className={s.send}
          loading={busy}
          disabled={!url.trim()}
          data-testid="directions-url-add"
        >
          {t.urlAdd}
        </Button>
      </form>
      {used.length > 0 && (
        <div className={s.used}>
          <p className={s.label}>{t.usedRefs}</p>
          <ul>
            {used.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <p className={s.status} role="status" aria-live="polite">
        {busy ? t.uploading : note}
      </p>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </details>
  );
}

/** The card: loads the latest proposal of the system, or offers to make one. */
export function DirectionsCard({
  systemId,
  api: given,
  editable = true,
  onPicked,
}: DirectionsCardProps): ReactNode {
  const [api] = useState(() => given ?? createDirectionsApi());
  const [proposal, setProposal] = useState<DirectionsProposalView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"propose" | "refine" | "pick" | null>(null);
  const [text, setText] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refsChanged, setRefsChanged] = useState(false);
  const [mode, setMode] = useState<ViewMode>(() =>
    typeof window !== "undefined" && window.innerWidth < 700 ? "phone" : "desktop",
  );

  useEffect(() => {
    let live = true;
    api
      .get(systemId)
      .then((p) => live && setProposal(p))
      .catch((e) => live && setError(errText(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [api, systemId]);

  const act = useCallback(async (kind: "propose" | "refine" | "pick", f: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const propose = (reroll = false) =>
    act("propose", async () => {
      setProposal(await api.propose(systemId, reroll));
      setReply(null);
      setRefsChanged(false);
    });

  const refine = (words: string) => {
    const v = words.trim();
    if (!v || !proposal) return;
    void act("refine", async () => {
      const r = await api.refine(systemId, proposal.id, v);
      setProposal(r.proposal);
      setReply(r.reply);
      if (r.kind !== "unknown") setText("");
      const p = r.proposal.picked;
      if (r.kind === "pick" && p)
        onPicked?.({ archetype: r.proposal.directions[p - 1]?.archetype ?? "", pinned: true });
    });
  };

  const pick = (n: number | null) => {
    if (!proposal) return;
    void act("pick", async () => {
      const r = await api.pick(systemId, proposal.id, n);
      const d = n === null ? null : proposal.directions[n - 1];
      setProposal({ ...proposal, picked: n });
      setReply(d ? t.pickedNote(d.name) : t.skipped);
      onPicked?.(r);
    });
  };

  return (
    <section className={s.root} aria-labelledby="directions-title" data-testid="directions-card">
      <header className={s.head}>
        <h2 id="directions-title" className={s.title}>
          {t.title}
        </h2>
        <p className={s.intro}>{proposal ? t.intro : t.empty}</p>
      </header>

      {!proposal && !loading && editable && (
        <Button
          variant="create"
          className={s.send}
          loading={busy === "propose"}
          onClick={() => void propose()}
          data-testid="directions-propose"
        >
          {busy === "propose" ? t.proposing : t.propose}
        </Button>
      )}

      {proposal && (
        <>
          <div className={s.toolbar}>
            <fieldset className={s.toggle}>
              <legend className={s.srOnly}>{t.view}</legend>
              {(["desktop", "phone"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={s.toggleButton}
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                  data-testid={`directions-view-${m}`}
                >
                  {t[m]}
                </button>
              ))}
            </fieldset>
            {editable && (
              <div className={s.toolbarActions}>
                <Button
                  size="sm"
                  className={s.small}
                  disabled={!!busy}
                  onClick={() => void propose(true)}
                  data-testid="directions-reroll"
                >
                  {busy === "propose" ? t.proposing : t.reroll}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className={s.small}
                  disabled={!!busy}
                  onClick={() => pick(null)}
                  data-testid="directions-skip"
                >
                  {t.skip}
                </Button>
              </div>
            )}
          </div>

          <div className={s.grid}>
            {proposal.directions.map((d) => (
              <Direction
                key={`${proposal.id}-${d.n}`}
                d={d}
                mode={mode}
                picked={proposal.picked === d.n}
                busy={!!busy}
                editable={editable}
                onPick={(n) => pick(n)}
              />
            ))}
          </div>
          {proposal.fallback && <p className={s.hint}>{t.textsFromBrief}</p>}

          {editable && (
            <form
              className={s.refine}
              onSubmit={(e) => {
                e.preventDefault();
                refine(text);
              }}
            >
              <label className={s.field}>
                <span className={s.label}>{t.refineLabel}</span>
                <input
                  className={s.input}
                  value={text}
                  maxLength={500}
                  placeholder={t.refinePlaceholder}
                  onChange={(e) => setText(e.target.value)}
                  data-testid="directions-refine-input"
                />
              </label>
              <Button
                type="submit"
                variant="primary"
                className={s.send}
                loading={busy === "refine"}
                disabled={!text.trim() || !!busy}
                data-testid="directions-refine-send"
              >
                {busy === "refine" ? t.refining : t.refineSend}
              </Button>
              <fieldset className={s.examples}>
                <legend className={s.srOnly}>{t.examplesLabel}</legend>
                {t.examples.map((x) => (
                  <Chip key={x} tone="outline" disabled={!!busy} onClick={() => refine(x)}>
                    {x}
                  </Chip>
                ))}
              </fieldset>
            </form>
          )}
        </>
      )}

      <p className={s.status} role="status" aria-live="polite" data-testid="directions-reply">
        {busy === "propose" ? t.proposing : reply}
      </p>
      {error && (
        <p className={s.error} role="alert" data-testid="directions-error">
          {error}
        </p>
      )}

      {editable && (
        <>
          <References
            systemId={systemId}
            api={api}
            used={proposal?.references ?? []}
            onAdded={() => setRefsChanged(true)}
          />
          {refsChanged && proposal && (
            <Button
              className={s.send}
              disabled={!!busy}
              onClick={() => void propose()}
              data-testid="directions-refresh"
            >
              {t.refresh}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
