// Stage «Тексты» of the builder v2 (builder.yaml#v2.stages.texts, callType build_texts): the model rewrites the texts of
// the plan's landing sections so they read well for the clients of this business. Same content keys and list sizes,
// no new numbers (prices, years, percents — only those already in the section), the plan stays valid for the catalog.
// Output that does not pass after the repairs → the planner's texts stay (fallback, not a failure).
import { SECTION_CATALOG, type SystemPlan } from "@wizard/appspec";
import type { LlmMessage } from "@wizard/llm";
import type { ModuleRegistry } from "@wizard/modules";
import { z } from "zod";
import type { RunStepFn } from "../../core/events.js";
import { type CallStats, callTool, type RouteFn } from "../../core/loop.js";
import { defineTool, type ToolIssue } from "../../core/tool.js";
import { planErrors, planIssues } from "../../planner/planner.js";
import { textRulesSection } from "../../text-rules.js";

const contentValue = z.union([
  z.string().min(1).max(600),
  z.array(z.union([z.string().min(1).max(300), z.record(z.string(), z.string().max(600))])).max(12),
]);

/** submit_texts input: new content of the sections worth improving (by their index in plan.landing.sections). */
export const textsInputSchema = z.strictObject({
  sections: z
    .array(
      z.strictObject({ index: z.number().int().min(0).max(19), content: z.record(z.string(), contentValue) }),
    )
    .max(20),
});
export type TextsInput = z.output<typeof textsInputSchema>;

const ROLE =
  "Ты — редактор текстов Born to Build: переписываешь тексты секций лендинга из утверждённого плана системы, чтобы клиентам этого бизнеса было сразу понятно, что предлагают и что сделать. Код не пишешь.";

const RULES = [
  "Меняй только тексты. Ключи содержимого секции — те же, что в исходной; список — того же размера; у элементов-объектов — те же ключи.",
  "Не добавляй фактов: цены, адреса, сроки, цифры, отзывы, имена — только те, что уже есть в тексте этой секции. Тексты «Пример: …» оставляй примерами.",
  "Кнопки (cta, submit_label) — 1–4 слова, начинаются с глагола. Заголовок — до 60 знаков, подзаголовок — до 140.",
  "Присылай только секции, которые стоит улучшить; хорошие не присылай.",
  "Без персональных данных: имён, телефонов, почт и адресов людей.",
  "Отвечай только вызовом submit_texts. Если инструмент вернул ошибки — исправь именно их и вызови снова.",
];

const NUMBER_RE = /\d+(?:[.,]\d+)?/g;

function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).join(" ");
  if (v && typeof v === "object") return Object.values(v).map(textOf).join(" ");
  return "";
}

function sameShape(a: unknown, b: unknown): boolean {
  if (typeof a === "string") return typeof b === "string";
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameShape(x, b[i]));
  }
  if (a && typeof a === "object") {
    if (!b || typeof b !== "object" || Array.isArray(b)) return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
  }
  return false;
}

/** The plan with the submitted contents (sections not submitted stay as they were). */
export function mergeTexts(plan: SystemPlan, input: TextsInput): SystemPlan {
  if (!plan.landing) return plan;
  const sections = plan.landing.sections.map((s) => ({ ...s, content: { ...s.content } }));
  for (const item of input.sections) {
    const s = sections[item.index];
    if (s) s.content = item.content as typeof s.content;
  }
  return { ...plan, landing: { ...plan.landing, sections } };
}

