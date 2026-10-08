import { type ChangeEvent, type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cx, type PBase, pRoot } from "../util.js";
import s from "./Composer.module.css";
import { Chip } from "./controls.js";

export interface ComposerSuggestion {
  id: string;
  label: string;
}

/** «Приложить ТЗ» (V3-04): the paperclip in the row; the file is checked here, then handed to `onFile`. */
export interface ComposerAttach {
  /**
   * Called with a file that passed the size and extension checks; while the promise is pending the row shows the
   * upload, a rejection shows its message (Russian text of an Error) under the row.
   */
  onFile(file: File): Promise<void> | void;
  /** Extensions offered in the file dialog (the server checks the signature anyway); default .docx .pdf .md .txt. */
  accept?: readonly string[];
  /** Largest file in bytes; default 10 МБ. */
  maxBytes?: number;
  /** Accessible name and tooltip of the paperclip; default «Приложить ТЗ». */
  label?: string;
}

/** Defaults of «Приложить ТЗ»: the formats of POST /systems/:id/brief/upload and its limit. */
export const COMPOSER_ATTACH_ACCEPT = [".docx", ".pdf", ".md", ".txt"] as const;
export const COMPOSER_ATTACH_MAX_BYTES = 10 * 1024 * 1024;

type AttachState =
  | { status: "idle" }
  | { status: "uploading"; name: string }
  | { status: "error"; message: string };

const listRu = (xs: readonly string[]) =>
  xs.length > 1 ? `${xs.slice(0, -1).join(", ")} и ${xs[xs.length - 1]}` : (xs[0] ?? "");
const sizeRu = (n: number) =>
  n >= 1024 * 1024
    ? `${Math.round((n / 1024 / 1024) * 10) / 10} МБ`
    : `${Math.max(1, Math.round(n / 1024))} КБ`;

/** The message of a failed upload: a Russian Error text as is, anything else — a general one. */
function uploadError(e: unknown): string {
  const m = e instanceof Error ? e.message.trim() : typeof e === "string" ? e.trim() : "";
  return /[а-яё]/i.test(m) ? m : "Не удалось загрузить ТЗ — попробуйте ещё раз";
}

export interface ComposerProps extends PBase {
  value: string;
  onChange(value: string): void;
  /** Called with the trimmed text; empty text never submits. */
  onSubmit(text: string): void;
  placeholder?: string;
  /** Accessible name of the field (visually hidden). */
  label?: string;
  /** idle; thinking — the row «breathes»; building — amber glow. */
  state?: "idle" | "thinking" | "building";
  /** start — the large first-screen row. */
  size?: "regular" | "start";
  /** Selected canvas block («ткни и скажи»): its label in the row; clicking it clears the selection. */
  target?: { label: string; onClear(): void } | null;
  /** Quick suggestions above the row («Другой вид», «Убрать»). */
  suggestions?: readonly ComposerSuggestion[];
  onSuggestion?(id: string): void;
  disabled?: boolean;
  /** «Приложить ТЗ»: the paperclip, file checks, upload state and errors in Russian; absent — no paperclip. */
  attach?: ComposerAttach | null;
}

