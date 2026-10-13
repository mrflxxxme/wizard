// Stage «Арт-директор» of the builder v3/v4 (builder-v3.md#C2; D79, grill-9 §3 «Арт-директор на модели», V4-07): the model
// proposes the design system — palette, a font pair of the OFL catalog, scale, grid, rhythm, motion and imagery — as
// ART_DIRECTION_K directions with their probabilities (verbalized sampling); code checks each one (AA contrast,
// licences and Cyrillic of the fonts, banned defaults, the brand colour, designLint) and sends issues back for a fix,
// then keeps the three most different. The likeliest of them is the build's design. No model, a refusal or an error →
// three archetype candidates of code (pickArchetypes with the niche memory, designSystemV3) and the first of them.
import { DESIGN_VOICES } from "@wizard/appspec";
import type { LlmMessage, OrgPolicy, RouteContext } from "@wizard/llm";
import { fontEntry } from "@wizard/ui-kit/themes";
import {
  type AccentUse,
  ARCHETYPE_IDS,
  type ArchetypeId,
  archetype as archetypeById,
  archetypeFit,
  type DesignProposal,
  type DesignSystemV3,
  type DesignVoice,
  designFromProposal,
  designSystemV3,
  isArchetypeId,
  normalizeBrand,
  PROPOSAL_DENSITIES,
  PROPOSAL_LAYOUTS,
  PROPOSAL_MOTIONS,
  PROPOSAL_RADII,
  PROPOSAL_SCALES,
  PROPOSAL_TREATMENTS,
  pickArchetypes,
  pickDistinct,
  proposalFonts,
  proposalIssues,
} from "@wizard/ui-kit/v3/design";
import { z } from "zod";
import type { RunStepFn } from "../../core/events.js";
import { type CallStats, callTool, type RouteFn } from "../../core/loop.js";
import { defineTool, type ToolIssue } from "../../core/tool.js";
import { VOICE_LABELS } from "../v2/direction.js";
import {
  type DirectionFacts,
  type DirectionTexts,
  factsText,
  inventedFacts,
  TEXT_LIMITS,
} from "./directions/texts.js";

/** callType of the stage (builder-v3.md §3 C7; route — specs/agents/models.yaml#routes.art_direction). */
export const ART_DIRECTION_CALL_TYPE = "art_direction" as const;

/** How the brand colour is used (palette.accentUse of the design system). */
export const ACCENT_USES = ["signal", "fill", "band"] as const satisfies readonly AccentUse[];

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
  /** brief.design.references (V4-07): the owner's references and words — principles for the model, never copied. */
  references?: readonly string[];
  /** brief.design (C1): an archetype the owner chose; pinned — the model is not asked. */
  design?: { archetype?: string; pinned?: boolean };
}

export interface ArtDirectionCandidate {
  archetype: ArchetypeId;
  /** Russian name of the direction. */
  name: string;
  /** Fit to the niche and goals (pickArchetype); a model direction — its probability. */
  fit: number;
  design: DesignSystemV3;
  /** V4-07: the model's proposal the design was made from (absent for archetype candidates of code). */
  proposal?: DesignProposal;
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
  /** V4-07: the proposal of the chosen direction when the model designed it. */
  proposal?: DesignProposal;
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
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "цвет #RRGGBB");

/** Directions the model is asked for (verbalized sampling, V4-07); code keeps the ART_DIRECTIONS most different. */
export const ART_DIRECTION_K = 5;
export const ART_DIRECTIONS = 3;
export const ART_DIRECTION_TOOL = "submit_design_directions";

