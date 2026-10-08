// Stage «Арт-директор» of the builder v3 (builder-v3.md#C2, #C6 «design»; D77 (6), (7)): three candidate directions
// are picked by code — pickArchetypes with the niche memory — and each gets its design system (designSystemV3, no
// model). When a model is available, one submit_art_direction call picks the direction among the three and interprets
// the brand colour and the voice of the texts; it never invents colours, fonts or archetypes (the palette is built by
// code from the brand colour). No model, a refusal or an error → the deterministic choice (the first candidate). The
// three candidates go to the «три направления» screen (V3-09).
import { DESIGN_VOICES } from "@wizard/appspec";
import type { LlmMessage, OrgPolicy, RouteContext } from "@wizard/llm";
import {
  type AccentUse,
  type ArchetypeId,
  archetype as archetypeById,
  archetypeFit,
  type DesignSystemV3,
  type DesignVoice,
  designLintErrors,
  designSystemV3,
  isArchetypeId,
  normalizeBrand,
  pickArchetypes,
} from "@wizard/ui-kit/v3/design";
import { z } from "zod";
import type { RunStepFn } from "../../core/events.js";
import { type CallStats, callTool, type RouteFn } from "../../core/loop.js";
import { defineTool, type ToolIssue } from "../../core/tool.js";
import { VOICE_LABELS } from "../v2/direction.js";

/** callType of the stage (builder-v3.md §3 C7; route — specs/agents/models.yaml#routes.art_direction). */
export const ART_DIRECTION_CALL_TYPE = "art_direction" as const;

/** How the brand colour is used (palette.accentUse of the design system). */
export const ACCENT_USES = ["signal", "fill", "band"] as const satisfies readonly AccentUse[];
const ACCENT_USE_LABELS: Readonly<Record<AccentUse, string>> = {
  signal: "сигнал: цвет только у главной кнопки и выделений, остальное держат шрифт и фото",
  fill: "заливка: цвет заливает крупные поверхности (кнопки, плашки, первый экран)",
  band: "полоса: одна осознанная цветная полоса на странице, остальное спокойно",
};

/** What the art director reads from the brief (C1: goals, audience, design) and the build. */
export interface ArtDirectorInput {
  niche: string;
  goals: readonly (string | { text: string })[];
  audience?: string;
  /** Seed of the build: the same seed gives the same candidates and tokens. */
  seed: string | number;
  /** Archetypes of the latest builds of this niche, most recent first (niche memory). */
  recent?: readonly string[];
  /** The client's brand colour #RRGGBB (logo, signboard); never changed. */
  brandColor?: string;
  /** A voice the brief asks for; the model may keep it or choose another. */
  voice?: DesignVoice;
  /** brief.design (C1): an archetype the owner chose; pinned — the model is not asked. */
  design?: { archetype?: string; pinned?: boolean };
}

export interface ArtDirectionCandidate {
  archetype: ArchetypeId;
  /** Russian name of the direction. */
  name: string;
  /** Fit to the niche and goals (pickArchetype). */
  fit: number;
  design: DesignSystemV3;
}

export interface ArtDirectionChoice {
  archetype: ArchetypeId;
  voice: DesignVoice;
  accentUse: AccentUse;
  /** Name of the style shown to the owner. */
  styleName: string;
  /** Why this direction, in Russian. */
  why: string;
  source: "model" | "fallback" | "pinned";
}

export interface ArtDirection {
  /** The chosen design system. */
  design: DesignSystemV3;
  /** Three different directions; the chosen one carries the final design. */
  candidates: ArtDirectionCandidate[];
  choice: ArtDirectionChoice;
  /** The model's answer was not used (no model, refusal, error). */
  fallback: boolean;
  /** Fitting archetypes skipped by the niche memory. */
  avoided: ArchetypeId[];
  stats: CallStats | null;
  /** Why the deterministic choice was taken (for the build log). */
  note?: string;
}

const design = (input: ArtDirectorInput, id: ArchetypeId, voice?: DesignVoice, accentUse?: AccentUse) => {
  const brandColor = normalizeBrand(input.brandColor);
  return designSystemV3({
    archetype: id,
    seed: input.seed,
    niche: input.niche,
    ...(brandColor ? { brandColor } : {}),
    ...(voice ? { voice } : {}),
    ...(accentUse ? { accentUse } : {}),
  });
};

/**
 * Three candidate directions by code: the owner's archetype first when the brief names one, then pickArchetypes
 * (seeded sampler with niche memory) without it.
 */
