// Stage «Дизайн» of the builder v2 (builder.yaml#v2.stages.design, callType build_design): the design agent (B2-37).
// One submit_design call returns a direction as data — mood, rhythm, voice of the texts, a catalog theme and font
// pair, the accent, the photo style for the stock search (B2-38) and, where the theme's choice does not fit, the
// ready layout and band of a landing section. The rest comes from the theme (direction.ts). The client's brand colour
// (design.direction.notes «фирменный…») and the owner's own choices (design.pinned, section.pinned) never change.
// The checks (direction.ts) run in the tool: themeLint without errors, ready variants only, contrast. Output that does
// not pass after the repairs → the fallback direction: themeForNiche and the theme's layouts (not a failure).
import { DESIGN_VOICES, SECTION_CATALOG, type SystemPlan, THEME_FONTS, THEME_PRESETS } from "@wizard/appspec";
import type { LlmMessage } from "@wizard/llm";
import type { ModuleRegistry } from "@wizard/modules";
import { THEME_PRESET_LIST } from "@wizard/ui-kit/themes";
import { z } from "zod";
import type { RunStepFn } from "../../core/events.js";
import { type CallStats, callTool, type RouteFn } from "../../core/loop.js";
import { defineTool, type ToolIssue } from "../../core/tool.js";
import { planErrors, planIssues } from "../../planner/planner.js";
import {
  brandAccent,
  designLintIssues,
  fallbackDesign,
  keeps,
  polishDirection,
  themeLayouts,
  VOICE_LABELS,
} from "./direction.js";

export { brandAccent };

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
      voice: z.enum(DESIGN_VOICES),
      notes: text(1, 400).optional(),
    }),
    theme: z.enum(themes),
    accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    fontPair: z.strictObject({ heading: z.enum(fonts), body: z.enum(fonts) }),
    photoStyle: text(3, 160),
    /** Landing sections (by index) whose layout or band differs from the theme's choice; ready variants only. */
    sections: z
      .array(
        z.strictObject({
          index: z.number().int().min(0).max(19),
          variant: z.string().min(1).max(40).optional(),
          band: z.enum(["base", "alt"]).optional(),
        }),
      )
      .max(20)
      .optional(),
  });
}
export type DesignInput = z.output<ReturnType<typeof designInputSchema>>;

/**
 * The plan with the submitted direction: the theme's layouts for the sections the answer does not name, the answer's
 * layouts and bands, the brand colour and the owner's choices kept; then the deterministic polish (direction.ts).
 */
export function mergeDesign(plan: SystemPlan, input: DesignInput, registry: ModuleRegistry): SystemPlan {
  const { sections: picks, ...design } = input;
  const theme = keeps(plan, "theme") ? plan.design.theme : design.theme;
  const next: SystemPlan = {
    ...plan,
    design: {
      ...design,
      direction: {
        ...design.direction,
        ...(brandAccent(plan) ? { notes: plan.design.direction.notes } : {}),
      },
      theme,
      accent: keeps(plan, "accent") ? plan.design.accent : design.accent,
      fontPair: keeps(plan, "fontPair") ? plan.design.fontPair : design.fontPair,
      ...(plan.design.pinned ? { pinned: plan.design.pinned } : {}),
    },
  };
  if (plan.landing) {
    const specs = new Map((registry.sections ?? SECTION_CATALOG).map((s) => [s.type, s]));
    const sections = plan.landing.sections.map((s, i) => {
      const pick = picks?.find((p) => p.index === i);
      const spec = specs.get(s.type);
      const variant = s.pinned
        ? s.variant
        : (pick?.variant ?? (spec ? themeLayouts(theme, spec)[0] : undefined) ?? s.variant);
      const { band: _b, ...rest } = s;
      const band = pick?.band ?? s.band;
      return { ...rest, variant, ...(band ? { band } : {}) };
    });
    next.landing = { ...plan.landing, sections };
  }
  return polishDirection(next, registry);
}

export function designIssues(plan: SystemPlan, input: DesignInput, registry: ModuleRegistry): ToolIssue[] {
  const specs = new Map((registry.sections ?? SECTION_CATALOG).map((s) => [s.type, s]));
  const sections = plan.landing?.sections ?? [];
  const issues: ToolIssue[] = [];
  for (const [i, l] of (input.sections ?? []).entries()) {
    const s = sections[l.index];
    if (!s) {
      issues.push({
        path: `sections.${i}`,
        code: "UNKNOWN_SECTION",
        message: `Секции с номером ${l.index} в плане нет.`,
      });
      continue;
    }
    const ready = specs.get(s.type)?.ready ?? [];
    if (l.variant !== undefined && !ready.includes(l.variant))
      issues.push({
        path: `sections.${i}.variant`,
        code: "UNKNOWN_VARIANT",
        message: `У секции ${s.type} готовы раскладки: ${ready.join(", ")}.`,
      });
  }
  if (issues.length) return issues;
  const merged = mergeDesign(plan, input, registry);
  const lint = designLintIssues(plan, merged.design);
  if (lint.length) return lint;
  return planIssues(planErrors(merged, registry));
}

