// «Три направления» (V3-09; D77 (7); docs/plans/2026-10-08-v3.md §2): after the brief, three first screens in three
// different archetypes with the client's texts. Code picks the archetypes (V3-07 candidates with the niche memory),
// their design systems (with the hints of the logo and references), the header and hero patterns (spread layouts);
// one model call writes the three sets of texts, with a deterministic fallback. The proposal is data: the platform
// stores it, builds the previews and turns the owner's choice into a new brief version.
import { BRIEF_LIMITS, type SystemBrief } from "@wizard/appspec";
import type { OrgPolicy, RouteContext } from "@wizard/llm";
import { scrub } from "@wizard/pii";
import { fontEntry } from "@wizard/ui-kit/themes";
import {
  ARCHETYPES,
  type ArchetypeId,
  archetype as archetypeById,
  type DesignSystemV3,
  type DesignVoice,
  goalTags,
  isArchetypeId,
  pickArchetype,
} from "@wizard/ui-kit/v3/design";
import { PATTERNS, type PatternMeta, selectPattern } from "@wizard/ui-kit/v3/patterns";
import type { RunStepFn } from "../../../core/events.js";
import { callTool, type RouteFn } from "../../../core/loop.js";
import { defineTool } from "../../../core/tool.js";
import { ART_DIRECTION_CALL_TYPE, artDirectionCandidates } from "../art-director.js";
import { referenceHints, WORDS_HEAD, wordsLine } from "./references.js";
import {
  briefFacts,
  DIRECTION_TEXTS_TOOL,
  type DirectionFacts,
  type DirectionTexts,
  directionTextsIssues,
  directionTextsMessages,
  directionTextsSchema,
  fallbackTexts,
} from "./texts.js";
import {
  type DirectionTuning,
  mergeTuning,
  normalizeTuning,
  TUNING_AXES,
  type TunedDesign,
  tuneDesign,
  tuningWords,
} from "./tuning.js";
import { DIRECTIONS_CALL_DEADLINE_MS, deadlineSignal, RubWallet } from "./wallet.js";

export const PROPOSAL_KIND = "wizard.design-directions" as const;
const BRIEF_REFERENCES = BRIEF_LIMITS.references;

/** One direction of a proposal (data; its design system is recomputed by code: directionDesign). */
export interface StoredDirection {
  n: 1 | 2 | 3;
  archetype: ArchetypeId;
  /** Russian name of the direction. */
  name: string;
  /** Why it exists (the archetype passport line). */
  why: string;
  voice: DesignVoice;
  tuning: DirectionTuning;
  texts: DirectionTexts;
  textsSource: "model" | "brief";
  header: string;
  hero: string;
}

export interface DirectionsProposal {
  kind: typeof PROPOSAL_KIND;
  version: 1;
  seed: string;
  niche: string;
  name: string;
  /** From the client's logo (brief.design.references). */
  brandColor?: string;
  /** brief.design.references the proposal was made with. */
  references: string[];
  nav: { label: string; href: string }[];
  directions: StoredDirection[];
  /** ₽ spent on models for this proposal and its refinements (route stats). */
  costRub: number;
  calls: number;
  /** Texts came from the brief (no model, refusal, error, deadline or budget). */
  fallback: boolean;
  notes: string[];
}

export interface DirectionsInput {
  brief: SystemBrief;
  /** The system (business) name shown in the header. */
  name: string;
  /** Niche text for the archetype sampler and the texts (system name and the first request), scrubbed. */
  niche: string;
  seed: string | number;
  /** Archetypes of the latest builds of the niche, most recent first. */
  recent?: readonly string[];
  /** Default: brief.design.references. */
  references?: readonly string[];
}

/** The model side of the step; without `route` everything is code. */
export interface DirectionsModel {
  route?: RouteFn;
  orgPolicy?: OrgPolicy | null;
  ctx?: RouteContext;
  signal?: AbortSignal;
  runStep?: RunStepFn;
  /** The step's money (default: a fresh 40 ₽ wallet). */
  wallet?: RubWallet;
  /** Deadline of one model call, ms (default DIRECTIONS_CALL_DEADLINE_MS). */
  deadlineMs?: number;
}

/** First screens that need facts the brief does not carry (an offer with a price, an event date) are not offered. */
const HERO_PHOTO = ["hero-split", "hero-full-bleed", "hero-editorial", "hero-collage", "hero-centered"];
const HERO_TEXT = ["hero-typographic", "hero-centered"];

