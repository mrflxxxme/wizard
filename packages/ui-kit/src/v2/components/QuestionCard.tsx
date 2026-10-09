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
  /** V3-03: why the recommended option fits, under the options («Почему советуем: …»). */
  recommendationWhy?: string;
  /** V3-03: «Решите за меня» — the agent takes the recommended answer and writes it down as an assumption. */
  onDelegate?(): void;
  /** V3-03: «Дальше решай сам» — the rest of the interview becomes assumptions of the brief. */
  onFinish?(): void;
  /** V3-03: the delegate and finish buttons wait (a turn is running). */
  assistDisabled?: boolean;
}

/**
 * Question card of the floating chat: options as chips, the recommended one marked by a word, «Дальше». V3-03: why the
 * recommendation, «Решите за меня» and «Дальше решай сам» — only when their props are given (v2 cards stay as they were).
 */
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
  recommendationWhy,
  onDelegate,
  onFinish,
  assistDisabled = false,
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
      {recommendationWhy && (
        <p className={s.why} data-testid="p-question-why">
          Почему советуем: {recommendationWhy}
        </p>
      )}
      {(onDelegate || onFinish) && (
        <div className={s.assist} data-testid="p-question-assist">
          {onDelegate && (
            <ActionButton
              variant="secondary"
              size="sm"
              testId="p-question-delegate"
              disabled={assistDisabled}
              onClick={onDelegate}
            >
              Решите за меня
            </ActionButton>
          )}
          {onFinish && (
            <ActionButton
              variant="ghost"
              size="sm"
              testId="p-question-finish"
              disabled={assistDisabled}
              onClick={onFinish}
            >
              Дальше решай сам
            </ActionButton>
          )}
        </div>
      )}
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