/**
 * Floating input row of the canvas: selected block label, suggestions, breathing while the AI thinks; with `attach` —
 * the paperclip «Приложить ТЗ» (docx, pdf, md, txt up to 10 МБ).
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder = "Расскажите о своём деле",
  label = "Сообщение",
  state = "idle",
  size = "regular",
  target = null,
  suggestions = [],
  onSuggestion,
  disabled = false,
  attach = null,
  className,
  testId,
}: ComposerProps): ReactNode {
  const id = useId();
  const text = value.trim();
  const fileRef = useRef<HTMLInputElement>(null);
  const [att, setAtt] = useState<AttachState>({ status: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const uploading = att.status === "uploading";
  const accept = attach?.accept ?? COMPOSER_ATTACH_ACCEPT;
  const attachLabel = attach?.label ?? "Приложить ТЗ";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text && !disabled) {
      if (att.status === "error") setAtt({ status: "idle" });
      onSubmit(text);
    }
  };
  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    // Reset, so that choosing the same file again fires change.
    input.value = "";
    if (!file || !attach || uploading) return;
    const max = attach.maxBytes ?? COMPOSER_ATTACH_MAX_BYTES;
    const ext = /\.[^.\\/]+$/.exec(file.name)?.[0]?.toLowerCase() ?? "";
    if (!accept.some((a) => a.toLowerCase() === ext))
      return setAtt({ status: "error", message: `Подходят файлы ${listRu(accept)}` });
    if (file.size > max)
      return setAtt({
        status: "error",
        message: `Файл больше ${sizeRu(max)} — сократите ТЗ или пришлите его частями`,
      });
    if (file.size === 0) return setAtt({ status: "error", message: "Файл пустой — выберите другой" });
    setAtt({ status: "uploading", name: file.name });
    try {
      await attach.onFile(file);
      if (alive.current) setAtt({ status: "idle" });
    } catch (err) {
      if (alive.current) setAtt({ status: "error", message: uploadError(err) });
    }
  };
  return (
    <div
      {...pRoot("Composer", testId, "p-composer")}
      data-state={state}
      aria-busy={state !== "idle" || undefined}
      className={cx(
        s.composer,
        state === "thinking" && s.thinking,
        state === "building" && s.building,
        size === "start" && s.start,
        attach && s.withAttach,
        className,
      )}
    >
      {suggestions.length > 0 && (
        <div className={s.sugg} data-testid="p-composer-suggestions">
          {suggestions.map((x) => (
            <Chip key={x.id} testId={`p-composer-suggestion-${x.id}`} onClick={() => onSuggestion?.(x.id)}>
              {x.label}
            </Chip>
          ))}
        </div>
      )}
      <form className={s.row} onSubmit={submit} autoComplete="off" data-testid="p-composer-row">
        {target && (
          <button
            type="button"
            className={s.target}
            onClick={target.onClear}
            aria-label={`Снять выбор: ${target.label}`}
            data-testid="p-composer-target"
          >
            <span className={s.targetText}>{target.label}</span>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        )}
        {attach && (
          <>
            <button
              type="button"
              className={s.attach}
              onClick={() => fileRef.current?.click()}
              disabled={disabled || uploading}
              aria-label={attachLabel}
              title={attachLabel}
              aria-busy={uploading || undefined}
              data-state={att.status}
              data-testid="p-composer-attach"
            >
              {uploading ? (
                <span className={s.spinner} aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M15.5 6.5 8.4 13.6a2 2 0 0 0 2.8 2.8l7.4-7.4a4 4 0 0 0-5.7-5.7l-7.4 7.4a6 6 0 0 0 8.5 8.5l6.4-6.4" />
                </svg>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              hidden
              tabIndex={-1}
              accept={accept.join(",")}
              aria-label={attachLabel}
              onChange={pick}
              data-testid="p-composer-file"
            />
          </>
        )}
        <label className={s.srOnly} htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          className={s.input}
          type="text"
          value={value}
          placeholder={placeholder}
          enterKeyHint="send"
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          data-testid="p-composer-input"
        />
        <button
          className={s.send}
          type="submit"
          aria-label="Отправить"
          disabled={disabled || !text}
          data-testid="p-composer-send"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
        </button>
      </form>
      {attach && (
        <p className={s.note} role="status" data-testid="p-composer-attach-status">
          {uploading ? `Читаем ТЗ «${att.name}»…` : ""}
        </p>
      )}
      {attach && att.status === "error" && (
        <p className={cx(s.note, s.noteError)} role="alert" data-testid="p-composer-attach-error">
          {att.message}
        </p>
      )}
    </div>
  );
}