const NAV: Readonly<Record<string, readonly string[]>> = {
  booking: ["Услуги", "О нас", "Контакты"],
  sales: ["Каталог", "О нас", "Контакты"],
  events: ["Программа", "О событии", "Контакты"],
  content: ["Материалы", "Об авторе", "Контакты"],
  operations: ["Возможности", "Контакты"],
  leads: ["Услуги", "О нас", "Контакты"],
};
const NAV_ORDER = ["booking", "sales", "events", "leads", "content", "operations"] as const;
const ANCHOR: Readonly<Record<string, string>> = {
  Услуги: "#services",
  Каталог: "#catalog",
  Программа: "#program",
  Материалы: "#articles",
  Возможности: "#features",
  "О нас": "#about",
  "О событии": "#about",
  "Об авторе": "#about",
  Контакты: "#contacts",
};

/** Header menu of the preview by the main goal (section names, not facts). */
export function previewNav(niche: string, goals: readonly string[]): { label: string; href: string }[] {
  const tags = goalTags(niche, goals);
  const tag = NAV_ORDER.find((t) => tags.includes(t)) ?? "leads";
  return (NAV[tag] ?? []).map((label) => ({ label, href: ANCHOR[label] ?? "#about" }));
}

const isSerifDisplay = (id: ArchetypeId) =>
  (archetypeById(id)?.fontPairs ?? []).every((p) => fontEntry(p.display)?.category === "serif");
const isSansDisplay = (id: ArchetypeId) =>
  (archetypeById(id)?.fontPairs ?? []).every((p) => fontEntry(p.display)?.category !== "serif");

/** The first-screen and header patterns of the three directions: different variants, layouts spread (C3). */
function patternsFor(
  archetypes: readonly ArchetypeId[],
  seed: string,
  tunings: readonly DirectionTuning[],
): { header: string; hero: string }[] {
  const usedHeaders: string[] = [];
  const usedHeroes: string[] = [];
  return archetypes.map((a, i) => {
    const header = pick(
      PATTERNS.filter((p) => p.sectionType === "header"),
      a,
      `${seed}|${i + 1}`,
      usedHeaders,
    );
    const hero = heroFor(a, `${seed}|${i + 1}`, tunings[i] ?? {}, usedHeroes);
    usedHeaders.push(header);
    usedHeroes.push(hero);
    return { header, hero };
  });
}

function pick(
  pool: readonly PatternMeta[],
  archetype: string,
  seed: string,
  used: readonly string[],
): string {
  const p = selectPattern(pool, { sectionType: pool[0]?.sectionType ?? "hero", archetype, seed, used });
  if (!p) throw new Error("no pattern");
  return p.id;
}

function heroFor(archetype: ArchetypeId, seed: string, t: DirectionTuning, used: readonly string[]): string {
  const ids =
    t.photos === false ? HERO_TEXT : t.photos === true ? HERO_PHOTO : [...HERO_PHOTO, "hero-typographic"];
  return pick(
    PATTERNS.filter((p) => ids.includes(p.id)),
    archetype,
    seed,
    used,
  );
}

/** The design system of a stored direction (archetype, seed, niche, brand colour and the owner's tuning). */
export function directionDesign(
  p: Pick<DirectionsProposal, "seed" | "niche" | "brandColor">,
  d: StoredDirection,
): TunedDesign {
  return tuneDesign(
    {
      archetype: d.archetype,
      seed: p.seed,
      niche: p.niche,
      ...(p.brandColor ? { brandColor: p.brandColor } : {}),
      voice: d.voice,
    },
    d.tuning,
  );
}

/** Design systems of the three directions. */
export const proposalDesigns = (p: DirectionsProposal): DesignSystemV3[] =>
  p.directions.map((d) => directionDesign(p, d).design);

/** Three archetypes: the art director's candidates, one swapped in when the references prefer another kind of headings. */
function archetypesFor(input: DirectionsInput, hints: ReturnType<typeof referenceHints>): ArchetypeId[] {
  const goals = input.brief.goals.map((g) => g.text);
  const { candidates } = artDirectionCandidates({
    niche: input.niche,
    goals,
    seed: input.seed,
    recent: input.recent ?? [],
    ...(hints.brandColor ? { brandColor: hints.brandColor } : {}),
    ...(input.brief.design.archetype ? { design: { archetype: input.brief.design.archetype } } : {}),
  });
  const ids = candidates.map((c) => c.archetype);
  const want =
    hints.type === "serif" || hints.type === "contrast"
      ? isSerifDisplay
      : hints.type === "sans"
        ? isSansDisplay
        : null;
  if (want && !ids.some(want)) {
    const others = ARCHETYPES.filter((a) => !want(a.id)).map((a) => a.id);
    try {
      const swap = pickArchetype({
        niche: input.niche,
        goals,
        seed: input.seed,
        recent: input.recent ?? [],
        exclude: [...ids.slice(0, 2), ...others],
      });
      ids[2] = swap.id;
    } catch {
      // No archetype of that kind is left: keep the candidates.
    }
  }
  return ids;
}

