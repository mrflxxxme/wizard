// Edits in three layers (V4-12, D79_v4 (9)) over the server of V4-15, in the «Правка» panel of the canvas v4:
// 1) instant, no model — a text or a photo picked on the site (the preview bridge edit-mode posts its source refs, the
//    values come from GET /edit/literals) is saved in ≈ 1 s, and the style sliders (radius, density, contrast, fonts)
//    change the site at once through apply-theme-tokens and are saved into the design system;
// 2) «Укажи и измени» — a block picked on the site (select-mode) and a wish in words: POST /messages with its target,
//    the agent edits only that block's file;
// 3) the chat for everything else.
import { ActionButton } from "@wizard/ui-kit/v2";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { MessageTarget } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import type { FromPreview } from "../../preview/bridge.js";
import type { FrameBridge } from "../../preview/SystemFrame.js";
import {
  type Contrast,
  createEditApi,
  type Density,
  type DesignControls,
  type DesignView,
  type EditApi,
  type Literal,
  type Radius,
} from "./api.js";
import s from "./EditPanel.module.css";
import { swapPhotoValue } from "./photos/api.js";
import { PhotoPicker } from "./photos/PhotoPicker.js";
import { photosRu } from "./photos/ru.js";
import { editRu as T } from "./ru.js";

/** POST /edit/literals: a text is at most this long (V4-15 VALIDATION). */
export const LITERAL_MAX = 500;
const RADII: Radius[] = ["sharp", "crisp", "soft", "round"];
const DENSITIES: Density[] = ["compact", "regular", "airy"];
const CONTRASTS: Contrast[] = ["normal", "high"];

type Tab = "text" | "style" | "point";

export interface EditPanelProps {
  systemId: string;
  /** The owner may edit (editor) and no build holds the system. */
  editable: boolean;
  /** A build runs: edits wait. */
  locked: boolean;
  bridge: FrameBridge | null;
  /** The latest message of the preview bridge (seq — a new one even when equal). */
  incoming: { seq: number; msg: FromPreview } | null;
  /** A new draft revision with its preview: the canvas re-reads the system and swaps the frame. */
  onSaved(previewRevision: number): void;
  /** «Укажи и измени» started a run: the canvas follows it. */
  onRun(runId: string): void;
  /** Drops an unsaved preview of the style (the frame reloads the shown revision). */
  onReloadFrame(): void;
  /** The owner starts picking on the site (the canvas hides the panel meanwhile). */
  onPick?(): void;
  /** Test double of the edit API. */
  api?: EditApi;
}

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : T.network);

