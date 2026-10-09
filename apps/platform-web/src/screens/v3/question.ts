// A question of the v3 grill interview on the canvas (V3-03: agents/interview-v3.ts platformQuestion): its buttons
// come with the reserved option «Решите за меня» (id "delegate", delegate: true), the recommendation is explained and
// the step is counted without a total. The canvas shows «Решите за меня» and «Дальше решай сам» as the card's own
// buttons, not as answer chips; a v2 question (no reserved option, no recommendation) stays as it was.

/** Reserved option id of «Решите за меня» (@wizard/agents/interview-v3 DELEGATE_OPTION_ID). */
export const DELEGATE_OPTION_ID = "delegate";

interface Option {
  id: string;
  label: string;
  recommended: boolean;
  description?: string;
  delegate?: boolean;
}

export interface V3QuestionView {
  /** 1-based number of the question in the interview. */
  step: number;
  /** The answer buttons without «Решите за меня». */
  options: Option[];
  /** Why the recommended option fits («Почему советуем»). */
  why: string | null;
  /** «Решите за меня» is offered (the reserved option is there and the question allows it). */
  delegate: boolean;
}

/** The v3 view of a pending question; null for a v2 question. */
export function v3Question(q: unknown): V3QuestionView | null {
  if (!q || typeof q !== "object") return null;
  const o = q as {
    options?: unknown;
    recommendation?: unknown;
    max?: unknown;
    step?: unknown;
    allowDelegate?: unknown;
  };
  const options = (Array.isArray(o.options) ? o.options : []) as Option[];
  const reserved = options.some((x) => x?.delegate === true || x?.id === DELEGATE_OPTION_ID);
  const shaped = typeof o.recommendation === "string" && typeof o.max === "number";
  if (!reserved && !shaped) return null;
  return {
    step: typeof o.step === "number" && o.step > 0 ? o.step : 1,
    options: options.filter((x) => x?.delegate !== true && x?.id !== DELEGATE_OPTION_ID),
    why: typeof o.recommendation === "string" && o.recommendation.trim() ? o.recommendation.trim() : null,
    delegate: reserved && o.allowDelegate !== false,
  };
}