/** One proposed direction: the design system as the model sees it (fonts only from the catalog list). */
export function designProposalSchema() {
  const fonts = proposalFonts();
  return z.strictObject({
    name: text(2, 40),
    why: text(10, 240),
    probability: z.number().min(0).max(1),
    base: z.enum(ARCHETYPE_IDS),
    scheme: z.enum(["light", "dark"]),
    colors: z.strictObject({ bg: hex, ink: hex, accent: hex, accent2: hex.optional() }),
    fonts: z.strictObject({
      display: z.enum(fonts.display as [string, ...string[]]),
      text: z.enum(fonts.text as [string, ...string[]]),
      why: text(10, 200).optional(),
    }),
    type: z.strictObject({ scale: z.enum(PROPOSAL_SCALES), upper: z.boolean() }),
    radius: z.enum(PROPOSAL_RADII),
    density: z.enum(PROPOSAL_DENSITIES),
    layout: z.enum(PROPOSAL_LAYOUTS),
    motion: z.enum(PROPOSAL_MOTIONS),
    imagery: z.strictObject({ style: text(10, 200), treatment: z.enum(PROPOSAL_TREATMENTS) }),
    voice: z.enum(DESIGN_VOICES),
  });
}
export type DesignDirectionAnswer = z.output<ReturnType<typeof designProposalSchema>>;

/** submit_design_directions input: 3–6 directions with their probabilities. */
export function designDirectionsSchema() {
  return z.strictObject({ directions: z.array(designProposalSchema()).min(ART_DIRECTIONS).max(6) });
}
export type DesignDirectionsAnswer = z.output<ReturnType<typeof designDirectionsSchema>>;

