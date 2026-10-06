import { type ReactNode, useId } from "react";
import { cx, type PBase, pRoot } from "../util.js";
import { ActionButton, Chip } from "./controls.js";
import s from "./QuestionCard.module.css";

export interface QuestionOption {
  id: string;
  label: string;
  /** The option the planner recommends: marked «советуем». */
  recommended?: boolean;
}

export interface QuestionCardProps extends PBase {
  /** «Вопрос 2 из 5». */
  step?: string;
  question: string;
  hint?: string;
  options: readonly QuestionOption[];
  /** Ids of the chosen options. */
  selected: readonly string[];
  /** Several answers allowed (otherwise choosing one replaces the previous). */
  multiple?: boolean;
  onToggle(id: string): void;
  /** «Дальше»; without it the card has no footer button. */
  onSubmit?(): void;
  submitLabel?: string;
}

/** Question card of the floating chat: options as chips, the recommended one marked by a word, «Дальше». */
export function QuestionCard({
  step,
  question,
  hint,
  options,
  selected,
  multiple = false,
  onToggle,
  onSubmit,
  submitLabel = "Дальше",
  className,
  testId,
}: QuestionCardProps): ReactNode {
  const qid = useId();
  return (
    <section
      {...pRoot("QuestionCard", testId, "p-question")}
      aria-labelledby={qid}
      className={cx(s.card, className)}
    >
      {step && <p className={s.step}>{step}</p>}
      <h2 id={qid} className={s.question}>
        {question}
      </h2>
      {hint && <p className={s.hint}>{hint}</p>}
      <fieldset className={s.opts}>
        <legend className={s.legend}>{multiple ? "Можно выбрать несколько" : "Выберите один вариант"}</legend>
        {options.map((o) => (
          <Chip
            key={o.id}
            testId={`p-question-option-${o.id}`}
            pressed={selected.includes(o.id)}
            recommended={o.recommended === true}
            onClick={() => onToggle(o.id)}
          >
            {o.label}
          </Chip>
        ))}
      </fieldset>
      {onSubmit && (
        <div className={s.foot}>
          <ActionButton
            variant="primary"
            size="sm"
            testId="p-question-submit"
            disabled={selected.length === 0}
            onClick={onSubmit}
          >
            {submitLabel}
          </ActionButton>
        </div>
      )}
    </section>
  );
}
