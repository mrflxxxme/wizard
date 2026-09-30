// S2 question card: one pendingQuestion at a time; answers are sent in one POST answers (platform-screens.yaml S2 rules).
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useId, useState } from "react";
import type { Answer, Question } from "../../api/types.js";
import { Pill } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import s from "./Workspace.module.css";

const CUSTOM = "__custom";

type Choice = { optionId: string; text: string; touched: boolean };

function recommendedOf(q: Question): string {
  return (q.options.find((o) => o.recommended) ?? q.options[0])?.id ?? "";
}

function toAnswer(q: Question, c: Choice): Answer | null {
  if (c.optionId === CUSTOM) {
    const text = c.text.trim();
    return text ? { questionId: q.id, text } : null;
  }
  return { questionId: q.id, optionId: c.optionId };
}

export function QuestionCard({
  questions,
  onSubmit,
}: {
  questions: Question[];
  onSubmit(body: { answers: Answer[]; restByRecommendation?: boolean }): Promise<void>;
}): ReactNode {
  const [k, setK] = useState(0);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState<"next" | "rest" | null>(null);
  const name = useId();
  const q = questions[k];
  if (!q) return null;
  const choice = choices[q.id] ?? { optionId: recommendedOf(q), text: "", touched: false };
  const set = (patch: Partial<Choice>) =>
    setChoices((c) => ({ ...c, [q.id]: { ...choice, ...patch, touched: true } }));
  const last = k === questions.length - 1;
  const answerOk = choice.optionId !== CUSTOM || choice.text.trim().length > 0;

  async function send(rest: boolean) {
    const answers: Answer[] = [];
    const upTo = rest ? k : questions.length - 1;
    for (let i = 0; i <= upTo; i++) {
      const qi = questions[i] as Question;
      const c = choices[qi.id] ?? { optionId: recommendedOf(qi), text: "", touched: false };
      // With «Остальное — по рекомендациям» the current question counts only if the user changed it.
      if (rest && i === k && !c.touched) continue;
      const a = toAnswer(qi, c);
      if (a) answers.push(a);
    }
    setBusy(rest ? "rest" : "next");
    try {
      await onSubmit(rest ? { answers, restByRecommendation: true } : { answers });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={s.questionCard} data-testid="question-card" aria-labelledby={`${name}-q`}>
      <div className={s.questionHead}>
        <span className={s.muted} data-testid="question-progress">
          {ru.questions.progress(k + 1, questions.length)}
        </span>
      </div>
      <h3 id={`${name}-q`} className={s.questionText}>
        {q.text}
      </h3>
      <p className={s.muted}>{q.whyItMatters}</p>
      <div role="radiogroup" aria-labelledby={`${name}-q`} className={s.options}>
        {q.options.map((o) => (
          <label key={o.id} className={s.option} data-testid={`question-option-${o.id}`}>
            <input
              type="radio"
              name={`${name}-${q.id}`}
              value={o.id}
              checked={choice.optionId === o.id}
              onChange={() => set({ optionId: o.id })}
            />
            <span className={s.optionBody}>
              <span className={s.optionLabel}>
                {o.label}{" "}
                {o.recommended && (
                  <Pill tone="accent" testId="question-recommended">
                    {ru.questions.recommended}
                  </Pill>
                )}
              </span>
              {o.description && <span className={s.muted}>{o.description}</span>}
            </span>
          </label>
        ))}
        {q.allowCustom !== false && (
          <label className={s.option} data-testid="question-custom">
            <input
              type="radio"
              name={`${name}-${q.id}`}
              value={CUSTOM}
              checked={choice.optionId === CUSTOM}
              onChange={() => set({ optionId: CUSTOM })}
            />
            <span className={s.optionBody}>
              <span className={s.optionLabel}>{ru.questions.custom}</span>
              {choice.optionId === CUSTOM && (
                <textarea
                  className={s.textarea}
                  data-testid="question-custom-text"
                  aria-label={ru.questions.custom}
                  maxLength={500}
                  rows={2}
                  placeholder={ru.questions.customPlaceholder}
                  value={choice.text}
                  onChange={(e) => set({ text: e.target.value })}
                />
              )}
            </span>
          </label>
        )}
      </div>
      <div className={s.row}>
        <Button
          variant="primary"
          data-testid="question-next"
          disabled={!answerOk || busy !== null}
          loading={busy === "next"}
          onClick={() => (last ? void send(false) : setK(k + 1))}
        >
          {last ? ru.questions.finish : ru.questions.next}
        </Button>
        <Button
          variant="ghost"
          data-testid="question-accept-rest"
          disabled={busy !== null}
          loading={busy === "rest"}
          onClick={() => void send(true)}
        >
          {ru.questions.acceptRest}
        </Button>
      </div>
    </section>
  );
}