const COLOUR_OR_CSS = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(|var\(--|\d+px\b|[{};]/i;

/** A model direction as the ui-kit proposal (voice stays with the direction). */
export const toProposal = (d: DesignDirectionAnswer): DesignProposal => {
  const { voice: _v, ...p } = d;
  return p as DesignProposal;
};

/**
 * Checks of the answer (code checks, the model chooses): each direction through proposalIssues — AA contrast, catalog
 * fonts, banned defaults, the brand colour, designLint; Russian names without colour codes. Issues go back only while
 * fewer than three valid directions on different base archetypes remain.
 */
export function designDirectionsIssues(v: DesignDirectionsAnswer, input: ArtDirectorInput): ToolIssue[] {
  const issues: ToolIssue[] = [];
  const brandColor = normalizeBrand(input.brandColor);
  const valid = new Set<string>();
  v.directions.forEach((d, i) => {
    const own: ToolIssue[] = proposalIssues(toProposal(d), {
      seed: input.seed,
      niche: input.niche,
      ...(brandColor ? { brandColor } : {}),
    }).map((x) => ({ path: `directions.${i}.${x.path}`, code: x.code, message: x.message }));
    for (const field of ["name", "why"] as const)
      if (COLOUR_OR_CSS.test(d[field]))
        own.push({
          path: `directions.${i}.${field}`,
          code: "NO_COLOURS",
          message: "В названии и объяснении — слова, без цветовых кодов и CSS.",
        });
    if (!/[а-яё]/i.test(d.name))
      own.push({
        path: `directions.${i}.name`,
        code: "RUSSIAN_NAME",
        message: "Название — по-русски, 1–4 слова.",
      });
    if (own.length) issues.push(...own);
    else valid.add(d.base);
  });
  // Three valid directions on different bases are enough: the rest is dropped by code, not sent back (each repair of
  // Kimi K3 costs a minute and rubles — live probe 13.10.2026).
  if (valid.size >= ART_DIRECTIONS) return [];
  issues.push({
    path: "directions",
    code: "TOO_FEW_DISTINCT",
    message: `Нужно хотя бы ${ART_DIRECTIONS} годных направления на разных базовых архетипах (base); сейчас ${valid.size}.`,
  });
  return issues;
}

const ROLE =
  "Ты — арт-директор Born to Build уровня сильной студии. Сначала дизайн-система, потом страницы: ты предлагаешь направления оформления сайта клиента — палитру, шрифтовую пару, шкалу, сетку, ритм, движение и фото. Код проверяет контраст, лицензии и токены и вернёт ошибки на исправление.";

const TASTE = [
  "Интересно, но никогда не уродливо: у каждого направления своя идея, которую видно с первого экрана, а не набор плиток.",
  "3–5 цветов: фон (bg), текст (ink), акцент (accent), по желанию второй акцент (accent2). Остальные оттенки код выведет сам.",
  "Контраст: текст на фоне не меньше 4,5:1, акцент на фоне не меньше 3:1 (WCAG AA).",
  "Не больше двух семейств шрифтов, только из списков ниже (лицензия OFL, есть кириллица).",
  "Без фиолетовых и индиго градиентов, без кремового фона «как у всех», без чисто чёрного фона, без декоративных пузырей и эмодзи вместо иконок.",
  "Не предлагай Inter, Manrope, Montserrat, Playfair — их нет в списках неспроста.",
  "Тёмная схема (scheme: dark) — только если её требует характер бизнеса, а не по привычке.",
];

const SAMPLING = [
  `Предложи ${ART_DIRECTION_K} направлений, заметно разных по характеру (шрифт, цвет, сетка, ритм, фото).`,
  "У каждого укажи probability — насколько такое направление типично для этой ниши (0…1, в сумме около 1).",
  "Минимум два направления — нетипичные (probability меньше 0,15), но уместные бизнесу: смелый ход, который владелец не ждал.",
  "base — ближайший архетип из списка: он задаёт только то, чего нет в направлении (колонки, рамки фото). У направлений — разные base.",
  "name — название по-русски для владельца (1–4 слова), без «современный», «стильный», «уникальный»; why — 1–2 предложения, почему это подходит бизнесу.",
  "fonts.why — обязательно, если берёшь Cormorant Garamond, Lora, IBM Plex Sans или Unbounded: почему именно он.",
  `Отвечай только вызовом ${ART_DIRECTION_TOOL}. Если инструмент вернул ошибки — исправь именно их и вызови снова со всеми направлениями.`,
];

/** Catalogs of the prompt: fonts, base archetypes, voices and the enum values (one-direction calls skip the fonts). */
function catalogBlocks(o: { fonts?: boolean; enums?: boolean } = {}): string[] {
  const fonts = proposalFonts();
  const faceLine = (f: string) => {
    const e = fontEntry(f);
    return `${f} (${e?.category === "serif" ? "антиква" : "гротеск"})`;
  };
  return [
    ...(o.fonts === false
      ? []
      : [
          "## Шрифты заголовков (fonts.display)",
          fonts.display.map(faceLine).join(", "),
          "## Шрифты текста (fonts.text)",
          fonts.text.map(faceLine).join(", "),
        ]),
    "## Базовые архетипы (base)",
    ARCHETYPE_IDS.map((id) => {
      const a = archetypeById(id);
      return `- ${id} — «${a?.name ?? id}»: ${a?.why ?? ""}`;
    }).join("\n"),
    "## Тон текстов (voice)",
    DESIGN_VOICES.map((v) => `- ${v} — ${VOICE_LABELS[v]}`).join("\n"),
    ...(o.enums === false
      ? []
      : [
          `## Значения полей\ntype.scale: ${PROPOSAL_SCALES.join(", ")}; radius: ${PROPOSAL_RADII.join(", ")}; density: ${PROPOSAL_DENSITIES.join(", ")}; layout: ${PROPOSAL_LAYOUTS.join(", ")}; motion: ${PROPOSAL_MOTIONS.join(", ")}; imagery.treatment: ${PROPOSAL_TREATMENTS.join(", ")}.`,
        ]),
  ];
}

/** The business of the prompt: niche, goals, audience, brand colour, voice, references and the niche's recent sites. */
function businessBlocks(input: ArtDirectorInput): string[] {
  const brand = normalizeBrand(input.brandColor);
  const goals = input.goals.map((g) => (typeof g === "string" ? g : g.text));
  return [
    `## Бизнес\nНиша: ${input.niche}\nЦели: ${goals.join("; ") || "не указаны"}${input.audience ? `\nАудитория: ${input.audience}` : ""}`,
    brand
      ? `## Фирменный цвет\n${brand} — цвет клиента: он остаётся акцентом (accent) или вторым акцентом (accent2) в каждом направлении, без изменений.`
      : "## Фирменный цвет\nНет: палитру предлагаешь ты.",
    input.voice ? `## Тон из брифа\n${input.voice} — ${VOICE_LABELS[input.voice]}` : "",
    input.references?.length
      ? `## Референсы владельца (принципы, не копировать)\n${input.references.map((r) => `- ${r}`).join("\n")}`
      : "",
    input.recent?.length
      ? `## Недавние сайты этой ниши\nУже были архетипы: ${input.recent.join(", ")}. Не повторяй их в типичном направлении.`
      : "",
  ].filter(Boolean);
}

/** The prompt: taste rules, verbalized sampling, the catalogs (fonts, archetypes, enums) and the business. */
export function designDirectionsMessages(input: ArtDirectorInput): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        ROLE,
        "## Вкус",
        TASTE.map((r) => `- ${r}`).join("\n"),
        "## Как предлагать",
        SAMPLING.map((r) => `- ${r}`).join("\n"),
        ...catalogBlocks(),
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        ...businessBlocks(input),
        `## Задача\nПредложи ${ART_DIRECTION_K} направлений и вызови ${ART_DIRECTION_TOOL}.`,
      ].join("\n\n"),
    },
  ];
}

