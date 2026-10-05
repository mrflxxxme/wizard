// ImageField (ui-kit.yaml#components.ImageField, M2-47): upload into an image field via POST /api/files; the runtime
// checks the signature (JPEG, PNG, WebP), compresses and makes variants. Shows a preview: the local file right after
// upload (the stored picture is readable only once a record holds it), the stored variant in an edit form.
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cx, useDataSource, useWzRoot, type WzBase } from "../../data/context.js";
import { toWzError } from "../../data/mutation.js";
import { ru } from "../../i18n/ru.js";
import fieldStyles from "../Field.module.css";
import { part, type RootAttrs } from "../root.js";
import { ImageImpl } from "./Image.js";
import styles from "./ImageField.module.css";

export interface ImageFieldProps extends WzBase {
  name: string;
  label: string;
  /** fileId */
  value: string | null;
  onChange(fileId: string | null): void;
  required?: boolean;
  error?: string;
  /** Entity of the field for POST /api/files; default — the runtime finds it by the field name and role. */
  entity?: string;
  disabled?: boolean;
}

const IMAGE_ACCEPT = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;

export function ImageField(props: ImageFieldProps): ReactNode {
  return <ImageFieldImpl {...props} root={useWzRoot("ImageField", `wz-imagefield-${props.name}`, props)} />;
}

export function ImageFieldImpl(props: ImageFieldProps & { root: RootAttrs }): ReactNode {
  const { root, name, label, value, onChange, required, error } = props;
  const files = useDataSource().useFiles();
  const [local, setLocal] = useState<{ fileId: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const input = useRef<HTMLInputElement>(null);
  const reactId = useId();
  const id = `wz-img-${root["data-wz-id"] ?? reactId}-${name}`.replace(/[^A-Za-z0-9_:.-]/g, "_");
  const hintId = `${id}-hint`;
  const errId = `${id}-error`;
  const shown = problem ?? error;

  useEffect(
    () => () => {
      if (local && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(local.url);
    },
    [local],
  );

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setProblem(undefined);
    if (file.size > MAX_BYTES) return setProblem(ru.image.tooLarge);
    if (file.type && !IMAGE_ACCEPT.includes(file.type)) return setProblem(ru.image.unsupported);
    setBusy(true);
    try {
      const uploaded = await files.upload(file, {
        field: name,
        ...(props.entity ? { entity: props.entity } : {}),
      });
      const url = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "";
      setLocal(url ? { fileId: uploaded.fileId, url } : null);
      onChange(uploaded.fileId);
    } catch (e) {
      const w = toWzError(e);
      setProblem(
        w.status === 415 || w.code === "UNSUPPORTED_MEDIA_TYPE"
          ? ru.image.unsupported
          : w.status === 413 || w.code === "PAYLOAD_TOO_LARGE"
            ? w.message || ru.image.tooLarge
            : w.message || ru.image.failed,
      );
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const preview = value && local?.fileId === value ? { src: local.url } : value ? { fileId: value } : null;
  return (
    <div {...root} className={cx(fieldStyles.field, props.className)} aria-busy={busy || undefined}>
      <label htmlFor={id} className={fieldStyles.label}>
        <span className={fieldStyles.labelRow}>
          <span className={fieldStyles.labelText}>{label}</span>
          {required && <span className={fieldStyles.required}>{ru.field.required}</span>}
        </span>
      </label>
      {preview && (
        <div className={styles.preview}>
          <ImageImpl
            root={part(`wz-imagefield-${name}-preview`)}
            {...preview}
            alt={ru.image.preview(label)}
            ratio="4/3"
            priority
          />
        </div>
      )}
      <div className={styles.row}>
        <input
          ref={input}
          id={id}
          name={name}
          type="file"
          className={styles.input}
          accept={IMAGE_ACCEPT.join(",")}
          disabled={props.disabled || busy}
          aria-invalid={shown ? true : undefined}
          required={required}
          aria-describedby={[hintId, shown ? errId : ""].filter(Boolean).join(" ")}
          data-testid={`wz-imagefield-${name}-input`}
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        {busy && (
          <span className={fieldStyles.hint} role="status">
            {ru.image.uploading}
          </span>
        )}
        {value && !busy && !props.disabled && (
          <button
            type="button"
            className={styles.remove}
            {...part(`wz-imagefield-${name}-remove`)}
            onClick={() => {
              setProblem(undefined);
              setLocal(null);
              onChange(null);
            }}
          >
            {ru.image.remove}
          </button>
        )}
      </div>
      <span id={hintId} className={fieldStyles.hint}>
        {ru.image.hint}
      </span>
      {shown && (
        <span
          id={errId}
          className={fieldStyles.error}
          data-testid={`wz-imagefield-${name}-error`}
          role="alert"
        >
          {shown}
        </span>
      )}
    </div>
  );
}
