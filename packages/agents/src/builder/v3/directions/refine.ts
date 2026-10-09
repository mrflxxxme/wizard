// «Что поменять?» (V3-09): the owner's words change the directions. The lexicon (lexicon.ts) understands the usual
// wishes by code; only a phrase it does not understand at all goes to the model (art_direction, submit_refinement) —
// within the step's 40 ₽ that the proposal already spent from. No model or no money — a polite Russian hint.
import { scrub } from "@wizard/pii";
import { z } from "zod";
import { callTool } from "../../../core/loop.js";
import { defineTool, type ToolIssue } from "../../../core/tool.js";
import { ART_DIRECTION_CALL_TYPE } from "../art-director.js";
import { type ParsedRefinement, parseRefinement, understood } from "./lexicon.js";
import {
  type DirectionsModel,
  type DirectionsProposal,
  directionDesign,
  retune,
  type StoredDirection,
} from "./propose.js";
import {
  type DirectionTuning,
  isEmptyTuning,
  normalizeTuning,
  type TUNING_AXES,
  tuningWords,
} from "./tuning.js";
import {
  DIRECTIONS_BUDGET_RUB,
  DIRECTIONS_CALL_DEADLINE_MS,
  deadlineSignal,
  RUB_PER_CREDIT,
  RubWallet,
} from "./wallet.js";

export interface RefineResult {
  /** tuned — new directions; pick — the owner chose one; unknown — nothing to change. */
  kind: "tuned" | "pick" | "unknown";
  proposal: DirectionsProposal;
  pick?: 1 | 2 | 3;
  /** Directions that changed (numbers). */
  changed: number[];
  /** Answer to the owner, Russian. */
  reply: string;
  source: "lexicon" | "model" | "none";
}

const ORDINAL_NAMES = ["", "первый", "второй", "третий"] as const;

export const REFINE_HINT =
  "Пока не понял, что поменять. Напишите, например: «теплее», «строже», «крупнее заголовок», «без фото» или «как второй, но строже».";

const step = z.number().int().min(-2).max(2);
export const refinementSchema = z.strictObject({
  understood: z.boolean(),
  /** 0 — all three directions. */
  target: z.number().int().min(0).max(3),
  /** 1–3 — the owner picks this direction; 0 — no pick. */
  pick: z.number().int().min(0).max(3),
  tuning: z.strictObject({
    warmth: step.optional(),
    contrast: step.optional(),
    saturation: step.optional(),
    density: step.optional(),
    scale: step.optional(),
    radius: step.optional(),
    motion: step.optional(),
    photos: z.boolean().optional(),
    scheme: z.enum(["light", "dark"]).optional(),
  }),
  reply: z.string().trim().min(2).max(240),
});
export type RefinementAnswer = z.output<typeof refinementSchema>;
export const REFINEMENT_TOOL = "submit_refinement";