/**
 * A stored proposal (brief.design.system, a directions proposal) checked before use: the schema of a direction without
 * the voice and proposalIssues; null when it is absent or does not pass any more.
 */
export function storedProposal(
  v: unknown,
  o: { seed: string | number; niche: string; brandColor?: string },
): DesignProposal | null {
  if (!v || typeof v !== "object") return null;
  const parsed = designProposalSchema().omit({ voice: true }).safeParse(v);
  if (!parsed.success) return null;
  const p = parsed.data as DesignProposal;
  return proposalIssues(p, o).length ? null : p;
}

/** A direction the model proposed and code accepted: its proposal, design system and voice. */
export interface ModelDirection {
  proposal: DesignProposal;
  design: DesignSystemV3;
  voice: DesignVoice;
  probability: number;
}

/** Accepted directions of an answer: valid ones only, the ART_DIRECTIONS most different on different bases. */
export function acceptedDirections(v: DesignDirectionsAnswer, input: ArtDirectorInput): ModelDirection[] {
  const brandColor = normalizeBrand(input.brandColor);
  const opts = { seed: input.seed, niche: input.niche, ...(brandColor ? { brandColor } : {}) };
  const valid: ModelDirection[] = [];
  for (const d of v.directions) {
    const proposal = toProposal(d);
    if (proposalIssues(proposal, opts).length) continue;
    valid.push({
      proposal,
      design: designFromProposal(proposal, { ...opts, voice: d.voice }),
      voice: d.voice,
      probability: d.probability,
    });
  }
  return pickDistinct(valid, ART_DIRECTIONS, (x) => x.proposal.base);
}

/** The submit_design_directions tool with its checks; `seen` gets every parsed answer (the last one survives repairs). */
export function designDirectionsTool(input: ArtDirectorInput, seen?: (v: DesignDirectionsAnswer) => void) {
  return defineTool({
    name: ART_DIRECTION_TOOL,
    description:
      "Design directions of the client's site: palette, a catalog font pair, scale, grid, rhythm, motion, imagery, probability.",
    input: designDirectionsSchema(),
    check: (v) => {
      seen?.(v);
      return designDirectionsIssues(v, input);
    },
  });
}

/**
 * One model call: ART_DIRECTION_K directions, checked by code (≤ 2 repairs with the issues). Directions that never
 * passed are dropped; fewer than three left — null (the caller falls back to the archetypes of code).
 */
