// V4-16 photo of a slot: 12–20 photos for the place picked on the site — the owner's own first, then the library by
// the meaning of the slot (its texts and the brief) — a search in Russian, «Загрузить своё». A pick (or an upload)
// becomes the instant edit of the slot (V4-15, no model); the direction's grade covers it on the site.
import { ActionButton } from "@wizard/ui-kit/v2";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { asUploadable, createPhotosApi, type PhotoChoice, type PhotosApi } from "./api.js";
import s from "./PhotoPicker.module.css";
import { photosRu as T } from "./ru.js";

const MAX_BYTES = 15 * 1024 * 1024;
const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : T.network);

export interface PhotoPickerProps {
  systemId: string;
  /** The source ref of the photo slot (its meaning comes from the texts around it). */
  slotRef: string;
  /** Library id of the photo now in the slot (marked «Сейчас на сайте»). */
  currentId: string | null;
  disabled: boolean;
  /** Puts the photo into the slot (the panel saves the literal). */
  onPick(id: string): Promise<void>;
  api?: PhotosApi;
}

export function PhotoPicker(p: PhotoPickerProps): ReactNode {
  const [api] = useState(() => p.api ?? createPhotosApi());
  const [photos, setPhotos] = useState<PhotoChoice[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (words: string) => {
      setPhotos(null);
      setError(null);
      try {
        const r = await api.list(p.systemId, {
          ref: p.slotRef,
          ...(words.trim() ? { q: words.trim() } : {}),
        });
        setPhotos(r.photos);
      } catch (e) {
        setPhotos([]);
        setError(errText(e));
      }
    },
    [api, p.systemId, p.slotRef],
  );
  useEffect(() => {
    void load("");
  }, [load]);

  async function pick(id: string) {
    setBusy(id);
    setError(null);
    try {
      await p.onPick(id);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File) {
    if (file.size > MAX_BYTES) return setError(T.tooLarge);
    const blob = await asUploadable(file);
    if (!blob) return setError(T.heic);
    setBusy("upload");
    setError(null);
    try {
      const r = await api.upload(p.systemId, blob);
      setPhotos((cur) => [r.photo, ...(cur ?? []).filter((x) => x.id !== r.photo.id)]);
      await p.onPick(r.photo.id);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={s.root} data-testid="photo-picker">
      <search>
        <form
          className={s.search}
          onSubmit={(e) => {
            e.preventDefault();
            void load(q);
          }}
        >
          <label className={s.srOnly} htmlFor="photo-picker-q">
            {T.search}
          </label>
          <input
            id="photo-picker-q"
            className={s.input}
            type="search"
            value={q}
            maxLength={200}
            placeholder={T.searchPlaceholder}
            data-testid="photo-search"
            onChange={(e) => setQ(e.target.value)}
          />
          <ActionButton
            size="sm"
            testId="photo-search-go"
            disabled={photos === null}
            onClick={() => void load(q)}
          >
            {T.searchButton}
          </ActionButton>
        </form>
      </search>
      <div className={s.upload}>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif"
          className={s.srOnly}
          tabIndex={-1}
          aria-label={T.upload}
          data-testid="photo-upload-file"
          disabled={p.disabled || busy !== null}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void upload(f);
          }}
        />
        <ActionButton
          size="sm"
          variant="secondary"
          testId="photo-upload"
          busy={busy === "upload"}
          disabled={p.disabled || busy !== null}
          onClick={() => fileRef.current?.click()}
        >
          {busy === "upload" ? T.uploading : T.upload}
        </ActionButton>
        <span className={s.hint}>{T.uploadHint}</span>
      </div>
      {photos === null ? (
        <p className={s.hint} aria-busy="true">
          {T.loading}
        </p>
      ) : photos.length === 0 && !error ? (
        <p className={s.hint}>{T.none}</p>
      ) : (
        <ul className={s.grid} data-testid="photo-grid">
          {photos.map((x, i) => (
            <li key={x.id}>
              <button
                type="button"
                className={s.cell}
                aria-pressed={x.id === p.currentId}
                aria-label={x.source === "owner" ? T.own : T.alt(i + 1, x.author)}
                disabled={p.disabled || busy !== null}
                data-testid="photo-choice"
                data-source={x.source}
                data-id={x.id}
                onClick={() => void pick(x.id)}
              >
                <img src={x.thumb} alt="" loading="lazy" className={s.img} />
                {x.id === p.currentId && <span className={s.badge}>{T.current}</span>}
                {x.source === "owner" && x.id !== p.currentId && <span className={s.badge}>{T.own}</span>}
                {busy === x.id && <span className={s.spin} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className={s.error} role="alert" data-testid="photo-error">
          {error}
        </p>
      )}
    </div>
  );
}
