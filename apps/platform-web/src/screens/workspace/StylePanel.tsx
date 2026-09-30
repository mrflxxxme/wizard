// S5 «Стиль»: token edits go to the preview at once; saving is POST /style with debounce 600 ms,
// 412 → re-read the system and retry once, 409 SYSTEM_LOCKED → retry after the run finishes (platform-screens.yaml S5).
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { Theme } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { ru } from "../../i18n/ru.js";
import {
  ACCENT_PRESETS,
  DENSITIES,
  FONTS,
  HEX_RE,
  hexId,
  MODES,
  RADII,
  withDefaults,
} from "../../style/theme.js";
import s from "./Workspace.module.css";

export const STYLE_DEBOUNCE_MS = 600;
const LOGO_MAX = 1024 * 1024;

type Status = "idle" | "saving" | "saved" | "locked" | "error";

export function useStyleSaver(o: {
  systemId: string;
  draftRevision: number;
  reloadRevision(): Promise<number>;
  runFinished: number;
}) {
  const { api } = usePlatform();
  const rev = useRef(o.draftRevision);
  const pending = useRef<Theme | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (o.draftRevision > rev.current) rev.current = o.draftRevision;
  }, [o.draftRevision]);

  const save = useCallback(
    async (theme: Theme, retried: boolean): Promise<void> => {
      try {
        const r = await api.setStyle(o.systemId, { expectedVersion: rev.current, theme });
        rev.current = r.revision.version;
      } catch (e) {
        if (e instanceof ApiError && e.status === 412 && !retried) {
          rev.current = await o.reloadRevision();
          return save(theme, true);
        }
        throw e;
      }
    },
    [api, o.systemId, o.reloadRevision],
  );

  const flush = useCallback(async () => {
    const theme = pending.current;
    if (!theme) return;
    setStatus("saving");
    setError(null);
    try {
      await save(theme, false);
      if (pending.current === theme) pending.current = null;
      setStatus(pending.current ? "saving" : "saved");
    } catch (e) {
      if (e instanceof ApiError && e.code === "SYSTEM_LOCKED") setStatus("locked");
      else {
        setStatus("error");
        setError(e instanceof Error ? e.message : ru.errors.generic);
      }
    }
  }, [save]);

  const schedule = useCallback(
    (theme: Theme) => {
      pending.current = theme;
      setStatus("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), STYLE_DEBOUNCE_MS);
    },
    [flush],
  );

  // «Сохраним после сборки»: repeat on run_finished.
  useEffect(() => {
    if (o.runFinished > 0 && pending.current) void flush();
  }, [o.runFinished, flush]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const uploadLogo = useCallback(
    async (file: File): Promise<string | null> => {
      if (!["image/png", "image/webp"].includes(file.type)) {
        setStatus("error");
        setError(ru.style.logoType);
        return null;
      }
      if (file.size > LOGO_MAX) {
        setStatus("error");
        setError(ru.style.logoTooBig);
        return null;
      }
      setStatus("saving");
      try {
        const r = await api.uploadLogo(o.systemId, file, rev.current);
        rev.current = r.revision.version;
        setStatus("saved");
        return r.path;
      } catch (e) {
        setStatus("error");
        setError(
          e instanceof ApiError && e.status === 415
            ? ru.style.logoType
            : e instanceof Error
              ? e.message
              : ru.errors.generic,
        );
        return null;
      }
    },
    [api, o.systemId],
  );

  return { status, error, schedule, retry: flush, uploadLogo };
}

export function StylePanel({
  theme,
  onChange,
  saver,
  onClose,
}: {
  theme: Theme;
  onChange(t: Theme): void;
  saver: ReturnType<typeof useStyleSaver>;
  onClose(): void;
}): ReactNode {
  const t = withDefaults(theme);
  const [custom, setCustom] = useState(t.accent);
  const set = (patch: Partial<Theme>) => {
    const next = { ...theme, ...patch };
    onChange(next);
    saver.schedule(next);
  };
  const statusText =
    saver.status === "saving"
      ? ru.style.saving
      : saver.status === "saved"
        ? ru.style.saved
        : saver.status === "locked"
          ? ru.style.afterBuild
          : "";

  return (
    <section className={s.style} data-testid="style-panel" aria-labelledby="style-title">
      <header className={s.styleHead}>
        <h2 id="style-title" className={s.blockTitle}>
          {ru.style.title} · <span className={s.muted}>{ru.style.subtitle}</span>
        </h2>
        <button type="button" className={s.linkButton} onClick={onClose} aria-label={ru.style.close}>
          ✕
        </button>
      </header>

      <fieldset className={s.fieldset}>
        <legend>{ru.style.accent}</legend>
        <div className={s.swatches}>
          {ACCENT_PRESETS.map((hex) => (
            <button
              key={hex}
              type="button"
              className={s.swatch}
              style={{ background: hex }}
              aria-label={hex}
              aria-pressed={t.accent.toUpperCase() === hex}
              data-testid={`style-accent-${hexId(hex)}`}
              onClick={() => {
                setCustom(hex);
                set({ accent: hex });
              }}
            />
          ))}
        </div>
        <label className={s.field}>
          {ru.style.accentCustom}
          <input
            type="text"
            data-testid="style-accent-custom"
            value={custom}
            maxLength={7}
            spellCheck={false}
            onChange={(e) => {
              setCustom(e.target.value);
              if (HEX_RE.test(e.target.value)) set({ accent: e.target.value.toUpperCase() });
            }}
          />
        </label>
      </fieldset>

      <label className={s.field}>
        {ru.style.font}
        <select
          data-testid="style-font"
          value={t.font}
          onChange={(e) => set({ font: e.target.value as (typeof FONTS)[number] })}
        >
          {FONTS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>

      <fieldset className={s.fieldset}>
        <legend>{ru.style.radius}</legend>
        <div className={s.segmented}>
          {RADII.map((r) => (
            <button
              key={r}
              type="button"
              className={t.radius === r ? s.segOn : s.seg}
              aria-pressed={t.radius === r}
              data-testid={`style-radius-${r}`}
              onClick={() => set({ radius: r })}
            >
              {r}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className={s.fieldset}>
        <legend>{ru.style.density}</legend>
        <div className={s.segmented}>
          {DENSITIES.map((d) => (
            <button
              key={d}
              type="button"
              className={t.density === d ? s.segOn : s.seg}
              aria-pressed={t.density === d}
              data-testid={`style-density-${d}`}
              onClick={() => set({ density: d })}
            >
              {ru.style.densityLabel[d]}
            </button>
          ))}
        </div>
      </fieldset>

      <label className={s.field}>
        {ru.style.logo}
        <input
          type="file"
          accept="image/png,image/webp"
          data-testid="style-logo"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            const path = await saver.uploadLogo(f);
            if (path) onChange({ ...theme, logoFile: path });
          }}
        />
        <span className={s.small}>{ru.style.logoHint}</span>
      </label>

      <fieldset className={s.fieldset}>
        <legend>{ru.style.mode}</legend>
        <div className={s.segmented}>
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={t.mode === m ? s.segOn : s.seg}
              aria-pressed={t.mode === m}
              data-testid={`style-mode-${m}`}
              onClick={() => set({ mode: m })}
            >
              {ru.style.modeLabel[m]}
            </button>
          ))}
        </div>
      </fieldset>

      <p className={s.small}>{ru.style.hint}</p>
      <div data-testid="style-status" className={s.small} role="status">
        {statusText}
      </div>
      {saver.status === "error" && (
        <div role="alert" className={s.alertBox}>
          <span>{saver.error}</span>{" "}
          <Button size="sm" variant="secondary" onClick={() => void saver.retry()}>
            {ru.errors.retry}
          </Button>
        </div>
      )}
    </section>
  );
}
