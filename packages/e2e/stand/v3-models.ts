// Models of the v3 stand (stand/v3.ts, D78): recorded answers, no network and no money. The grill interview answers
// from the dental dialog of V3-03 (packages/agents/test/interview-v3/helpers.ts DENTAL_SCRIPT without its search turn —
// the stand has no web tools), one scripted answer per call and per system, then a wish after the build edits the
// brief and finishes again; the reviewer of the techreview (V3-15) finds nothing. Every other call (the texts of the
// three directions, the art director) fails, and those steps take their deterministic fallbacks from the brief.
// The page writer is the V3-12 composer on the real pattern library without a model: the skeleton, and a scenario
// step that keeps it (as v3-goals.browser.test.ts, 0 ₽).
import { createPageComposer, type PageComposer } from "@wizard/agents/builder";
import {
  createRegistry,
  type RouteInput,
  type RouteOutput,
  type Router,
  type RouterOptions,
} from "@wizard/llm";
import {
  DENTAL_SCRIPT,
  finish,
  type ScriptedAnswer,
  update,
} from "../../agents/test/interview-v3/helpers.js";

/** The wish of the owner after the build, as the spec types it in the chat. */
export const V3_WISH = "Добавьте, что к нам приходят и родители с детьми";
/** The audience of the brief after the wish (the model's edit). */
export const V3_WISH_AUDIENCE = "Пациенты клиники в Казани и родители с детьми";

/** Interview answers in order: the dental dialog, then every later call (a wish) edits the audience and finishes. */
const INTERVIEW: readonly ScriptedAnswer[] = [
  ...(DENTAL_SCRIPT.slice(1) as ScriptedAnswer[]),
  [update({ audience: V3_WISH_AUDIENCE }), finish],
];

/** Calls of interview_v3 seen per system (each system of the specs walks its own dialog). */
const turns = new Map<string, number>();

function answer(input: RouteInput): ScriptedAnswer {
  if (input.callType === "interview_v3") {
    const key = input.ctx.systemId ?? input.ctx.orgId;
    const n = turns.get(key) ?? 0;
    turns.set(key, n + 1);
    return INTERVIEW[Math.min(n, INTERVIEW.length - 1)] as ScriptedAnswer;
  }
  if (input.callType === "techreview") return [{ name: "submit_techreview", args: { findings: [] } }];
  return new Error(`нет записанного ответа для ${input.callType}`);
}

/** The platform router of the v3 stand (interview, directions, build): scripted answers by call type. */
export function v3Router(opts: RouterOptions): Router {
  const registry = opts.registry ?? createRegistry();
  return {
    mode: "fixture",
    registry,
    async route(input: RouteInput): Promise<RouteOutput> {
      const a = answer(input);
      if (a instanceof Error) throw a;
      return {
        tier: "T1",
        model: "fixture",
        result: Array.isArray(a)
          ? {
              toolCalls: a.map((c, i) => ({
                id: `call_${input.callType}_${i + 1}`,
                name: c.name,
                args: c.args as Record<string, unknown>,
              })),
              finishReason: "tool-calls",
            }
          : { toolCalls: [], text: a, finishReason: "stop" },
        usage: { inputTokens: 2000, cachedTokens: 0, outputTokens: 300 },
        creditsCharged: 0.05,
        creditsMilli: 50,
        routeReason: "default_T1",
        scrubbed: true,
        ruFallback: false,
      };
    },
  };
}

/** The V3-12 composer without a model: the skeleton on library patterns; a scenario step keeps it. */
export function v3Composer(): PageComposer {
  const real = createPageComposer();
  return {
    skeleton: (ctx) => real.skeleton(ctx),
    scenario: async () => ({ files: new Map(), pages: [], notes: [], spentRub: 0 }),
  };
}
