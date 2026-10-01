// FileField (ui-kit.yaml#components.FileField, M2-14): upload into a file field via POST /api/files (runtime.yaml#files);
// shows the name and size, never a preview (files are served as attachments). Value = fileId.
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cx, useDataSource, useWzRoot } from "../data/context.js";
import { toWzError } from "../data/mutation.js";
import type { FileInfo, FileMimeType } from "../data/types.js";
import { ru } from "../i18n/ru.js";
import fieldStyles from "./Field.module.css";
import styles from "./FileField.module.css";
import { part, type RootAttrs } from "./root.js";
import type { FileFieldProps } from "./types.js";

export const FILE_MIMES: readonly FileMimeType[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const TYPE_LABEL: Record<FileMimeType, string> = {
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/webp": "WebP",
  "application/pdf": "PDF",
};

/** 1 536 → «1,5 КБ» (ru-RU, one decimal above 1 КБ). */
export function formatFileSize(bytes: number): string {
  const fmt = (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  if (bytes < 1024) return ru.file.bytes(fmt(bytes));
  if (bytes < 1024 * 1024) return ru.file.kb(fmt(bytes / 1024));
  return ru.file.mb(fmt(bytes / (1024 * 1024)));
}

export function FileField(props: FileFieldProps): ReactNode {
  return <FileFieldImpl {...props} root={useWzRoot("FileField", `wz-filefield-${props.name}`, props)} />;
}

export function FileFieldImpl(props: FileFieldProps & { root: RootAttrs }): ReactNode {
  const { root, name, label, value, onChange, required, error } = props;
  const files = useDataSource().useFiles();
  const accept = props.accept?.length ? props.accept : FILE_MIMES;
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const input = useRef<HTMLInputElement>(null);
  const reactId = useId();
  const id = `wz-file-${root["data-wz-id"] ?? reactId}-${name}`.replace(/[^A-Za-z0-9_:.-]/g, "_");
  const hintId = `${id}-hint`;
  const errId = `${id}-error`;
  const shown = problem ?? error;

  // An existing value (edit form): name and size from the server; the id alone when it cannot be read.
  useEffect(() => {
    if (!value) {
      setInfo(null);
      return;
    }
    if (info?.fileId === value) return;
    let live = true;
    files.info(value).then(
      (i) => live && setInfo(i),
      () => live && setInfo(null),
    );
    return () => {
      live = false;
    };
  }, [value, info?.fileId, files]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setProblem(undefined);
    if (file.size > MAX_FILE_BYTES) return setProblem(ru.file.tooLarge);
    // The browser's type is a hint only; the server decides by the file signature.
    if (file.type && !accept.includes(file.type as FileMimeType)) return setProblem(ru.file.unsupported);
    setBusy(true);
    try {
      const uploaded = await files.upload(file, {
        field: name,
        ...(props.entity ? { entity: props.entity } : {}),
      });
      setInfo(uploaded);
      onChange(uploaded.fileId);
    } catch (e) {
      const w = toWzError(e);
      setProblem(
        w.status === 415 || w.code === "UNSUPPORTED_MEDIA_TYPE"
          ? ru.file.unsupported
          : w.status === 413 || w.code === "PAYLOAD_TOO_LARGE"
            ? ru.file.tooLarge
            : w.message || ru.file.failed,
      );
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div {...root} className={cx(fieldStyles.field, props.className)} aria-busy={busy || undefined}>
      <label htmlFor={id} className={fieldStyles.label}>
        <span className={fieldStyles.labelRow}>
          <span className={fieldStyles.labelText}>{label}</span>
          {required && <span className={fieldStyles.required}>{ru.field.required}</span>}
        </span>
      </label>
      <div className={styles.row}>
        <input
          ref={input}
          id={id}
          name={name}
          type="file"
          className={styles.input}
          accept={accept.join(",")}
          disabled={props.disabled || busy}
          aria-invalid={shown ? true : undefined}
          required={required}
          aria-describedby={[hintId, shown ? errId : ""].filter(Boolean).join(" ")}
          data-testid={`wz-filefield-${name}-input`}
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        {value && !busy && (
          <span className={styles.file} data-testid={`wz-filefield-${name}-file`}>
            {/* Not a link: an upload is readable only once its record is saved (download — RecordCard «Скачать»). */}
            <span className={styles.name} data-testid={`wz-filefield-${name}-name`}>
              {info?.fileId === value ? info.name : ru.file.stored}
            </span>
            {info?.fileId === value && (
              <span className={styles.size} data-testid={`wz-filefield-${name}-size`}>
                {formatFileSize(info.size)}
              </span>
            )}
          </span>
        )}
        {busy && (
          <span className={styles.size} role="status">
            {ru.file.uploading}
          </span>
        )}
        {value && !busy && !props.disabled && (
          <button
            type="button"
            className={styles.remove}
            {...part(`wz-filefield-${name}-remove`)}
            onClick={() => {
              setProblem(undefined);
              setInfo(null);
              onChange(null);
            }}
          >
            {ru.file.remove}
          </button>
        )}
      </div>
      <span id={hintId} className={fieldStyles.hint}>
        {ru.file.hint(accept.map((m) => TYPE_LABEL[m]).join(", "))}
      </span>
      {shown && (
        <span
          id={errId}
          className={fieldStyles.error}
          data-testid={`wz-filefield-${name}-error`}
          role="alert"
        >
          {shown}
        </span>
      )}
    </div>
  );
}