export function artDirectionCandidates(input: ArtDirectorInput): {
  candidates: ArtDirectionCandidate[];
  avoided: ArchetypeId[];
} {
  const ownerArchetype = archetypeById(input.design?.archetype);
  const pickInput = { niche: input.niche, goals: input.goals, seed: input.seed, recent: input.recent ?? [] };
  const first = ownerArchetype
    ? {
        id: ownerArchetype.id,
        fit: archetypeFit(ownerArchetype, input.niche, input.goals),
        avoided: [] as ArchetypeId[],
      }
    : undefined;
  const picks = first
    ? [first, ...pickArchetypes({ ...pickInput, exclude: [first.id] }, 2)]
    : pickArchetypes(pickInput, 3);
  const candidates = picks.map((p) => ({
    archetype: p.id,
    name: archetypeById(p.id)?.name ?? p.id,
    fit: p.fit,
    design: design(input, p.id, input.voice),
  }));
  return { candidates, avoided: [...new Set(picks.flatMap((p) => p.avoided))] };
}

const text = (min: number, max: number) => z.string().min(min).max(max);

/** submit_art_direction input: one of the candidates, a voice, the use of the brand colour, the style name and why. */
export function artDirectionSchema(ids: readonly ArchetypeId[]) {
  return z.strictObject({
    archetype: z.enum(ids as [ArchetypeId, ...ArchetypeId[]]),
    voice: z.enum(DESIGN_VOICES),
    accentUse: z.enum(ACCENT_USES),
    styleName: text(2, 40),
    why: text(10, 400),
  });
}
export type ArtDirectionAnswer = z.output<ReturnType<typeof artDirectionSchema>>;