/** Problems of submit_texts: unknown section, other keys or list sizes, invented numbers, an invalid plan. */
export function textsIssues(plan: SystemPlan, input: TextsInput, registry: ModuleRegistry): ToolIssue[] {
  const sections = plan.landing?.sections ?? [];
  const issues: ToolIssue[] = [];
  const seen = new Set<number>();
  for (const [i, item] of input.sections.entries()) {
    const path = `sections.${i}`;
    const s = sections[item.index];
    if (!s) {
      issues.push({ path, code: "UNKNOWN_SECTION", message: `Секции с номером ${item.index} в плане нет.` });
      continue;
    }
    if (seen.has(item.index))
      issues.push({ path, code: "DUPLICATE", message: `Секция ${item.index} прислана дважды.` });
    seen.add(item.index);
    const keys = Object.keys(s.content).sort();
    const got = Object.keys(item.content).sort();
    if (keys.join(",") !== got.join(",")) {
      issues.push({
        path: `${path}.content`,
        code: "KEYS_CHANGED",
        message: `У секции ${item.index} (${s.type}) должны остаться ключи: ${keys.join(", ")}.`,
      });
      continue;
    }
    for (const k of keys) {
      if (!sameShape(s.content[k], item.content[k]))
        issues.push({
          path: `${path}.content.${k}`,
          code: "SHAPE_CHANGED",
          message: `«${k}» секции ${item.index}: та же форма, что в исходной (строка или список того же размера).`,
        });
    }
    const known = new Set(textOf(s.content).match(NUMBER_RE) ?? []);
    const invented = [...new Set(textOf(item.content).match(NUMBER_RE) ?? [])].filter((n) => !known.has(n));
    if (invented.length)
      issues.push({
        path: `${path}.content`,
        code: "INVENTED_NUMBER",
        message: `В секции ${item.index} появились цифры, которых нет в исходном тексте: ${invented.join(", ")}. Не придумывай цифры.`,
      });
  }
  if (issues.length) return issues;
  return planIssues(planErrors(mergeTexts(plan, input), registry));
}

/** Prompt of the stage: static rules (cacheable prefix) + the plan's business and sections. */
export function textsMessages(plan: SystemPlan, registry: ModuleRegistry): LlmMessage[] {
  const specs = new Map((registry.sections ?? SECTION_CATALOG).map((s) => [s.type, s]));
  const lines = (plan.landing?.sections ?? []).map((s, i) => {
    const label = specs.get(s.type)?.label ?? s.type;
    return `[${i}] ${s.type} «${label}» (${s.variant}): ${JSON.stringify(s.content)}`;
  });
  return [
    {
      role: "system",
      content: [
        ROLE,
        "## Правила",
        RULES.map((r) => `- ${r}`).join("\n"),
        "## Тексты для людей",
        textRulesSection("system"),
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        `## Бизнес\nНиша: ${plan.niche}\nЦели: ${plan.goals.map((g) => g.statement).join("; ")}`,
        `## Секции лендинга\n${lines.join("\n")}`,
        "## Задача\nПерепиши тексты секций, которые стоит улучшить, и вызови submit_texts.",
      ].join("\n\n"),
    },
  ];
}

export interface TextsStageResult {
  plan: SystemPlan;
  /** Sections whose texts changed. */
  changed: number;
  /** The model's texts did not pass: the planner's texts stay. */
  fallback: boolean;
  stats: CallStats;
}

/** Runs the stage: one submit_texts call with ≤ 2 repairs (models.yaml#call_policy.structured_output). */
export async function runTextsStage(o: {
  route: RouteFn;
  runStep: RunStepFn;
  signal?: AbortSignal;
  plan: SystemPlan;
  registry: ModuleRegistry;
}): Promise<TextsStageResult> {
  const tool = defineTool({
    name: "submit_texts",
    description:
      "New texts of the landing sections worth improving: same keys and list sizes, no new numbers.",
    input: textsInputSchema,
    check: (v) => textsIssues(o.plan, v, o.registry),
  });
  const r = await callTool({
    route: o.route,
    callType: "build_texts",
    orgPolicy: null,
    ctx: { orgId: "host" },
    runStep: o.runStep,
    ...(o.signal ? { signal: o.signal } : {}),
    stepName: "texts",
    messages: textsMessages(o.plan, o.registry),
    tool,
  });
  if (!r.ok) return { plan: o.plan, changed: 0, fallback: true, stats: r.stats };
  const plan = mergeTexts(o.plan, r.value);
  const before = o.plan.landing?.sections ?? [];
  const changed = (plan.landing?.sections ?? []).filter(
    (s, i) => JSON.stringify(s.content) !== JSON.stringify(before[i]?.content),
  ).length;
  return { plan, changed, fallback: false, stats: r.stats };
}
