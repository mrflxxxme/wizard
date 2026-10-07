// Stage «Дизайн» of the builder v2 (builder.yaml#v2.stages.design, callType build_design): direction, theme and fonts
// from the catalogs, the accent, the photo style and section layouts from the ready variants — by niche and goals.
// The full design agent (direction by niche, stock photos) is B2-37/B2-38; the plan format stays the same.
// The client's brand colour (design.direction.notes says «фирменный») is never changed. Output that does not pass
// after the repairs → the planner's design stays (fallback, not a failure).
import { SECTION_CATALOG, type SystemPlan, THEME_FONTS, THEME_PRESETS } from "@wizard/appspec";
import type { LlmMessage } from "@wizard/llm";
import type { ModuleRegistry } from "@wizard/modules";
import { z } from "zod";
import type { RunStepFn } from "../../core/events.js";
import { type CallStats, callTool, type RouteFn } from "../../core/loop.js";
import { defineTool, type ToolIssue } from "../../core/tool.js";
import { planErrors, planIssues } from "../../planner/planner.js";

/** Short looks of the theme presets (specs/ui/themes.yaml#presets, B2-36); a theme missing here is listed by id. */
const THEME_LOOKS: Readonly<Record<string, string>> = {
  strict: "строгая деловая: сдержанные цвета, чёткая сетка (юристы, финансы, B2B, недвижимость, логистика)",
  warm: "тёплая: кремовый фон, заголовки с засечками, большие скругления (салоны красоты, маникюр, цветы, гостевые дома)",
  bright:
    "яркая современная: насыщенный цвет, крупные широкие заголовки (спорт и танцы, детские студии, квесты)",
  calm: "спокойная минималистичная: много воздуха, приглушённые тона (психологи, йога, интерьеры, галереи)",
  boutique:
    "изысканная: высококонтрастная антиква, прямые углы, воздух (свадьбы, фотографы, ювелиры, стилисты)",
  bistro: "аппетитная: тёплая антиква, сочный цвет, мягкие карточки (кафе, рестораны, пекарни, кофейни)",
  workshop: "мастерская: узкие заголовки капсом, чёткие линии (барбершопы, ремонт, автосервис, стройка)",
  academy: "дружелюбная: гуманистичный шрифт, спокойный зелёный (репетиторы, языковые школы, курсы)",
  poster: "афиша: плакатные заголовки капсом, книжный текст (мероприятия, концерты, театры, музеи)",
  care: "заботливая: мягкий разборчивый шрифт, прохладные чистые тона (клиники, стоматология, ветклиники)",
};

const text = (min: number, max: number) => z.string().min(min).max(max);

/** submit_design input for a registry: catalog themes and fonts only. */
export function designInputSchema(registry: ModuleRegistry) {
  const themes = [...(registry.themes ?? THEME_PRESETS)] as [string, ...string[]];
  const fonts = [...(registry.fonts ?? THEME_FONTS)] as [string, ...string[]];
  return z.strictObject({
    direction: z.strictObject({
      mood: z.array(text(2, 30)).min(1).max(5),
      rhythm: z.enum(["airy", "balanced", "dense"]),
      notes: text(1, 400).optional(),
    }),
    theme: z.enum(themes),
    accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    fontPair: z.strictObject({ heading: z.enum(fonts), body: z.enum(fonts) }),
    photoStyle: text(3, 160),
    /** Layout variants of the landing sections (by index), ready variants only. */
    layouts: z
      .array(z.strictObject({ index: z.number().int().min(0).max(19), variant: z.string().min(1).max(40) }))
      .max(20)
      .optional(),
  });
}
export type DesignInput = z.output<ReturnType<typeof designInputSchema>>;

/** The client named the accent (brand colour): the design stage keeps it. */
export const brandAccent = (plan: SystemPlan): boolean => /фирменн/i.test(plan.design.direction.notes ?? "");

/** The plan with the submitted design and layouts. */
export function mergeDesign(plan: SystemPlan, input: DesignInput): SystemPlan {
  const { layouts, ...design } = input;
  const next: SystemPlan = {
    ...plan,
    design: {
      ...design,
      direction: {
        ...design.direction,
        ...(brandAccent(plan) ? { notes: plan.design.direction.notes } : {}),
      },
      accent: brandAccent(plan) ? plan.design.accent : design.accent,
    },
  };
  if (plan.landing && layouts?.length) {
    const sections = plan.landing.sections.map((s) => ({ ...s }));
    for (const l of layouts) {
      const s = sections[l.index];
      if (s) s.variant = l.variant;
    }
    next.landing = { ...plan.landing, sections };
  }
  return next;
}

