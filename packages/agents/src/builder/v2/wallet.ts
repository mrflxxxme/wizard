// Stage budgets of the builder v2 (builder.yaml#v2.budgets): before every model call the upper bound of its cost
// (budget.ts upperBoundCredits — the most expensive model of the route) must fit the stage budget and what is left of
// the build budget; the actual cost of each call is added to the stage. The run cap is still enforced by host.route.
import { type CallType, createRegistry, type Registry, type RouteInput } from "@wizard/llm";
import type { RouteFn } from "../../core/loop.js";
import { upperBoundCredits } from "../budget.js";
import type { V2Host, V2Stage } from "./types.js";

/** A call would not fit the stage budget (scope stage) or the build budget (scope total). */
export class StageBudgetError extends Error {
  constructor(
    readonly stage: V2Stage,
    readonly scope: "stage" | "total",
    readonly needRub: number,
    readonly leftRub: number,
  ) {
    super(`stage budget: ${stage} ${scope} need ${needRub} left ${leftRub}`);
    this.name = "StageBudgetError";
  }
}

const rub = (milli: number, rubPerCredit: number) => Math.round((milli / 1000) * rubPerCredit * 100) / 100;

/** Spend of one stage in this run. */
export class StageWallet {
  spentMilli = 0;
  calls = 0;
  constructor(
    readonly stage: V2Stage,
    /** ₽ the stage may spend. */
    readonly budgetRub: number,
    /** ₽ left of the build budget before this stage. */
    readonly totalLeftRub: number,
    readonly rubPerCredit: number,
  ) {}

  get spentRub(): number {
    return rub(this.spentMilli, this.rubPerCredit);
  }

  /** RouteFn over host.route that checks the budgets before each call and counts its credits. */
  route(host: V2Host, registry: Registry = createRegistry()): RouteFn {
    return async (input: RouteInput) => {
      const { ctx: _ctx, orgPolicy: _policy, signal: _signal, ...rest } = input;
      const ub = upperBoundCredits(input.callType as CallType, input.messages, input.tools ?? [], registry);
      const ubRub = ub * this.rubPerCredit;
      const stageLeft = this.budgetRub - this.spentRub;
      if (ubRub > stageLeft) throw new StageBudgetError(this.stage, "stage", round(ubRub), round(stageLeft));
      const totalLeft = this.totalLeftRub - this.spentRub;
      if (ubRub > totalLeft) throw new StageBudgetError(this.stage, "total", round(ubRub), round(totalLeft));
      this.calls += 1;
      const out = await host.route({ ...rest, step: `${this.stage}:${this.calls}`, upperBoundCredits: ub });
      this.spentMilli += out.creditsMilli;
      return out;
    };
  }
}

const round = (x: number) => Math.round(x * 100) / 100;

/** ₽ of credits (milli). */
export const milliToRub = rub;
