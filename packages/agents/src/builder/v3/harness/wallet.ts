// Wallet of one step of the harness v3 (a stage or a scenario): before every model call the upper bound of its cost
// (budget.ts upperBoundCredits — the most expensive model of the route) must fit what is left of the step and of its
// pool (the cap of the build, or the target for «should» scenarios); the actual cost of each call is added to the step.
import { type CallType, createRegistry, type Registry, type RouteInput } from "@wizard/llm";
import type { RouteFn } from "../../../core/loop.js";
import { upperBoundCredits } from "../../budget.js";
import type { V3Host } from "./types.js";

/** A call would not fit the step (scope step) or the pool it draws from (scope pool). */
export class V3BudgetError extends Error {
  constructor(
    readonly step: string,
    readonly scope: "step" | "pool",
    readonly needRub: number,
    readonly leftRub: number,
  ) {
    super(`v3 budget: ${step} ${scope} need ${needRub} left ${leftRub}`);
    this.name = "V3BudgetError";
  }
}

const round = (x: number) => Math.round(x * 100) / 100;

/** ₽ of credits (milli). */
export const milliRub = (milli: number, rubPerCredit: number): number =>
  Math.round((milli / 1000) * rubPerCredit * 100) / 100;

/** Spend of one step in this run. */
export class V3Wallet {
  spentMilli = 0;
  calls = 0;
  constructor(
    /** Step name: the stage id or `scenario:<id>` (durable steps of host.route are `<step>:<n>`). */
    readonly step: string,
    /** ₽ the step may spend. */
    readonly budgetRub: number,
    /** ₽ left of the pool before this step. */
    readonly poolLeftRub: number,
    readonly rubPerCredit: number,
  ) {}

  get spentRub(): number {
    return milliRub(this.spentMilli, this.rubPerCredit);
  }

  /** ₽ the step may still spend (the composer's ctx.budgetRub). */
  get leftRub(): number {
    return Math.max(0, round(Math.min(this.budgetRub, this.poolLeftRub) - this.spentRub));
  }

  /** RouteFn over host.route that checks the budgets before each call and counts its credits. */
  route(host: Pick<V3Host, "route">, registry: Registry = createRegistry()): RouteFn {
    return async (input: RouteInput) => {
      const { ctx: _ctx, orgPolicy: _policy, signal: _signal, ...rest } = input;
      const ub = upperBoundCredits(input.callType as CallType, input.messages, input.tools ?? [], registry);
      const ubRub = ub * this.rubPerCredit;
      const stepLeft = this.budgetRub - this.spentRub;
      if (ubRub > stepLeft) throw new V3BudgetError(this.step, "step", round(ubRub), round(stepLeft));
      const poolLeft = this.poolLeftRub - this.spentRub;
      if (ubRub > poolLeft) throw new V3BudgetError(this.step, "pool", round(ubRub), round(poolLeft));
      this.calls += 1;
      const out = await host.route({ ...rest, step: `${this.step}:${this.calls}`, upperBoundCredits: ub });
      this.spentMilli += out.creditsMilli;
      return out;
    };
  }
}