/**
 * The three directions of a brief: archetypes, tuning from the references, patterns and texts (one model call or
 * the brief). Same input and the same model answer → the same proposal.
 */
export async function proposeDirections(
  input: DirectionsInput,
  model: DirectionsModel = {},
): Promise<DirectionsProposal> {
  const seed = String(input.seed);
  const references = [...(input.references ?? input.brief.design.references)];
  const hints = referenceHints(references);
  const archetypes = archetypesFor(input, hints);
  const tuning = normalizeTuning(hints.tuning);
  const tunings = archetypes.map(() => tuning);
  const patterns = patternsFor(archetypes, seed, tunings);
  const facts = briefFacts(input.brief, input.name, input.niche);
  const voices = archetypes.map((id) => (archetypeById(id)?.voices[0] ?? "calm") as DesignVoice);
  const wallet = model.wallet ?? new RubWallet();
  const notes: string[] = [];
  const texts = await writeTexts(facts, archetypes, voices, model, wallet, notes);
  const directions: StoredDirection[] = archetypes.map((id, i) => {
    const a = archetypeById(id);
    return {
      n: (i + 1) as 1 | 2 | 3,
      archetype: id,
      name: a?.name ?? id,
      why: a?.why ?? "",
      voice: voices[i] as DesignVoice,
      tuning,
      texts: texts.sets[i] as DirectionTexts,
      textsSource: texts.source,
      header: (patterns[i] as { header: string }).header,
      hero: (patterns[i] as { hero: string }).hero,
    };
  });
  return {
    kind: PROPOSAL_KIND,
    version: 1,
    seed,
    niche: input.niche,
    name: facts.name,
    ...(hints.brandColor ? { brandColor: hints.brandColor } : {}),
    references,
    nav: previewNav(input.niche, facts.goals),
    directions,
    costRub: wallet.spentRub,
    calls: wallet.calls,
    fallback: texts.source === "brief",
    notes,
  };
}

async function writeTexts(
  facts: DirectionFacts,
  archetypes: readonly ArchetypeId[],
  voices: readonly DesignVoice[],
  model: DirectionsModel,
  wallet: RubWallet,
  notes: string[],
): Promise<{ sets: DirectionTexts[]; source: "model" | "brief" }> {
  const fallback = () => ({
    sets: archetypes.map((_, i) => fallbackTexts(facts, i)),
    source: "brief" as const,
  });
  if (!model.route) {
    notes.push("модель не подключена: тексты из брифа");
    return fallback();
  }
  model.signal?.throwIfAborted();
  const attempts = wallet.attempts();
  if (attempts < 1) {
    notes.push("бюджет шага исчерпан: тексты из брифа");
    return fallback();
  }
  const tool = defineTool({
    name: DIRECTION_TEXTS_TOOL,
    description:
      "First-screen texts of the three design directions: headline, subheadline and button label each.",
    input: directionTextsSchema(archetypes),
    check: (v) => directionTextsIssues(v, facts),
  });
  try {
    const r = await callTool({
      route: wallet.route(model.route),
      callType: ART_DIRECTION_CALL_TYPE,
      orgPolicy: model.orgPolicy ?? null,
      ctx: model.ctx ?? { orgId: "host" },
      signal: deadlineSignal(model.signal, model.deadlineMs ?? DIRECTIONS_CALL_DEADLINE_MS),
      ...(model.runStep ? { runStep: model.runStep } : {}),
      stepName: "direction_texts",
      messages: directionTextsMessages(
        facts,
        archetypes.map((archetype, i) => ({ archetype, voice: voices[i] as DesignVoice })),
      ),
      tool,
      maxRepairs: Math.min(2, attempts - 1),
    });
    if (!r.ok) {
      notes.push("ответ модели не прошёл проверку: тексты из брифа");
      return fallback();
    }
    const by = new Map(r.value.sets.map((s) => [s.direction, s]));
    return {
      source: "model",
      sets: archetypes.map((id) => {
        const s = by.get(id);
        return s ? { title: s.title, lead: s.lead, action: s.action } : fallbackTexts(facts, 0);
      }),
    };
  } catch (e) {
    if (model.signal?.aborted) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    notes.push(`модель не ответила (${msg.slice(0, 120)}): тексты из брифа`);
    return fallback();
  }
}