export async function proposeDesignDirections(o: {
  input: ArtDirectorInput;
  route: RouteFn;
  runStep?: RunStepFn;
  signal?: AbortSignal;
  orgPolicy?: OrgPolicy | null;
  ctx?: RouteContext;
  stepName?: string;
  maxRepairs?: number;
}): Promise<{ directions: ModelDirection[] | null; stats: CallStats | null; note?: string }> {
  let last: DesignDirectionsAnswer | null = null;
  const tool = designDirectionsTool(o.input, (v) => {
    last = v;
  });
  try {
    const r = await callTool({
      route: o.route,
      callType: ART_DIRECTION_CALL_TYPE,
      orgPolicy: o.orgPolicy ?? null,
      ctx: o.ctx ?? { orgId: "host" },
      ...(o.runStep ? { runStep: o.runStep } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      stepName: o.stepName ?? "art_direction",
      messages: designDirectionsMessages(o.input),
      tool,
      ...(o.maxRepairs !== undefined ? { maxRepairs: o.maxRepairs } : {}),
    });
    const answer = r.ok ? r.value : last;
    const directions = answer ? acceptedDirections(answer, o.input) : [];
    if (directions.length < ART_DIRECTIONS)
      return { directions: null, stats: r.stats, note: "ответ модели не прошёл проверку" };
    return { directions, stats: r.stats };
  } catch (e) {
    if (o.signal?.aborted) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    return { directions: null, stats: null, note: `ошибка модели: ${msg}` };
  }
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

  const r = await proposeDesignDirections({
    input: o.input,
    route: o.route,
    ...(o.runStep ? { runStep: o.runStep } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.orgPolicy !== undefined ? { orgPolicy: o.orgPolicy } : {}),
    ...(o.ctx ? { ctx: o.ctx } : {}),
  });
  if (!r.directions)
    return done(
      fallbackChoice(first, "fallback"),
      first.design,
      r.stats,
      r.note ?? "ответ модели не прошёл проверку",
    );
  const picked = r.directions;
  const chosen = picked[0] as ModelDirection;
  return {
    design: chosen.design,
    candidates: picked.map((d) => ({
      archetype: d.proposal.base,
      name: d.proposal.name,
      fit: d.probability,
      design: d.design,
      proposal: d.proposal,
    })),
    choice: {
      archetype: chosen.proposal.base,
      voice: chosen.voice,
      accentUse: chosen.design.palette.accentUse,
      styleName: chosen.proposal.name,
      why: chosen.proposal.why,
      source: "model",
    },
    proposal: chosen.proposal,
    fallback: false,
    avoided,
    stats: r.stats,
  };
}

// ——— V4-17: the directions in parallel ———
// Kimi K3 answers a call in 60–90 s: one call for five whole directions and another for their texts leave the owner
// waiting minutes. Instead a short call names the ideas (verbalized sampling stays: probabilities, rare ones among
// them, different bases), then one call per idea designs its system and writes its first screen at the same time —
// each direction is shown as soon as its own call ends. Code checks each answer as before.

export const DIRECTION_IDEAS_TOOL = "submit_direction_ideas";
export const DESIGN_DIRECTION_TOOL = "submit_design_direction";

/** An idea of a direction: its name, why, base archetype, voice and how typical it is for the niche. */
export interface DirectionIdea {
  name: string;
  why: string;
  probability: number;
  base: ArchetypeId;
  voice: DesignVoice;
}

const ideaSchema = () =>
  z.strictObject({
    name: text(2, 40),
    why: text(10, 240),
    probability: z.number().min(0).max(1),
    base: z.enum(ARCHETYPE_IDS),
    voice: z.enum(DESIGN_VOICES),
  });

/** submit_direction_ideas input: 3–6 ideas with their probabilities. */
export function directionIdeasSchema() {
  return z.strictObject({ ideas: z.array(ideaSchema()).min(ART_DIRECTIONS).max(6) });
}
export type DirectionIdeasAnswer = z.output<ReturnType<typeof directionIdeasSchema>>;

function wordsIssues(d: { name: string; why: string }, path: string): ToolIssue[] {
  const issues: ToolIssue[] = [];
  for (const field of ["name", "why"] as const)
    if (COLOUR_OR_CSS.test(d[field]))
      issues.push({
        path: `${path}.${field}`,
        code: "NO_COLOURS",
        message: "В названии и объяснении — слова, без цветовых кодов и CSS.",
      });
  if (!/[а-яё]/i.test(d.name))
    issues.push({ path: `${path}.name`, code: "RUSSIAN_NAME", message: "Название — по-русски, 1–4 слова." });
  return issues;
}

/** Checks of the ideas: words without colours, at least three on different bases. */
export function directionIdeasIssues(v: DirectionIdeasAnswer): ToolIssue[] {
  const issues: ToolIssue[] = [];
  const bases = new Set<string>();
  v.ideas.forEach((d, i) => {
    const own = wordsIssues(d, `ideas.${i}`);
    if (own.length) issues.push(...own);
    else bases.add(d.base);
  });
  if (bases.size >= ART_DIRECTIONS) return [];
  issues.push({
    path: "ideas",
    code: "TOO_FEW_DISTINCT",
    message: `Нужно хотя бы ${ART_DIRECTIONS} годные идеи на разных базовых архетипах (base); сейчас ${bases.size}.`,
  });
  return issues;
}

/** Three ideas of an answer on different bases: the most typical one, then the rarest (the owner's surprise). */
export function pickIdeas(v: DirectionIdeasAnswer): DirectionIdea[] {
  const valid = v.ideas.filter((d) => wordsIssues(d, "").length === 0);
  const byProb = [...valid].sort((a, b) => b.probability - a.probability);
  const out: DirectionIdea[] = [];
  const take = (d: DirectionIdea | undefined) => {
    if (d && out.length < ART_DIRECTIONS && !out.some((x) => x.base === d.base)) out.push(d);
  };
  take(byProb[0]);
  for (const d of [...byProb].reverse()) take(d);
  return out;
}

const IDEAS = [
  `Предложи ${ART_DIRECTION_K} идей оформления, заметно разных по характеру. Только идею: название, почему подходит, базовый архетип и тон — палитру и шрифты подберут следующим шагом.`,
  "У каждой укажи probability — насколько такая идея типична для этой ниши (0…1, в сумме около 1).",
  "Минимум две идеи — нетипичные (probability меньше 0,15), но уместные бизнесу.",
  "base — ближайший архетип из списка; у идей — разные base.",
  "name — по-русски для владельца (1–4 слова), без «современный», «стильный», «уникальный»; why — 1–2 предложения, почему это подходит бизнесу.",
  `Отвечай только вызовом ${DIRECTION_IDEAS_TOOL}, коротко.`,
];

/** The short prompt of the ideas: taste, sampling, bases and voices (no font lists), the business. */
export function directionIdeasMessages(input: ArtDirectorInput): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        ROLE,
        "## Вкус",
        TASTE.map((r) => `- ${r}`).join("\n"),
        "## Как предлагать",
        IDEAS.map((r) => `- ${r}`).join("\n"),
        ...catalogBlocks({ fonts: false, enums: false }),
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        ...businessBlocks(input),
        `## Задача\nПредложи ${ART_DIRECTION_K} идей и вызови ${DIRECTION_IDEAS_TOOL}.`,
      ].join("\n\n"),
    },
  ];
}