export function designIssues(plan: SystemPlan, input: DesignInput, registry: ModuleRegistry): ToolIssue[] {
  const specs = new Map((registry.sections ?? SECTION_CATALOG).map((s) => [s.type, s]));
  const sections = plan.landing?.sections ?? [];
  const issues: ToolIssue[] = [];
  for (const [i, l] of (input.layouts ?? []).entries()) {
    const s = sections[l.index];
    if (!s) {
      issues.push({
        path: `layouts.${i}`,
        code: "UNKNOWN_SECTION",
        message: `Секции с номером ${l.index} в плане нет.`,
      });
      continue;
    }
    const ready = specs.get(s.type)?.ready ?? [];
    if (!ready.includes(l.variant))
      issues.push({
        path: `layouts.${i}.variant`,
        code: "UNKNOWN_VARIANT",
        message: `У секции ${s.type} готовы раскладки: ${ready.join(", ")}.`,
      });
  }
  if (issues.length) return issues;
  return planIssues(planErrors(mergeDesign(plan, input), registry));
}

const ROLE =
  "Ты — дизайнер Born to Build: подбираешь оформление системы по нише, целям и настроению бизнеса из готовых тем, шрифтов и раскладок. Код не пишешь.";

const RULES = [
  "theme — одна из тем каталога, подходящая нише; fontPair — шрифты только из списка; accent — цвет #RRGGBB, спокойный и читаемый на светлом и тёмном фоне.",
  "Если в текущем дизайне сказано, что цвет фирменный, — accent не меняй.",
  "direction.mood — 1–5 слов о настроении; rhythm: airy — много воздуха, balanced, dense — плотно.",
  "photoStyle — каким должно быть фото для этого бизнеса (свет, место, люди), без брендов и имён.",
  "layouts — только если другая готовая раскладка секции подойдёт лучше; только из перечисленных вариантов.",
  "Отвечай только вызовом submit_design. Если инструмент вернул ошибки — исправь именно их и вызови снова.",
];

export function designMessages(plan: SystemPlan, registry: ModuleRegistry): LlmMessage[] {
  const themes = registry.themes ?? THEME_PRESETS;
  const fonts = registry.fonts ?? THEME_FONTS;
  const specs = new Map((registry.sections ?? SECTION_CATALOG).map((s) => [s.type, s]));
  const sections = (plan.landing?.sections ?? []).map(
    (s, i) => `[${i}] ${s.type}: сейчас ${s.variant}; готовы ${(specs.get(s.type)?.ready ?? []).join(", ")}`,
  );
  return [
    {
      role: "system",
      content: [
        ROLE,
        "## Темы",
        themes.map((t) => `- ${t}${THEME_LOOKS[t] ? ` — ${THEME_LOOKS[t]}` : ""}`).join("\n"),
        "## Шрифты",
        fonts.join(", "),
        "## Правила",
        RULES.map((r) => `- ${r}`).join("\n"),
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        `## Бизнес\nНиша: ${plan.niche}\nЦели: ${plan.goals.map((g) => g.statement).join("; ")}\nМодули: ${plan.modules.map((m) => m.id).join(", ")}`,
        `## Текущий дизайн\n${JSON.stringify(plan.design)}`,
        sections.length ? `## Секции лендинга\n${sections.join("\n")}` : "## Секции лендинга\nнет",
        "## Задача\nПодбери оформление и вызови submit_design.",
      ].join("\n\n"),
    },
  ];
}

export interface DesignStageResult {
  plan: SystemPlan;
  fallback: boolean;
  stats: CallStats;
}

/** Runs the stage: one submit_design call with ≤ 2 repairs. */
export async function runDesignStage(o: {
  route: RouteFn;
  runStep: RunStepFn;
  signal?: AbortSignal;
  plan: SystemPlan;
  registry: ModuleRegistry;
}): Promise<DesignStageResult> {
  const tool = defineTool({
    name: "submit_design",
    description:
      "Design of the system: direction, catalog theme and fonts, accent, photo style, ready section layouts.",
    input: designInputSchema(o.registry),
    check: (v) => designIssues(o.plan, v, o.registry),
  });
  const r = await callTool({
    route: o.route,
    callType: "build_design",
    orgPolicy: null,
    ctx: { orgId: "host" },
    runStep: o.runStep,
    ...(o.signal ? { signal: o.signal } : {}),
    stepName: "design",
    messages: designMessages(o.plan, o.registry),
    tool,
  });
  if (!r.ok) return { plan: o.plan, fallback: true, stats: r.stats };
  return { plan: mergeDesign(o.plan, r.value), fallback: false, stats: r.stats };
}