const COLOUR_OR_CSS = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(|var\(--|\d+px\b|[{};]/i;

/** Semantic checks: no invented colours or CSS in the texts; a Russian style name. */
export function artDirectionIssues(v: ArtDirectionAnswer): ToolIssue[] {
  const issues: ToolIssue[] = [];
  for (const field of ["styleName", "why"] as const)
    if (COLOUR_OR_CSS.test(v[field]))
      issues.push({
        path: field,
        code: "NO_COLOURS",
        message:
          "Цвета и CSS не указывайте: палитру строит код от фирменного цвета. Опишите направление словами.",
      });
  if (!/[а-яё]/i.test(v.styleName))
    issues.push({
      path: "styleName",
      code: "RUSSIAN_NAME",
      message: "Название стиля — по-русски, 1–4 слова.",
    });
  return issues;
}

const ROLE =
  "Ты — арт-директор Born to Build: выбираешь направление оформления сайта клиента из трёх готовых направлений и объясняешь выбор простыми словами. Палитру, шрифты и сетку строит код; ты их не придумываешь.";

const RULES = [
  "archetype — одно из трёх направлений ниже: то, что точнее передаёт характер бизнеса и цели, а не самое очевидное для ниши.",
  "voice — тон текстов сайта под аудиторию и направление.",
  "accentUse — как использовать фирменный цвет: сигнал, заливка или одна полоса. Сам цвет не меняй и новых цветов не предлагай.",
  "styleName — короткое название стиля по-русски для владельца (1–4 слова), без слов «современный», «стильный», «уникальный».",
  "why — 1–2 предложения: почему это направление подходит бизнесу и его клиентам. Без цветовых кодов и CSS.",
  "Отвечай только вызовом submit_art_direction. Если инструмент вернул ошибки — исправь именно их и вызови снова.",
];

/** The prompt: the three candidates as data, voices and uses of the brand colour, the business and its colour. */
export function artDirectionMessages(
  input: ArtDirectorInput,
  candidates: readonly ArtDirectionCandidate[],
): LlmMessage[] {
  const lines = candidates.map((c) => {
    const a = archetypeById(c.archetype);
    const d = c.design;
    return [
      `- ${c.archetype} — «${c.name}»: ${a?.why ?? ""}`,
      `  Шрифты: ${d.fonts.display.family} (заголовки) + ${d.fonts.text.family} (текст). Сетка: ${d.grid.layout}, ритм: ${d.grid.rhythm.density}. Движение: ${d.motion.profile}.`,
      `  Фото: ${d.imagery.style}. Избегает: ${a?.avoid ?? ""}.`,
    ].join("\n");
  });
  const brand = normalizeBrand(input.brandColor);
  const goals = input.goals.map((g) => (typeof g === "string" ? g : g.text));
  return [
    {
      role: "system",
      content: [
        ROLE,
        "## Направления-кандидаты",
        lines.join("\n"),
        "## Тон текстов (voice)",
        DESIGN_VOICES.map((v) => `- ${v} — ${VOICE_LABELS[v]}`).join("\n"),
        "## Фирменный цвет (accentUse)",
        ACCENT_USES.map((u) => `- ${u} — ${ACCENT_USE_LABELS[u]}`).join("\n"),
        "## Правила",
        RULES.map((r) => `- ${r}`).join("\n"),
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        `## Бизнес\nНиша: ${input.niche}\nЦели: ${goals.join("; ") || "не указаны"}${input.audience ? `\nАудитория: ${input.audience}` : ""}`,
        brand
          ? `## Фирменный цвет\n${brand} — цвет клиента. Его не меняй: реши только, как его использовать.`
          : "## Фирменный цвет\nНет: палитру возьмёт выбранное направление.",
        input.voice ? `## Тон из брифа\n${input.voice} — ${VOICE_LABELS[input.voice]}` : "",
        "## Задача\nВыбери одно направление из трёх и вызови submit_art_direction.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

function fallbackChoice(c: ArtDirectionCandidate, source: ArtDirectionChoice["source"]): ArtDirectionChoice {
  const a = archetypeById(c.archetype);
  return {
    archetype: c.archetype,
    voice: c.design.voice,
    accentUse: c.design.palette.accentUse,
    styleName: c.name,
    why: a?.why ?? c.name,
    source,
  };
}

/**
 * Runs the stage. `route` absent — no model: the deterministic choice. A pinned archetype of the owner is taken as is.
 * Otherwise one submit_art_direction call with ≤ 2 repairs; a refusal or an error (not an abort) → the first candidate.
 */
export async function runArtDirector(o: {
  input: ArtDirectorInput;
  route?: RouteFn;
  runStep?: RunStepFn;
  signal?: AbortSignal;
  orgPolicy?: OrgPolicy | null;
  ctx?: RouteContext;
}): Promise<ArtDirection> {
  const { candidates, avoided } = artDirectionCandidates(o.input);
  const first = candidates[0] as ArtDirectionCandidate;
  const done = (
    choice: ArtDirectionChoice,
    ds: DesignSystemV3,
    stats: CallStats | null,
    note?: string,
  ): ArtDirection => ({
    design: ds,
    candidates: candidates.map((c) => (c.archetype === choice.archetype ? { ...c, design: ds } : c)),
    choice,
    fallback: choice.source === "fallback",
    avoided,
    stats,
    ...(note ? { note } : {}),
  });
  if (o.input.design?.pinned && isArchetypeId(o.input.design.archetype))
    return done(fallbackChoice(first, "pinned"), first.design, null);
  if (!o.route) return done(fallbackChoice(first, "fallback"), first.design, null, "модель не подключена");

  const tool = defineTool({
    name: "submit_art_direction",
    description:
      "Art direction: one of the candidate archetypes, voice, use of the brand colour, style name, reason.",
    input: artDirectionSchema(candidates.map((c) => c.archetype)),
    check: artDirectionIssues,
  });
  let result: Awaited<ReturnType<typeof callTool<typeof tool.input>>>;
  try {
    result = await callTool({
      route: o.route,
      callType: ART_DIRECTION_CALL_TYPE,
      orgPolicy: o.orgPolicy ?? null,
      ctx: o.ctx ?? { orgId: "host" },
      ...(o.runStep ? { runStep: o.runStep } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      stepName: "art_direction",
      messages: artDirectionMessages(o.input, candidates),
      tool,
    });
  } catch (e) {
    if (o.signal?.aborted) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    return done(fallbackChoice(first, "fallback"), first.design, null, `ошибка модели: ${msg}`);
  }
  if (!result.ok)
    return done(
      fallbackChoice(first, "fallback"),
      first.design,
      result.stats,
      "ответ модели не прошёл проверку",
    );
  const v = result.value;
  const ds = design(o.input, v.archetype, v.voice, v.accentUse);
  // Tokens are code and pass designLint by construction; a failure here means a bug — keep the candidate's system.
  if (designLintErrors(ds).length)
    return done(
      fallbackChoice(first, "fallback"),
      first.design,
      result.stats,
      "токены направления не прошли проверку",
    );
  return done({ ...v, source: "model" }, ds, result.stats);
}