const line = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(/^[^\n]*$/);

/** submit_design_direction input: one direction's system (as in submit_design_directions) and its first screen. */
export function designDirectionSchema() {
  return designProposalSchema().extend({
    texts: z.strictObject({
      title: line(8, TEXT_LIMITS.title),
      lead: line(20, TEXT_LIMITS.lead),
      action: line(2, TEXT_LIMITS.action),
    }),
  });
}
export type DesignDirectionOneAnswer = z.output<ReturnType<typeof designDirectionSchema>>;

/** Checks of one direction: its base kept, proposalIssues, words without colours, texts only from the brief's facts. */
export function designDirectionIssues(
  v: DesignDirectionOneAnswer,
  idea: DirectionIdea,
  input: ArtDirectorInput,
  facts: DirectionFacts,
): ToolIssue[] {
  const brandColor = normalizeBrand(input.brandColor);
  const { texts, ...d } = v;
  const issues: ToolIssue[] = proposalIssues(toProposal(d), {
    seed: input.seed,
    niche: input.niche,
    ...(brandColor ? { brandColor } : {}),
  }).map((x) => ({ path: x.path, code: x.code, message: x.message }));
  issues.push(...wordsIssues(d, ""));
  if (d.base !== idea.base)
    issues.push({ path: "base", code: "BASE_FIXED", message: `base этого направления — ${idea.base}.` });
  const source = factsText(facts);
  for (const field of ["title", "lead", "action"] as const)
    issues.push(...inventedFacts(texts[field], source, `texts.${field}`));
  if (texts.action.split(/\s+/).length > 4)
    issues.push({ path: "texts.action", code: "ACTION_LONG", message: "Кнопка — 1–3 слова." });
  return issues;
}