export function refinementIssues(v: RefinementAnswer): ToolIssue[] {
  const issues: ToolIssue[] = [];
  if (!/[а-яё]/i.test(v.reply))
    issues.push({ path: "reply", code: "RUSSIAN", message: "Ответ владельцу — по-русски." });
  if (/#[0-9a-f]{3,8}\b|\b(?:rgba?|oklch|hsla?)\(|[{};]/i.test(v.reply))
    issues.push({
      path: "reply",
      code: "NO_CSS",
      message: "Без цветовых кодов и CSS: опишите изменение словами.",
    });
  if (!v.understood && (v.pick !== 0 || !isEmptyTuning(v.tuning)))
    issues.push({
      path: "understood",
      code: "CONTRADICTION",
      message: "understood=false — тогда tuning пустой и pick=0.",
    });
  return issues;
}

const AXES_HELP = [
  "warmth: + теплее (тёплые оттенки), − холоднее",
  "contrast: + строже и контрастнее, − мягче",
  "saturation: + ярче цвет, − спокойнее",
  "density: + больше воздуха, − плотнее",
  "scale: + крупнее заголовок первого экрана, − мельче",
  "radius: + круглее углы, − острее",
  "motion: + живее движение, − спокойнее (−2 — без анимации)",
  "photos: false — первый экран без фото, true — с фото",
  "scheme: dark — тёмный фон, light — светлый",
];

export function refinementMessages(p: DirectionsProposal, text: string) {
  return [
    {
      role: "system" as const,
      content: [
        "Ты — арт-директор Born to Build. Владелец смотрит три направления оформления первого экрана и пишет, что поменять. Переведи его слова в шаги параметров дизайн-системы — цвета и шрифты считает код, ты их не придумываешь.",
        "## Параметры (шаги от −2 до +2)",
        AXES_HELP.map((x) => `- ${x}`).join("\n"),
        "## Правила",
        [
          "- target — номер направления, о котором речь (1–3), 0 — все три.",
          "- pick — номер направления, если владелец его выбирает и ничего не меняет, иначе 0.",
          "- reply — 1 предложение владельцу по-русски: что изменится. Без цветовых кодов и CSS.",
          "- Если просьба не про оформление первого экрана или её не выразить параметрами — understood=false, пустой tuning, pick=0 и вежливо объясни в reply, что можно поменять.",
          `- Отвечай только вызовом ${REFINEMENT_TOOL}.`,
        ].join("\n"),
      ].join("\n\n"),
    },
    {
      role: "user" as const,
      content: [
        `## Направления\n${p.directions.map((d) => `${d.n}. «${d.name}»${d.tuning && !isEmptyTuning(d.tuning) ? ` (уже: ${tuningWords(d.tuning).join(", ")})` : ""}`).join("\n")}`,
        `## Слова владельца\n${scrub(text).text.slice(0, 500)}`,
      ].join("\n\n"),
    },
  ];
}

function apply(
  p: DirectionsProposal,
  delta: DirectionTuning,
  target: 1 | 2 | 3 | null,
): { proposal: DirectionsProposal; changed: number[]; skipped: Map<number, string[]> } {
  const skipped = new Map<number, string[]>();
  const changed: number[] = [];
  const directions = p.directions.map((d): StoredDirection => {
    if (target !== null && d.n !== target) return d;
    let next = retune(p, d, delta);
    const tuned = directionDesign(p, next);
    // A step the design cannot take (lint, limit) is not stored: the next «ещё крупнее» starts from what is shown.
    const mine = tuned.skipped.filter(
      (x) => (x.axis === "scheme" ? delta.scheme : delta[x.axis]) !== undefined,
    );
    if (mine.length) skipped.set(d.n, [...new Set(mine.map((x) => x.reasonRu))]);
    const revert = mine.filter((x) => x.axis !== "scheme");
    if (revert.length) {
      const tuning = { ...next.tuning };
      for (const x of revert) {
        const axis = x.axis as (typeof TUNING_AXES)[number];
        if (d.tuning[axis] === undefined) delete tuning[axis];
        else tuning[axis] = d.tuning[axis];
      }
      next = { ...next, tuning: normalizeTuning(tuning) };
    }
    if (JSON.stringify(next) !== JSON.stringify(d)) changed.push(d.n);
    return next;
  });
  return { proposal: { ...p, directions }, changed, skipped };
}

const WHO: Readonly<Record<string, string>> = {
  "1": "Первый вариант",
  "2": "Второй вариант",
  "3": "Третий вариант",
  "1,2": "Первый и второй варианты",
  "1,3": "Первый и третий варианты",
  "2,3": "Второй и третий варианты",
  "1,2,3": "Все три варианта",
};
const OF: readonly string[] = ["", "первого", "второго", "третьего"];

function tunedReply(
  delta: DirectionTuning,
  changed: number[],
  skipped: Map<number, string[]>,
  unknown: string[],
): string {
  const parts = [
    changed.length
      ? `${WHO[changed.join(",")]}: ${tuningWords(delta).join(", ")}.`
      : "Это изменение сейчас не сделать.",
  ];
  for (const [n, reasons] of skipped) parts.push(`У ${OF[n]} не получилось: ${reasons.join("; ")}.`);
  if (unknown.length) parts.push(`Не понял: «${unknown.slice(0, 3).join(" ")}» — это пока не меняю.`);
  return parts.join(" ");
}

/**
 * Applies the owner's words to a proposal. The lexicon first; a phrase it does not understand goes to the model when
 * there is a route and money left within the step's 40 ₽; otherwise the hint REFINE_HINT.
 */
export async function refineDirections(
  proposal: DirectionsProposal,
  text: string,
  model: DirectionsModel = {},
): Promise<RefineResult> {
  const parsed = parseRefinement(text);
  if (understood(parsed)) return fromParsed(proposal, parsed, "lexicon");
  model.signal?.throwIfAborted();
  const wallet = model.wallet ?? new RubWallet(DIRECTIONS_BUDGET_RUB, RUB_PER_CREDIT, proposal.costRub);
  const attempts = wallet.attempts();
  if (!model.route || attempts < 1)
    return { kind: "unknown", proposal, changed: [], reply: REFINE_HINT, source: "none" };
  const tool = defineTool({
    name: REFINEMENT_TOOL,
    description: "The owner's wish as steps of the design parameters, the direction it is about, or a pick.",
    input: refinementSchema,
    check: refinementIssues,
  });
  // The wallet starts from what the proposal already spent (a caller's wallet too): its total is the step's spend.
  const spent = (p: DirectionsProposal) => ({
    ...p,
    costRub: wallet.spentRub,
    calls: proposal.calls + wallet.calls,
  });
  try {
    const r = await callTool({
      route: wallet.route(model.route),
      callType: ART_DIRECTION_CALL_TYPE,
      orgPolicy: model.orgPolicy ?? null,
      ctx: model.ctx ?? { orgId: "host" },
      signal: deadlineSignal(model.signal, model.deadlineMs ?? DIRECTIONS_CALL_DEADLINE_MS),
      ...(model.runStep ? { runStep: model.runStep } : {}),
      stepName: "direction_refine",
      messages: refinementMessages(proposal, text),
      tool,
      maxRepairs: Math.min(1, attempts - 1),
    });
    if (!r.ok || !r.value.understood)
      return {
        kind: "unknown",
        proposal: spent(proposal),
        changed: [],
        reply: r.ok ? r.value.reply : REFINE_HINT,
        source: "model",
      };
    const v = r.value;
    const asParsed: ParsedRefinement = {
      tuning: normalizeTuning(v.tuning),
      matched: isEmptyTuning(v.tuning) ? [] : ["model"],
      target: v.target >= 1 && v.target <= 3 ? (v.target as 1 | 2 | 3) : null,
      pick: v.pick >= 1 && v.pick <= 3 && isEmptyTuning(v.tuning) ? (v.pick as 1 | 2 | 3) : null,
      unknown: [],
    };
    if (!understood(asParsed))
      return { kind: "unknown", proposal: spent(proposal), changed: [], reply: v.reply, source: "model" };
    const out = fromParsed(spent(proposal), asParsed, "model");
    return out.kind === "tuned" && out.changed.length ? { ...out, reply: v.reply } : out;
  } catch (e) {
    if (model.signal?.aborted) throw e;
    return { kind: "unknown", proposal: spent(proposal), changed: [], reply: REFINE_HINT, source: "model" };
  }
}

function fromParsed(
  p: DirectionsProposal,
  parsed: ParsedRefinement,
  source: RefineResult["source"],
): RefineResult {
  if (parsed.pick !== null) {
    const d = p.directions[parsed.pick - 1];
    return {
      kind: "pick",
      proposal: p,
      pick: parsed.pick,
      changed: [],
      reply: `Выбран ${ORDINAL_NAMES[parsed.pick]} вариант — «${d?.name ?? ""}».`,
      source,
    };
  }
  const r = apply(p, parsed.tuning, parsed.target);
  return {
    kind: "tuned",
    proposal: r.proposal,
    changed: r.changed,
    reply: tunedReply(parsed.tuning, r.changed, r.skipped, parsed.unknown),
    source,
  };
}