const ROLE =
  "Ты — дизайнер Born to Build: задаёшь направление оформления сайта и кабинетов по нише, целям и настроению бизнеса. Выбираешь только из готовых тем, шрифтов и раскладок. Код и CSS не пишешь.";

const RULES = [
  "theme — тема каталога под нишу и настроение; не бери самую очевидную тему, если другая точнее передаёт характер бизнеса.",
  "fontPair — пара из списка: heading с характером, body — спокойный шрифт для текста. Шрифты только для заголовков: Unbounded, Cormorant Garamond, Sofia Sans Extra Condensed, Alumni Sans, Wix Madefor Display.",
  "accent — #RRGGBB, насыщенный и достаточно тёмный: белая надпись на кнопке читается, кнопка не сливается с фоном. Без фиолетово-неоновых «ИИ-градиентов». Цвет, помеченный как фирменный или закреплённый владельцем, не меняй.",
  "direction.mood — 1–5 слов о настроении; rhythm: airy — много воздуха и редкие цветные полосы, balanced, dense — плотно; voice — тон текстов секций.",
  "photoStyle — каким должно быть фото для этого бизнеса (свет, место, люди, детали), без брендов и имён.",
  "sections — только секции, где раскладка или полоса (band: base — фон страницы, alt — цветная полоса) должна отличаться от выбора темы; остальные подберутся под тему. Раскладки — только из готовых. Закреплённые владельцем секции не трогай.",
  "Отвечай только вызовом submit_design. Если инструмент вернул ошибки — исправь именно их и вызови снова.",
];

export function designMessages(plan: SystemPlan, registry: ModuleRegistry): LlmMessage[] {
  const themes = registry.themes ?? THEME_PRESETS;
  const fonts = registry.fonts ?? THEME_FONTS;
  const specs = new Map((registry.sections ?? SECTION_CATALOG).map((s) => [s.type, s]));
  const pairs = new Map(THEME_PRESET_LIST.map((p) => [p.id, p.defaults]));
  const sections = (plan.landing?.sections ?? []).map((s, i) => {
    const spec = specs.get(s.type);
    if (s.pinned) return `[${i}] ${s.type}: ${s.variant} — закреплено владельцем`;
    return `[${i}] ${s.type}: готовы ${(spec?.ready ?? []).join(", ")}`;
  });
  const pinned = [
    keeps(plan, "theme") ? `тема ${plan.design.theme}` : "",
    keeps(plan, "accent") ? `цвет ${plan.design.accent}` : "",
    keeps(plan, "fontPair") ? `шрифты ${plan.design.fontPair.heading} + ${plan.design.fontPair.body}` : "",
  ].filter(Boolean);
  return [
    {
      role: "system",
      content: [
        ROLE,
        "## Темы (пара шрифтов темы: заголовки + текст)",
        themes
          .map((t) => {
            const p = pairs.get(t as never);
            const look = THEME_LOOKS[t] ? ` — ${THEME_LOOKS[t]}` : "";
            return `- ${t}${look}${p ? `; ${p.headingFont} + ${p.font}` : ""}`;
          })
          .join("\n"),
        "## Шрифты",
        fonts.join(", "),
        "## Тон текстов (voice)",
        DESIGN_VOICES.map((v) => `- ${v} — ${VOICE_LABELS[v]}`).join("\n"),
        "## Правила",
        RULES.map((r) => `- ${r}`).join("\n"),
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        `## Бизнес\nНиша: ${plan.niche}\nЦели: ${plan.goals.map((g) => g.statement).join("; ")}\nМодули: ${plan.modules.map((m) => m.id).join(", ")}`,
        `## Текущий дизайн\n${JSON.stringify(plan.design)}`,
        pinned.length ? `## Закреплено владельцем\n${pinned.join("; ")}` : "",
        sections.length ? `## Секции лендинга\n${sections.join("\n")}` : "## Секции лендинга\nнет",
        "## Задача\nЗадай направление оформления и вызови submit_design.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

export interface DesignStageResult {
  plan: SystemPlan;
  fallback: boolean;
  stats: CallStats;
}

/** Runs the stage: one submit_design call with ≤ 2 repairs; no valid answer → the fallback direction. */
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
      "Design direction: mood, rhythm, voice, catalog theme and fonts, accent, photo style, ready section layouts and bands.",
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
  if (!r.ok) return { plan: fallbackDesign(o.plan, o.registry), fallback: true, stats: r.stats };
  return { plan: mergeDesign(o.plan, r.value, o.registry), fallback: false, stats: r.stats };
}
