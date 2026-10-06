import { type FormEvent, type ReactNode, useId } from "react";
import { cx, type PBase, pRoot } from "../util.js";
import s from "./Composer.module.css";
import { Chip } from "./controls.js";

export interface ComposerSuggestion {
  id: string;
  label: string;
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
}

/** Floating input row of the canvas: selected block label, suggestions, breathing while the AI thinks. */
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
  className,
  testId,
}: ComposerProps): ReactNode {
  const id = useId();
  const text = value.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text && !disabled) onSubmit(text);
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
    </div>
  );
}