/** Whether a stored value is a proposal of this version (data from storage is checked before use). */
export function isDirectionsProposal(v: unknown): v is DirectionsProposal {
  if (!v || typeof v !== "object") return false;
  const p = v as Partial<DirectionsProposal>;
  return (
    p.kind === PROPOSAL_KIND &&
    p.version === 1 &&
    typeof p.seed === "string" &&
    typeof p.niche === "string" &&
    Array.isArray(p.directions) &&
    p.directions.length === 3 &&
    p.directions.every(
      (d) =>
        isArchetypeId(d.archetype) &&
        typeof d.header === "string" &&
        typeof d.hero === "string" &&
        typeof d.texts?.title === "string" &&
        typeof d.texts?.action === "string",
    )
  );
}

/** A direction with new tuning: the design is recomputed, the hero changes only when photos were switched. */
export function retune(p: DirectionsProposal, d: StoredDirection, delta: DirectionTuning): StoredDirection {
  const tuning = mergeTuning(d.tuning, delta);
  const photosChanged = delta.photos !== undefined && delta.photos !== d.tuning.photos;
  if (!photosChanged) return { ...d, tuning };
  const used = p.directions.filter((x) => x.n !== d.n).map((x) => x.hero);
  return { ...d, tuning, hero: heroFor(d.archetype, `${p.seed}|${d.n}|${tuning.photos}`, tuning, used) };
}

/** Niche text of a system for the sampler and the texts: its name and the owner's first request, scrubbed, ≤ 300. */
export function directionsNiche(name: string, request: string | null | undefined): string {
  const text = [name, request ?? ""]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(". ");
  return scrub(text).text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * The design system a brief asks for (the build's «design» stage, V3-11): the archetype the owner chose, the brand
 * colour of the logo and the owner's words from brief.design.references. Null when the brief names no archetype.
 * With the proposal's seed and niche it is exactly the first screen the owner picked.
 */
export function briefDesign(
  brief: SystemBrief,
  o: { seed: string | number; niche: string },
): TunedDesign | null {
  const id = brief.design.archetype;
  if (!isArchetypeId(id)) return null;
  const hints = referenceHints(brief.design.references);
  return tuneDesign(
    {
      archetype: id,
      seed: o.seed,
      niche: o.niche,
      ...(hints.brandColor ? { brandColor: hints.brandColor } : {}),
    },
    hints.tuning,
  );
}

/** `full` minus what `base` already gives: the owner's own words on top of the references' hints. */
export function tuningDelta(full: DirectionTuning, base: DirectionTuning): DirectionTuning {
  const out: DirectionTuning = {};
  for (const axis of TUNING_AXES) {
    const v = (full[axis] ?? 0) - (base[axis] ?? 0);
    if (v) out[axis] = v;
  }
  if (full.photos !== undefined && full.photos !== base.photos) out.photos = full.photos;
  if (full.scheme !== undefined && full.scheme !== base.scheme) out.scheme = full.scheme;
  return normalizeTuning(out);
}

/**
 * brief.design after the owner's choice: the archetype of direction `n` pinned, the references kept, and the owner's
 * words of that direction (its tuning beyond what the references give) as one «Пожелания словами» line — so that
 * briefDesign(brief) is the first screen the owner picked. `n` null — «Решите за меня»: the first direction, not pinned.
 */
export function pickedDesign(
  design: SystemBrief["design"],
  p: DirectionsProposal,
  n: number | null,
): SystemBrief["design"] {
  const d = p.directions[(n ?? 1) - 1];
  if (!d) throw new Error(`no direction ${n}`);
  const refs = design.references.filter((r) => !r.startsWith(WORDS_HEAD));
  const pinned = n !== null;
  const words = pinned ? tuningWords(tuningDelta(d.tuning, referenceHints(refs).tuning)) : [];
  return {
    archetype: d.archetype,
    pinned,
    references: [...refs, ...(words.length ? [wordsLine(words)] : [])].slice(-BRIEF_REFERENCES),
  };
}