export function EditPanel(p: EditPanelProps): ReactNode {
  const { api: platform } = usePlatform();
  const [api] = useState(() => p.api ?? createEditApi());
  const [tab, setTab] = useState<Tab>("text");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { bridge } = p;

  // ——— texts and photos ———
  const [picking, setPicking] = useState(false);
  const [lits, setLits] = useState<{ revision: number; list: Literal[] } | null>(null);
  const [selected, setSelected] = useState<{ refs: string[]; kind: "text" | "image" } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  // ——— style ———
  const [design, setDesign] = useState<DesignView | null>(null);
  const [styleDraft, setStyleDraft] = useState<DesignControls | null>(null);
  const [styleUnavailable, setStyleUnavailable] = useState(false);

  // ——— «Укажи и измени» ———
  const [pointing, setPointing] = useState(false);
  const [target, setTarget] = useState<MessageTarget | null>(null);
  const [wish, setWish] = useState("");

  const loadLiterals = useCallback(async () => {
    const r = await api.literals(p.systemId);
    setLits({ revision: r.revision, list: r.literals });
    return r;
  }, [api, p.systemId]);

  // Modes of the frame follow the tab: edit-mode for texts and photos, select-mode for a block; off when leaving.
  useEffect(() => {
    if (!bridge) return;
    bridge.send({ type: "edit-mode", payload: { enabled: tab === "text" && picking } });
    bridge.send({ type: "select-mode", payload: { enabled: tab === "point" && pointing } });
  }, [bridge, tab, picking, pointing]);
  useEffect(
    () => () => {
      bridge?.send({ type: "edit-mode", payload: { enabled: false } });
      bridge?.send({ type: "select-mode", payload: { enabled: false } });
      bridge?.send({ type: "highlight-literal", payload: { refs: null } });
    },
    [bridge],
  );

  // Messages of the bridge: a literal or a block picked, Esc.
  const seq = p.incoming?.seq;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one step per new message
  useEffect(() => {
    const m = p.incoming?.msg;
    if (!m) return;
    if (m.type === "literal-selected") {
      setNote(null);
      setError(null);
      setSelected({ refs: m.payload.refs, kind: m.payload.kind });
      setPicking(false);
      void loadLiterals()
        .then((r) => {
          const byRef = new Map(r.literals.map((l) => [l.ref, l]));
          setDraft(
            Object.fromEntries(
              m.payload.refs.flatMap((ref) => {
                const l = byRef.get(ref);
                return l ? [[ref, l.value]] : [];
              }),
            ),
          );
          bridge?.send({ type: "highlight-literal", payload: { refs: m.payload.refs } });
        })
        .catch((e) => setError(errText(e)));
    }
    if (m.type === "element-selected") {
      setPointing(false);
      setTarget({
        wzId: m.payload.wzId,
        componentName: m.payload.componentName,
        file: m.payload.file,
        line: m.payload.line,
        ...(m.payload.route ? { route: m.payload.route } : {}),
      });
    }
    if (m.type === "select-cancelled") {
      setPicking(false);
      setPointing(false);
    }
  }, [seq]);

  // The style: read once the tab is opened.
  useEffect(() => {
    if (tab !== "style" || design || styleUnavailable) return;
    let live = true;
    api
      .design(p.systemId)
      .then((d) => {
        if (!live) return;
        setDesign(d);
        setStyleDraft({ radius: d.radius, density: d.density, contrast: d.contrast, fontPair: d.fontPair });
      })
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) setStyleUnavailable(true);
        else setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [api, p.systemId, tab, design, styleUnavailable]);

  const byRef = useMemo(() => new Map((lits?.list ?? []).map((l) => [l.ref, l])), [lits]);

  function failure(e: unknown) {
    if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
      setNote(T.stale);
      void loadLiterals().catch(() => {});
      return;
    }
    if (e instanceof ApiError && e.code === "SYSTEM_LOCKED") return setError(T.locked);
    setError(errText(e));
  }

  /** V4-16: a photo of the slot — the instant edit of its literal (no model); the frame swaps to the new revision. */
  async function savePhoto(ref: string, value: string, id: string) {
    if (!lits) return;
    setError(null);
    setNote(null);
    try {
      const r = await api.saveLiterals(p.systemId, lits.revision, [
        { ref, value: swapPhotoValue(value, id) },
      ]);
      setNote(photosRu.applied((r.ms / 1000).toFixed(1)));
      p.onSaved(r.previewRevision);
      await loadLiterals().catch(() => {});
    } catch (e) {
      failure(e);
    }
  }

  async function saveText() {
    if (!selected || !lits) return;
    const edits = selected.refs
      .filter((ref) => byRef.get(ref) && draft[ref] !== undefined && draft[ref] !== byRef.get(ref)?.value)
      .map((ref) => ({ ref, value: (draft[ref] ?? "").trim() }));
    if (edits.length === 0) return;
    if (edits.some((x) => byRef.get(x.ref)?.kind !== "image" && !x.value)) return setError(T.text.empty);
    if (edits.some((x) => x.value.length > LITERAL_MAX)) return setError(T.text.tooLong(LITERAL_MAX));
    setBusy("text");
    setError(null);
    setNote(null);
    try {
      const r = await api.saveLiterals(p.systemId, lits.revision, edits);
      setNote(T.text.saved((r.ms / 1000).toFixed(1)));
      p.onSaved(r.previewRevision);
      await loadLiterals().catch(() => {});
    } catch (e) {
      failure(e);
    } finally {
      setBusy(null);
    }
  }

  // The live preview of the sliders: the --ds-* variables of every value that differs from the saved style.
  function previewStyle(next: DesignControls) {
    setStyleDraft(next);
    if (!design || !bridge) return;
    const tokens = {
      ...(design.preview.radius[next.radius] ?? {}),
      ...(design.preview.density[next.density] ?? {}),
      ...(design.preview.contrast[next.contrast] ?? {}),
      ...(design.preview.fontPair[next.fontPair] ?? {}),
    };
    bridge.send({ type: "apply-theme-tokens", payload: { tokens } });
  }

  const styleChanged =
    !!design &&
    !!styleDraft &&
    (styleDraft.radius !== design.radius ||
      styleDraft.density !== design.density ||
      styleDraft.contrast !== design.contrast ||
      styleDraft.fontPair !== design.fontPair);

  async function saveStyle() {
    if (!design || !styleDraft || !styleChanged) return;
    const changed: Partial<DesignControls> = {};
    for (const k of ["radius", "density", "contrast", "fontPair"] as const)
      if (styleDraft[k] !== design[k]) Object.assign(changed, { [k]: styleDraft[k] });
    setBusy("style");
    setError(null);
    setNote(null);
    try {
      const r = await api.saveDesign(p.systemId, design.revision, changed);
      setNote(T.style.saved);
      p.onSaved(r.previewRevision);
      setDesign(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        setNote(T.stale);
        setDesign(null);
      } else failure(e);
    } finally {
      setBusy(null);
    }
  }

  function resetStyle() {
    if (!design) return;
    setStyleDraft({
      radius: design.radius,
      density: design.density,
      contrast: design.contrast,
      fontPair: design.fontPair,
    });
    p.onReloadFrame();
  }

  async function sendWish() {
    const text = wish.trim();
    if (!target || !text) return;
    setBusy("point");
    setError(null);
    try {
      const r = await platform.postMessage(p.systemId, text, { target });
      setWish("");
      setTarget(null);
      setNote(T.point.started);
      p.onRun(r.run.id);
    } catch (e) {
      failure(e);
    } finally {
      setBusy(null);
    }
  }

  const disabled = !p.editable || p.locked;

  return (
    <div className={s.root} data-testid="edit-panel">
      <div className={s.tabs} role="tablist" aria-label={T.title}>
        {(["text", "style", "point"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={s.tab}
            data-testid={`edit-tab-${t}`}
            onClick={() => {
              setTab(t);
              setError(null);
              setNote(null);
            }}
          >
            {T.tabs[t]}
          </button>
        ))}
      </div>

      {p.locked && <p className={s.note}>{T.locked}</p>}

      {tab === "text" && (
        <section className={s.section} data-testid="edit-text">
          <ActionButton
            size="sm"
            variant={picking ? "primary" : "secondary"}
            testId="edit-text-pick"
            disabled={disabled || !bridge}
            onClick={() => {
              if (!picking) p.onPick?.();
              setPicking((x) => !x);
            }}
          >
            {picking ? T.text.stop : T.text.pick}
          </ActionButton>
          {picking && <p className={s.hint}>{T.text.picking}</p>}
          {!selected && !picking && <p className={s.hint}>{T.text.none}</p>}
          {selected && lits && (
            <div className={s.fields}>
              {selected.refs.map((ref) => {
                const l = byRef.get(ref);
                if (!l) return null;
                if (l.kind === "image")
                  return (
                    <div key={ref} className={s.field}>
                      <span className={s.label}>{T.text.photo}</span>
                      <PhotoPicker
                        systemId={p.systemId}
                        slotRef={ref}
                        currentId={/[0-9a-f-]{36}/.exec(l.value)?.[0] ?? null}
                        disabled={disabled}
                        onPick={(id) => savePhoto(ref, l.value, id)}
                      />
                    </div>
                  );
                return (
                  <label key={ref} className={s.field}>
                    <span className={s.label}>{l.kind === "alt" ? T.text.alt : T.text.field}</span>
                    <textarea
                      className={s.textarea}
                      rows={Math.min(6, Math.max(2, Math.ceil((draft[ref] ?? l.value).length / 40)))}
                      maxLength={LITERAL_MAX + 50}
                      value={draft[ref] ?? l.value}
                      data-testid="edit-text-field"
                      onChange={(e) => setDraft((d) => ({ ...d, [ref]: e.target.value }))}
                    />
                  </label>
                );
              })}
              {selected.refs.some((ref) => byRef.get(ref)?.kind !== "image") && (
                <ActionButton
                  variant="primary"
                  testId="edit-text-save"
                  busy={busy === "text"}
                  disabled={disabled || busy !== null}
                  onClick={() => void saveText()}
                >
                  {busy === "text" ? T.text.saving : T.text.save}
                </ActionButton>
              )}
            </div>
          )}
        </section>
      )}

      {tab === "style" && (
        <section className={s.section} data-testid="edit-style">
          {styleUnavailable && <p className={s.hint}>{T.style.unavailable}</p>}
          {design && styleDraft && (
            <>
              <Segmented
                label={T.style.radius}
                id="radius"
                values={RADII}
                value={styleDraft.radius}
                disabled={disabled}
                onChange={(v) => previewStyle({ ...styleDraft, radius: v })}
              />
              <Segmented
                label={T.style.density}
                id="density"
                values={DENSITIES}
                value={styleDraft.density}
                disabled={disabled}
                onChange={(v) => previewStyle({ ...styleDraft, density: v })}
              />
              <Segmented
                label={T.style.contrast}
                id="contrast"
                values={CONTRASTS}
                value={styleDraft.contrast}
                disabled={disabled}
                onChange={(v) => previewStyle({ ...styleDraft, contrast: v })}
              />
              <label className={s.field}>
                <span className={s.label}>{T.style.fonts}</span>
                <select
                  className={s.select}
                  value={styleDraft.fontPair}
                  disabled={disabled}
                  data-testid="edit-style-fonts"
                  onChange={(e) => previewStyle({ ...styleDraft, fontPair: e.target.value })}
                >
                  {design.fontPairs.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className={s.row}>
                <ActionButton
                  variant="primary"
                  testId="edit-style-save"
                  busy={busy === "style"}
                  disabled={disabled || !styleChanged || busy !== null}
                  onClick={() => void saveStyle()}
                >
                  {busy === "style" ? T.style.saving : T.style.save}
                </ActionButton>
                <ActionButton
                  variant="ghost"
                  size="sm"
                  testId="edit-style-reset"
                  disabled={!styleChanged || busy !== null}
                  onClick={resetStyle}
                >
                  {T.style.reset}
                </ActionButton>
              </div>
            </>
          )}
        </section>
      )}

      {tab === "point" && (
        <section className={s.section} data-testid="edit-point">
          <ActionButton
            size="sm"
            variant={pointing ? "primary" : "secondary"}
            testId="edit-point-pick"
            disabled={disabled || !bridge}
            onClick={() => {
              if (!pointing) p.onPick?.();
              setPointing((x) => !x);
            }}
          >
            {pointing ? T.point.picking : T.point.pick}
          </ActionButton>
          {!target && !pointing && <p className={s.hint}>{T.point.none}</p>}
          {target && (
            <div className={s.fields}>
              <p className={s.target} data-testid="edit-point-target">
                {T.point.target(target.componentName)}
              </p>
              <textarea
                className={s.textarea}
                rows={3}
                maxLength={2000}
                placeholder={T.point.placeholder}
                value={wish}
                data-testid="edit-point-wish"
                onChange={(e) => setWish(e.target.value)}
              />
              <ActionButton
                variant="primary"
                testId="edit-point-send"
                busy={busy === "point"}
                disabled={disabled || !wish.trim() || busy !== null}
                onClick={() => void sendWish()}
              >
                {busy === "point" ? T.point.sending : T.point.send}
              </ActionButton>
            </div>
          )}
        </section>
      )}

      {note && (
        <p className={s.note} role="status" data-testid="edit-note">
          {note}
        </p>
      )}
      {error && (
        <p className={s.error} role="alert" data-testid="edit-error">
          {error}
        </p>
      )}
    </div>
  );
}

function Segmented<V extends string>(o: {
  label: string;
  id: string;
  values: readonly V[];
  value: V;
  disabled: boolean;
  onChange(v: V): void;
}): ReactNode {
  return (
    <fieldset className={s.seg} data-testid={`edit-style-${o.id}`}>
      <legend className={s.label}>{o.label}</legend>
      <div className={s.segRow}>
        {o.values.map((v) => (
          <button
            key={v}
            type="button"
            className={s.segBtn}
            aria-pressed={o.value === v}
            disabled={o.disabled}
            data-testid={`edit-style-${o.id}-${v}`}
            onClick={() => o.onChange(v)}
          >
            {T.style.values[v] ?? v}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
