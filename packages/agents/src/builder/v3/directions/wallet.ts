// Money and time of the directions step (V3-09 acceptance: ≤ 40 ₽ and ≤ 2 min). Every model call goes through the
// wallet's route: its creditsCharged (all billable attempts, models.yaml#credits) × ₽ per credit is the spend. A call
// is made only when its worst case still fits: attempts × the ceiling of one attempt ≤ what is left.
import type { RouteFn } from "../../../core/loop.js";

/** Ceiling of the step: the three directions and the refinements of one proposal (V4-07: Kimi K3 designs them). */
export const DIRECTIONS_BUDGET_RUB = 70;
/** models.yaml#credits.rub_per_credit. */
export const RUB_PER_CREDIT = 5;
/**
 * Worst case of one art_direction attempt: 8 000 input + 6 000 output tokens (route max_tokens) on the dearest model
 * of the chain (kimi-k3: 348 / 1 739 ₽ per million) ≈ 13.2 ₽.
 */
export const ATTEMPT_CEILING_RUB = 14;
/** Deadline of one model call of the step; past it the texts come from the brief. */
export const DIRECTIONS_CALL_DEADLINE_MS = 75_000;
/**
 * Deadline of the design call (V4-07: the model writes five design systems); past it — the archetypes of code. The
 * route's own timeout: Kimi K3 thinks 60–130 s on it (stage probe 13.10.2026), a shorter cut leaves no answer at all.
 */
export const DESIGN_CALL_DEADLINE_MS = 240_000;
/** V4-17: deadline of the short ideas call; past it — the archetypes of code. */
export const IDEAS_CALL_DEADLINE_MS = 90_000;
/** V4-17: deadline of one direction's call (its system and texts); past it — that direction by its archetype. */
export const DIRECTION_CALL_DEADLINE_MS = 120_000;

export class RubWallet {
  #spent = 0;
  #calls = 0;
  constructor(
    readonly limitRub: number = DIRECTIONS_BUDGET_RUB,
    readonly rubPerCredit: number = RUB_PER_CREDIT,
    spentRub = 0,
  ) {
    this.#spent = spentRub;
  }

  /** ₽ spent so far (rounded to kopecks). */
  get spentRub(): number {
    return Math.round(this.#spent * 100) / 100;
  }
  get calls(): number {
    return this.#calls;
  }
  get leftRub(): number {
    return Math.max(0, this.limitRub - this.#spent);
  }

  /** How many model attempts still fit in the worst case (0 — no call). */
  attempts(): number {
    return Math.floor(this.leftRub / ATTEMPT_CEILING_RUB);
  }

  /** The route that counts each answer's credits. */
  route(inner: RouteFn): RouteFn {
    return async (input) => {
      const out = await inner(input);
      this.#calls += 1;
      this.#spent += out.creditsCharged * this.rubPerCredit;
      return out;
    };
  }
}

/** The caller's signal plus the step deadline; tells a deadline from the caller's abort. */
export function deadlineSignal(outer: AbortSignal | undefined, ms: number): AbortSignal {
  const own = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([outer, own]) : own;
}