const ONE = [
  "Ниже — идея одного направления. Разверни её в дизайн-систему (палитра, шрифты, шкала, сетка, ритм, движение, фото) и напиши первый экран сайта этим тоном.",
  "name, why, base и voice — как в идее (можно уточнить слова name и why, base не менять); probability — как в идее.",
  "Направление должно заметно отличаться от остальных идей (они перечислены): другой шрифт, другой цвет, другой ритм.",
  "texts.title — до 90 знаков: что получает клиент, словами бизнеса. texts.lead — 1–2 предложения, 20–220 знаков. texts.action — 1–3 слова, действие по главной цели.",
  "В текстах только факты из брифа: без цифр, цен, сроков, адресов, наград, отзывов, гарантий и слов «лучший», «№ 1», «уникальный». Обращение на «вы», без восклицательных знаков.",
  "fonts.why — обязательно, если берёшь Cormorant Garamond, Lora, IBM Plex Sans или Unbounded: почему именно он.",
  `Отвечай только вызовом ${DESIGN_DIRECTION_TOOL}. Если инструмент вернул ошибки — исправь именно их и вызови снова.`,
];

/** The prompt of one direction: taste, the full catalogs, the business and its facts, the idea and the others. */
export function designDirectionMessages(
  input: ArtDirectorInput,
  idea: DirectionIdea,
  others: readonly DirectionIdea[],
  facts: DirectionFacts,
): LlmMessage[] {
  const facts_ = [
    `Название: ${facts.name || "не указано"}`,
    facts.scenarios.length
      ? `Что делают посетители:\n${facts.scenarios.map((x) => `- ${x}`).join("\n")}`
      : "",
    facts.outOfScope.length ? `Не входит (не обещать): ${facts.outOfScope.join("; ")}` : "",
  ].filter(Boolean);
  return [
    {
      role: "system",
      content: [
        ROLE,
        "## Вкус",
        TASTE.map((r) => `- ${r}`).join("\n"),
        "## Как развернуть идею",
        ONE.map((r) => `- ${r}`).join("\n"),
        ...catalogBlocks(),
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        ...businessBlocks(input),
        `## Факты для текстов\n${facts_.join("\n")}`,
        `## Идея\n«${idea.name}» — ${idea.why}\nbase: ${idea.base}; voice: ${idea.voice} — ${VOICE_LABELS[idea.voice]}; probability: ${idea.probability}`,
        others.length
          ? `## Другие направления (не повторяй)\n${others.map((o) => `- «${o.name}», base ${o.base}`).join("\n")}`
          : "",
        `## Задача\nРазверни идею и вызови ${DESIGN_DIRECTION_TOOL}.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

interface CallOpts {
  route: RouteFn;
  runStep?: RunStepFn;
  signal?: AbortSignal;
  orgPolicy?: OrgPolicy | null;
  ctx?: RouteContext;
  maxRepairs?: number;
}

/** The ideas call: three ideas on different bases, or null (a note says why) — the caller falls back to code. */
export async function proposeDirectionIdeas(
  o: CallOpts & { input: ArtDirectorInput },
): Promise<{ ideas: DirectionIdea[] | null; stats: CallStats | null; note?: string }> {
  let last: DirectionIdeasAnswer | null = null;
  const tool = defineTool({
    name: DIRECTION_IDEAS_TOOL,
    description:
      "Ideas of the design directions of the client's site: name, why, base archetype, voice, probability.",
    input: directionIdeasSchema(),
    check: (v) => {
      last = v;
      return directionIdeasIssues(v);
    },
  });
  try {
    const r = await callTool({
      route: o.route,
      callType: ART_DIRECTION_CALL_TYPE,
      orgPolicy: o.orgPolicy ?? null,
      ctx: o.ctx ?? { orgId: "host" },
      ...(o.runStep ? { runStep: o.runStep } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      stepName: "direction_ideas",
      messages: directionIdeasMessages(o.input),
      tool,
      ...(o.maxRepairs !== undefined ? { maxRepairs: o.maxRepairs } : {}),
    });
    const answer = r.ok ? r.value : last;
    const ideas = answer ? pickIdeas(answer) : [];
    if (ideas.length < ART_DIRECTIONS)
      return { ideas: null, stats: r.stats, note: "идеи модели не прошли проверку" };
    return { ideas, stats: r.stats };
  } catch (e) {
    if (o.signal?.aborted) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    return { ideas: null, stats: null, note: `ошибка модели: ${msg}` };
  }
}

/** One direction designed by the model with its first-screen texts (null — no valid answer; a note says why). */
export async function designOneDirection(
  o: CallOpts & {
    input: ArtDirectorInput;
    idea: DirectionIdea;
    others: readonly DirectionIdea[];
    facts: DirectionFacts;
  },
): Promise<{
  direction: ModelDirection | null;
  texts: DirectionTexts | null;
  stats: CallStats | null;
  note?: string;
}> {
  const tool = defineTool({
    name: DESIGN_DIRECTION_TOOL,
    description: "One design direction of the client's site and its first-screen texts.",
    input: designDirectionSchema(),
    check: (v) => designDirectionIssues(v, o.idea, o.input, o.facts),
  });
  try {
    const r = await callTool({
      route: o.route,
      callType: ART_DIRECTION_CALL_TYPE,
      orgPolicy: o.orgPolicy ?? null,
      ctx: o.ctx ?? { orgId: "host" },
      ...(o.runStep ? { runStep: o.runStep } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      stepName: "design_direction",
      messages: designDirectionMessages(o.input, o.idea, o.others, o.facts),
      tool,
      ...(o.maxRepairs !== undefined ? { maxRepairs: o.maxRepairs } : {}),
    });
    if (!r.ok)
      return { direction: null, texts: null, stats: r.stats, note: "ответ модели не прошёл проверку" };
    const { texts, ...d } = r.value;
    const brandColor = normalizeBrand(o.input.brandColor);
    const opts = { seed: o.input.seed, niche: o.input.niche, ...(brandColor ? { brandColor } : {}) };
    const proposal = toProposal(d);
    return {
      direction: {
        proposal,
        design: designFromProposal(proposal, { ...opts, voice: d.voice }),
        voice: d.voice,
        probability: d.probability,
      },
      texts: { title: texts.title, lead: texts.lead, action: texts.action },
      stats: r.stats,
    };
  } catch (e) {
    if (o.signal?.aborted) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    return { direction: null, texts: null, stats: null, note: `ошибка модели: ${msg}` };
  }
}
