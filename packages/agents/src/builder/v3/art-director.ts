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

/** The prompt: taste rules, verbalized sampling, the catalogs (fonts, archetypes, enums) and the business. */
export function designDirectionsMessages(input: ArtDirectorInput): LlmMessage[] {
  const fonts = proposalFonts();
  const faceLine = (f: string) => {
    const e = fontEntry(f);
    return `${f} (${e?.category === "serif" ? "антиква" : "гротеск"})`;
  };
  const brand = normalizeBrand(input.brandColor);
  const goals = input.goals.map((g) => (typeof g === "string" ? g : g.text));
  return [
    {
      role: "system",
      content: [
        ROLE,
        "## Вкус",
        TASTE.map((r) => `- ${r}`).join("\n"),
        "## Как предлагать",
        SAMPLING.map((r) => `- ${r}`).join("\n"),
        "## Шрифты заголовков (fonts.display)",
        fonts.display.map(faceLine).join(", "),
        "## Шрифты текста (fonts.text)",
        fonts.text.map(faceLine).join(", "),
        "## Базовые архетипы (base)",
        ARCHETYPE_IDS.map((id) => {
          const a = archetypeById(id);
          return `- ${id} — «${a?.name ?? id}»: ${a?.why ?? ""}`;
        }).join("\n"),
        "## Тон текстов (voice)",
        DESIGN_VOICES.map((v) => `- ${v} — ${VOICE_LABELS[v]}`).join("\n"),
        `## Значения полей\ntype.scale: ${PROPOSAL_SCALES.join(", ")}; radius: ${PROPOSAL_RADII.join(", ")}; density: ${PROPOSAL_DENSITIES.join(", ")}; layout: ${PROPOSAL_LAYOUTS.join(", ")}; motion: ${PROPOSAL_MOTIONS.join(", ")}; imagery.treatment: ${PROPOSAL_TREATMENTS.join(", ")}.`,
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
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
        `## Задача\nПредложи ${ART_DIRECTION_K} направлений и вызови ${ART_DIRECTION_TOOL}.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
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
